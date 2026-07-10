"""Actor driver: builds Actor images and runs Actor containers via Docker.

Exposes a small ``Driver`` protocol so tests can substitute a stub that does not
require a Docker daemon. ``DockerDriver`` talks to the host daemon through the
mounted socket using the Docker SDK.
"""
from __future__ import annotations

import base64
from pathlib import Path
from typing import Protocol

# Per-read (inactivity) timeout on the Docker build's streaming HTTP response.
# It bounds a *silently* hung build - one that stops emitting output for this
# many seconds is aborted, so a build worker (and the build's RUNNING status)
# cannot block forever. It is NOT a hard wall-clock cap on total build duration:
# a slow build that keeps producing output can still run past this window.
BUILD_TIMEOUT_SECS = 600
# Sane default resource caps for Actor run containers so a runaway Actor cannot
# starve the host / Docker daemon. Memory is overridden per-run from options.
DEFAULT_PIDS_LIMIT = 512
DEFAULT_NANO_CPUS = 2_000_000_000  # 2 CPUs


class SourceFileNameError(ValueError):
    """A pushed ``sourceFiles[].name`` escapes the build destination directory."""


def write_source_files(source_files: list[dict], dest: Path) -> None:
    """Materialise pushed ``sourceFiles`` (inline TEXT/BASE64) into ``dest``.

    ``name`` is fully attacker-controlled (it comes straight from the request
    body of ``apify push``). Each name is validated to stay strictly inside
    ``dest``: absolute paths and any ``..`` traversal that would resolve outside
    the build directory are rejected before anything is written to disk.
    """
    dest.mkdir(parents=True, exist_ok=True)
    dest_resolved = dest.resolve()
    for entry in source_files:
        name = entry.get("name")
        if not name:
            continue
        if Path(name).is_absolute():
            raise SourceFileNameError(f"Illegal absolute source file name: {name!r}")
        target = (dest / name).resolve()
        if target != dest_resolved and dest_resolved not in target.parents:
            raise SourceFileNameError(f"Source file name escapes build directory: {name!r}")
        target.parent.mkdir(parents=True, exist_ok=True)
        content = entry.get("content", "")
        if entry.get("format") == "BASE64":
            target.write_bytes(base64.b64decode(content))
        else:
            target.write_text(content)


def resolve_dockerfile(build_dir: Path) -> str | None:
    """Return the Dockerfile path relative to ``build_dir``, Apify conventions."""
    for candidate in (".actor/Dockerfile", "Dockerfile"):
        if (build_dir / candidate).is_file():
            return candidate
    return None


class BuildResult:
    def __init__(self, ok: bool, log: str) -> None:
        self.ok = ok
        self.log = log


class RunResult:
    def __init__(self, exit_code: int, log: str, timed_out: bool = False) -> None:
        self.exit_code = exit_code
        self.log = log
        self.timed_out = timed_out


class Driver(Protocol):
    def build(self, build_dir: Path, image_tag: str) -> BuildResult: ...

    def run(
        self,
        image_tag: str,
        host_storage_dir: str,
        environment: dict[str, str],
        timeout_secs: int,
        container_name: str | None = None,
        mem_limit_mb: int | None = None,
    ) -> RunResult: ...

    def stop(self, container_name: str) -> None: ...

    def remove_image(self, image_tag: str) -> None: ...


class DockerDriver:
    """Real driver using the host Docker daemon via the mounted socket."""

    def __init__(self) -> None:
        import docker

        self._docker = docker
        self._client = docker.from_env()

    def build(self, build_dir: Path, image_tag: str) -> BuildResult:
        dockerfile = resolve_dockerfile(build_dir)
        if dockerfile is None:
            return BuildResult(False, "No Dockerfile found (looked for .actor/Dockerfile, Dockerfile).\n")
        lines: list[str] = []
        try:
            _, logs = self._client.images.build(
                path=str(build_dir),
                dockerfile=dockerfile,
                tag=image_tag,
                rm=True,
                forcerm=True,
                pull=False,
                timeout=BUILD_TIMEOUT_SECS,
            )
            for chunk in logs:
                if "stream" in chunk:
                    lines.append(chunk["stream"])
                elif "error" in chunk:
                    lines.append(chunk["error"])
        except self._docker.errors.BuildError as exc:
            for item in getattr(exc, "build_log", []) or []:
                if isinstance(item, dict) and "stream" in item:
                    lines.append(item["stream"])
            lines.append(f"\nBUILD ERROR: {exc}\n")
            return BuildResult(False, "".join(lines))
        except Exception as exc:  # noqa: BLE001 - surface any daemon error as a failed build
            lines.append(f"\nBUILD ERROR: {exc}\n")
            return BuildResult(False, "".join(lines))
        return BuildResult(True, "".join(lines))

    def run(
        self,
        image_tag: str,
        host_storage_dir: str,
        environment: dict[str, str],
        timeout_secs: int,
        container_name: str | None = None,
        mem_limit_mb: int | None = None,
    ) -> RunResult:
        run_kwargs: dict = dict(
            detach=True,
            environment=environment,
            volumes={host_storage_dir: {"bind": "/apify_storage", "mode": "rw"}},
            network_mode="bridge",
            # Resource caps: enforce the caller's memory budget and apply sane
            # process/CPU ceilings so a runaway Actor cannot exhaust the host.
            pids_limit=DEFAULT_PIDS_LIMIT,
            nano_cpus=DEFAULT_NANO_CPUS,
        )
        if container_name:
            run_kwargs["name"] = container_name
        if mem_limit_mb:
            run_kwargs["mem_limit"] = f"{int(mem_limit_mb)}m"
        container = self._client.containers.run(image_tag, **run_kwargs)
        timed_out = False
        exit_code = 1
        try:
            try:
                result = container.wait(timeout=timeout_secs)
                exit_code = int(result.get("StatusCode", 1))
            except Exception as exc:  # noqa: BLE001 - treat a wait timeout as a run timeout
                if _is_timeout(exc):
                    timed_out = True
                    try:
                        container.kill()
                    except Exception:  # noqa: BLE001
                        pass
                else:
                    raise
            log = container.logs().decode("utf-8", errors="replace")
        finally:
            try:
                container.remove(force=True)
            except Exception:  # noqa: BLE001
                pass
        return RunResult(exit_code, log, timed_out=timed_out)

    def stop(self, container_name: str) -> None:
        """Best-effort kill of a run container (used by abort)."""
        try:
            self._client.containers.get(container_name).kill()
        except Exception:  # noqa: BLE001 - container may already be gone
            pass

    def remove_image(self, image_tag: str) -> None:
        """Best-effort removal of a built image (used to clean up failed builds)."""
        try:
            self._client.images.remove(image=image_tag, force=True, noprune=False)
        except Exception:  # noqa: BLE001
            pass


def _is_timeout(exc: Exception) -> bool:
    """Recognise a docker-py / requests read timeout without a hard dependency."""
    name = type(exc).__name__.lower()
    return "timeout" in name or "timeout" in str(exc).lower()

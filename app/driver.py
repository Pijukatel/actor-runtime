"""Actor driver: builds Actor images and runs Actor containers via Docker.

Exposes a small ``Driver`` protocol so tests can substitute a stub that does not
require a Docker daemon. ``DockerDriver`` talks to the host daemon through the
mounted socket using the Docker SDK.
"""
from __future__ import annotations

import base64
import io
import logging
import shutil
import stat
import threading
import zipfile
from pathlib import Path
from typing import Callable, Protocol

from .config import ACTOR_STANDBY_PORT, NETWORK_ALIAS, NETWORK_NAME

logger = logging.getLogger(__name__)

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


def extract_zip(zip_bytes: bytes, dest: Path) -> None:
    """Unzip ``zip_bytes`` into ``dest`` with the same traversal safety as
    ``write_source_files``.

    Zip entry names are fully attacker-controlled (the archive is uploaded by
    ``apify push``), so each name is validated to stay strictly inside ``dest``
    BEFORE anything is written: absolute names and any ``..`` traversal resolving
    outside the build directory are rejected. ``ZipFile.extractall`` is
    deliberately not used (it is vulnerable to zip-slip). Symlink entries are
    never materialised as links.
    """
    dest.mkdir(parents=True, exist_ok=True)
    dest_resolved = dest.resolve()
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        infos = zf.infolist()
        for info in infos:
            name = info.filename
            if not name or name.endswith("/"):
                continue
            if Path(name).is_absolute():
                raise SourceFileNameError(f"Illegal absolute zip entry name: {name!r}")
            target = (dest / name).resolve()
            if target != dest_resolved and dest_resolved not in target.parents:
                raise SourceFileNameError(f"Zip entry name escapes build directory: {name!r}")
        for info in infos:
            name = info.filename
            if not name or name.endswith("/"):
                continue
            if stat.S_ISLNK((info.external_attr >> 16) & 0xFFFF):
                continue
            target = (dest / name).resolve()
            target.parent.mkdir(parents=True, exist_ok=True)
            with zf.open(info) as src, open(target, "wb") as out:
                shutil.copyfileobj(src, out)


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
    def build(
        self, build_dir: Path, image_tag: str, log_sink: Callable[[str], None] | None = None
    ) -> BuildResult: ...

    def run(
        self,
        image_tag: str,
        host_storage_dir: str,
        environment: dict[str, str],
        timeout_secs: int,
        container_name: str | None = None,
        mem_limit_mb: int | None = None,
        log_sink: Callable[[str], None] | None = None,
    ) -> RunResult: ...

    def ensure_network(self) -> None: ...

    def start(
        self,
        image_tag: str,
        host_storage_dir: str,
        environment: dict[str, str],
        container_name: str,
        mem_limit_mb: int | None = None,
    ) -> str: ...

    def reap(self, container_name: str) -> None: ...

    def stop(self, container_name: str) -> None: ...

    def remove_image(self, image_tag: str) -> None: ...

    def logs(self, container_name: str) -> str: ...


class DockerDriver:
    """Real driver using the host Docker daemon via the mounted socket."""

    def __init__(self, client=None, network_name: str = NETWORK_NAME) -> None:
        import docker

        self._docker = docker
        self._client = docker.from_env() if client is None else client
        self._network_name = network_name
        # Set True only once `ensure_network()` has confirmed the shared
        # network actually exists (found or freshly created). Both `run()`
        # and `start()` below key off this instead of blindly assuming the
        # named network is there -- see the fallback logic in each.
        self._network_available = False

    def ensure_network(self) -> None:
        """Create the shared user-defined network (idempotent) and self-attach.

        Actor containers only get embedded DNS (resolving each other, and the
        runtime, by name) on a user-defined network -- the default bridge has
        none. Self-attach needs the runtime to actually be a container whose
        id is discoverable via its own hostname; when it is not (e.g. running
        directly on a host, as in local dev outside Docker), self-attach is
        skipped -- Actor containers still join the network below, but the
        runtime itself stays unreachable by name from inside them, so
        APIFY_API_BASE_URL will not resolve for those containers.

        If the network itself cannot be found OR created (e.g. a daemon that
        restricts user-defined network creation), ``self._network_available``
        is left ``False``: ``run()`` then falls back to the default bridge
        network (preserving pre-standby on-demand-run behavior) and ``start()``
        raises a clear, actionable error instead of referencing a network that
        does not exist.
        """
        try:
            self._client.networks.get(self._network_name)
        except self._docker.errors.NotFound:
            try:
                self._client.networks.create(self._network_name, driver="bridge")
            except Exception:  # noqa: BLE001 - best-effort; run()/start() fall back below
                logger.warning("Could not create Docker network %r.", self._network_name)
                return
        except Exception:  # noqa: BLE001
            logger.warning("Could not look up Docker network %r.", self._network_name)
            return
        # The network exists (found, or just created) -- on-demand runs and
        # standby starts can now safely reference it by name.
        self._network_available = True
        try:
            import socket

            self_container = self._client.containers.get(socket.gethostname())
            self._client.networks.get(self._network_name).connect(
                self_container, aliases=[NETWORK_ALIAS]
            )
        except self._docker.errors.APIError as exc:
            # Already connected (e.g. a restarted, not recreated, container) is
            # the common, harmless case -- only warn for anything else.
            if "already exists" not in str(exc).lower() and "already connected" not in str(exc).lower():
                logger.warning("Could not self-attach to network %r: %s", self._network_name, exc)
        except Exception:  # noqa: BLE001 - not running as a container: guarded fallback, not fatal
            logger.warning(
                "Could not self-attach to network %r under alias %r (not running as a "
                "container?); APIFY_API_BASE_URL will not be reachable from Actor containers.",
                self._network_name, NETWORK_ALIAS,
            )

    def build(
        self, build_dir: Path, image_tag: str, log_sink: Callable[[str], None] | None = None
    ) -> BuildResult:
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
                line = None
                if "stream" in chunk:
                    line = chunk["stream"]
                elif "error" in chunk:
                    line = chunk["error"]
                if line is not None:
                    lines.append(line)
                    if log_sink is not None:
                        log_sink(line)
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
        log_sink: Callable[[str], None] | None = None,
    ) -> RunResult:
        run_kwargs: dict = dict(
            detach=True,
            environment=environment,
            volumes={host_storage_dir: {"bind": "/apify_storage", "mode": "rw"}},
            # Resource caps: enforce the caller's memory budget and apply sane
            # process/CPU ceilings so a runaway Actor cannot exhaust the host.
            pids_limit=DEFAULT_PIDS_LIMIT,
            nano_cpus=DEFAULT_NANO_CPUS,
        )
        if self._network_available:
            # The shared user-defined network (not the default bridge) so this
            # container can reach the runtime's APIFY_API_BASE_URL, and be
            # reached in turn, by name.
            run_kwargs["network"] = self._network_name
        else:
            # `ensure_network()` couldn't create/look up the shared network at
            # boot -- fall back to Docker's always-present default bridge so
            # on-demand runs keep working exactly as they did before standby
            # support existed (network-name-reachability and standby
            # forwarding simply won't work in this degraded case).
            run_kwargs["network_mode"] = "bridge"
        if container_name:
            run_kwargs["name"] = container_name
        if mem_limit_mb:
            run_kwargs["mem_limit"] = f"{int(mem_limit_mb)}m"
        container = self._client.containers.run(image_tag, **run_kwargs)
        timed_out = False
        exit_code = 1
        log = ""
        chunks: list[str] = []
        log_thread: threading.Thread | None = None
        if log_sink is not None:
            # Stream logs in a sibling thread while the main flow enforces the
            # timeout CONCURRENTLY. ``container.logs(follow=True)`` blocks until the
            # container exits, so it cannot itself drive the timeout; running it
            # alongside ``container.wait(timeout=...)`` lets a hung Actor still be
            # killed. The sink only appends to memory, so a slow consumer can never
            # apply back-pressure to this thread.
            def _follow() -> None:
                try:
                    for chunk in container.logs(stream=True, follow=True):
                        text = (
                            chunk.decode("utf-8", errors="replace")
                            if isinstance(chunk, (bytes, bytearray))
                            else str(chunk)
                        )
                        chunks.append(text)
                        log_sink(text)
                except Exception:  # noqa: BLE001 - the stream ends when the container dies
                    pass

            log_thread = threading.Thread(target=_follow, daemon=True)
            log_thread.start()
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
            if log_sink is None:
                log = container.logs().decode("utf-8", errors="replace")
        finally:
            if log_thread is not None:
                # Ensure the container is stopped so the follow stream ends, then
                # join so the log thread can never outlive the call, then assemble
                # the final log from the accumulator.
                try:
                    container.kill()
                except Exception:  # noqa: BLE001
                    pass
                log_thread.join()
                log = "".join(chunks)
            try:
                container.remove(force=True)
            except Exception:  # noqa: BLE001
                pass
        return RunResult(exit_code, log, timed_out=timed_out)

    def start(
        self,
        image_tag: str,
        host_storage_dir: str,
        environment: dict[str, str],
        container_name: str,
        mem_limit_mb: int | None = None,
    ) -> str:
        """Non-blocking start: launch a detached, long-lived container and return
        immediately with its forwarding endpoint (no ``wait``, no auto-remove --
        that is ``reap``'s job). Used for standby Actor runs, where the caller
        needs a live handle rather than a completed :class:`RunResult`.

        The container's name doubles as its DNS name on the shared network, so
        the endpoint is known synchronously without inspecting the container.

        Raises ``RuntimeError`` with a clear, actionable message if the shared
        network is not available (``ensure_network()`` failed at boot) instead
        of attempting to join a network that doesn't exist: unlike an on-demand
        ``run()``, a standby container is unreachable by anything but its
        network DNS name, so there is no degraded-but-working fallback here.
        """
        if not self._network_available:
            raise RuntimeError(
                f"Cannot start a standby Actor container: the shared Docker "
                f"network {self._network_name!r} is not available (network "
                "setup failed at runtime boot -- see the 'Could not create/"
                "look up Docker network' warning in the runtime's own logs). "
                "Standby actors require container-to-container networking by "
                "name; on-demand runs are unaffected and keep working via the "
                "default bridge network. Fix the daemon's network-creation "
                "permissions and restart the runtime to enable standby actors."
            )
        run_kwargs: dict = dict(
            detach=True,
            environment=environment,
            volumes={host_storage_dir: {"bind": "/apify_storage", "mode": "rw"}},
            network=self._network_name,
            name=container_name,
            pids_limit=DEFAULT_PIDS_LIMIT,
            nano_cpus=DEFAULT_NANO_CPUS,
        )
        if mem_limit_mb:
            run_kwargs["mem_limit"] = f"{int(mem_limit_mb)}m"
        self._client.containers.run(image_tag, **run_kwargs)
        return f"http://{container_name}:{ACTOR_STANDBY_PORT}"

    def reap(self, container_name: str) -> None:
        """Kill and remove a container started via ``start`` (idempotent)."""
        try:
            container = self._client.containers.get(container_name)
        except Exception:  # noqa: BLE001 - already gone
            return
        try:
            container.remove(force=True)
        except Exception:  # noqa: BLE001
            pass

    def stop(self, container_name: str) -> None:
        """Best-effort kill of a run container (used by abort)."""
        try:
            self._client.containers.get(container_name).kill()
        except Exception:  # noqa: BLE001 - container may already be gone
            pass

    def logs(self, container_name: str) -> str:
        """Best-effort fetch of a still-alive container's accumulated stdout/stderr.

        Standby runs have no live ``log_sink`` the way the blocking ``run()``
        path does (there is no in-flight call to attach one to), so the
        service calls this at reap/teardown time -- before ``reap`` kills and
        removes the container -- to populate ``Run.log`` instead of leaving it
        permanently empty for a standby run's whole warm lifetime. Returns an
        empty string if the container is already gone or logs can't be read;
        never raises.
        """
        try:
            container = self._client.containers.get(container_name)
            return container.logs().decode("utf-8", errors="replace")
        except Exception:  # noqa: BLE001 - best-effort only
            return ""

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

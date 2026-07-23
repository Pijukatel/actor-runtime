"""Runtime configuration, read from the environment with sensible defaults."""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

# The default user, used when no Authorization token is presented. There is no
# real auth: the bearer token selects/creates the acting user, and its absence
# falls back to this single default user (preserving the original behaviour).
DEFAULT_USERNAME = "local-user"

# The API and console ports are fixed and not configurable via the environment.
API_PORT = 3333
CONSOLE_PORT = 3000

# The shared user-defined Docker network every Actor container -- and the
# runtime itself, via DockerDriver.ensure_network() -- joins. Containers only
# get embedded DNS (resolving each other, and the runtime, by name) on a
# user-defined network; the default bridge network has none.
NETWORK_NAME = "actor-runtime-net"
NETWORK_ALIAS = "actor-runtime"

# Fixed port every standby Actor's HTTP server listens on inside its
# container (mirrors the real platform's ACTOR_STANDBY_PORT). Fixed rather
# than allocated per-run: containers are addressed by name on the shared
# network, so there is no host port to allocate or collide over.
ACTOR_STANDBY_PORT = 4321

# Mirrors apify-core's actorStandby.idleTimeoutSecs: default 300s (5 min),
# enforced minimum 5s.
STANDBY_IDLE_TIMEOUT_DEFAULT_SECS = 300
STANDBY_IDLE_TIMEOUT_MIN_SECS = 5


@dataclass(frozen=True)
class Settings:
    data_dir: Path
    # Absolute path of ``data_dir`` on the Docker host. When the runtime itself
    # runs inside a container (sharing the host Docker socket), volume mounts for
    # Actor containers must reference host paths, not runtime-container paths.
    # Defaults to ``data_dir`` for the "runtime runs directly on the host" case.
    host_data_dir: Path
    port_api: int
    port_console: int
    network_name: str = NETWORK_NAME
    network_alias: str = NETWORK_ALIAS
    # Global override for every actor's standby idle timeout: bypasses both the
    # per-actor config AND the platform-mirrored 5s floor, so tests can reap in
    # a fraction of a second. ``None`` means "use the per-actor config".
    standby_idle_override_secs: float | None = None
    # How long ensure_standby_run() polls a freshly-started container's
    # readiness probe before giving up. A Settings field (not a constant) so
    # tests can shrink it instead of waiting out the production default.
    standby_ready_timeout_secs: float = 30.0
    # Base URL the upstream-fallback middleware (app/upstream.py) replays an
    # allowlisted local-404 request against. A `Settings` field (not a plain
    # constant) purely so tests can point it at a local stub server instead of
    # the real platform.
    apify_upstream_base_url: str = "https://api.apify.com"
    # NOTE: the standby-forwarding proxy's upstream connect timeout is a
    # plain module constant in app/routers/standby.py
    # (`_STANDBY_FORWARD_CONNECT_TIMEOUT_SECS`), not a `Settings` field --
    # unlike `standby_idle_override_secs`/`standby_ready_timeout_secs` above,
    # nothing has ever needed to override it per-environment or in a test.

    # Host-supplied Apify proxy password, forwarded into every Actor
    # container's environment (see Service._build_environment) so the SDK's
    # Configuration.proxy_password picks it up. Empty means "not configured" --
    # no APIFY_PROXY_PASSWORD is injected into Actor containers at all (see
    # README.md's Apify Proxy section).
    apify_proxy_password: str = ""

    @property
    def meta_db_url(self) -> str:
        return f"sqlite+aiosqlite:///{self.data_dir / 'meta.db'}"

    @property
    def storage_db_url(self) -> str:
        return f"sqlite+aiosqlite:///{self.data_dir / 'storage.db'}"

    @property
    def runs_dir(self) -> Path:
        return self.data_dir / "runs"

    @property
    def host_runs_dir(self) -> Path:
        return self.host_data_dir / "runs"

    @property
    def builds_dir(self) -> Path:
        return self.data_dir / "builds"

    @property
    def container_api_base_url(self) -> str:
        """The runtime's own API, reachable by name from any Actor container on
        the shared network (see ``NETWORK_NAME``/``NETWORK_ALIAS``)."""
        return f"http://{self.network_alias}:{self.port_api}"


def load_settings() -> Settings:
    data_dir = Path(os.environ.get("DATA_DIR", "/data")).resolve()
    host_data_dir = Path(os.environ.get("HOST_DATA_DIR", str(data_dir)))
    override_raw = os.environ.get("STANDBY_IDLE_OVERRIDE_SECS")
    return Settings(
        data_dir=data_dir,
        host_data_dir=host_data_dir,
        port_api=API_PORT,
        port_console=CONSOLE_PORT,
        standby_idle_override_secs=float(override_raw) if override_raw else None,
        apify_proxy_password=os.environ.get("APIFY_PROXY_PASSWORD", ""),
        apify_upstream_base_url=os.environ.get("APIFY_UPSTREAM_BASE_URL", "https://api.apify.com"),
    )

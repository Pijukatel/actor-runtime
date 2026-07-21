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

# Apify Proxy connection defaults, mirroring apify-core's production
# `superProxy` settings (hostname/port/statusPageUrl). The real platform
# injects these into every Actor container as APIFY_PROXY_HOSTNAME /
# APIFY_PROXY_PORT / APIFY_PROXY_STATUS_URL; the runtime does the same so an
# Actor (or the apify SDK inside it) builds exactly the same
# `http://<username>:<password>@proxy.apify.com:8000` URLs it would build on
# the platform. The runtime cannot mint proxy passwords -- the user supplies
# their own via APIFY_PROXY_PASSWORD on the runtime container (see
# `load_settings`).
PROXY_HOSTNAME_DEFAULT = "proxy.apify.com"
PROXY_PORT_DEFAULT = 8000


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
    # Apify Proxy wiring for Actor containers (see PROXY_HOSTNAME_DEFAULT's
    # comment). `proxy_password` is the user's own Apify Proxy password
    # (populated via the APIFY_PROXY_PASSWORD env var on the runtime
    # container); `None` means the user provided none, and Actor containers
    # then get no APIFY_PROXY_PASSWORD at all -- so an Actor requesting Apify
    # Proxy fails with the SDK's own clear "password must be provided" error,
    # exactly as on the platform with a missing password.
    proxy_password: str | None = None
    proxy_hostname: str = PROXY_HOSTNAME_DEFAULT
    proxy_port: int = PROXY_PORT_DEFAULT
    # Defaults to `http://<proxy_hostname>` in `load_settings` (matching the
    # platform, where the status page lives on the proxy hostname itself).
    proxy_status_url: str = f"http://{PROXY_HOSTNAME_DEFAULT}"
    # NOTE: the standby-forwarding proxy's upstream connect timeout is a
    # plain module constant in app/routers/standby.py
    # (`_STANDBY_FORWARD_CONNECT_TIMEOUT_SECS`), not a `Settings` field --
    # unlike `standby_idle_override_secs`/`standby_ready_timeout_secs` above,
    # nothing has ever needed to override it per-environment or in a test.

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
    proxy_hostname = os.environ.get("APIFY_PROXY_HOSTNAME") or PROXY_HOSTNAME_DEFAULT
    try:
        proxy_port = int(os.environ.get("APIFY_PROXY_PORT") or PROXY_PORT_DEFAULT)
    except ValueError:
        proxy_port = PROXY_PORT_DEFAULT
    return Settings(
        data_dir=data_dir,
        host_data_dir=host_data_dir,
        port_api=API_PORT,
        port_console=CONSOLE_PORT,
        standby_idle_override_secs=float(override_raw) if override_raw else None,
        # Empty-string password counts as "not provided": passing an empty
        # APIFY_PROXY_PASSWORD through to Actor containers would make the SDK
        # build proxy URLs with a blank password instead of raising its clear
        # missing-password error.
        proxy_password=os.environ.get("APIFY_PROXY_PASSWORD") or None,
        proxy_hostname=proxy_hostname,
        proxy_port=proxy_port,
        proxy_status_url=os.environ.get("APIFY_PROXY_STATUS_URL") or f"http://{proxy_hostname}",
    )

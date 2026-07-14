"""Runtime configuration, read from the environment with sensible defaults."""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

# The default user, used when no Authorization token is presented. There is no
# real auth: the bearer token selects/creates the acting user, and its absence
# falls back to this single default user (preserving the original behaviour).
DEFAULT_USERNAME = "local-user"


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


def load_settings() -> Settings:
    data_dir = Path(os.environ.get("DATA_DIR", "/data")).resolve()
    host_data_dir = Path(os.environ.get("HOST_DATA_DIR", str(data_dir)))
    return Settings(
        data_dir=data_dir,
        host_data_dir=host_data_dir,
        port_api=int(os.environ.get("PORT_API", "8080")),
        port_console=int(os.environ.get("PORT_CONSOLE", "8081")),
    )

"""Shared test fixtures: an in-process app wired to a Docker-free stub driver."""
from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest_asyncio

from app.config import Settings
from app.db import Database
from app.driver import BuildResult, RunResult
from app.main import create_app
from app.service import Service
from app.storage import Storage


class StubDriver:
    """Driver replacement that needs no Docker daemon.

    ``run`` simulates the sample Actor: it reads INPUT and writes an OUTPUT
    record, one dataset item and one queued request into the run's storage dir,
    exactly as the real containerised Actor would.
    """

    def build(self, build_dir: Path, image_tag: str) -> BuildResult:
        return BuildResult(True, f"stub: built {image_tag}\n")

    def stop(self, container_name: str) -> None:  # no Docker in the stub
        pass

    def remove_image(self, image_tag: str) -> None:  # no Docker in the stub
        pass

    def run(
        self, image_tag, host_storage_dir, environment, timeout_secs,
        container_name=None, mem_limit_mb=None,
    ) -> RunResult:
        storage = Path(host_storage_dir)
        kv = storage / "key_value_stores" / "default"
        input_path = kv / "INPUT.json"
        actor_input = json.loads(input_path.read_text()) if input_path.exists() else {}
        greeting = actor_input.get("greeting", "hello")

        (kv).mkdir(parents=True, exist_ok=True)
        (kv / "OUTPUT.json").write_text(json.dumps({"greeting": greeting, "receivedInput": actor_input}))

        ds = storage / "datasets" / "default"
        ds.mkdir(parents=True, exist_ok=True)
        (ds / "000000001.json").write_text(json.dumps({"message": f"{greeting} world", "index": 1}))

        rq = storage / "request_queues" / "default"
        rq.mkdir(parents=True, exist_ok=True)
        (rq / "request-1.json").write_text(
            json.dumps({"url": "https://example.com/from-actor", "uniqueKey": "https://example.com/from-actor", "method": "GET"})
        )
        return RunResult(0, f"stub run of {image_tag}: greeting={greeting}\n")


def make_settings(tmp_path: Path) -> Settings:
    return Settings(
        data_dir=tmp_path,
        host_data_dir=tmp_path,
        port_api=8080,
        port_console=8081,
    )


@pytest_asyncio.fixture
async def wired(tmp_path):
    settings = make_settings(tmp_path)
    settings.runs_dir.mkdir(parents=True, exist_ok=True)
    settings.builds_dir.mkdir(parents=True, exist_ok=True)
    db = Database(settings.meta_db_url)
    await db.create_all()
    storage = Storage(settings.storage_db_url)
    await storage.start()
    driver = StubDriver()
    service = Service(settings, db, storage, driver)
    app = create_app(settings, driver)
    app.state.service = service
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        yield client, service
    await storage.stop()
    await db.dispose()

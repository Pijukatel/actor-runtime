"""Shared test fixtures: an in-process app wired to a Docker-free stub driver."""
from __future__ import annotations

import json
import time
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

    def __init__(self) -> None:
        # Records the environment dict passed to each ``run`` so tests can assert
        # what does (and does not) reach the Actor container.
        self.captured_envs: list[dict] = []

    def build(self, build_dir: Path, image_tag: str, log_sink=None) -> BuildResult:
        return BuildResult(True, f"stub: built {image_tag}\n")

    def stop(self, container_name: str) -> None:  # no Docker in the stub
        pass

    def remove_image(self, image_tag: str) -> None:  # no Docker in the stub
        pass

    def _materialize(self, host_storage_dir) -> str:
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
        return greeting

    def run(
        self, image_tag, host_storage_dir, environment, timeout_secs,
        container_name=None, mem_limit_mb=None, log_sink=None,
    ) -> RunResult:
        self.captured_envs.append(dict(environment))
        greeting = self._materialize(host_storage_dir)
        return RunResult(0, f"stub run of {image_tag}: greeting={greeting}\n")


class StreamingStubDriver(StubDriver):
    """Docker-free driver that delivers its log in chunks over time via ``log_sink``.

    ``run`` and ``build`` feed several chunks through the sink with short delays
    (so the live-streaming buffer, endpoint, terminal-state handoff and console
    wiring are unit-testable without Docker), while the returned result's ``log``
    equals the exact concatenation of those chunks. The real docker-py streaming
    path is verified on a Docker-enabled host/CI.
    """

    def __init__(self, chunks=None, delay=0.6) -> None:
        super().__init__()
        self.chunks = list(chunks) if chunks is not None else ["chunk-1\n", "chunk-2\n", "chunk-3\n"]
        self.delay = delay

    def _emit(self, log_sink) -> str:
        for chunk in self.chunks:
            if log_sink is not None:
                log_sink(chunk)
            time.sleep(self.delay)
        return "".join(self.chunks)

    def run(
        self, image_tag, host_storage_dir, environment, timeout_secs,
        container_name=None, mem_limit_mb=None, log_sink=None,
    ) -> RunResult:
        self.captured_envs.append(dict(environment))
        self._materialize(host_storage_dir)
        return RunResult(0, self._emit(log_sink))

    def build(self, build_dir: Path, image_tag: str, log_sink=None) -> BuildResult:
        return BuildResult(True, self._emit(log_sink))


def make_settings(tmp_path: Path) -> Settings:
    return Settings(
        data_dir=tmp_path,
        host_data_dir=tmp_path,
        port_api=3333,
        port_console=3000,
    )


async def _wire(tmp_path, driver):
    settings = make_settings(tmp_path)
    settings.runs_dir.mkdir(parents=True, exist_ok=True)
    settings.builds_dir.mkdir(parents=True, exist_ok=True)
    db = Database(settings.meta_db_url)
    await db.create_all()
    storage = Storage(settings.storage_db_url)
    await storage.start()
    service = Service(settings, db, storage, driver)
    app = create_app(settings, driver)
    app.state.service = service
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        yield client, service
    await storage.stop()
    await db.dispose()


@pytest_asyncio.fixture
async def wired(tmp_path):
    async for pair in _wire(tmp_path, StubDriver()):
        yield pair


@pytest_asyncio.fixture
async def wired_streaming(tmp_path):
    """Like ``wired`` but driven by the chunked, delayed ``StreamingStubDriver``.

    Tests reach the driver via ``service.driver`` to tune ``chunks``/``delay``.
    """
    async for pair in _wire(tmp_path, StreamingStubDriver()):
        yield pair

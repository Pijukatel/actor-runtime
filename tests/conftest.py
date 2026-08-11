"""Shared test fixtures: an in-process app wired to a Docker-free stub driver."""
from __future__ import annotations

import http.server
import json
import threading
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


def _make_threaded_http_server(handler_cls: type) -> http.server.ThreadingHTTPServer:
    """Construct (but do not yet start serving) a `ThreadingHTTPServer` for
    `handler_cls` on an ephemeral loopback port.

    Shared by every in-process HTTP stub in this suite -- `FakeStandbyServer`
    below, and `FakeUpstreamServer` in `test_upstream_fallback.py` -- so only
    the request handler differs between them. Callers set any handler-specific
    attributes on the returned server BEFORE starting its thread with
    `_start_http_server_thread`, matching the ordering each stub already relied
    on.
    """
    return http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler_cls)


def _start_http_server_thread(httpd: http.server.ThreadingHTTPServer) -> threading.Thread:
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    return thread


def _stop_threaded_http_server(httpd: http.server.ThreadingHTTPServer, thread: threading.Thread) -> None:
    """Shut down, close and join a server started via the two helpers above.

    Not idempotent by itself -- a caller that may `stop()` more than once
    (e.g. `FakeUpstreamServer`, stopped mid-test to simulate a connect error
    and again by its fixture's teardown) guards with its own already-stopped
    flag before calling this.
    """
    httpd.shutdown()
    httpd.server_close()
    thread.join(timeout=5)


class _QuietHandlerMixin:
    """Silences `BaseHTTPRequestHandler`'s default per-request stderr logging.

    Shared by every in-process HTTP stub handler in this suite so the
    silencing override lives in one place.
    """

    def log_message(self, format, *args) -> None:
        pass


class _StandbyProbeHandler(_QuietHandlerMixin, http.server.BaseHTTPRequestHandler):
    """Serves the readiness probe and echoes everything else back as JSON.

    Mirrors apify-core's own standby fixture actors (``shared_actors.js``): any
    request carrying the readiness-probe header gets 200 (or 503 while
    ``server.never_ready`` is set, to simulate an Actor that never comes up);
    any other request is echoed (method/path/query/headers/body) plus a
    per-server request counter, so tests can assert both exact forwarding and
    warm-container reuse across requests.
    """

    def _handle(self) -> None:
        if self.headers.get("x-apify-container-server-readiness-probe"):
            hang_secs = getattr(self.server, "readiness_hang_secs", 0.0)
            if hang_secs:
                # Simulate a container that accepted the TCP connection but
                # hangs before answering the probe (e.g. its HTTP framework is
                # deadlocked) -- used to prove the readiness wait's per-attempt
                # timeout is bounded by the configured
                # `standby_ready_timeout_secs`, not a fixed constant.
                time.sleep(hang_secs)
            self.send_response(503 if self.server.never_ready else 200)
            self.end_headers()
            return
        if self.path.startswith("/stream-slow"):
            self._handle_streamed()
            return
        if self.path.startswith("/multi-header"):
            self._handle_multi_header()
            return
        length = int(self.headers.get("content-length") or 0)
        body = self.rfile.read(length) if length else b""
        self.server.request_count += 1
        payload = json.dumps(
            {
                "method": self.command,
                "path": self.path,
                "headers": dict(self.headers.items()),
                "body": body.decode("utf-8", errors="replace"),
                "requestCount": self.server.request_count,
            }
        ).encode("utf-8")
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.end_headers()
        self.wfile.write(payload)

    def _handle_streamed(self) -> None:
        """Write the response body in several flushed chunks with a real delay
        between them, closing the connection instead of declaring
        Content-Length (so a client reading incrementally has no way to get
        the body except by reading it as it arrives).

        This is what lets a test prove the runtime's standby-forwarding proxy
        (``app/routers/standby.py``) genuinely streams the response back to
        the original caller rather than buffering the whole body first: with
        real delays between writes over a real (loopback) socket, the first
        chunk can only arrive quickly if the proxy forwards bytes as they're
        read rather than waiting for the whole body.
        """
        self.send_response(200)
        self.send_header("content-type", "text/plain")
        self.close_connection = True
        self.end_headers()
        for chunk in (b"chunk-1\n", b"chunk-2\n", b"chunk-3\n"):
            self.wfile.write(chunk)
            self.wfile.flush()
            time.sleep(0.3)

    def _handle_multi_header(self) -> None:
        """Echo received headers as an ORDERED list of (name, value) PAIRS
        (never collapsed into a dict, which would silently drop any repeated
        header name) and reply with two ``Set-Cookie`` headers of its own, so
        a test can assert repeated header names survive the round trip in
        BOTH directions -- the forwarding proxy must preserve multi-value
        headers, not just single-value ones.
        """
        length = int(self.headers.get("content-length") or 0)
        if length:
            self.rfile.read(length)
        payload = json.dumps({"receivedHeaderPairs": list(self.headers.items())}).encode("utf-8")
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("set-cookie", "a=1")
        self.send_header("set-cookie", "b=2")
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self) -> None:
        self._handle()

    def do_POST(self) -> None:
        self._handle()


class FakeStandbyServer:
    """In-process stand-in for a standby Actor's ``ACTOR_STANDBY_PORT`` listener.

    Lets ``StubDriver.start`` hand back a real, connectable ``http://127.0.0.1:<port>``
    endpoint so forwarding/readiness/idle-reap are exercised through real (loopback)
    HTTP, without any Docker container -- see the design's "in-process fake standby
    target" requirement.
    """

    def __init__(self, never_ready: bool = False, readiness_hang_secs: float = 0.0) -> None:
        self._httpd = _make_threaded_http_server(_StandbyProbeHandler)
        self._httpd.never_ready = never_ready
        self._httpd.readiness_hang_secs = readiness_hang_secs
        self._httpd.request_count = 0
        self.port = self._httpd.server_address[1]
        self._thread = _start_http_server_thread(self._httpd)

    @property
    def request_count(self) -> int:
        return self._httpd.request_count

    def stop(self) -> None:
        _stop_threaded_http_server(self._httpd, self._thread)


class StubDriver:
    """Driver replacement that needs no Docker daemon.

    ``run`` simulates the sample Actor: it reads INPUT and writes an OUTPUT
    record, one dataset item and one queued request into the run's storage dir,
    exactly as the real containerised Actor would.
    """

    def __init__(self) -> None:
        # Records the environment dict passed to each ``run``/``start`` so
        # tests can assert what does (and does not) reach the Actor container.
        self.captured_envs: list[dict] = []
        # Records the ``mem_limit_mb`` passed to each ``run``/``start`` call --
        # so tests can assert the ACTUAL container memory cap matches the
        # persisted ``run.options.memoryMbytes`` (regression: these used to
        # diverge for standby runs with no explicit memory config, capping
        # the reported value at 1024 MB while leaving the real container
        # uncapped).
        self.captured_mem_limits: list[int | None] = []
        # Records the materialized build directory handed to the most recent
        # ``build`` (before the service rmtree's it) so tests can assert exactly
        # which source was unzipped/written. Always-on; existing tests ignore it.
        self.captured_build_files: list[str] = []
        self.captured_build_dir_contents: dict[str, bytes] = {}
        # container_name -> FakeStandbyServer, so `reap` shuts down exactly the
        # in-process server `start` spun up as that "container"'s stand-in.
        self.standby_servers: dict[str, FakeStandbyServer] = {}
        # When set, the NEXT `start` call's server answers the readiness probe
        # with 503 forever, simulating a standby Actor that never becomes ready.
        self.next_start_never_ready = False
        # When set, the NEXT `start` call's server sleeps this long before
        # answering EVERY readiness probe -- simulating a container that
        # accepts the connection but hangs before responding (as opposed to
        # `next_start_never_ready`, which answers immediately with 503).
        self.next_start_readiness_hang_secs = 0.0

    def ensure_network(self) -> None:  # no Docker in the stub
        pass

    def build(self, build_dir: Path, image_tag: str, log_sink=None) -> BuildResult:
        files = [p for p in build_dir.rglob("*") if p.is_file()]
        self.captured_build_files = sorted(str(p.relative_to(build_dir)) for p in files)
        self.captured_build_dir_contents = {
            str(p.relative_to(build_dir)): p.read_bytes() for p in files
        }
        return BuildResult(True, f"stub: built {image_tag}\n")

    def stop(self, container_name: str) -> None:  # no Docker in the stub
        pass

    def remove_image(self, image_tag: str) -> None:  # no Docker in the stub
        pass

    def start(
        self,
        image_tag: str,
        host_storage_dir: str,
        environment: dict,
        container_name: str,
        mem_limit_mb=None,
    ) -> str:
        """Non-blocking start stand-in: materialize storage immediately (like a
        real container would eventually do) and spin up an in-process fake HTTP
        server standing in for the container's ``ACTOR_STANDBY_PORT`` listener.
        """
        self.captured_envs.append(dict(environment))
        self.captured_mem_limits.append(mem_limit_mb)
        self._materialize(host_storage_dir)
        server = FakeStandbyServer(
            never_ready=self.next_start_never_ready,
            readiness_hang_secs=self.next_start_readiness_hang_secs,
        )
        self.next_start_never_ready = False
        self.next_start_readiness_hang_secs = 0.0
        self.standby_servers[container_name] = server
        return f"http://127.0.0.1:{server.port}"

    def reap(self, container_name: str) -> None:
        server = self.standby_servers.pop(container_name, None)
        if server is not None:
            server.stop()

    def logs(self, container_name: str) -> str:
        """Stand-in for a real container's captured stdout/stderr (see
        ``DockerDriver.logs``). Deterministic per container name (rather than
        empty) so tests can assert it actually lands in ``Run.log`` at
        reap/teardown time.
        """
        return f"stub container log for {container_name}\n"

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


def make_settings(
    tmp_path: Path,
    standby_idle_override_secs: float | None = None,
    standby_ready_timeout_secs: float = 5.0,
    apify_proxy_password: str = "",
) -> Settings:
    # Unit tests default to a short readiness-wait bound (production is 30s)
    # so a deliberately-never-ready fake standby server (see
    # ``FakeStandbyServer``/``next_start_never_ready``) fails fast in tests
    # instead of stalling them.
    return Settings(
        data_dir=tmp_path,
        host_data_dir=tmp_path,
        port_api=3333,
        port_console=3000,
        standby_idle_override_secs=standby_idle_override_secs,
        standby_ready_timeout_secs=standby_ready_timeout_secs,
        apify_proxy_password=apify_proxy_password,
    )


async def _wire(tmp_path, driver, settings=None):
    settings = settings or make_settings(tmp_path)
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
    # No-op if a test never started it (create_app's lifespan, which normally
    # starts it, does not run under ASGITransport) -- harmless safety net so a
    # standby-watchdog test never leaks a background task past teardown.
    await service.stop_standby_watchdog()
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


@pytest_asyncio.fixture
async def wired_fast_standby(tmp_path):
    """Like ``wired`` but with a near-instant standby idle timeout and a short
    readiness-wait bound, for deterministic idle-reap and never-ready tests
    (criteria that would otherwise need multi-second/minute real waits).
    """
    settings = make_settings(tmp_path, standby_idle_override_secs=0.2, standby_ready_timeout_secs=1.0)
    async for pair in _wire(tmp_path, StubDriver(), settings=settings):
        yield pair


@pytest_asyncio.fixture
async def wired_with_proxy_password(tmp_path):
    """Like ``wired`` but with ``Settings.apify_proxy_password`` set, for
    asserting ``APIFY_PROXY_PASSWORD`` reaches the Actor container env (see
    ``Service._build_environment``)."""
    settings = make_settings(tmp_path, apify_proxy_password="dummy-proxy-password")
    async for pair in _wire(tmp_path, StubDriver(), settings=settings):
        yield pair

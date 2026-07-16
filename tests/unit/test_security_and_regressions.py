"""Security and correctness regression tests: path traversal, symlink-following
storage-import disclosure, run/build terminal-status integrity, memory-limit
forwarding, binary KV round-tripping, malformed-body handling, and console
XSS-safety.

Each test reproduces a specific bug and would fail against the pre-fix code.
All run without a Docker daemon, using the ``wired`` fixture (in-process app +
StubDriver) or a small service built on the same Docker-free driver pattern.
"""
from __future__ import annotations

import threading

import pytest

from app.config import Settings
from app.db import Database
from app.driver import BuildResult, RunResult, SourceFileNameError, write_source_files
from app.service import Service
from app.storage import Storage


class _OkDriver:
    """Minimal Docker-free driver whose build/run always succeed."""

    def build(self, build_dir, image_tag, log_sink=None) -> BuildResult:
        return BuildResult(True, "built\n")

    def stop(self, container_name) -> None:
        pass

    def remove_image(self, image_tag) -> None:
        pass

    def run(self, image_tag, host_storage_dir, environment, timeout_secs,
            container_name=None, mem_limit_mb=None, log_sink=None) -> RunResult:
        return RunResult(0, "ok\n")


def _settings(tmp_path) -> Settings:
    return Settings(data_dir=tmp_path, host_data_dir=tmp_path, port_api=3333, port_console=3000)


async def _make_service(tmp_path, driver) -> tuple[Service, Storage, Database]:
    settings = _settings(tmp_path)
    settings.runs_dir.mkdir(parents=True, exist_ok=True)
    settings.builds_dir.mkdir(parents=True, exist_ok=True)
    db = Database(settings.meta_db_url)
    await db.create_all()
    storage = Storage(settings.storage_db_url)
    await storage.start()
    return Service(settings, db, storage, driver), storage, db


# -- Blocker #1: path traversal in write_source_files ---------------------
def test_write_source_files_rejects_parent_traversal(tmp_path):
    dest = tmp_path / "build"
    with pytest.raises(SourceFileNameError):
        write_source_files(
            [{"name": "../../escape.py", "format": "TEXT", "content": "x = 1\n"}], dest
        )
    assert not (tmp_path / "escape.py").exists()


def test_write_source_files_rejects_absolute_path(tmp_path):
    dest = tmp_path / "build"
    target = tmp_path / "pwned.py"
    with pytest.raises(SourceFileNameError):
        write_source_files(
            [{"name": str(target), "format": "TEXT", "content": "evil\n"}], dest
        )
    assert not target.exists()


def test_write_source_files_accepts_nested_relative_name(tmp_path):
    dest = tmp_path / "build"
    write_source_files([{"name": "src/main.py", "format": "TEXT", "content": "ok\n"}], dest)
    assert (dest / "src" / "main.py").read_text() == "ok\n"


# -- Major #2: symlink-following disclosure in import_run_storage ---------
async def test_import_run_storage_ignores_symlink(tmp_path):
    settings = _settings(tmp_path)
    storage = Storage(settings.storage_db_url)
    await storage.start()
    try:
        secret = tmp_path / "secret.txt"
        secret.write_text("TOP SECRET RUNTIME SOURCE")

        run_dir = tmp_path / "storage"
        kv = run_dir / "key_value_stores" / "default"
        kv.mkdir(parents=True)
        (run_dir / "datasets" / "default").mkdir(parents=True)
        (run_dir / "request_queues" / "default").mkdir(parents=True)
        # Malicious Actor plants a symlink pointing outside the storage dir.
        (kv / "leak.txt").symlink_to(secret)

        await storage.import_run_storage(run_dir, "kvS", "dsS", "rqS")

        # The symlinked file must NOT have been imported as a record.
        assert await storage.kv_record("kvS", "leak") is None
        keys = await storage.kv_keys("kvS")
        assert keys == []
    finally:
        await storage.stop()


# -- Major #2 (reopened): symlinked DIRECTORY bypass in import_run_storage -
# The earlier fix only rejected symlinked leaf *files*. A malicious Actor
# (RW on the bind-mounted storage) can instead replace an intermediate directory
# (``default``, ``key_value_stores``, or the storage root) with a symlink to an
# arbitrary location; every regular file under the target then passed the old
# per-file check. These tests would import the target's files against the old
# per-file-only check and import nothing once the directory-chain check
# guards every ancestor too.
async def test_import_ignores_symlinked_default_directory(tmp_path):
    storage = Storage(_settings(tmp_path).storage_db_url)
    await storage.start()
    try:
        secret = tmp_path / "secret"
        secret.mkdir()
        (secret / "stolen.json").write_text('{"leaked": true}')

        run_dir = tmp_path / "storage"
        (run_dir / "key_value_stores").mkdir(parents=True)
        (run_dir / "datasets" / "default").mkdir(parents=True)
        (run_dir / "request_queues" / "default").mkdir(parents=True)
        # Swap the KV `default` directory for a symlink pointing outside the run.
        (run_dir / "key_value_stores" / "default").symlink_to(secret, target_is_directory=True)

        await storage.import_run_storage(run_dir, "kvS", "dsS", "rqS")

        assert await storage.kv_keys("kvS") == []
        assert await storage.kv_record("kvS", "stolen") is None
    finally:
        await storage.stop()


async def test_import_ignores_symlinked_parent_directory(tmp_path):
    storage = Storage(_settings(tmp_path).storage_db_url)
    await storage.start()
    try:
        secret = tmp_path / "secret_ds"
        (secret / "default").mkdir(parents=True)
        (secret / "default" / "item.json").write_text('{"leaked": true}')

        run_dir = tmp_path / "storage"
        (run_dir / "key_value_stores" / "default").mkdir(parents=True)
        (run_dir / "request_queues" / "default").mkdir(parents=True)
        # Swap the whole `datasets` directory for a symlink to attacker content.
        (run_dir / "datasets").symlink_to(secret, target_is_directory=True)

        await storage.import_run_storage(run_dir, "kvS", "dsS", "rqS")

        assert (await storage.dataset_items("dsS"))["items"] == []
    finally:
        await storage.stop()


async def test_import_uses_captured_trusted_root(tmp_path):
    """With an explicit captured anchor, a swapped directory imports nothing."""
    import os

    storage = Storage(_settings(tmp_path).storage_db_url)
    await storage.start()
    try:
        secret = tmp_path / "secret2"
        secret.mkdir()
        (secret / "creds.txt").write_text("api-key")

        run_dir = tmp_path / "storage"
        (run_dir / "key_value_stores").mkdir(parents=True)
        (run_dir / "datasets" / "default").mkdir(parents=True)
        (run_dir / "request_queues" / "default").mkdir(parents=True)
        trusted_root = os.path.realpath(run_dir)  # captured before the "Actor" runs
        (run_dir / "key_value_stores" / "default").symlink_to(secret, target_is_directory=True)

        await storage.import_run_storage(run_dir, "kvS", "dsS", "rqS", trusted_root=trusted_root)

        assert await storage.kv_keys("kvS") == []
    finally:
        await storage.stop()


# -- Major #3: abort_run yields a terminal ABORTED not later clobbered ----
class _BlockingDriver:
    """Build succeeds; run blocks until ``stop`` is called (as if killed)."""

    def __init__(self) -> None:
        self.released = threading.Event()
        self.stopped = False

    def build(self, build_dir, image_tag, log_sink=None) -> BuildResult:
        return BuildResult(True, "built\n")

    def stop(self, container_name) -> None:
        self.stopped = True
        self.released.set()

    def remove_image(self, image_tag) -> None:
        pass

    def run(self, image_tag, host_storage_dir, environment, timeout_secs,
            container_name=None, mem_limit_mb=None, log_sink=None) -> RunResult:
        # Simulate a long-running container that only exits when killed.
        self.released.wait(timeout=10)
        return RunResult(0, "would-have-succeeded\n")  # natural exit code 0


async def test_abort_run_is_terminal_and_not_overwritten(tmp_path):
    driver = _BlockingDriver()
    svc, storage, db = await _make_service(tmp_path, driver)
    try:
        actor = await svc.create_actor("abortme", {}, [{"versionNumber": "0.0"}])
        build = await svc.start_build(actor.id, "0.0", "latest")
        await svc.wait_idle()
        assert (await svc.get_build(build.id)).status == "SUCCEEDED"

        run = await svc.start_run(actor.id, {"x": 1}, {"timeoutSecs": 30})
        aborted = await svc.abort_run(run.id)
        assert aborted.status == "ABORTED"
        assert driver.stopped is True  # the container was actually stopped

        await svc.wait_idle()  # let the (now unblocked) run task finish
        final = await svc.get_run(run.id)
        # Natural finish (exit 0) must NOT clobber the ABORTED status.
        assert final.status == "ABORTED"
    finally:
        driver.released.set()
        await storage.stop()
        await db.dispose()


# -- Major #4: memoryMbytes forwarded to the driver -----------------------
class _CapturingDriver:
    def __init__(self) -> None:
        self.run_kwargs: dict = {}

    def build(self, build_dir, image_tag, log_sink=None) -> BuildResult:
        return BuildResult(True, "built\n")

    def stop(self, container_name) -> None:
        pass

    def remove_image(self, image_tag) -> None:
        pass

    def run(self, image_tag, host_storage_dir, environment, timeout_secs,
            container_name=None, mem_limit_mb=None, log_sink=None) -> RunResult:
        self.run_kwargs = {
            "container_name": container_name,
            "mem_limit_mb": mem_limit_mb,
            "timeout_secs": timeout_secs,
        }
        return RunResult(0, "ok\n")


async def test_memory_limit_forwarded_to_driver(tmp_path):
    driver = _CapturingDriver()
    svc, storage, db = await _make_service(tmp_path, driver)
    try:
        actor = await svc.create_actor("memcap", {}, [{"versionNumber": "0.0"}])
        await svc.start_build(actor.id, "0.0", "latest")
        await svc.wait_idle()
        run = await svc.start_run(actor.id, {}, {"memoryMbytes": 256, "timeoutSecs": 30})
        await svc.wait_idle()
        assert driver.run_kwargs["mem_limit_mb"] == 256
        assert driver.run_kwargs["container_name"] == svc._container_name(run.id)
    finally:
        await storage.stop()
        await db.dispose()


# -- Major #5: binary KV records round-trip unchanged ---------------------
async def test_binary_kv_record_roundtrips(wired):
    client, _ = wired
    png = bytes([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x01, 0xFF, 0xFE, 0x80])
    put = await client.put(
        "/v2/key-value-stores/kvbin/records/shot.png",
        content=png,
        headers={"content-type": "image/png"},
    )
    assert put.status_code == 200
    got = await client.get("/v2/key-value-stores/kvbin/records/shot.png")
    assert got.status_code == 200
    assert got.content == png  # bytes unchanged, not UTF-8 mangled


# -- Minor #6: malformed bodies return 4xx not 500 ------------------------
async def test_malformed_json_body_returns_4xx(wired):
    client, _ = wired
    resp = await client.post(
        "/v2/acts",
        content=b"{not valid json",
        headers={"content-type": "application/json"},
    )
    assert resp.status_code == 400


async def test_bad_gzip_body_returns_4xx(wired):
    client, _ = wired
    resp = await client.post(
        "/v2/acts",
        content=b"this is not gzip",
        headers={"content-type": "application/json", "content-encoding": "gzip"},
    )
    assert resp.status_code == 400


# -- Minor #7: PUT /v2/acts/{id} actually applies the payload -------------
async def test_update_actor_applies_payload(wired):
    client, _ = wired
    await client.post("/v2/acts", json={"name": "updatable"})
    resp = await client.put(
        "/v2/acts/local-user~updatable",
        json={"defaultRunOptions": {"timeoutSecs": 42, "memoryMbytes": 512}},
    )
    assert resp.status_code == 200
    actor = resp.json()["data"]
    assert actor["defaultRunOptions"]["timeoutSecs"] == 42
    # Persisted, not just echoed.
    again = (await client.get("/v2/acts/local-user~updatable")).json()["data"]
    assert again["defaultRunOptions"]["timeoutSecs"] == 42


# -- Minor #8: a failing build reaches FAILED, never stuck RUNNING --------
async def test_build_with_illegal_source_name_reaches_failed(tmp_path):
    svc, storage, db = await _make_service(tmp_path, _OkDriver())
    try:
        actor = await svc.create_actor(
            "badsrc",
            {},
            [{"versionNumber": "0.0",
              "sourceFiles": [{"name": "../evil.py", "format": "TEXT", "content": "x\n"}]}],
        )
        build = await svc.start_build(actor.id, "0.0", "latest")
        await svc.wait_idle()
        final = await svc.get_build(build.id)
        assert final.status == "FAILED"  # not stuck at RUNNING
        assert final.finished_at is not None
    finally:
        await storage.stop()
        await db.dispose()


# -- Minor #9: startup reconciliation sweeps stale RUNNING rows -----------
async def test_reconcile_sweeps_stale_running_jobs(tmp_path):
    svc, storage, db = await _make_service(tmp_path, _OkDriver())
    try:
        from app.db import Build, Run

        async with db.session() as s:
            s.add(Build(id="b-stale", actor_id="a", version_number="0.0",
                        build_number="0.0.1", status="RUNNING", image_tag="t"))
            s.add(Run(id="r-stale", actor_id="a", build_id="b-stale", build_number="0.0.1",
                      status="RUNNING", kv_store_id="k", dataset_id="d", request_queue_id="q"))
            await s.commit()

        await svc.reconcile_stale_jobs()

        assert (await svc.get_build("b-stale")).status == "FAILED"
        assert (await svc.get_run("r-stale")).status == "ABORTED"
    finally:
        await storage.stop()
        await db.dispose()


# -- Nit #14: a real timeout produces TIMED-OUT, not FAILED ---------------
class _TimeoutDriver:
    def build(self, build_dir, image_tag, log_sink=None) -> BuildResult:
        return BuildResult(True, "built\n")

    def stop(self, container_name) -> None:
        pass

    def remove_image(self, image_tag) -> None:
        pass

    def run(self, image_tag, host_storage_dir, environment, timeout_secs,
            container_name=None, mem_limit_mb=None, log_sink=None) -> RunResult:
        return RunResult(-1, "timed out\n", timed_out=True)


async def test_timeout_sets_timed_out_status(tmp_path):
    svc, storage, db = await _make_service(tmp_path, _TimeoutDriver())
    try:
        actor = await svc.create_actor("slow", {}, [{"versionNumber": "0.0"}])
        await svc.start_build(actor.id, "0.0", "latest")
        await svc.wait_idle()
        run = await svc.start_run(actor.id, {}, {"timeoutSecs": 1})
        await svc.wait_idle()
        assert (await svc.get_run(run.id)).status == "TIMED-OUT"
    finally:
        await storage.stop()
        await db.dispose()


# -- Minor #3: bad run-start query params return 400, not a bare 500 ------
async def test_run_start_non_integer_query_param_returns_400(wired):
    client, _ = wired
    await client.post("/v2/acts", json={"name": "qp", "versions": [{"versionNumber": "0.0"}]})
    for qs in ("memory=abc", "timeout=abc", "waitForFinish=abc"):
        resp = await client.post(f"/v2/acts/local-user~qp/runs?{qs}")
        assert resp.status_code == 400, f"{qs} -> {resp.status_code}"


# -- Nit #5: non-positive memory is rejected, never a silent uncapped run --
async def test_run_start_zero_or_negative_memory_returns_400(wired):
    client, _ = wired
    await client.post("/v2/acts", json={"name": "memz", "versions": [{"versionNumber": "0.0"}]})
    for qs in ("memory=0", "memory=-1"):
        resp = await client.post(f"/v2/acts/local-user~memz/runs?{qs}")
        assert resp.status_code == 400, f"{qs} -> {resp.status_code}"


# -- Major #2 (console XSS): no untrusted string reaches an inline handler -
# A headless browser is out of scope for this suite (documented in claim.md), so
# validate structurally: the served console JS must not build inline event-handler
# attributes at all - behaviour is attached with addEventListener over closures,
# so no interpolated string is ever HTML-decoded back into an inline JS handler.
async def test_console_has_no_inline_event_handlers(wired):
    client, _ = wired
    app_js = (await client.get("/console/app.js")).text
    index = (await client.get("/")).text
    for src, label in ((app_js, "app.js"), (index, "index.html")):
        for handler in ("onclick=", "onload=", "onerror=", "onmouseover="):
            assert handler not in src.lower(), f"{label} contains inline {handler}"
    # Positive check: behaviour is wired with addEventListener.
    assert "addEventListener" in app_js


@pytest.mark.asyncio
async def test_prepare_run_storage_is_world_writable(wired):
    """Per-run storage dirs must be writable by a non-root Actor container user.

    Regression: the runtime runs as root and created these dirs 0755, so a real
    Apify Actor image (which runs as a non-root user, e.g. uid 1000) could not
    write to the bind-mounted /apify_storage and crashed on first write with
    PermissionError. The dirs must be world-writable so any container user can
    write; INPUT.json must stay world-readable so the Actor can read its input.
    """
    _client, service = wired
    storage_dir, _trusted_root = service._prepare_run_storage("perm-test-run", {"greeting": "hi"})

    for sub in ("key_value_stores/default", "datasets/default", "request_queues/default"):
        d = storage_dir / sub
        mode = d.stat().st_mode & 0o777
        assert mode & 0o002, f"{sub} is not world-writable (mode {oct(mode)})"
    # The whole tree (including nested created dirs) must be writable by others.
    for path in storage_dir.rglob("*"):
        if path.is_dir():
            assert path.stat().st_mode & 0o002, f"{path} not world-writable"
    # Input stays readable by the (non-root) Actor.
    assert (storage_dir / "key_value_stores/default/INPUT.json").stat().st_mode & 0o004

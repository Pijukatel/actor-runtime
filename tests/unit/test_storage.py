"""Unit tests for the crawlee-SQL-backed storage layer (no Docker, no HTTP)."""
from __future__ import annotations

import json

from app.storage import Storage


async def test_kv_dataset_rq_roundtrip(tmp_path):
    storage = Storage(f"sqlite+aiosqlite:///{tmp_path / 'storage.db'}")
    await storage.start()
    try:
        await storage.kv_set("kv1", "OUTPUT", {"a": 1}, "application/json")
        keys = await storage.kv_keys("kv1")
        assert any(k["key"] == "OUTPUT" for k in keys)
        value, ct = await storage.kv_record("kv1", "OUTPUT")
        assert value == {"a": 1} and "json" in ct

        await storage.dataset_push("ds1", [{"x": 1}, {"x": 2}])
        page = await storage.dataset_items("ds1")
        assert page["total"] == 2 and page["items"][0]["x"] == 1

        await storage.rq_add("rq1", [{"url": "https://example.com/a"}])
        meta = await storage.rq_metadata("rq1")
        assert meta["totalRequestCount"] == 1
        reqs = await storage.rq_requests("rq1")
        assert reqs[0]["url"] == "https://example.com/a"
    finally:
        await storage.stop()


async def test_import_run_storage(tmp_path):
    storage = Storage(f"sqlite+aiosqlite:///{tmp_path / 'storage.db'}")
    await storage.start()
    try:
        run_dir = tmp_path / "storage"
        for kind in ("key_value_stores", "datasets", "request_queues"):
            (run_dir / kind / "default").mkdir(parents=True)
        (run_dir / "key_value_stores" / "default" / "OUTPUT.json").write_text(json.dumps({"ok": True}))
        (run_dir / "datasets" / "default" / "000000001.json").write_text(json.dumps({"i": 1}))
        (run_dir / "request_queues" / "default" / "r1.json").write_text(
            json.dumps({"url": "https://example.com/x", "uniqueKey": "u1"})
        )

        await storage.import_run_storage(run_dir, "kvX", "dsX", "rqX")

        value, _ = await storage.kv_record("kvX", "OUTPUT")
        assert value == {"ok": True}
        assert (await storage.dataset_items("dsX"))["items"] == [{"i": 1}]
        reqs = await storage.rq_requests("rqX")
        assert reqs[0]["url"] == "https://example.com/x"
    finally:
        await storage.stop()


async def test_import_run_storage_isolates_binary_kv_record(tmp_path):
    """A binary KV record must not crash the whole import.

    Reproduces the reviewer's failure scenario: an Actor writes a binary KV file
    (a PNG screenshot) alongside a dataset item and a queued request. Against the
    old ``path.read_text()`` code, decoding the PNG bytes as UTF-8 raises
    ``UnicodeDecodeError`` which propagates out of ``import_run_storage`` and
    aborts the entire import - the dataset item and queued request are silently
    lost too, even though only the KV file was bad.

    This test fails (red) against the pre-fix code and passes (green) after
    ``import_run_storage`` reads KV files as bytes with per-file isolation.
    """
    storage = Storage(f"sqlite+aiosqlite:///{tmp_path / 'storage.db'}")
    await storage.start()
    try:
        run_dir = tmp_path / "storage"
        for kind in ("key_value_stores", "datasets", "request_queues"):
            (run_dir / kind / "default").mkdir(parents=True)

        # Non-UTF-8 bytes (PNG magic header) - raises UnicodeDecodeError under
        # `.read_text()`.
        png_bytes = b"\x89PNG\r\n\x1a\n" + bytes(range(256))
        (run_dir / "key_value_stores" / "default" / "shot.png").write_bytes(png_bytes)
        (run_dir / "key_value_stores" / "default" / "OUTPUT.json").write_text(json.dumps({"ok": True}))
        (run_dir / "datasets" / "default" / "000000001.json").write_text(json.dumps({"i": 1}))
        (run_dir / "request_queues" / "default" / "r1.json").write_text(
            json.dumps({"url": "https://example.com/x", "uniqueKey": "u1"})
        )

        # Must not raise, despite the binary KV record.
        await storage.import_run_storage(run_dir, "kvBin", "dsBin", "rqBin")

        # The binary record round-trips as raw bytes, unchanged.
        value, content_type = await storage.kv_record("kvBin", "shot")
        assert value == png_bytes
        assert content_type == "image/png"

        # The other KV record, dataset item and queued request all still made it
        # in - one bad file did not wipe out the rest of the import.
        json_value, _ = await storage.kv_record("kvBin", "OUTPUT")
        assert json_value == {"ok": True}
        assert (await storage.dataset_items("dsBin"))["items"] == [{"i": 1}]
        reqs = await storage.rq_requests("rqBin")
        assert reqs[0]["url"] == "https://example.com/x"
    finally:
        await storage.stop()

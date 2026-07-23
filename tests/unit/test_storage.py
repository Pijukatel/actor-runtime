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

    Scenario: an Actor writes a binary KV file (a PNG screenshot) alongside a
    dataset item and a queued request. Against the old ``path.read_text()``
    code, decoding the PNG bytes as UTF-8 raises ``UnicodeDecodeError`` which
    propagates out of ``import_run_storage`` and aborts the entire import -
    the dataset item and queued request are silently lost too, even though
    only the KV file was bad.

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


async def test_rq_requests_returns_wire_standard_shape_with_handled_at(tmp_path):
    """``Storage.rq_requests`` (backing ``GET /request-queues/{id}/requests``)
    must return the same wire-standard per-request shape every other
    per-request route in this module returns (via ``_row_dict``) -- not the
    old ad hoc ``{id, url, uniqueKey, method, handled: bool}`` subset.

    This directly locks the defect the real ``apify`` SDK hits: its
    ``ApifyRequestQueueSingleClient._init_caches()`` calls this exact route
    and classifies each returned item by feeding it straight through
    ``crawlee.Request.model_validate(item)`` -- ``was_already_handled`` is a
    computed property reading ``handled_at is not None``. ``apify.Request``
    IS ``crawlee.Request`` (no subclass), so validating through the real,
    installed ``crawlee.Request`` model here reproduces the SDK's own
    classification exactly, not a re-implementation of it.

    Fails (red) against the pre-fix ``{..., handled: bool}`` shape: it has no
    ``handledAt`` key, so ``handled_at`` always parses ``None`` and the
    already-handled request below would classify as
    ``was_already_handled=False``. Passes (green) once ``rq_requests``
    returns ``_row_dict``'s wire shape (including ``handledAt``).
    """
    from crawlee import Request

    from app.storage import _request_id_for

    storage = Storage(f"sqlite+aiosqlite:///{tmp_path / 'storage.db'}")
    await storage.start()
    try:
        await storage.rq_add_batch(
            "rq1",
            [
                {"url": "https://example.com/pending", "uniqueKey": "https://example.com/pending"},
                {"url": "https://example.com/done", "uniqueKey": "https://example.com/done"},
            ],
        )
        done_id = _request_id_for("https://example.com/done")
        await storage.rq_update_request(
            "rq1",
            done_id,
            {
                "url": "https://example.com/done",
                "uniqueKey": "https://example.com/done",
                "handledAt": "2026-01-01T00:00:00.000Z",
            },
        )

        items = await storage.rq_requests("rq1")
        assert len(items) == 2
        by_key = {i["uniqueKey"]: i for i in items}

        # Wire-standard shape: every per-request field _row_dict produces,
        # not just id/url/uniqueKey/method.
        for item in items:
            for key in (
                "id",
                "url",
                "uniqueKey",
                "method",
                "retryCount",
                "noRetry",
                "loadedUrl",
                "handledAt",
                "headers",
                "userData",
                "payload",
            ):
                assert key in item, f"missing {key!r} in {item!r}"
            assert "handled" not in item  # old ad hoc key is gone, not merely additive

        pending_item = by_key["https://example.com/pending"]
        done_item = by_key["https://example.com/done"]
        assert not pending_item["handledAt"]
        assert done_item["handledAt"]

        # Exact reproduction of the real SDK's own classification.
        pending_request = Request.model_validate(pending_item)
        done_request = Request.model_validate(done_item)
        assert pending_request.was_already_handled is False
        assert done_request.was_already_handled is True
    finally:
        await storage.stop()


async def test_rq_update_request_preserves_caller_supplied_handled_at(tmp_path):
    """A PUT that marks a request handled must persist the caller's own
    ``handledAt`` timestamp, not silently substitute the server's own call
    time. The real ``apify`` SDK's ``mark_request_as_handled`` always PUTs
    its own exact ``handledAt`` on the full request dict.

    Fails (red) against the pre-fix code: ``_rq_request_kwargs`` never
    forwarded ``handledAt``, so the ``Request`` built in ``rq_update_request``
    always had ``handled_at=None``; crawlee's own
    ``SqlRequestQueueClient.mark_request_as_handled`` fills in
    ``datetime.now(timezone.utc)`` whenever ``handled_at is None``, so the
    read-back value would be a just-now timestamp, not the given one below
    (from 2020). Passes (green) once ``_rq_request_kwargs`` threads
    ``handledAt`` through.
    """
    from datetime import datetime

    from app.storage import _request_id_for

    storage = Storage(f"sqlite+aiosqlite:///{tmp_path / 'storage.db'}")
    await storage.start()
    try:
        await storage.rq_add_batch(
            "rq1", [{"url": "https://example.com/exact", "uniqueKey": "https://example.com/exact"}]
        )
        request_id = _request_id_for("https://example.com/exact")
        given_handled_at = "2020-01-01T00:00:00.000000Z"
        await storage.rq_update_request(
            "rq1",
            request_id,
            {
                "url": "https://example.com/exact",
                "uniqueKey": "https://example.com/exact",
                "handledAt": given_handled_at,
            },
        )

        found = await storage.rq_get_request("rq1", request_id)
        assert found is not None
        assert datetime.fromisoformat(found["handledAt"]) == datetime.fromisoformat(given_handled_at)
    finally:
        await storage.stop()


async def test_rq_update_request_forefront_false_reclaim_releases_lock(tmp_path):
    """A PUT with the default ``forefront=False`` is what a real Actor's SDK
    sends every time it requeues a request after a processing failure
    (``request_queue.reclaim_request(request)``, called through
    ``ApifyRequestQueueSharedClient``/``ApifyRequestQueueSingleClient`` in the
    real ``apify`` package). It must actually release the request's lock, not
    silently no-op just because ``forefront`` is falsy.
    """
    storage = Storage(f"sqlite+aiosqlite:///{tmp_path / 'storage.db'}")
    await storage.start()
    try:
        await storage.rq_add_batch(
            "rq1", [{"url": "https://example.com/a", "uniqueKey": "https://example.com/a"}]
        )

        # Lock it, exactly like a real consumer's `fetch_next_request` does
        # (`rq_head_and_lock`, backing `POST .../head/lock`).
        locked = await storage.rq_head_and_lock("rq1", limit=10, lock_secs=180)
        assert len(locked["items"]) == 1
        request_id = locked["items"][0]["id"]

        # A real reclaim PUTs back exactly the body the lock/head read
        # returned -- no `handledAt`, default `forefront=False`.
        body = locked["items"][0]
        result = await storage.rq_update_request("rq1", request_id, body, forefront=False)
        assert result is not None
        assert result["wasAlreadyPresent"] is True

        # The request must be fetchable again -- not still locked for the
        # rest of its (180s) TTL. Fails (red) against the pre-fix code, whose
        # `elif forefront and was_already_present:` branch never runs for
        # `forefront=False`, leaving `time_blocked_until` untouched; passes
        # (green) once the reclaim call runs unconditionally for an existing,
        # not-yet-handled request.
        head = await storage.rq_head("rq1")
        assert len(head["items"]) == 1
        assert head["items"][0]["id"] == request_id

        head_lock = await storage.rq_head_and_lock("rq1", limit=10, lock_secs=60)
        assert len(head_lock["items"]) == 1
        assert head_lock["items"][0]["id"] == request_id
    finally:
        await storage.stop()

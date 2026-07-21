"""Request-queue HTTP surface: the full client route set (head, head/lock,
per-request GET/PUT/DELETE, per-request lock PUT/DELETE, batch add/delete,
requests/unlock) on top of the create/get/list/single-add routes, plus the
per-request field round-trips (headers/payload/userData/retryCount/noRetry/
loadedUrl/handledAt) and the head/lock and unlock-all regressions those
routes depend on.

All Docker-free via the ``wired`` fixture (in-process app + StubDriver, see
tests/conftest.py).
"""
from __future__ import annotations


async def test_request_queue_full_surface(wired):
    """Exercises every request-queue route the design adds (head, head/lock,
    per-request GET/PUT/DELETE, per-request lock PUT/DELETE, batch add/delete,
    requests/unlock) on top of the pre-existing create/get/list/single-add
    surface. None of the four sample-actor fixtures exercise these routes
    (they only add-and-forget through the single/batch add path) -- this is
    the sole coverage for the fuller client surface apify-client 3.1.0's
    ``RequestQueueClient``/``RequestQueueClientAsync`` expose.
    """
    client, _service = wired
    rq = (await client.post("/v2/request-queues", json={"name": "full-surface"})).json()["data"]
    rq_id = rq["id"]

    # Batch add: two new requests.
    add = (
        await client.post(
            f"/v2/request-queues/{rq_id}/requests/batch",
            json=[
                {"url": "https://example.com/a", "uniqueKey": "https://example.com/a"},
                {"url": "https://example.com/b", "uniqueKey": "https://example.com/b"},
            ],
        )
    ).json()["data"]
    assert len(add["processedRequests"]) == 2
    assert add["unprocessedRequests"] == []
    req_a_id = next(p["requestId"] for p in add["processedRequests"] if p["uniqueKey"] == "https://example.com/a")
    req_b_id = next(p["requestId"] for p in add["processedRequests"] if p["uniqueKey"] == "https://example.com/b")

    # Re-adding the same uniqueKey is reported as already present.
    redo = (
        await client.post(
            f"/v2/request-queues/{rq_id}/requests/batch",
            json=[{"url": "https://example.com/a", "uniqueKey": "https://example.com/a"}],
        )
    ).json()["data"]
    assert redo["processedRequests"][0]["wasAlreadyPresent"] is True

    # head: both unhandled requests come back, unlocked.
    head = (await client.get(f"/v2/request-queues/{rq_id}/head")).json()["data"]
    assert {i["uniqueKey"] for i in head["items"]} == {"https://example.com/a", "https://example.com/b"}
    assert "queueModifiedAt" in head and "hadMultipleClients" in head

    # head/lock: locks what it returns; a second call excludes the now-locked ones.
    locked = (await client.post(f"/v2/request-queues/{rq_id}/head/lock?lockSecs=60")).json()["data"]
    assert len(locked["items"]) == 2
    assert locked["queueHasLockedRequests"] is True
    # Regression: a second call with nothing NEW to lock must still report
    # `queueHasLockedRequests: True`, since both requests locked by the prior
    # call are still within their lock window. The buggy formula
    # (`len(available) > len(to_lock)`) compared unlocked-inventory-vs-limit
    # instead of locked-vs-total, and happened to agree with the correct
    # value whenever `to_lock` was non-empty -- exactly why this same test's
    # first `head/lock` call above could never catch it. `apify`'s own shared
    # request-queue client's `is_finished` (`len(head.items) == 0 and not
    # queue_has_locked_requests`) consumes this flag directly, so a
    # false-`False` here would make a multi-consumer crawl conclude it's
    # finished while another consumer still holds locked work.
    still_locked = (await client.post(f"/v2/request-queues/{rq_id}/head/lock?lockSecs=60")).json()["data"]
    assert still_locked["items"] == []
    assert still_locked["queueHasLockedRequests"] is True

    # Per-request GET; unknown id -> 404.
    got = (await client.get(f"/v2/request-queues/{rq_id}/requests/{req_a_id}")).json()["data"]
    assert got["url"] == "https://example.com/a"
    assert (await client.get(f"/v2/request-queues/{rq_id}/requests/doesnotexist")).status_code == 404

    # Per-request lock prolong, then release.
    lock = (await client.put(f"/v2/request-queues/{rq_id}/requests/{req_a_id}/lock?lockSecs=30")).json()["data"]
    assert "lockExpiresAt" in lock
    assert (await client.delete(f"/v2/request-queues/{rq_id}/requests/{req_a_id}/lock")).status_code == 200

    # Unlock-all frees every remaining lock (from head/lock above).
    unlock_all = (await client.post(f"/v2/request-queues/{rq_id}/requests/unlock")).json()["data"]
    assert unlock_all["unlockedCount"] >= 1
    freed = (await client.post(f"/v2/request-queues/{rq_id}/head/lock?lockSecs=60")).json()["data"]
    assert len(freed["items"]) == 2

    # PUT marks a request handled; the queue metadata reflects it.
    update = (
        await client.put(
            f"/v2/request-queues/{rq_id}/requests/{req_a_id}",
            json={
                "url": "https://example.com/a",
                "uniqueKey": "https://example.com/a",
                "handledAt": "2026-01-01T00:00:00.000Z",
            },
        )
    ).json()["data"]
    assert update["wasAlreadyHandled"] is False
    meta_after_handle = (await client.get(f"/v2/request-queues/{rq_id}")).json()["data"]
    assert meta_after_handle["handledRequestCount"] == 1
    assert meta_after_handle["totalRequestCount"] == 2
    assert meta_after_handle["pendingRequestCount"] == 1

    # DELETE a single request: the aggregate counts on the queue's own GET
    # must drop along with it, not just the per-request GET going 404. A
    # raw-SQL row delete that bypasses crawlee's own metadata bookkeeping
    # would leave totalRequestCount/pendingRequestCount permanently inflated.
    assert (await client.delete(f"/v2/request-queues/{rq_id}/requests/{req_b_id}")).status_code == 200
    assert (await client.get(f"/v2/request-queues/{rq_id}/requests/{req_b_id}")).status_code == 404
    meta_after_delete = (await client.get(f"/v2/request-queues/{rq_id}")).json()["data"]
    assert meta_after_delete["totalRequestCount"] == 1
    assert meta_after_delete["pendingRequestCount"] == 0
    assert meta_after_delete["handledRequestCount"] == 1

    # Batch delete: same aggregate-metadata requirement as single delete.
    more = (
        await client.post(
            f"/v2/request-queues/{rq_id}/requests/batch",
            json=[{"url": "https://example.com/c", "uniqueKey": "https://example.com/c"}],
        )
    ).json()["data"]
    req_c_id = more["processedRequests"][0]["requestId"]
    meta_after_add_c = (await client.get(f"/v2/request-queues/{rq_id}")).json()["data"]
    assert meta_after_add_c["totalRequestCount"] == 2
    assert meta_after_add_c["pendingRequestCount"] == 1
    batch_del = (
        await client.request(
            "DELETE", f"/v2/request-queues/{rq_id}/requests/batch", json=[{"id": req_c_id}]
        )
    ).json()["data"]
    assert any(p["requestId"] == req_c_id for p in batch_del["processedRequests"])
    assert (await client.get(f"/v2/request-queues/{rq_id}/requests/{req_c_id}")).status_code == 404
    meta_after_batch_delete = (await client.get(f"/v2/request-queues/{rq_id}")).json()["data"]
    assert meta_after_batch_delete["totalRequestCount"] == 1
    assert meta_after_batch_delete["pendingRequestCount"] == 0
    assert meta_after_batch_delete["handledRequestCount"] == 1


async def test_rq_head_lock_reports_locked_requests_from_a_prior_call(wired):
    """Isolated regression for the ``queueHasLockedRequests`` bug: a queue with
    exactly one request, locked by an earlier ``head/lock`` call and nothing
    left to lock, must still report ``queueHasLockedRequests: True`` on a
    later call. Before the fix, ``rq_head_and_lock`` compared "unlocked
    inventory left over the limit" (``len(available) > len(to_lock)``)
    instead of "any locked request exists" (``len(rows) > len(available) or
    bool(to_lock)``) -- the two formulas coincide whenever something IS newly
    locked (``to_lock`` non-empty), which is why a same-call assertion never
    caught it; they diverge exactly in this already-fully-locked case.
    """
    client, _service = wired
    rq = (await client.post("/v2/request-queues", json={"name": "lock-carryover"})).json()["data"]
    rq_id = rq["id"]
    await client.post(
        f"/v2/request-queues/{rq_id}/requests/batch",
        json=[{"url": "https://example.com/only", "uniqueKey": "https://example.com/only"}],
    )

    first = (await client.post(f"/v2/request-queues/{rq_id}/head/lock?lockSecs=60")).json()["data"]
    assert len(first["items"]) == 1
    assert first["queueHasLockedRequests"] is True

    second = (await client.post(f"/v2/request-queues/{rq_id}/head/lock?lockSecs=60")).json()["data"]
    assert second["items"] == []
    assert second["queueHasLockedRequests"] is True


async def test_rq_unlock_all_counts_only_previously_locked_rows(wired):
    """``unlockedCount`` must count only rows whose lock was actually cleared,
    not every row in the queue. Before the fix, ``rq_unlock_all``'s ``UPDATE``
    had no ``time_blocked_until IS NOT NULL`` filter, so ``rowcount`` counted
    every unhandled+handled row regardless of lock state.
    """
    client, _service = wired
    rq = (await client.post("/v2/request-queues", json={"name": "unlock-count"})).json()["data"]
    rq_id = rq["id"]
    await client.post(
        f"/v2/request-queues/{rq_id}/requests/batch",
        json=[
            {"url": "https://example.com/locked", "uniqueKey": "https://example.com/locked"},
            {"url": "https://example.com/unlocked", "uniqueKey": "https://example.com/unlocked"},
        ],
    )
    # Lock only one of the two requests (per-request lock, not head/lock, so
    # exactly one row ends up with a non-null time_blocked_until).
    locked_id = next(
        p["id"]
        for p in (
            await client.get(f"/v2/request-queues/{rq_id}/requests")
        ).json()["data"]["items"]
        if p["uniqueKey"] == "https://example.com/locked"
    )
    await client.put(f"/v2/request-queues/{rq_id}/requests/{locked_id}/lock?lockSecs=60")

    unlock_all = (await client.post(f"/v2/request-queues/{rq_id}/requests/unlock")).json()["data"]
    assert unlock_all["unlockedCount"] == 1


async def test_rq_unlock_all_does_not_count_already_expired_locks(wired):
    """``unlockedCount`` must count only rows whose *active* lock was cleared
    by this call, not a row whose lock had already expired before the call.
    Nothing proactively nulls ``time_blocked_until`` on expiry (``rq_head``/
    ``rq_head_and_lock`` merely treat an expired-lock row as available again),
    so a stale row still has a non-null ``time_blocked_until`` at call time --
    before the fix, ``rq_unlock_all``'s ``UPDATE`` only filtered
    ``IS NOT NULL``, so that stale row was counted as "unlocked by this call"
    even though it was already effectively unlocked beforehand.
    """
    client, _service = wired
    rq = (await client.post("/v2/request-queues", json={"name": "unlock-expired"})).json()["data"]
    rq_id = rq["id"]
    await client.post(
        f"/v2/request-queues/{rq_id}/requests/batch",
        json=[
            {"url": "https://example.com/stale", "uniqueKey": "https://example.com/stale"},
            {"url": "https://example.com/active", "uniqueKey": "https://example.com/active"},
        ],
    )
    items = (await client.get(f"/v2/request-queues/{rq_id}/requests")).json()["data"]["items"]
    stale_id = next(p["id"] for p in items if p["uniqueKey"] == "https://example.com/stale")
    active_id = next(p["id"] for p in items if p["uniqueKey"] == "https://example.com/active")

    # A negative lockSecs deterministically puts `time_blocked_until` in the
    # past (no sleep/timing dependency needed) -- an already-expired lock,
    # column still non-null.
    await client.put(f"/v2/request-queues/{rq_id}/requests/{stale_id}/lock?lockSecs=-10")
    # Genuinely active at call time.
    await client.put(f"/v2/request-queues/{rq_id}/requests/{active_id}/lock?lockSecs=60")

    unlock_all = (await client.post(f"/v2/request-queues/{rq_id}/requests/unlock")).json()["data"]
    assert unlock_all["unlockedCount"] == 1


# -- RQ request round-trip: headers/payload/userData/retryCount/noRetry/loadedUrl --
#
# `rq_add_batch`/`rq_update_request` (`app/storage.py`) build every stored
# request as `Request.from_url(...)`. Every field a real Actor's SDK actually
# sets on a request -- not just `url`/`method`/`uniqueKey` -- must be
# forwarded, or it silently vanishes on write: without `headers=`/`payload=`/
# `user_data=`/`retry_count=`/`no_retry=`/`loaded_url=` passed through,
# read-back would show `userData: {"__crawlee": {}}` (crawlee's own
# bookkeeping key, never the caller's data), `headers: {}`, `payload: null`,
# `retryCount: 0`, `noRetry: false`, `loadedUrl: null`, regardless of what
# was actually sent.


async def test_rq_add_single_round_trips_headers_payload_user_data(wired):
    """The single-add route (``POST .../requests``, backed by ``rq_add_batch``
    with a one-element list) must preserve caller-supplied ``headers``/
    ``payload``/``userData``/``retryCount``/``noRetry``/``loadedUrl`` -- not
    just ``url``/``method``/``uniqueKey``.
    """
    client, _service = wired
    rq = (await client.post("/v2/request-queues", params={"name": "rq-single-fields"})).json()["data"]
    rq_id = rq["id"]

    added = (
        await client.post(
            f"/v2/request-queues/{rq_id}/requests",
            json={
                "url": "https://example.com/single",
                "uniqueKey": "https://example.com/single",
                "headers": {"x-custom": "1"},
                "payload": "some-payload",
                "userData": {"foo": "bar", "label": "DETAIL"},
                "retryCount": 2,
                "noRetry": True,
                "loadedUrl": "https://example.com/single-redirected",
            },
        )
    ).json()["data"]
    request_id = added["requestId"]

    got = (await client.get(f"/v2/request-queues/{rq_id}/requests/{request_id}")).json()["data"]
    assert got["headers"] == {"x-custom": "1"}
    assert got["payload"] == "some-payload"
    assert got["userData"]["foo"] == "bar"
    assert got["userData"]["label"] == "DETAIL"
    assert got["retryCount"] == 2
    assert got["noRetry"] is True
    assert got["loadedUrl"] == "https://example.com/single-redirected"


async def test_rq_add_batch_round_trips_headers_payload_user_data(wired):
    """Batch add (``POST .../requests/batch``) must preserve per-request
    ``headers``/``payload``/``userData``/``retryCount``/``noRetry``/
    ``loadedUrl`` for every request in the batch, not just the first/only one.
    """
    client, _service = wired
    rq = (await client.post("/v2/request-queues", params={"name": "rq-batch-fields"})).json()["data"]
    rq_id = rq["id"]

    add = (
        await client.post(
            f"/v2/request-queues/{rq_id}/requests/batch",
            json=[
                {
                    "url": "https://example.com/batch-a",
                    "uniqueKey": "https://example.com/batch-a",
                    "headers": {"x-a": "1"},
                    "payload": "payload-a",
                    "userData": {"which": "a"},
                    "retryCount": 1,
                    "noRetry": False,
                    "loadedUrl": "https://example.com/batch-a-redirected",
                },
                {
                    "url": "https://example.com/batch-b",
                    "uniqueKey": "https://example.com/batch-b",
                    "headers": {"x-b": "2"},
                    "payload": "payload-b",
                    "userData": {"which": "b"},
                    "retryCount": 3,
                    "noRetry": True,
                },
            ],
        )
    ).json()["data"]
    by_key = {p["uniqueKey"]: p["requestId"] for p in add["processedRequests"]}

    got_a = (
        await client.get(f"/v2/request-queues/{rq_id}/requests/{by_key['https://example.com/batch-a']}")
    ).json()["data"]
    got_b = (
        await client.get(f"/v2/request-queues/{rq_id}/requests/{by_key['https://example.com/batch-b']}")
    ).json()["data"]
    assert got_a["headers"] == {"x-a": "1"}
    assert got_a["payload"] == "payload-a"
    assert got_a["userData"]["which"] == "a"
    assert got_a["retryCount"] == 1
    assert got_a["noRetry"] is False
    assert got_a["loadedUrl"] == "https://example.com/batch-a-redirected"
    assert got_b["headers"] == {"x-b": "2"}
    assert got_b["payload"] == "payload-b"
    assert got_b["userData"]["which"] == "b"
    assert got_b["retryCount"] == 3
    assert got_b["noRetry"] is True


async def test_rq_update_round_trips_headers_payload_user_data(wired):
    """PUT (``rq_update_request``) must preserve ``headers``/``payload``/
    ``userData``/``retryCount``/``noRetry``/``loadedUrl`` both when it
    upserts a brand-new request (no existing row) and when it updates an
    existing one via the ``handledAt`` (mark-handled) branch -- the two
    branches that actually persist ``req`` to storage.
    """
    from app.storage import _request_id_for

    client, _service = wired
    rq = (await client.post("/v2/request-queues", params={"name": "rq-update-fields"})).json()["data"]
    rq_id = rq["id"]

    # Upsert branch: request_id has no existing row yet. A real caller (the
    # apify SDK) always computes the URL's `request_id` as the SHA-256-based
    # hash of `uniqueKey` (`unique_key_to_request_id`, mirrored here by
    # `_request_id_for` -- see `app/storage.py`'s docstring), since that hash
    # is also what a later GET/lock/delete addresses the same request by.
    new_unique_key = "https://example.com/put-new"
    upsert_id = _request_id_for(new_unique_key)
    put_new = (
        await client.put(
            f"/v2/request-queues/{rq_id}/requests/{upsert_id}",
            json={
                "url": "https://example.com/put-new",
                "uniqueKey": new_unique_key,
                "headers": {"x-new": "n"},
                "payload": "payload-new",
                "userData": {"which": "new"},
                "retryCount": 1,
                "noRetry": False,
                "loadedUrl": "https://example.com/put-new-redirected",
            },
        )
    ).json()["data"]
    assert put_new["wasAlreadyPresent"] is False
    got_new = (await client.get(f"/v2/request-queues/{rq_id}/requests/{upsert_id}")).json()["data"]
    assert got_new["headers"] == {"x-new": "n"}
    assert got_new["payload"] == "payload-new"
    assert got_new["userData"]["which"] == "new"
    assert got_new["retryCount"] == 1
    assert got_new["noRetry"] is False
    assert got_new["loadedUrl"] == "https://example.com/put-new-redirected"

    # Mark-handled branch: an existing (added-via-batch) request, updated via
    # PUT with `handledAt` set and different headers/payload/userData -- this
    # is the branch `apify`'s own `mark_request_as_handled` drives, always
    # sending the FULL current request dict.
    add = (
        await client.post(
            f"/v2/request-queues/{rq_id}/requests/batch",
            json=[{"url": "https://example.com/put-handle", "uniqueKey": "https://example.com/put-handle"}],
        )
    ).json()["data"]
    handle_id = add["processedRequests"][0]["requestId"]
    put_handled = (
        await client.put(
            f"/v2/request-queues/{rq_id}/requests/{handle_id}",
            json={
                "url": "https://example.com/put-handle",
                "uniqueKey": "https://example.com/put-handle",
                "handledAt": "2026-01-01T00:00:00.000Z",
                "headers": {"x-handled": "h"},
                "payload": "payload-handled",
                "userData": {"which": "handled"},
                "retryCount": 2,
                "noRetry": True,
                "loadedUrl": "https://example.com/put-handle-redirected",
            },
        )
    ).json()["data"]
    assert put_handled["wasAlreadyPresent"] is True
    got_handled = (await client.get(f"/v2/request-queues/{rq_id}/requests/{handle_id}")).json()["data"]
    assert got_handled["headers"] == {"x-handled": "h"}
    assert got_handled["payload"] == "payload-handled"
    assert got_handled["userData"]["which"] == "handled"
    assert got_handled["retryCount"] == 2
    assert got_handled["noRetry"] is True
    assert got_handled["loadedUrl"] == "https://example.com/put-handle-redirected"


async def test_rq_update_forefront_false_reclaim_releases_lock(wired):
    """The real SDK's ``request_queue.reclaim_request(request)`` -- the
    standard way any crawlee/apify-based Actor requeues a request after a
    processing failure -- issues exactly this HTTP call: lock a request via
    ``head/lock``, then PUT it straight back with the default
    ``forefront=False`` and no ``handledAt``. That PUT must actually release
    the lock so the request is fetchable again; reporting
    ``wasAlreadyPresent: true`` while leaving the request locked for the rest
    of its TTL would silently strand it (this is what apify-client's
    ``update_request(request, forefront=forefront)`` sends: the full request
    dict as JSON body, ``forefront`` as a query param defaulting to falsy).
    """
    client, _service = wired
    rq = (await client.post("/v2/request-queues", params={"name": "rq-reclaim"})).json()["data"]
    rq_id = rq["id"]
    await client.post(
        f"/v2/request-queues/{rq_id}/requests",
        json={"url": "https://example.com/reclaim", "uniqueKey": "https://example.com/reclaim"},
    )

    locked = (await client.post(f"/v2/request-queues/{rq_id}/head/lock", params={"lockSecs": 180})).json()["data"]
    assert len(locked["items"]) == 1
    request_id = locked["items"][0]["id"]
    body = locked["items"][0]

    # No `handledAt`, default `forefront=False` -- exactly the reclaim-after-
    # failure call pattern.
    put = await client.put(f"/v2/request-queues/{rq_id}/requests/{request_id}", json=body)
    assert put.status_code == 200
    assert put.json()["data"]["wasAlreadyPresent"] is True

    # The request must be fetchable again -- not still locked for the rest
    # of its (180s) TTL.
    head = (await client.get(f"/v2/request-queues/{rq_id}/head")).json()["data"]
    assert len(head["items"]) == 1
    assert head["items"][0]["id"] == request_id


async def test_rq_list_requests_returns_wire_standard_shape_and_handled_at(wired):
    """``GET /request-queues/{id}/requests`` (the plain list route, not the
    per-request ``GET .../requests/{id}``) must return the same
    wire-standard per-request shape as every other per-request route --
    including ``handledAt`` -- not the old ad hoc
    ``{id, url, uniqueKey, method, handled: bool}`` subset.

    The real ``apify`` SDK's ``ApifyRequestQueueSingleClient._init_caches()``
    calls exactly this route (``list_requests(limit=10_000)``) on the first
    ``add_requests`` against a request queue that already has rows in it, and
    classifies each item purely from ``handledAt`` (via
    ``crawlee.Request.model_validate(item).was_already_handled``). Fails
    (red) against the pre-fix shape, which has no ``handledAt`` key at all;
    passes (green) once the list route returns ``_row_dict``'s wire shape.
    """
    from app.storage import _request_id_for

    client, _service = wired
    rq = (await client.post("/v2/request-queues", params={"name": "rq-list-shape"})).json()["data"]
    rq_id = rq["id"]

    await client.post(
        f"/v2/request-queues/{rq_id}/requests",
        json={"url": "https://example.com/list-pending", "uniqueKey": "https://example.com/list-pending"},
    )
    handled_key = "https://example.com/list-handled"
    handled_id = _request_id_for(handled_key)
    await client.put(
        f"/v2/request-queues/{rq_id}/requests/{handled_id}",
        json={"url": handled_key, "uniqueKey": handled_key, "handledAt": "2026-02-02T00:00:00.000Z"},
    )

    items = (await client.get(f"/v2/request-queues/{rq_id}/requests")).json()["data"]["items"]
    assert len(items) == 2
    by_key = {i["uniqueKey"]: i for i in items}
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

    assert not by_key["https://example.com/list-pending"]["handledAt"]
    assert by_key[handled_key]["handledAt"]


async def test_rq_update_preserves_caller_supplied_handled_at(wired):
    """A PUT that marks a request handled must persist the caller's own
    ``handledAt`` timestamp, not silently substitute the server's own call
    time. Real Actor SDKs (``mark_request_as_handled``) always PUT their own
    exact ``handledAt`` on the full request dict, and this runtime's sibling
    fields (headers/payload/userData/retryCount/noRetry/loadedUrl) already
    get this exact round-trip fidelity on the same call path.

    Fails (red) against the pre-fix code -- ``_rq_request_kwargs`` never
    forwarded ``handledAt``, so crawlee's own
    ``SqlRequestQueueClient.mark_request_as_handled`` filled in its own
    ``datetime.now(timezone.utc)`` instead (since it only substitutes when
    ``request.handled_at is None``); the read-back value would be a just-now
    timestamp, not the year-2020 one given below. Passes (green) once
    ``_rq_request_kwargs`` threads ``handledAt`` through.
    """
    client, _service = wired
    rq = (await client.post("/v2/request-queues", params={"name": "rq-handled-at-fidelity"})).json()["data"]
    rq_id = rq["id"]

    add = (
        await client.post(
            f"/v2/request-queues/{rq_id}/requests/batch",
            json=[
                {
                    "url": "https://example.com/exact-handled-at",
                    "uniqueKey": "https://example.com/exact-handled-at",
                }
            ],
        )
    ).json()["data"]
    request_id = add["processedRequests"][0]["requestId"]

    given_handled_at = "2020-01-01T00:00:00.000000Z"
    await client.put(
        f"/v2/request-queues/{rq_id}/requests/{request_id}",
        json={
            "url": "https://example.com/exact-handled-at",
            "uniqueKey": "https://example.com/exact-handled-at",
            "handledAt": given_handled_at,
        },
    )

    got = (await client.get(f"/v2/request-queues/{rq_id}/requests/{request_id}")).json()["data"]
    from datetime import datetime

    assert datetime.fromisoformat(got["handledAt"]) == datetime.fromisoformat(given_handled_at)


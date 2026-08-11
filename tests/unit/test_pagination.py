"""Optional `limit`/`offset` pagination for the four listing surfaces (dataset
items, KV keys, RQ requests, per-user storage lists): a bare request (neither
param supplied) stays byte-for-byte identical to today's unpaginated shape --
the contract every non-console (CLI/SDK/curl) caller keeps relying on; supplying
`limit`/`offset` returns the corresponding slice plus enough total-count
information to page. KV keys additionally accept an `exclusiveStartKey`
cursor with a truthful `isTruncated`/`nextExclusiveStartKey` (see the
"KV keys" section below). See requirements/api.md's "Pagination" section.
"""
from __future__ import annotations

import json


def auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


async def _create_user(client, name):
    await client.post("/v2/users", json={"name": name})


# -------------------------------------------------------------- dataset items


async def test_dataset_items_bare_request_is_unpaginated_bare_array(wired):
    client, service = wired
    await _create_user(client, "ann")
    created = await client.post("/v2/datasets", json={"name": "big"}, headers=auth("ann"))
    ds_id = created.json()["data"]["id"]
    await service.storage.dataset_push(ds_id, [{"i": i} for i in range(150)])

    resp = await client.get(f"/v2/datasets/{ds_id}/items", headers=auth("ann"))
    assert resp.status_code == 200
    body = resp.json()
    assert isinstance(body, list)
    assert len(body) == 150
    assert body[0] == {"i": 0} and body[-1] == {"i": 149}
    # No new headers at all when the caller never asked to page.
    assert not any(k.lower().startswith("x-apify-pagination") for k in resp.headers)
    # Byte-for-byte, not just parsed-equal: a bare request must reproduce the
    # exact wire body (item key order included), the literal thing
    # requirements/api.md's "byte-for-byte identical" promise -- and success
    # criterion 15's own "capture, re-run, diff" verification -- means.
    assert resp.text == json.dumps([{"i": i} for i in range(150)], separators=(",", ":"))


async def test_dataset_items_limit_offset_returns_slice_and_headers(wired):
    client, service = wired
    await _create_user(client, "ann2")
    created = await client.post("/v2/datasets", json={"name": "big2"}, headers=auth("ann2"))
    ds_id = created.json()["data"]["id"]
    await service.storage.dataset_push(ds_id, [{"i": i} for i in range(150)])

    resp = await client.get(f"/v2/datasets/{ds_id}/items?limit=20&offset=100", headers=auth("ann2"))
    assert resp.status_code == 200
    body = resp.json()
    assert isinstance(body, list)
    assert len(body) == 20
    assert body[0] == {"i": 100} and body[-1] == {"i": 119}
    assert resp.headers["X-Apify-Pagination-Offset"] == "100"
    assert resp.headers["X-Apify-Pagination-Count"] == "20"
    assert resp.headers["X-Apify-Pagination-Total"] == "150"
    assert resp.headers["X-Apify-Pagination-Limit"] == "20"


async def test_dataset_items_offset_only_keeps_no_limit_semantics(wired):
    """Supplying only `offset` (no `limit`) still counts as "params given" (the
    paginated branch), but the effective limit stays "no cap" -- matching the
    real API's own `dataset-items-get` documented default. `-Limit` must
    therefore echo the actual returned count (5), never the internal
    `DEFAULT_ITEM_LIMIT` sentinel (999999) the storage layer applies under
    the hood for "no cap"."""
    client, service = wired
    await _create_user(client, "ann3")
    created = await client.post("/v2/datasets", json={"name": "big3"}, headers=auth("ann3"))
    ds_id = created.json()["data"]["id"]
    await service.storage.dataset_push(ds_id, [{"i": i} for i in range(30)])

    resp = await client.get(f"/v2/datasets/{ds_id}/items?offset=25", headers=auth("ann3"))
    assert resp.status_code == 200
    body = resp.json()
    assert len(body) == 5
    assert body[0] == {"i": 25} and body[-1] == {"i": 29}
    assert resp.headers["X-Apify-Pagination-Offset"] == "25"
    assert resp.headers["X-Apify-Pagination-Total"] == "30"
    assert resp.headers["X-Apify-Pagination-Count"] == "5"
    assert resp.headers["X-Apify-Pagination-Limit"] == "5"


async def test_dataset_items_limit_only_slices_from_start(wired):
    """`limit` without `offset` was previously untested for this surface (only
    "offset-only" and "both supplied" were exercised) -- unlike the KV-keys
    equivalent, exercises `paginate()`'s `items[start:start+limit]` branch
    with `start == 0` via the default, not an explicit `offset=0`."""
    client, service = wired
    await _create_user(client, "ann4")
    created = await client.post("/v2/datasets", json={"name": "big4"}, headers=auth("ann4"))
    ds_id = created.json()["data"]["id"]
    await service.storage.dataset_push(ds_id, [{"i": i} for i in range(30)])

    resp = await client.get(f"/v2/datasets/{ds_id}/items?limit=5", headers=auth("ann4"))
    assert resp.status_code == 200
    body = resp.json()
    assert len(body) == 5
    assert body[0] == {"i": 0} and body[-1] == {"i": 4}
    assert resp.headers["X-Apify-Pagination-Offset"] == "0"
    assert resp.headers["X-Apify-Pagination-Count"] == "5"
    assert resp.headers["X-Apify-Pagination-Total"] == "30"
    assert resp.headers["X-Apify-Pagination-Limit"] == "5"


async def test_dataset_items_pagination_headers_are_cors_exposed(wired):
    """Regression: CORSMiddleware (app/main.py) shipped with no
    `expose_headers`, so a cross-origin browser caller could see the four
    `X-Apify-Pagination-*` headers on the wire but never read them from JS --
    the browser hides any response header not explicitly exposed -- silently
    forcing such a caller back onto `items.length` to page. The shipped
    console itself is same-origin and unaffected; this is about any OTHER
    browser-based caller of this permissive (`allow_origins=["*"]`) API."""
    client, _service = wired
    await _create_user(client, "cors")
    created = await client.post("/v2/datasets", json={"name": "d"}, headers=auth("cors"))
    ds_id = created.json()["data"]["id"]

    resp = await client.get(
        f"/v2/datasets/{ds_id}/items?limit=5",
        headers={**auth("cors"), "Origin": "https://example.com"},
    )
    assert resp.status_code == 200
    exposed = resp.headers.get("access-control-expose-headers", "").lower()
    for header in (
        "x-apify-pagination-offset",
        "x-apify-pagination-count",
        "x-apify-pagination-total",
        "x-apify-pagination-limit",
    ):
        assert header in exposed


async def test_dataset_items_negative_limit_is_bad_request(wired):
    client, _service = wired
    await _create_user(client, "neg")
    created = await client.post("/v2/datasets", json={"name": "d"}, headers=auth("neg"))
    ds_id = created.json()["data"]["id"]
    resp = await client.get(f"/v2/datasets/{ds_id}/items?limit=-1", headers=auth("neg"))
    assert resp.status_code == 400


async def test_dataset_items_non_integer_limit_is_bad_request(wired):
    """`_parse_int`'s `except (TypeError, ValueError)` branch, reached via
    `parse_page`'s `optional()` closure, was previously only exercised by
    `runs.py`'s pre-existing `memoryMbytes`/`timeoutSecs` validation -- never
    by any of the four new listing surfaces this branch now also guards.
    `int("abc")` raises `ValueError`, so this must be `400` -- in the bare
    FastAPI `{"detail": ...}` shape `_parse_int` itself raises, not this
    app's own error envelope (see requirements/api.md's Pagination section
    for why)."""
    client, _service = wired
    await _create_user(client, "nonint")
    created = await client.post("/v2/datasets", json={"name": "d"}, headers=auth("nonint"))
    ds_id = created.json()["data"]["id"]
    resp = await client.get(f"/v2/datasets/{ds_id}/items?limit=abc", headers=auth("nonint"))
    assert resp.status_code == 400
    assert resp.json()["detail"] == "Query parameter 'limit' must be an integer."


async def test_dataset_items_non_integer_offset_is_bad_request(wired):
    """Same branch as above, exercised via `offset` instead of `limit`, and
    with a value that looks numeric but isn't an integer (`int("1.5")` also
    raises `ValueError` -- Python's `int()` never parses a float from a
    string) -- a caller passing a float string must get the same `400`, not a
    silently-truncated/ignored offset."""
    client, _service = wired
    await _create_user(client, "nonint2")
    created = await client.post("/v2/datasets", json={"name": "d"}, headers=auth("nonint2"))
    ds_id = created.json()["data"]["id"]
    resp = await client.get(f"/v2/datasets/{ds_id}/items?offset=1.5", headers=auth("nonint2"))
    assert resp.status_code == 400
    assert resp.json()["detail"] == "Query parameter 'offset' must be an integer."


async def test_dataset_items_empty_string_params_are_treated_as_absent(wired):
    """An empty `?limit=&offset=` (an explicit but blank query value) must be
    treated identically to omitting the params entirely -- the same
    unpaginated bare-array response, byte-for-byte, not a `400` from trying
    to parse `""` as an integer."""
    client, service = wired
    await _create_user(client, "es")
    created = await client.post("/v2/datasets", json={"name": "big"}, headers=auth("es"))
    ds_id = created.json()["data"]["id"]
    await service.storage.dataset_push(ds_id, [{"i": i} for i in range(150)])

    bare = await client.get(f"/v2/datasets/{ds_id}/items", headers=auth("es"))
    empty = await client.get(f"/v2/datasets/{ds_id}/items?limit=&offset=", headers=auth("es"))

    assert empty.status_code == 200
    assert empty.json() == bare.json()
    assert len(empty.json()) == 150
    # Empty-string params land on the identical unpaginated branch as no
    # params at all -- no pagination headers appear either.
    assert not any(k.lower().startswith("x-apify-pagination") for k in empty.headers)


# -------------------------------------------------------------------- KV keys


async def _seed_keys(client, store_id: str, token: str, count: int) -> None:
    for i in range(count):
        await client.put(
            f"/v2/key-value-stores/{store_id}/records/k{i:04d}",
            content=json.dumps({"v": i}),
            headers={**auth(token), "content-type": "application/json"},
        )


async def _seed_keys_fast(service, store_id: str, count: int) -> None:
    """Same key naming/content as `_seed_keys`, but written directly against
    ONE reused crawlee KVS client (no per-key HTTP round trip, and no
    per-key `create_kvs_client()` -- that call itself hits the DB to
    find-or-create the store row) -- for tests that need a store larger than
    the pinned `apify-client`'s 1000-key paging chunk, where `count`
    individual `Storage.kv_set()` calls (each opening its own client) made
    this noticeably slower without testing anything `_seed_keys` doesn't
    already cover."""
    kv = await service.storage._client.create_kvs_client(name=store_id)
    for i in range(count):
        await kv.set_value(key=f"k{i:04d}", value={"v": i}, content_type="application/json")


async def test_kv_keys_bare_request_is_unpaginated_and_unchanged(wired):
    client, _service = wired
    await _create_user(client, "kate")
    created = await client.post("/v2/key-value-stores", json={"name": "big"}, headers=auth("kate"))
    store_id = created.json()["data"]["id"]
    await _seed_keys(client, store_id, "kate", 120)

    resp = await client.get(f"/v2/key-value-stores/{store_id}/keys", headers=auth("kate"))
    assert resp.status_code == 200
    body = resp.json()["data"]
    # Order-sensitive (not `set(body.keys())`, which is blind to a reorder):
    # this is the exact key order the surface had before optional pagination
    # existed, and no additive `total`.
    assert list(body.keys()) == ["items", "count", "limit", "isTruncated"]
    assert body["count"] == 120
    assert body["limit"] == 120
    assert body["isTruncated"] is False
    assert len(body["items"]) == 120


async def test_kv_keys_limit_offset_returns_slice_with_total(wired):
    """`offset`-mode paging (no `exclusiveStartKey`): `isTruncated` is now
    computed truthfully here too (`offset + limit < total`), even though this
    is this runtime's own console-only mechanism with no cursor to hand back
    -- there is deliberately no `nextExclusiveStartKey` on this branch."""
    client, _service = wired
    await _create_user(client, "kate2")
    created = await client.post("/v2/key-value-stores", json={"name": "big2"}, headers=auth("kate2"))
    store_id = created.json()["data"]["id"]
    await _seed_keys(client, store_id, "kate2", 120)

    resp = await client.get(
        f"/v2/key-value-stores/{store_id}/keys?limit=10&offset=100", headers=auth("kate2")
    )
    assert resp.status_code == 200
    body = resp.json()["data"]
    assert body["count"] == 10
    assert body["limit"] == 10
    assert body["total"] == 120
    assert len(body["items"]) == 10
    assert body["isTruncated"] is True
    assert "nextExclusiveStartKey" not in body


async def test_kv_keys_limit_only_slices_from_start(wired):
    """`limit` alone (no `offset`, no `exclusiveStartKey`) takes the
    cursor-pushdown path (see `app/storage.py::kv_keys_page`): a truncating
    `limit` must report a truthful `isTruncated`/`nextExclusiveStartKey`, not
    the previously-hardcoded `isTruncated: false` -- this is exactly the
    shape the pinned `apify-client`'s `iterate_keys()` sends on its first
    page of any store larger than its chunk size."""
    client, _service = wired
    await _create_user(client, "kate3")
    created = await client.post("/v2/key-value-stores", json={"name": "big3"}, headers=auth("kate3"))
    store_id = created.json()["data"]["id"]
    await _seed_keys(client, store_id, "kate3", 30)

    resp = await client.get(f"/v2/key-value-stores/{store_id}/keys?limit=5", headers=auth("kate3"))
    body = resp.json()["data"]
    assert body["count"] == 5
    assert body["total"] == 30
    assert body["isTruncated"] is True
    assert body["nextExclusiveStartKey"] == "k0004"
    assert [item["key"] for item in body["items"]] == ["k0000", "k0001", "k0002", "k0003", "k0004"]


async def test_kv_keys_limit_without_truncation_is_not_truncated(wired):
    """A `limit` at or beyond the store's key count truncates nothing:
    `isTruncated: false` and no `nextExclusiveStartKey` -- the direct
    counterpart of the truncating case above, on the same cursor-pushdown
    path."""
    client, _service = wired
    await _create_user(client, "kate3b")
    created = await client.post("/v2/key-value-stores", json={"name": "big3b"}, headers=auth("kate3b"))
    store_id = created.json()["data"]["id"]
    await _seed_keys(client, store_id, "kate3b", 5)

    resp = await client.get(f"/v2/key-value-stores/{store_id}/keys?limit=10", headers=auth("kate3b"))
    body = resp.json()["data"]
    assert body["count"] == 5
    assert body["total"] == 5
    assert body["isTruncated"] is False
    assert "nextExclusiveStartKey" not in body


async def test_kv_keys_offset_only_keeps_no_limit_semantics(wired):
    """Supplying only `offset` (no `limit`) still counts as "params given" (the
    paginated branch, gains the additive `total`), but the effective limit
    stays "no cap" -- exercising `paginate`'s `items[start:]` branch, not just
    `items[start:start+limit]`. No `limit` means nothing was truncated."""
    client, _service = wired
    await _create_user(client, "kate4")
    created = await client.post("/v2/key-value-stores", json={"name": "big4"}, headers=auth("kate4"))
    store_id = created.json()["data"]["id"]
    await _seed_keys(client, store_id, "kate4", 10)

    resp = await client.get(f"/v2/key-value-stores/{store_id}/keys?offset=7", headers=auth("kate4"))
    assert resp.status_code == 200
    body = resp.json()["data"]
    assert body["count"] == 3
    assert body["total"] == 10
    assert len(body["items"]) == 3
    assert body["isTruncated"] is False


async def test_kv_keys_cursor_cycle_enumerates_every_key_exactly_once(wired):
    """Criterion 25: a curl-style `limit` + `exclusiveStartKey` cycle over a
    store bigger than `limit` must visit every key exactly once, reporting
    `isTruncated`/`nextExclusiveStartKey` correctly at each step (true+cursor
    on every page but the last, false+no-cursor on the last)."""
    client, _service = wired
    await _create_user(client, "cyclist")
    created = await client.post("/v2/key-value-stores", json={"name": "cyc"}, headers=auth("cyclist"))
    store_id = created.json()["data"]["id"]
    total = 47
    limit = 10
    await _seed_keys(client, store_id, "cyclist", total)
    expected = [f"k{i:04d}" for i in range(total)]

    seen: list[str] = []
    cursor = None
    pages = 0
    while True:
        qs = f"limit={limit}" + (f"&exclusiveStartKey={cursor}" if cursor else "")
        resp = await client.get(f"/v2/key-value-stores/{store_id}/keys?{qs}", headers=auth("cyclist"))
        assert resp.status_code == 200
        body = resp.json()["data"]
        pages += 1
        seen.extend(item["key"] for item in body["items"])
        cursor = body.get("nextExclusiveStartKey")
        if not body["items"] or cursor is None:
            assert body["isTruncated"] is False
            break
        assert body["isTruncated"] is True
        assert pages < 20  # sanity bound against an infinite loop on a bug

    assert seen == expected  # every key, in order, no skip, no repeat
    assert pages == 5  # 47 keys / limit 10 -> 4 full pages + 1 remainder page


async def test_kv_keys_exclusive_start_key_with_offset_cursor_wins(wired):
    """`exclusiveStartKey` combined with `offset`: the real API's KV-keys
    endpoint has no `offset` concept, so this runtime treats the cursor as
    authoritative and ignores `offset` entirely -- the response must be
    identical to the same request with `offset` omitted."""
    client, _service = wired
    await _create_user(client, "combo")
    created = await client.post("/v2/key-value-stores", json={"name": "combo"}, headers=auth("combo"))
    store_id = created.json()["data"]["id"]
    await _seed_keys(client, store_id, "combo", 20)

    cursor_only = await client.get(
        f"/v2/key-value-stores/{store_id}/keys?exclusiveStartKey=k0004&limit=5", headers=auth("combo")
    )
    cursor_with_offset = await client.get(
        f"/v2/key-value-stores/{store_id}/keys?exclusiveStartKey=k0004&limit=5&offset=15",
        headers=auth("combo"),
    )
    assert cursor_only.status_code == cursor_with_offset.status_code == 200
    assert cursor_only.json() == cursor_with_offset.json()
    body = cursor_only.json()["data"]
    assert [item["key"] for item in body["items"]] == ["k0005", "k0006", "k0007", "k0008", "k0009"]


async def test_kv_keys_iterate_keys_apify_client_paging_loop_over_1000_keys(wired):
    """Criterion 26: the pinned `apify-client`'s `iterate_keys()`
    (`requirements-dev.txt` pins 3.1.0) pages KV keys via
    `get_cursor_iterator_async` -- see
    `.venv/lib/*/site-packages/apify_client/_pagination.py` -- which, with no
    caller-supplied overall `limit`, requests `limit=1000` (its
    `DEFAULT_CHUNK_SIZE`) per call and follows each page's
    `nextExclusiveStartKey` as the next call's `exclusiveStartKey` until one
    comes back `None`. That version's HTTP transport is `impit`, a
    non-httpx binding with no ASGI-transport hook, so it cannot be pointed at
    this suite's in-process `wired` fixture (see requirements/test.md); this
    test instead reproduces that exact request/loop shape directly against
    `wired` -- same per-call `limit`, same cursor field, same stop condition
    -- against a store bigger than the 1000-key chunk, and asserts every key
    comes back exactly once."""
    client, service = wired
    await _create_user(client, "chunky")
    created = await client.post("/v2/key-value-stores", json={"name": "chunky"}, headers=auth("chunky"))
    store_id = created.json()["data"]["id"]
    total = 1050
    await _seed_keys_fast(service, store_id, total)
    expected = {f"k{i:04d}" for i in range(total)}

    seen: list[str] = []
    cursor = None
    pages = 0
    while True:
        qs = "limit=1000" + (f"&exclusiveStartKey={cursor}" if cursor else "")
        resp = await client.get(f"/v2/key-value-stores/{store_id}/keys?{qs}", headers=auth("chunky"))
        assert resp.status_code == 200
        body = resp.json()["data"]
        pages += 1
        items = body["items"]
        seen.extend(item["key"] for item in items)
        cursor = body.get("nextExclusiveStartKey")
        if not items or cursor is None:
            break
        assert pages < 20  # sanity bound against an infinite loop on a bug

    assert len(seen) == len(set(seen)) == total  # exactly once, no duplicates
    assert set(seen) == expected
    assert pages == 2  # 1050 keys, chunk size 1000 -> one full page + one remainder page


# --------------------------------------------------------------- RQ requests


async def test_rq_requests_bare_request_is_unpaginated_and_unchanged(wired):
    client, service = wired
    await _create_user(client, "rick")
    created = await client.post("/v2/request-queues", json={"name": "big"}, headers=auth("rick"))
    rq_id = created.json()["data"]["id"]
    await service.storage.rq_add_batch(
        rq_id, [{"url": f"https://example.com/{i}", "uniqueKey": str(i)} for i in range(130)]
    )

    resp = await client.get(f"/v2/request-queues/{rq_id}/requests", headers=auth("rick"))
    assert resp.status_code == 200
    body = resp.json()["data"]
    # Order-sensitive (not `set(body.keys())`): this surface's bare shape
    # never had an extra field to reorder, but pin it anyway alongside the
    # other three surfaces so a future change can't quietly slip one in
    # ahead of `limit` unnoticed.
    assert list(body.keys()) == ["items", "count", "limit"]  # no additive `total`
    assert body["count"] == 130
    assert body["limit"] == 130
    assert len(body["items"]) == 130


async def test_rq_requests_limit_offset_returns_slice_with_total(wired):
    client, service = wired
    await _create_user(client, "rick2")
    created = await client.post("/v2/request-queues", json={"name": "big2"}, headers=auth("rick2"))
    rq_id = created.json()["data"]["id"]
    await service.storage.rq_add_batch(
        rq_id, [{"url": f"https://example.com/{i}", "uniqueKey": str(i)} for i in range(130)]
    )

    resp = await client.get(
        f"/v2/request-queues/{rq_id}/requests?limit=30&offset=100", headers=auth("rick2")
    )
    assert resp.status_code == 200
    body = resp.json()["data"]
    assert body["count"] == 30
    assert body["limit"] == 30
    assert body["total"] == 130
    assert len(body["items"]) == 30


# ---------------------------------------------------------- per-user listings


async def test_my_key_value_stores_bare_request_is_unpaginated_and_unchanged(wired):
    """The bare-request contract (requirements/api.md's Pagination section)
    must hold for a resource with more than 100 items/entries -- the other
    three surfaces already seed 150/120/130, so this per-user listing (the
    fourth) seeds 110 too, rather than a count small enough that the bare
    (uncapped) branch and a hypothetical accidentally-introduced 100-item cap
    would look identical."""
    client, _service = wired
    await _create_user(client, "stan")
    for i in range(110):
        await client.post("/v2/key-value-stores", json={"name": f"s{i:04d}"}, headers=auth("stan"))

    resp = await client.get("/v2/users/me/key-value-stores", headers=auth("stan"))
    assert resp.status_code == 200
    body = resp.json()["data"]
    # Order-sensitive: this is the same `total, count, items` order its
    # siblings `my_actors`/`my_builds`/`my_runs` use, unaffected by the
    # optional `limit`/`offset` this surface additionally accepts.
    assert list(body.keys()) == ["total", "count", "items"]
    assert body["total"] == 110
    assert body["count"] == 110
    assert len(body["items"]) == 110


async def test_my_key_value_stores_limit_offset_returns_slice(wired):
    client, _service = wired
    await _create_user(client, "stan2")
    for i in range(15):
        await client.post("/v2/key-value-stores", json={"name": f"s{i}"}, headers=auth("stan2"))

    resp = await client.get("/v2/users/me/key-value-stores?limit=5&offset=10", headers=auth("stan2"))
    assert resp.status_code == 200
    body = resp.json()["data"]
    assert body["total"] == 15
    assert body["count"] == 5
    assert len(body["items"]) == 5


async def test_my_datasets_and_request_queues_also_paginate(wired):
    """The other two aggregate storage listings (not just KV) get the same
    optional slice."""
    client, _service = wired
    await _create_user(client, "stan3")
    for i in range(12):
        await client.post("/v2/datasets", json={"name": f"d{i}"}, headers=auth("stan3"))
        await client.post("/v2/request-queues", json={"name": f"q{i}"}, headers=auth("stan3"))

    ds = (await client.get("/v2/users/me/datasets?limit=4&offset=8", headers=auth("stan3"))).json()["data"]
    rq = (await client.get("/v2/users/me/request-queues?limit=4&offset=8", headers=auth("stan3"))).json()["data"]
    assert ds["total"] == 12 and ds["count"] == 4 and len(ds["items"]) == 4
    assert rq["total"] == 12 and rq["count"] == 4 and len(rq["items"]) == 4

    bare_ds = (await client.get("/v2/users/me/datasets", headers=auth("stan3"))).json()["data"]
    assert bare_ds["total"] == 12 and bare_ds["count"] == 12 and len(bare_ds["items"]) == 12

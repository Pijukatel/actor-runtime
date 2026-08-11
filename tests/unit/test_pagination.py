"""Optional `limit`/`offset` pagination for the four listing surfaces (dataset
items, KV keys, RQ requests, per-user storage lists): a bare request (neither
param supplied) stays byte-for-byte identical to today's unpaginated shape --
the contract every non-console (CLI/SDK/curl) caller keeps relying on; supplying
`limit`/`offset` returns the corresponding slice plus enough total-count
information to page. See requirements/api.md's "Pagination" section.
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
    real API's own `dataset-items-get` documented default."""
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


async def test_dataset_items_negative_limit_is_bad_request(wired):
    client, _service = wired
    await _create_user(client, "neg")
    created = await client.post("/v2/datasets", json={"name": "d"}, headers=auth("neg"))
    ds_id = created.json()["data"]["id"]
    resp = await client.get(f"/v2/datasets/{ds_id}/items?limit=-1", headers=auth("neg"))
    assert resp.status_code == 400


async def test_dataset_items_non_integer_limit_is_bad_request(wired):
    """`_parse_int`'s `except (TypeError, ValueError)` branch, reached via
    `optional_bounded_int`/`parse_page`, was previously only exercised by
    `runs.py`'s pre-existing `memoryMbytes`/`timeoutSecs` validation -- never
    by any of the four new listing surfaces this branch now also guards.
    `int("abc")` raises `ValueError`, so this must be `400`. Note the actual
    shipped body here is FastAPI's own default `{"detail": ...}` shape, NOT
    the `{"error": {"type": ..., "message": ...}}` Apify envelope every other
    4xx in this app uses -- `_parse_int` raises a bare `HTTPException` with no
    handler translating it, a pre-existing quirk of this helper (shared with
    `runs.py`'s `memoryMbytes`/`timeoutSecs`), not something this diff
    introduced or is asked to fix."""
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
    """`optional_bounded_int`'s `raw == ""` arm -- an explicit-but-empty query
    value is treated identically to the key being omitted entirely, returning
    `None` rather than falling through to `_parse_int("", ...)` -- is new in
    this diff but was never exercised by any of the four listing surfaces:
    every existing test here sends either no `limit`/`offset` at all or a
    concrete value, never `?limit=&offset=`. A client that serializes empty
    query values (rather than dropping the key) must land on the exact same
    byte-for-byte unpaginated bare-array response as the true bare request --
    not a `400 Query parameter 'limit' must be an integer.`, which is what
    `int("")` raises and is exactly what you'd get if the `or raw == ""` check
    were ever dropped from `optional_bounded_int`. Red proof (verified locally
    by temporarily changing that check to `raw is None`): with the arm
    removed, this test's `empty` request 400s instead of matching `bare`."""
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


async def test_kv_keys_bare_request_is_unpaginated_and_unchanged(wired):
    client, _service = wired
    await _create_user(client, "kate")
    created = await client.post("/v2/key-value-stores", json={"name": "big"}, headers=auth("kate"))
    store_id = created.json()["data"]["id"]
    await _seed_keys(client, store_id, "kate", 120)

    resp = await client.get(f"/v2/key-value-stores/{store_id}/keys", headers=auth("kate"))
    assert resp.status_code == 200
    body = resp.json()["data"]
    assert set(body.keys()) == {"items", "count", "limit", "isTruncated"}  # no additive `total`
    assert body["count"] == 120
    assert body["limit"] == 120
    assert body["isTruncated"] is False
    assert len(body["items"]) == 120


async def test_kv_keys_limit_offset_returns_slice_with_total(wired):
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


async def test_kv_keys_limit_only_slices_from_start(wired):
    client, _service = wired
    await _create_user(client, "kate3")
    created = await client.post("/v2/key-value-stores", json={"name": "big3"}, headers=auth("kate3"))
    store_id = created.json()["data"]["id"]
    await _seed_keys(client, store_id, "kate3", 30)

    resp = await client.get(f"/v2/key-value-stores/{store_id}/keys?limit=5", headers=auth("kate3"))
    body = resp.json()["data"]
    assert body["count"] == 5
    assert body["total"] == 30


async def test_kv_keys_offset_only_keeps_no_limit_semantics(wired):
    """Supplying only `offset` (no `limit`) still counts as "params given" (the
    paginated branch, gains the additive `total`), but the effective limit
    stays "no cap" -- exercising `_paginate`'s `items[start:]` branch, not just
    `items[start:start+limit]`."""
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
    assert set(body.keys()) == {"items", "count", "limit"}  # no additive `total`
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


async def test_rq_requests_limit_only_slices_from_start(wired):
    """`limit` without `offset` was previously untested for this surface (only
    "offset-only" and "both supplied" were exercised) -- unlike the KV-keys
    equivalent."""
    client, service = wired
    await _create_user(client, "rick4")
    created = await client.post("/v2/request-queues", json={"name": "big4"}, headers=auth("rick4"))
    rq_id = created.json()["data"]["id"]
    await service.storage.rq_add_batch(
        rq_id, [{"url": f"https://example.com/{i}", "uniqueKey": str(i)} for i in range(20)]
    )

    resp = await client.get(f"/v2/request-queues/{rq_id}/requests?limit=5", headers=auth("rick4"))
    assert resp.status_code == 200
    body = resp.json()["data"]
    assert body["count"] == 5
    assert body["total"] == 20
    assert len(body["items"]) == 5


async def test_rq_requests_offset_only_keeps_no_limit_semantics(wired):
    """Same `items[start:]` branch as the KV-keys equivalent above, for the
    request-queue surface."""
    client, service = wired
    await _create_user(client, "rick3")
    created = await client.post("/v2/request-queues", json={"name": "big3"}, headers=auth("rick3"))
    rq_id = created.json()["data"]["id"]
    await service.storage.rq_add_batch(
        rq_id, [{"url": f"https://example.com/{i}", "uniqueKey": str(i)} for i in range(10)]
    )

    resp = await client.get(f"/v2/request-queues/{rq_id}/requests?offset=7", headers=auth("rick3"))
    assert resp.status_code == 200
    body = resp.json()["data"]
    assert body["count"] == 3
    assert body["total"] == 10
    assert len(body["items"]) == 3


# ---------------------------------------------------------- per-user listings


async def test_my_key_value_stores_bare_request_is_unpaginated_and_unchanged(wired):
    """3-success-criteria.md #15 asks this verified "for a resource with more
    than 100 items/entries" -- the other three surfaces already seed
    150/120/130, so this per-user listing (the fourth) seeds 110 too, rather
    than a count small enough that the bare (uncapped) branch and a
    hypothetical accidentally-introduced 100-item cap would look identical."""
    client, _service = wired
    await _create_user(client, "stan")
    for i in range(110):
        await client.post("/v2/key-value-stores", json={"name": f"s{i:04d}"}, headers=auth("stan"))

    resp = await client.get("/v2/users/me/key-value-stores", headers=auth("stan"))
    assert resp.status_code == 200
    body = resp.json()["data"]
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


async def test_my_key_value_stores_limit_only_slices_from_start(wired):
    """`limit` without `offset` was previously untested for any per-user
    listing surface (only "offset-only" and "both supplied" were exercised)
    -- unlike the KV-keys equivalent."""
    client, _service = wired
    await _create_user(client, "stan5")
    for i in range(15):
        await client.post("/v2/key-value-stores", json={"name": f"y{i}"}, headers=auth("stan5"))

    resp = await client.get("/v2/users/me/key-value-stores?limit=5", headers=auth("stan5"))
    assert resp.status_code == 200
    body = resp.json()["data"]
    assert body["total"] == 15
    assert body["count"] == 5
    assert len(body["items"]) == 5


async def test_my_key_value_stores_offset_only_keeps_no_limit_semantics(wired):
    """Same `items[start:]` branch (no `limit` supplied) as the KV-keys/RQ
    surfaces above, for a per-user aggregate storage listing."""
    client, _service = wired
    await _create_user(client, "stan4")
    for i in range(10):
        await client.post("/v2/key-value-stores", json={"name": f"z{i}"}, headers=auth("stan4"))

    resp = await client.get("/v2/users/me/key-value-stores?offset=7", headers=auth("stan4"))
    assert resp.status_code == 200
    body = resp.json()["data"]
    assert body["total"] == 10
    assert body["count"] == 3
    assert len(body["items"]) == 3


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

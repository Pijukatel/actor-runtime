"""Real, pinned `apify-client` compatibility checks: the bare-call idioms a
real SDK caller uses by default must parse and validate against this
runtime, not merely against a hand-rolled reproduction of the client's own
request/response shapes -- `test_pagination.py` already covers several
`limit`/`offset`-supplied and cursor-mode pinned-client shapes; this file is
scoped to the genuinely BARE call forms those don't exercise.

This client's HTTP transport (`impit`, not `httpx`) has no ASGI-transport
hook, so every check here drives it against a real `uvicorn` server on a real
loopback socket (`tests/conftest.py`'s `wired_uvicorn` fixture) instead of the
in-process `wired` fixture the rest of this suite uses.
"""
from __future__ import annotations

import httpx
from apify_client import ApifyClientAsync


def auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


async def _bootstrap_over_socket(base_url: str, path: str, name: str) -> str:
    """Create a user and one storage for it over a real socket, returning the
    created storage's id."""
    async with httpx.AsyncClient(base_url=base_url) as bootstrap:
        await bootstrap.post("/v2/users", json={"name": name})
        created = await bootstrap.post(path, json={"name": name}, headers=auth(name))
        return created.json()["data"]["id"]


async def test_dataset_list_items_bare_and_paged_and_iterate_items_all_parse(wired_uvicorn):
    """`dataset.list_items()` called with ZERO arguments -- the genuinely
    bare shape, sending no `limit`/`offset` query params at all
    (`_build_params` drops `None` values) -- must parse and return the
    seeded items without error.

    A dataset-items response that carries the five `X-Apify-Pagination-*`
    headers only when the caller actually passed `limit`/`offset` would leave
    a genuinely bare call with none of them; `DatasetItemsPage.list_items()`
    indexes all five directly (no `.get()`), so parsing would raise
    `KeyError: 'x-apify-pagination-total'` before a single item came back.
    `list_items(limit=, offset=)` and `iterate_items()` are exercised too in
    the same test, so a fix that only patches one call shape can't slip
    through unnoticed -- `iterate_items()` always sends an explicit
    `offset`/`limit` internally (its own default chunk size), so it never
    actually exercises the bare branch either way, but must still keep
    working.
    """
    service, base_url = wired_uvicorn
    dataset_id = await _bootstrap_over_socket(base_url, "/v2/datasets", "sdkbare")
    await service.storage.dataset_push(dataset_id, [{"i": i} for i in range(12)])

    client = ApifyClientAsync(token="sdkbare", api_url=base_url, api_public_url=base_url)
    dataset = client.dataset(dataset_id)

    # The genuinely bare call: zero arguments, no limit/offset on the wire.
    bare_page = await dataset.list_items()
    assert [item["i"] for item in bare_page.items] == list(range(12))
    assert bare_page.total == 12
    assert bare_page.offset == 0
    assert bare_page.count == 12
    assert bare_page.desc is False

    paged = await dataset.list_items(limit=5, offset=3)
    assert [item["i"] for item in paged.items] == list(range(3, 8))

    iterated = [item async for item in dataset.iterate_items()]
    assert [item["i"] for item in iterated] == list(range(12))


async def test_key_value_store_iterate_keys_with_no_explicit_limit_validates(wired_uvicorn):
    """`key_value_store.iterate_keys()` called with no `limit` argument --
    the SDK's own default in-Actor idiom -- must yield every seeded key with
    no `ValidationError`.

    Empirically, this pinned client's `iterate_keys()` always resolves its
    OWN internal `chunk_size` to a real numeric `limit` (1000 by default)
    before the request ever reaches the wire (see
    `apify_client._pagination.get_cursor_iterator_async`), so this specific
    call shape already takes this runtime's cursor-mode branch, which always
    carries `recordPublicUrl` on each item regardless of this fix. The
    validation gap this fix closes shows up one level down, on the plain
    `list_keys()` single call `iterate_keys()` is built on top of: called
    with no cursor and no limit at all, that is the genuinely bare request
    whose items must ALSO carry `recordPublicUrl` -- required (no default) on
    `KeyValueStoreKey` -- or parsing raises a `ValidationError` before a
    single key comes back. Both calls are asserted here so this test covers
    the SDK's own default iteration idiom AND the specific bare request the
    underlying fix actually changes.
    """
    service, base_url = wired_uvicorn
    store_id = await _bootstrap_over_socket(base_url, "/v2/key-value-stores", "sdkkv")
    for i in range(5):
        await service.storage.kv_set(store_id, f"k{i:04d}", {"v": i}, "application/json")

    client = ApifyClientAsync(token="sdkkv", api_url=base_url, api_public_url=base_url)
    kv_store = client.key_value_store(store_id)

    seen = [key.key async for key in kv_store.iterate_keys()]
    assert seen == [f"k{i:04d}" for i in range(5)]

    # The genuinely bare single call underneath: no cursor, no limit, on the
    # wire at all. Each returned item must carry `recordPublicUrl`, or
    # parsing raises a `ValidationError` before a single key comes back.
    bare_list = await kv_store.list_keys()
    assert [k.key for k in bare_list.items] == [f"k{i:04d}" for i in range(5)]

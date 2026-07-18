"""Storage-naming: server-side name validation, per-owner/type collision
handling, and the concurrency races `get_or_create_named_storage`
(`app/storage_access.py`) must resolve safely.

All Docker-free via the ``wired`` fixture (in-process app + StubDriver, see
tests/conftest.py).
"""
from __future__ import annotations

import asyncio
import json

import pytest

from app.service import STORAGE_DS, STORAGE_RQ, StorageTypeCollisionError


async def test_create_storage_honors_query_param_name(wired):
    """The real ``apify-client`` (2.5.1) sends a get-or-create's ``name`` as a
    query parameter with an empty JSON body -- ``ResourceCollectionClientAsync.
    _get_or_create()`` calls ``params=self._params(name=name), json=resource``
    with ``resource`` being ``None`` (request queues) or ``{}`` (datasets/KVS
    with no schema), never a body containing ``name``. This is exactly the
    request shape ``Actor.open_dataset(name=...)``/``open_key_value_store(
    name=...)``/``open_request_queue(name=...)`` produce. Before the fix,
    ``_create_storage`` only read ``body.get("name", "default")``, so every
    such call silently created (or resolved to) a storage named "default"
    regardless of the name actually requested.
    """
    client, _service = wired
    resp = await client.post("/v2/key-value-stores", params={"name": "query-named"})
    assert resp.status_code == 201
    assert resp.json()["data"] == {"id": "local-user~query-named", "name": "query-named"}

    # Same route, real request-queue get-or-create shape: no body at all.
    resp2 = await client.post("/v2/request-queues", params={"name": "query-named-rq"})
    assert resp2.status_code == 201
    assert resp2.json()["data"]["id"] == "local-user~query-named-rq"

    # Idempotent: calling again with the same query-param name resolves to
    # the same storage, not a fresh "default".
    again = await client.post("/v2/key-value-stores", params={"name": "query-named"})
    assert again.status_code == 200
    assert again.json()["data"]["id"] == "local-user~query-named"


async def test_create_storage_same_name_different_types_are_distinct(wired):
    """A KV store and a dataset (etc.) created with the identical owner+name
    must be two distinct, independently-usable storages -- never a silent
    misroute to the first one's type, and never a crash. Before the fix,
    ``_create_storage``'s existing-row check only compared ``owner``, never
    ``type``, so the second create's route would echo back the FIRST type's
    id as if it were the second type; the next metadata fetch through the
    correct-type route then 404s (or, worse, an unrelated write lands in the
    wrong storage).
    """
    client, _service = wired
    kv = (await client.post("/v2/key-value-stores", params={"name": "shared-name"})).json()["data"]
    ds = (await client.post("/v2/datasets", params={"name": "shared-name"})).json()["data"]
    rq = (await client.post("/v2/request-queues", params={"name": "shared-name"})).json()["data"]

    ids = {kv["id"], ds["id"], rq["id"]}
    assert len(ids) == 3, f"expected 3 distinct ids, got {ids}"

    # Each id actually works as its own storage type (no misrouting/404), and
    # every GET's `name` field is the bare requested name -- never a raw
    # first-`~` split of a type-qualified id, which would leave the type
    # prefix attached (e.g. "dataset~shared-name" instead of "shared-name").
    # That mis-derived name is a string crawlee's own `validate_storage_name`
    # rejects outright (it contains `~`), so it would crash a real SDK Actor
    # that opens a dataset and a KV store under the same name -- an entirely
    # ordinary usage pattern, not an edge case.
    kv_get = await client.get(f"/v2/key-value-stores/{kv['id']}")
    ds_get = await client.get(f"/v2/datasets/{ds['id']}")
    rq_get = await client.get(f"/v2/request-queues/{rq['id']}")
    assert kv_get.status_code == 200
    assert ds_get.status_code == 200
    assert rq_get.status_code == 200
    assert kv_get.json()["data"]["name"] == "shared-name"
    assert ds_get.json()["data"]["name"] == "shared-name"
    assert rq_get.json()["data"]["name"] == "shared-name"

    # And they are independently writable/readable without cross-talk.
    await client.put(
        f"/v2/key-value-stores/{kv['id']}/records/K",
        content=json.dumps({"which": "kv"}),
        headers={"content-type": "application/json"},
    )
    push = await client.post(
        f"/v2/datasets/{ds['id']}/items",
        content=json.dumps({"which": "ds"}),
        headers={"content-type": "application/json"},
    )
    assert push.status_code == 201
    kv_record = (await client.get(f"/v2/key-value-stores/{kv['id']}/records/K")).json()
    assert kv_record == {"which": "kv"}
    ds_items = (await client.get(f"/v2/datasets/{ds['id']}/items")).json()
    assert ds_items == [{"which": "ds"}]

    # Repeating the create for each type with the same name+type is still
    # idempotent, resolving back to the same (possibly type-qualified) id.
    kv_again = (await client.post("/v2/key-value-stores", params={"name": "shared-name"})).json()["data"]
    assert kv_again["id"] == kv["id"]
    ds_again = (await client.post("/v2/datasets", params={"name": "shared-name"})).json()["data"]
    assert ds_again["id"] == ds["id"]


async def test_create_storage_concurrent_cross_type_race_is_safe(wired):
    """Concurrent get-or-create of DIFFERENT storage types under one fresh,
    not-yet-existing owner+name must not misroute any caller to an id that
    does not actually hold the type it asked for.

    Before the fix, ``_create_storage`` read-and-decided the id to use
    (unqualified ``owner~name`` vs. type-qualified ``owner~{type}~name``)
    with a plain ``get_storage()`` read followed later by a call to the
    type-blind ``ensure_storage()`` -- both un-locked. Racing calls for
    different types (as ``asyncio.gather`` below drives -- ``POST
    /v2/key-value-stores``, ``POST /v2/datasets`` and ``POST
    /v2/request-queues`` sharing one fresh ``name``) could all read the
    unqualified id as absent before any of them committed, so more than one
    type would take the unqualified-id branch: only the first writer's row
    actually held that type; every other racer's ``ensure_storage`` call
    would see the row the first writer just created, read back ITS owner
    (== the same user, since ownership doesn't encode type), and
    ``_create_storage`` would report "success" (200/201) for an id that
    silently does not hold the type that caller asked for. A standalone
    repro of this race hit it 30/30 trials.

    Run unfixed (only the sequential test above, which cannot observe a
    race, existed): this test fails -- some GET-by-type-route 404s.
    Run against the fix (``get_or_create_named_storage``'s per-(owner, name)
    lock in ``app/storage_access.py``): every returned id resolves via its
    own type's GET route, and the three ids are pairwise distinct.
    """
    client, _service = wired
    routes = {
        "kv": ("/v2/key-value-stores", "/v2/key-value-stores/{id}"),
        "ds": ("/v2/datasets", "/v2/datasets/{id}"),
        "rq": ("/v2/request-queues", "/v2/request-queues/{id}"),
    }
    name = "race-name"

    async def _create(kind: str) -> tuple[str, dict]:
        create_path, get_template = routes[kind]
        resp = await client.post(create_path, params={"name": name})
        assert resp.status_code in (200, 201), resp.text
        return kind, resp.json()["data"]

    results = dict(await asyncio.gather(*(_create(kind) for kind in routes)))

    ids = {payload["id"] for payload in results.values()}
    assert len(ids) == 3, f"expected 3 distinct ids for 3 distinct types, got {results}"

    for kind, payload in results.items():
        _create_path, get_template = routes[kind]
        get_resp = await client.get(get_template.format(id=payload["id"]))
        assert get_resp.status_code == 200, (
            f"{kind} id {payload['id']!r} does not resolve as a {kind} storage "
            f"(got {get_resp.status_code}) -- misrouted by the create race"
        )
        assert get_resp.json()["data"]["name"] == name


async def test_create_storage_concurrent_same_type_race_returns_one_id(wired):
    """Concurrent get-or-create calls for the SAME type and fresh owner+name
    must converge on exactly one id -- the ``ensure_storage`` DB-level
    unique-constraint/rollback/read-back path already made this case safe,
    and the new per-(owner, name) lock in ``get_or_create_named_storage``
    now serializes it outright, so every racer either creates (201) or
    observes the already-created row (200), never two different ids.
    """
    client, _service = wired
    name = "same-type-race-name"

    async def _create() -> dict:
        resp = await client.post("/v2/key-value-stores", params={"name": name})
        assert resp.status_code in (200, 201), resp.text
        return resp.json()["data"]

    results = await asyncio.gather(*(_create() for _ in range(8)))
    ids = {payload["id"] for payload in results}
    assert ids == {f"local-user~{name}"}

    get_resp = await client.get(f"/v2/key-value-stores/local-user~{name}")
    assert get_resp.status_code == 200
    assert get_resp.json()["data"]["name"] == name


async def test_named_storage_locks_bounded_by_distinct_names(wired):
    """`StorageAccessManager._named_storage_locks` is bounded by the number of
    DISTINCT (owner, name) pairs actually get-or-created, not by how many
    calls/racers hit a given name: repeating a create for the same name must
    not add a second entry, and several racers sharing one fresh name must
    still collapse onto a single lock for that key -- one entry per named
    storage, never one per request.
    """
    client, service = wired
    locks = service.storage_access._named_storage_locks

    # Same name, requested repeatedly (sequentially): exactly one entry.
    for i in range(5):
        resp = await client.post("/v2/key-value-stores", params={"name": "lock-bound-repeat"})
        assert resp.status_code in (200, 201)
    assert list(locks) == ["local-user\x00lock-bound-repeat"]

    # Concurrent racers sharing one fresh name: still just one more entry.
    await asyncio.gather(
        *(client.post("/v2/datasets", params={"name": "lock-bound-concurrent"}) for _ in range(6))
    )
    assert set(locks) == {"local-user\x00lock-bound-repeat", "local-user\x00lock-bound-concurrent"}

# -- Storage-name validation + type re-check -------------------------------
#
# Before the fix, `get_or_create_named_storage` (`app/storage_access.py`) had
# no server-side name validation at all, and never re-checked the resolved
# row's type after computing the type-qualified id. A caller-chosen name
# containing `~` (e.g. "key-value-store~shared") could deterministically --
# no race needed -- collide with an unrelated storage's literal id, silently
# reporting success while actually resolving to the WRONG storage.


async def test_create_storage_rejects_invalid_name(wired):
    """A `~`-containing (or otherwise non-conforming) name is now rejected
    with `400 invalid-request`, instead of silently being accepted and
    potentially colliding with this runtime's own `owner~name` /
    `owner~{type}~name` id-qualification scheme.

    Red on the pre-fix code (no validation existed -- this would have
    returned 201/200), green after `get_or_create_named_storage` calls
    `validate_storage_name` before doing anything else.
    """
    client, _service = wired
    for bad_name in ("key-value-store~shared", "has_underscore", "-leading-hyphen", "trailing-hyphen-", "~"):
        resp = await client.post("/v2/datasets", params={"name": bad_name})
        assert resp.status_code == 400, f"{bad_name!r}: expected 400, got {resp.status_code} ({resp.text})"
        assert resp.json()["error"]["type"] == "invalid-request"

    # A conforming name (letters/digits/hyphen, not leading/trailing) still works.
    ok = await client.post("/v2/datasets", params={"name": "still-fine-1"})
    assert ok.status_code == 201


async def test_create_storage_name_collision_scenario_is_now_safe(wired):
    """Exercises the exact deterministic (non-concurrent) collision: a
    dataset named ``"key-value-store~shared"`` would mint id
    ``local-user~key-value-store~shared`` -- the SAME id a key-value store
    named plain ``"shared"`` computes as its type-qualified id once
    ``local-user~shared`` is already taken by a different type. Before the
    fix this made the KV-store "create" call return 200/201 success while
    actually resolving to the dataset's row (`kv["id"] == ds["id"]`); any
    subsequent KV-store-typed read then 404s, contradicting the success
    response.

    Now the poisoned name is rejected outright at the first call, so the
    later, ordinarily-valid creates never see a colliding id at all.
    """
    client, _service = wired

    poisoned = await client.post("/v2/datasets", params={"name": "key-value-store~shared"})
    assert poisoned.status_code == 400

    # The request queue claims the unqualified id first (nothing else named
    # "shared" exists yet, since the poisoned dataset create above never
    # went through).
    rq = (await client.post("/v2/request-queues", params={"name": "shared"})).json()["data"]
    assert rq["id"] == "local-user~shared"

    # The key-value store, sharing that same name, is forced onto ITS OWN
    # type-qualified id -- "local-user~key-value-store~shared" -- which is
    # EXACTLY the id the (rejected) poisoned dataset name would have
    # produced. Before the fix this would have collided with that dataset's
    # row; now the dataset never existed, so this id is genuinely fresh and
    # genuinely a key-value store.
    kv = (await client.post("/v2/key-value-stores", params={"name": "shared"})).json()["data"]
    assert kv["id"] == "local-user~key-value-store~shared"
    assert kv["id"] != rq["id"]

    # And the KV store genuinely IS a key-value store (no misrouting/404).
    kv_get = await client.get(f"/v2/key-value-stores/{kv['id']}")
    assert kv_get.status_code == 200
    assert kv_get.json()["data"]["name"] == "shared"

    # The poisoned dataset name was rejected outright -- no dataset row (or
    # any row at all) exists at the id it would have minted.
    assert (await client.get(f"/v2/datasets/{kv['id']}")).status_code == 404


async def test_get_or_create_named_storage_raises_on_type_collision(wired):
    """Defence-in-depth unit test for the (now normally unreachable, thanks to
    `validate_storage_name`) type re-check: if the type-qualified id a
    `get_or_create_named_storage` call would compute is somehow ALREADY
    occupied by a storage of a different type (simulating pre-existing
    `~`-containing data written before validation existed, or a future bug
    elsewhere), the function must refuse to silently hand back that
    wrong-typed id -- it must raise `StorageTypeCollisionError` instead.

    Constructed directly against `StorageAccessManager` (bypassing the now-
    validated HTTP create route on purpose) since a real caller can no longer
    reach this state through the API.
    """
    client, service = wired
    owner = "local-user"

    # Claim the unqualified id as a KV store first, so a dataset create for
    # the same name is forced onto the type-qualified branch.
    kv = (await client.post("/v2/key-value-stores", params={"name": "collide"})).json()["data"]
    assert kv["id"] == f"{owner}~collide"

    # Simulate pre-existing data at the type-qualified id the dataset create
    # would compute (`owner~dataset~collide`), but holding the WRONG type
    # (request-queue, not dataset) -- bypassing `get_or_create_named_storage`
    # (and its validation) entirely, exactly like data written before
    # validation existed would look.
    poisoned_id = f"{owner}~{STORAGE_DS}~collide"
    await service.storage_access.ensure_storage(poisoned_id, STORAGE_RQ, owner)

    with pytest.raises(StorageTypeCollisionError):
        await service.get_or_create_named_storage("collide", STORAGE_DS, owner)


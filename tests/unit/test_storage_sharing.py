"""Storage sharing: grant/revoke READ or WRITE access on an individual
storage to another user, and the visibility/authorization rules around it.

Identity model matches `tests/unit/test_multi_user.py`: users are decoupled
username/token pairs, created via the open, token-less `/v2/users` endpoint.
Everything runs Docker-free via the ``wired`` fixture; the acting user is
chosen per request with ``Authorization: Bearer <token>``.
"""
from __future__ import annotations

from _provisioning_harness import (  # noqa: F401 - `_seed_users` is autouse, applied via import
    _provision,
    _push,
    _read_paths,
    _seed_users,
    _storage_id,
    _write,
)

NOT_FOUND = "record-not-found"

KV = "key-value-stores"
DS = "datasets"
RQ = "request-queues"


def auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


# -- Sharing: grant READ ----------------------------------------------------
async def test_grant_read_lets_grantee_read(wired):
    client, service = wired
    _actor_id, _build, run = await _provision(client, service, "alice")
    for stype in (KV, DS, RQ):
        sid = _storage_id(run, stype)
        # Before the grant: bob is blind.
        assert (await client.get(f"/v2/{stype}/{sid}", headers=auth("bob"))).status_code == 404
        grant = await client.post(
            f"/v2/{stype}/{sid}/access-rights",
            json={"grantee": "bob", "level": "READ"},
            headers=auth("alice"),
        )
        assert grant.status_code == 201
        # After the grant: every read succeeds and matches alice's content.
        for path in _read_paths(stype, sid):
            bob_resp = await client.get(path, headers=auth("bob"))
            alice_resp = await client.get(path, headers=auth("alice"))
            assert bob_resp.status_code == 200, path
            assert bob_resp.json() == alice_resp.json(), path


# -- Sharing: grant WRITE ---------------------------------------------------
async def test_grant_write_lets_grantee_write_and_owner_sees_it(wired):
    client, service = wired
    _actor_id, _build, run = await _provision(client, service, "alice")
    for stype in (KV, DS, RQ):
        sid = _storage_id(run, stype)
        await client.post(
            f"/v2/{stype}/{sid}/access-rights",
            json={"grantee": "bob", "level": "WRITE"},
            headers=auth("alice"),
        )
        resp = await _write(client, stype, sid, "bob")
        assert resp.status_code in (200, 201), f"{stype} grantee write refused"

        if stype == KV:
            bob_val = (await client.get(f"/v2/{KV}/{sid}/records/GRANTEE", headers=auth("bob"))).json()
            alice_val = (await client.get(f"/v2/{KV}/{sid}/records/GRANTEE", headers=auth("alice"))).json()
            assert bob_val == {"from": "bob"} == alice_val
            keys = (await client.get(f"/v2/{KV}/{sid}/keys", headers=auth("alice"))).json()["data"]
            assert any(k["key"] == "GRANTEE" for k in keys["items"])
        elif stype == DS:
            bob_items = (await client.get(f"/v2/{DS}/{sid}/items", headers=auth("bob"))).json()
            alice_items = (await client.get(f"/v2/{DS}/{sid}/items", headers=auth("alice"))).json()
            assert {"from": "bob"} in bob_items
            assert bob_items == alice_items
        else:
            bob_reqs = (await client.get(f"/v2/{RQ}/{sid}/requests", headers=auth("bob"))).json()["data"]["items"]
            alice_reqs = (await client.get(f"/v2/{RQ}/{sid}/requests", headers=auth("alice"))).json()["data"]["items"]
            assert any(r["url"] == "https://example.com/bob" for r in bob_reqs)
            assert len(bob_reqs) == len(alice_reqs)


# -- Sharing: READ grantee write is forbidden, distinct from not-found -----
async def test_read_grantee_write_is_forbidden_distinct_from_not_found(wired):
    client, service = wired
    _actor_id, _build, run = await _provision(client, service, "alice")
    for stype in (KV, DS, RQ):
        sid = _storage_id(run, stype)
        await client.post(
            f"/v2/{stype}/{sid}/access-rights",
            json={"grantee": "bob", "level": "READ"},
            headers=auth("alice"),
        )
        resp = await _write(client, stype, sid, "bob")
        assert resp.status_code == 403, f"{stype}: expected forbidden"
        assert resp.json()["error"]["type"] != NOT_FOUND
        assert resp.json()["error"]["type"] == "insufficient-permissions"
    # Alice's storage unchanged.
    items = (await client.get(f"/v2/{DS}/{run['defaultDatasetId']}/items", headers=auth("alice"))).json()
    assert items == [{"message": "hi world", "index": 1}]


# -- Sharing: owner-only management -----------------------------------------
async def test_only_owner_can_manage_shares(wired):
    client, service = wired
    _actor_id, _build, run = await _provision(client, service, "alice")
    sid = run["defaultKeyValueStoreId"]

    # A stranger (no access) cannot grant, list or revoke.
    assert (await client.post(f"/v2/{KV}/{sid}/access-rights", json={"grantee": "mallory", "level": "READ"}, headers=auth("bob"))).status_code == 403
    assert (await client.get(f"/v2/{KV}/{sid}/access-rights", headers=auth("bob"))).status_code == 403
    assert (await client.delete(f"/v2/{KV}/{sid}/access-rights/anyone", headers=auth("bob"))).status_code == 403

    # A WRITE grantee still cannot manage (no re-share / escalation).
    await client.post(f"/v2/{KV}/{sid}/access-rights", json={"grantee": "bob", "level": "WRITE"}, headers=auth("alice"))
    assert (await client.post(f"/v2/{KV}/{sid}/access-rights", json={"grantee": "carol", "level": "WRITE"}, headers=auth("bob"))).status_code == 403
    assert (await client.get(f"/v2/{KV}/{sid}/access-rights", headers=auth("bob"))).status_code == 403
    assert (await client.delete(f"/v2/{KV}/{sid}/access-rights/bob", headers=auth("bob"))).status_code == 403

    # State unchanged: bob is still exactly WRITE, carol was never added.
    rights = (await client.get(f"/v2/{KV}/{sid}/access-rights", headers=auth("alice"))).json()["data"]["items"]
    grantees = {r["grantee"]: r["level"] for r in rights}
    assert grantees == {"bob": "WRITE"}


# -- Sharing: per-storage scoping --------------------------------------------
async def test_grant_is_per_storage_only(wired):
    client, service = wired
    actor_id, build, run = await _provision(client, service, "alice")
    shared = run["defaultKeyValueStoreId"]
    await client.post(f"/v2/{KV}/{shared}/access-rights", json={"grantee": "bob", "level": "READ"}, headers=auth("alice"))

    # Bob can reach only the shared KV store.
    assert (await client.get(f"/v2/{KV}/{shared}", headers=auth("bob"))).status_code == 200
    # The other two storages of the same run stay invisible.
    assert (await client.get(f"/v2/{DS}/{run['defaultDatasetId']}", headers=auth("bob"))).status_code == 404
    assert (await client.get(f"/v2/{RQ}/{run['defaultRequestQueueId']}", headers=auth("bob"))).status_code == 404
    # The run/build/actor behind it stay invisible.
    assert (await client.get(f"/v2/actor-runs/{run['id']}", headers=auth("bob"))).status_code == 404
    assert (await client.get(f"/v2/actor-builds/{build['id']}", headers=auth("bob"))).status_code == 404
    assert (await client.get(f"/v2/actors/{actor_id}", headers=auth("bob"))).status_code == 404
    # Bob's own lists still show none of alice's objects.
    assert (await client.get("/v2/users/me/actors", headers=auth("bob"))).json()["data"]["items"] == []
    assert (await client.get("/v2/users/me/runs", headers=auth("bob"))).json()["data"]["items"] == []


# -- Sharing: revoke ----------------------------------------------------------
async def test_revoke_returns_storage_to_not_found(wired):
    client, service = wired
    _actor_id, _build, run = await _provision(client, service, "alice")
    sid = run["defaultKeyValueStoreId"]
    await client.post(f"/v2/{KV}/{sid}/access-rights", json={"grantee": "bob", "level": "WRITE"}, headers=auth("alice"))
    assert (await client.get(f"/v2/{KV}/{sid}", headers=auth("bob"))).status_code == 200

    revoke = await client.delete(f"/v2/{KV}/{sid}/access-rights/bob", headers=auth("alice"))
    assert revoke.status_code == 200

    read = await client.get(f"/v2/{KV}/{sid}", headers=auth("bob"))
    assert read.status_code == 404 and read.json()["error"]["type"] == NOT_FOUND
    write = await _write(client, KV, sid, "bob")
    assert write.status_code == 404 and write.json()["error"]["type"] == NOT_FOUND
    # Alice still reads her unchanged store.
    assert (await client.get(f"/v2/{KV}/{sid}/records/OUTPUT", headers=auth("alice"))).status_code == 200


# -- Sharing: list grantees reflects grants/revokes --------------------------
async def test_list_grantees_reflects_changes(wired):
    client, service = wired
    _actor_id, _build, run = await _provision(client, service, "alice")
    sid = run["defaultDatasetId"]

    await client.post(f"/v2/{DS}/{sid}/access-rights", json={"grantee": "bob", "level": "READ"}, headers=auth("alice"))
    rights = (await client.get(f"/v2/{DS}/{sid}/access-rights", headers=auth("alice"))).json()["data"]["items"]
    assert {r["grantee"]: r["level"] for r in rights} == {"bob": "READ"}

    # Upgrade to WRITE (re-grant updates the level in place).
    await client.post(f"/v2/{DS}/{sid}/access-rights", json={"grantee": "bob", "level": "WRITE"}, headers=auth("alice"))
    rights = (await client.get(f"/v2/{DS}/{sid}/access-rights", headers=auth("alice"))).json()["data"]["items"]
    assert {r["grantee"]: r["level"] for r in rights} == {"bob": "WRITE"}

    # Revoke removes bob from the listing.
    await client.delete(f"/v2/{DS}/{sid}/access-rights/bob", headers=auth("alice"))
    rights = (await client.get(f"/v2/{DS}/{sid}/access-rights", headers=auth("alice"))).json()["data"]["items"]
    assert rights == []

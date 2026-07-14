"""Multi-user, placeholder-login and storage-sharing behaviour.

Covers success criteria 1-21 (identity/provisioning/default user, per-user
ownership, strict isolation across Actors/Builds/Runs and run storages, and the
full grant/list/revoke sharing flow at READ and WRITE levels) plus the console
regressions (22-23). Everything runs Docker-free via the ``wired`` fixture; the
acting user is chosen per request with ``Authorization: Bearer <token>``.
"""
from __future__ import annotations

import json

from app.service import STORAGE_KV

NOT_FOUND = "record-not-found"

KV = "key-value-stores"
DS = "datasets"
RQ = "request-queues"


def auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


async def _push(client, name, token):
    await client.post(
        "/v2/acts",
        json={"name": name, "versions": [{"versionNumber": "0.0", "buildTag": "latest"}]},
        headers=auth(token),
    )
    actor_id = f"{token}~{name}"
    await client.post(
        f"/v2/actors/{actor_id}/versions",
        json={
            "versionNumber": "0.0",
            "sourceType": "SOURCE_FILES",
            "sourceFiles": [{"name": "main.py", "format": "TEXT", "content": "print('hi')\n"}],
        },
        headers=auth(token),
    )
    return actor_id


async def _provision(client, service, token, name="sample-actor", greeting="hi"):
    """Push, build and run an Actor under ``token``; return (actor_id, build, run)."""
    actor_id = await _push(client, name, token)
    build = (
        await client.post(f"/v2/acts/{actor_id}/builds?version=0.0", headers=auth(token))
    ).json()["data"]
    await service.wait_idle()
    run = (
        await client.post(
            f"/v2/acts/{actor_id}/runs",
            content=json.dumps({"greeting": greeting}),
            headers={**auth(token), "content-type": "application/json"},
        )
    ).json()["data"]
    await service.wait_idle()
    run = (await client.get(f"/v2/actor-runs/{run['id']}", headers=auth(token))).json()["data"]
    return actor_id, build, run


def _storage_id(run, storage_type):
    return {
        KV: run["defaultKeyValueStoreId"],
        DS: run["defaultDatasetId"],
        RQ: run["defaultRequestQueueId"],
    }[storage_type]


def _read_paths(storage_type, storage_id):
    if storage_type == KV:
        return [
            f"/v2/{KV}/{storage_id}",
            f"/v2/{KV}/{storage_id}/keys",
            f"/v2/{KV}/{storage_id}/records/OUTPUT",
        ]
    if storage_type == DS:
        return [f"/v2/{DS}/{storage_id}", f"/v2/{DS}/{storage_id}/items"]
    return [f"/v2/{RQ}/{storage_id}", f"/v2/{RQ}/{storage_id}/requests"]


async def _write(client, storage_type, storage_id, token):
    """Perform the write-shaped op for the storage type; return the response."""
    if storage_type == KV:
        return await client.put(
            f"/v2/{KV}/{storage_id}/records/GRANTEE",
            content=json.dumps({"from": token}),
            headers={**auth(token), "content-type": "application/json"},
        )
    if storage_type == DS:
        return await client.post(
            f"/v2/{DS}/{storage_id}/items",
            content=json.dumps({"from": token}),
            headers={**auth(token), "content-type": "application/json"},
        )
    return await client.post(
        f"/v2/{RQ}/{storage_id}/requests",
        content=json.dumps({"url": f"https://example.com/{token}", "uniqueKey": token}),
        headers={**auth(token), "content-type": "application/json"},
    )


# -- Identity, provisioning, default user (criteria 1-4) ------------------
async def test_token_selects_user_and_users_me_reflects_it(wired):
    client, _ = wired
    alice = (await client.get("/v2/users/me", headers=auth("alice"))).json()["data"]
    bob = (await client.get("/v2/users/me", headers=auth("bob"))).json()["data"]
    assert alice["username"] == "alice"
    assert bob["username"] == "bob"
    assert alice["username"] != bob["username"]
    assert alice["username"] != "local-user"


async def test_first_use_auto_provisions_and_identity_persists(wired):
    client, _ = wired
    # A never-before-seen token works on first request.
    await _push(client, "sample-actor", "fresh")
    # A later request with the same token resolves to the same user + sees the object.
    me = (await client.get("/v2/users/me", headers=auth("fresh"))).json()["data"]
    assert me["username"] == "fresh"
    listing = (await client.get("/v2/users/me/actors", headers=auth("fresh"))).json()["data"]
    assert [a["name"] for a in listing["items"]] == ["sample-actor"]


async def test_no_token_is_default_local_user(wired):
    client, _ = wired
    me = (await client.get("/v2/users/me")).json()["data"]
    assert me["username"] == "local-user"
    actor = (await client.post("/v2/acts", json={"name": "noauth"})).json()["data"]
    assert actor["id"] == "local-user~noauth"


async def test_arbitrary_unknown_token_is_accepted_not_rejected(wired):
    client, _ = wired
    resp = await client.get("/v2/users/me", headers=auth("never-seen-9f2c"))
    assert resp.status_code == 200  # unknown != rejected; it is simply a new user
    assert resp.json()["data"]["username"] == "never-seen-9f2c"


# -- Per-user ownership (criteria 5-8) ------------------------------------
async def test_actor_owned_by_acting_user(wired):
    client, _ = wired
    actor = (
        await client.post("/v2/acts", json={"name": "sample-actor"}, headers=auth("alice"))
    ).json()["data"]
    assert actor["username"] == "alice"
    assert actor["userId"] == "alice"
    assert actor["id"] == "alice~sample-actor"


async def test_build_and_run_owned_by_acting_user(wired):
    client, service = wired
    _actor_id, build, run = await _provision(client, service, "alice")
    fetched_build = (
        await client.get(f"/v2/actor-builds/{build['id']}", headers=auth("alice"))
    ).json()["data"]
    assert fetched_build["username"] == "alice"
    assert run["username"] == "alice"


async def test_two_users_same_actor_name_no_collision(wired):
    client, _ = wired
    a = (await client.post("/v2/acts", json={"name": "sample-actor"}, headers=auth("alice"))).json()["data"]
    b = (await client.post("/v2/acts", json={"name": "sample-actor"}, headers=auth("bob"))).json()["data"]
    assert a["id"] == "alice~sample-actor"
    assert b["id"] == "bob~sample-actor"
    assert a["id"] != b["id"]
    # Bob creating did not surface or overwrite alice's actor.
    alice_list = (await client.get("/v2/users/me/actors", headers=auth("alice"))).json()["data"]
    assert [x["id"] for x in alice_list["items"]] == ["alice~sample-actor"]


# -- Strict isolation, Actors/Builds/Runs (criteria 9-11) -----------------
async def test_lists_are_disjoint_per_user(wired):
    client, service = wired
    alice_actor, _, _ = await _provision(client, service, "alice")
    bob_actor, _, _ = await _provision(client, service, "bob")

    for token, own_actor, other_actor in (("alice", alice_actor, bob_actor), ("bob", bob_actor, alice_actor)):
        actors = (await client.get("/v2/acts", headers=auth(token))).json()["data"]["items"]
        assert [a["id"] for a in actors] == [own_actor]
        builds = (await client.get("/v2/users/me/builds", headers=auth(token))).json()["data"]["items"]
        assert builds and all(b["username"] == token for b in builds)
        runs = (await client.get("/v2/users/me/runs", headers=auth(token))).json()["data"]["items"]
        assert runs and all(r["username"] == token for r in runs)
        # Actor-scoped build/run lists for the other user's actor are empty for me.
        other_builds = (await client.get(f"/v2/acts/{other_actor}/builds", headers=auth(token))).json()["data"]
        assert other_builds["items"] == []
        other_runs = (await client.get(f"/v2/acts/{other_actor}/runs", headers=auth(token))).json()["data"]
        assert other_runs["items"] == []


async def test_cross_user_get_by_id_is_not_found(wired):
    client, service = wired
    alice_actor, alice_build, alice_run = await _provision(client, service, "alice")

    for path in (
        f"/v2/actors/{alice_actor}",
        f"/v2/actor-builds/{alice_build['id']}",
        f"/v2/actor-runs/{alice_run['id']}",
    ):
        resp = await client.get(path, headers=auth("bob"))
        assert resp.status_code == 404, path
        assert resp.json()["error"]["type"] == NOT_FOUND
    # Identical to a genuinely invented id.
    invented = await client.get("/v2/actor-runs/does-not-exist", headers=auth("bob"))
    assert invented.status_code == 404
    assert invented.json()["error"]["type"] == NOT_FOUND


async def test_cross_user_mutation_is_not_found_and_has_no_effect(wired):
    client, service = wired
    alice_actor, _, alice_run = await _provision(client, service, "alice")

    # Abort another user's run.
    resp = await client.post(f"/v2/actor-runs/{alice_run['id']}/abort", headers=auth("bob"))
    assert resp.status_code == 404 and resp.json()["error"]["type"] == NOT_FOUND
    # Update another user's actor.
    resp = await client.put(
        f"/v2/actors/{alice_actor}",
        json={"defaultRunOptions": {"timeoutSecs": 999}},
        headers=auth("bob"),
    )
    assert resp.status_code == 404 and resp.json()["error"]["type"] == NOT_FOUND
    # Trigger a build on another user's actor.
    resp = await client.post(f"/v2/acts/{alice_actor}/builds?version=0.0", headers=auth("bob"))
    assert resp.status_code == 404 and resp.json()["error"]["type"] == NOT_FOUND

    # Alice's run is untouched (still SUCCEEDED, not ABORTED).
    still = (await client.get(f"/v2/actor-runs/{alice_run['id']}", headers=auth("alice"))).json()["data"]
    assert still["status"] == "SUCCEEDED"


# -- Owner drives own flow incl. storages (criterion 12) ------------------
async def test_owner_full_flow_including_storages(wired):
    client, service = wired
    _actor_id, build, run = await _provision(client, service, "alice", greeting="howdy")
    assert (
        await client.get(f"/v2/actor-builds/{build['id']}", headers=auth("alice"))
    ).json()["data"]["status"] == "SUCCEEDED"
    assert run["status"] == "SUCCEEDED"

    kv = run["defaultKeyValueStoreId"]
    ds = run["defaultDatasetId"]
    rq = run["defaultRequestQueueId"]
    output = (await client.get(f"/v2/{KV}/{kv}/records/OUTPUT", headers=auth("alice"))).json()
    assert output["greeting"] == "howdy"
    items = (await client.get(f"/v2/{DS}/{ds}/items", headers=auth("alice"))).json()
    assert items == [{"message": "howdy world", "index": 1}]
    meta = (await client.get(f"/v2/{RQ}/{rq}", headers=auth("alice"))).json()["data"]
    assert meta["totalRequestCount"] == 1


# -- Run-storage isolation, READ (criterion 13) ---------------------------
async def test_run_storages_private_on_read(wired):
    client, service = wired
    _actor_id, _build, run = await _provision(client, service, "alice")
    for stype in (KV, DS, RQ):
        sid = _storage_id(run, stype)
        for path in _read_paths(stype, sid):
            ok = await client.get(path, headers=auth("alice"))
            assert ok.status_code == 200, f"owner denied: {path}"
            denied = await client.get(path, headers=auth("bob"))
            assert denied.status_code == 404, f"cross-user leak: {path}"
            assert denied.json()["error"]["type"] == NOT_FOUND
        # Indistinguishable from an invented id of the same type.
        invented = await client.get(f"/v2/{stype}/invented-{stype}", headers=auth("bob"))
        assert invented.status_code == 404
        assert invented.json()["error"]["type"] == NOT_FOUND


# -- Run-storage isolation, WRITE (criterion 14) --------------------------
async def test_run_storages_private_on_write(wired):
    client, service = wired
    _actor_id, _build, run = await _provision(client, service, "alice")
    for stype in (KV, DS, RQ):
        sid = _storage_id(run, stype)
        resp = await _write(client, stype, sid, "bob")
        assert resp.status_code == 404, f"{stype} write leaked"
        assert resp.json()["error"]["type"] == NOT_FOUND
    # Alice's storages are unchanged (no bob payload).
    keys = (await client.get(f"/v2/{KV}/{run['defaultKeyValueStoreId']}/keys", headers=auth("alice"))).json()["data"]
    assert all(k["key"] != "GRANTEE" for k in keys["items"])
    items = (await client.get(f"/v2/{DS}/{run['defaultDatasetId']}/items", headers=auth("alice"))).json()
    assert items == [{"message": "hi world", "index": 1}]


# -- Sharing: grant READ (criterion 15) -----------------------------------
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


# -- Sharing: grant WRITE (criterion 16) ----------------------------------
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


# -- Sharing: READ grantee write is forbidden, distinct from not-found (17)
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


# -- Sharing: owner-only management (criterion 18) ------------------------
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


# -- Sharing: per-storage scoping (criterion 19) --------------------------
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


# -- Sharing: revoke (criterion 20) ---------------------------------------
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


# -- Sharing: list grantees reflects grants/revokes (criterion 21) --------
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


# -- Regression: standalone create-echo storages are per-user -------------
# The client-supplied name must never become a GLOBAL un-namespaced storage
# id: two users' `POST {"name":"foo"}` must not collide on one row, and no
# user may seize another's not-yet-created name via a bare write.
async def test_create_storage_is_namespaced_and_usable_per_user(wired):
    client, _ = wired
    # Alice and Bob both create a KV store with the SAME name.
    a = await client.post("/v2/key-value-stores", json={"name": "shared"}, headers=auth("alice"))
    b = await client.post("/v2/key-value-stores", json={"name": "shared"}, headers=auth("bob"))
    assert a.status_code == 201 and b.status_code == 201
    aid = a.json()["data"]["id"]
    bid = b.json()["data"]["id"]
    # Distinct, namespaced ids owned by their creators (never a shared "default").
    assert aid == "alice~shared"
    assert bid == "bob~shared"
    assert aid != bid

    # The returned id is actually usable by its owner: alice writes then reads.
    put = await client.put(
        f"/v2/{KV}/{aid}/records/K",
        content=json.dumps({"who": "alice"}),
        headers={**auth("alice"), "content-type": "application/json"},
    )
    assert put.status_code == 200
    got = await client.get(f"/v2/{KV}/{aid}/records/K", headers=auth("alice"))
    assert got.status_code == 200 and got.json() == {"who": "alice"}

    # Bob cannot read or write alice's namespaced store (isolation preserved).
    assert (await client.get(f"/v2/{KV}/{aid}", headers=auth("bob"))).status_code == 404
    bob_write = await client.put(
        f"/v2/{KV}/{aid}/records/K",
        content=json.dumps({"who": "bob"}),
        headers={**auth("bob"), "content-type": "application/json"},
    )
    assert bob_write.status_code == 404 and bob_write.json()["error"]["type"] == NOT_FOUND
    # Alice's content is untouched by bob's rejected write.
    reread = (await client.get(f"/v2/{KV}/{aid}/records/K", headers=auth("alice"))).json()
    assert reread == {"who": "alice"}


async def test_write_cannot_squat_another_users_namespaced_id(wired):
    client, _ = wired
    # Bob writes to an id in alice's namespace that has no backing row yet.
    squat = await client.put(
        f"/v2/{KV}/alice~notyet/records/X",
        content=json.dumps({"who": "bob"}),
        headers={**auth("bob"), "content-type": "application/json"},
    )
    # He must NOT seize it: 404, not a silent auto-create owned by bob.
    assert squat.status_code == 404 and squat.json()["error"]["type"] == NOT_FOUND

    # Alice can now legitimately create + own it via the documented flow.
    created = await client.post("/v2/key-value-stores", json={"name": "notyet"}, headers=auth("alice"))
    assert created.status_code == 201
    aid = created.json()["data"]["id"]
    assert aid == "alice~notyet"
    # And use it; bob still cannot see it.
    put = await client.put(
        f"/v2/{KV}/{aid}/records/X",
        content=json.dumps({"who": "alice"}),
        headers={**auth("alice"), "content-type": "application/json"},
    )
    assert put.status_code == 200
    assert (await client.get(f"/v2/{KV}/{aid}", headers=auth("bob"))).status_code == 404


async def test_create_storage_is_idempotent_for_owner_and_covers_datasets(wired):
    client, _ = wired
    first = await client.post("/v2/datasets", json={"name": "d"}, headers=auth("alice"))
    assert first.status_code == 201
    did = first.json()["data"]["id"]
    assert did == "alice~d"
    # Re-creating the same storage as the owner is idempotent, not a misleading new 201.
    again = await client.post("/v2/datasets", json={"name": "d"}, headers=auth("alice"))
    assert again.status_code == 200
    assert again.json()["data"]["id"] == did

    # Bob creating "d" gets his OWN distinct dataset, never alice's row.
    bob = await client.post("/v2/datasets", json={"name": "d"}, headers=auth("bob"))
    assert bob.status_code == 201 and bob.json()["data"]["id"] == "bob~d"
    push = await client.post(
        f"/v2/{DS}/bob~d/items",
        content=json.dumps({"who": "bob"}),
        headers={**auth("bob"), "content-type": "application/json"},
    )
    assert push.status_code == 201
    # Bob's push landed only in his dataset; alice's stays empty and private.
    assert (await client.get(f"/v2/{DS}/{did}", headers=auth("bob"))).status_code == 404
    alice_items = await client.get(f"/v2/{DS}/{did}/items", headers=auth("alice"))
    assert alice_items.status_code == 200 and alice_items.json() == []


# -- Regression: absent-write race cannot land in another owner's store ---
# A writer that loses the create race for a fresh bare id must never have its
# payload persisted into the winner's storage -- that would be a cross-user
# write with no grant (violates criterion 14). `ensure_storage` must be
# authoritative about who owns the id, and `_guard` must deny the race
# loser 404.
async def test_ensure_storage_owner_is_authoritative_not_the_caller(wired):
    _client, service = wired
    # First caller wins ownership of a fresh bare id.
    assert await service.ensure_storage("bare-race", STORAGE_KV, "alice") == "alice"
    # A second caller for the SAME id is told alice owns it -- never itself,
    # so `_guard` can always tell the race winner from the loser.
    assert await service.ensure_storage("bare-race", STORAGE_KV, "bob") == "alice"


async def test_write_to_already_owned_bare_id_cannot_land(wired):
    client, service = wired
    # Deterministic sequential analogue of the race: alice already owns a fresh
    # bare id (as if she won the create race).
    await service.ensure_storage("bare-shared", STORAGE_KV, "alice")
    alice_put = await client.put(
        f"/v2/{KV}/bare-shared/records/K",
        content=json.dumps({"who": "alice"}),
        headers={**auth("alice"), "content-type": "application/json"},
    )
    assert alice_put.status_code == 200
    # A different user's write to that same bare id is denied and never persisted.
    bob_put = await client.put(
        f"/v2/{KV}/bare-shared/records/K",
        content=json.dumps({"who": "bob"}),
        headers={**auth("bob"), "content-type": "application/json"},
    )
    assert bob_put.status_code == 404 and bob_put.json()["error"]["type"] == NOT_FOUND
    # Alice's content is unchanged -- bob's payload never landed in her storage.
    reread = (await client.get(f"/v2/{KV}/bare-shared/records/K", headers=auth("alice"))).json()
    assert reread == {"who": "alice"}


# -- storage.type is validated against the route --------------------------
async def test_wrong_type_route_is_not_found(wired):
    client, service = wired
    _actor_id, _build, run = await _provision(client, service, "alice")
    kv = run["defaultKeyValueStoreId"]
    # A KV id addressed through the dataset route does not exist AS a dataset: 404,
    # even for its owner -- indistinguishable from an invented dataset id.
    resp = await client.get(f"/v2/{DS}/{kv}/items", headers=auth("alice"))
    assert resp.status_code == 404 and resp.json()["error"]["type"] == NOT_FOUND
    # The correct-type route still works for the owner (no false positives).
    assert (await client.get(f"/v2/{KV}/{kv}", headers=auth("alice"))).status_code == 200
    # A write to the wrong-type route is likewise 404 and does not auto-create.
    wrong_write = await client.post(
        f"/v2/{DS}/{kv}/items",
        content=json.dumps({"x": 1}),
        headers={**auth("alice"), "content-type": "application/json"},
    )
    assert wrong_write.status_code == 404 and wrong_write.json()["error"]["type"] == NOT_FOUND


# -- create-echo 409 when the computed id is owned by another -------------
# With per-user namespacing a create always targets `{caller}~{name}`, so this
# branch is unreachable through the public API; seed the row directly to give the
# defensive branch regression coverage and prove it never leaks the other owner.
async def test_create_storage_conflict_on_foreign_owned_id(wired):
    client, service = wired
    # Seed a storages row at the exact id alice's create-echo would compute, owned
    # by bob (only reachable via direct seeding under the namespacing invariant).
    await service.ensure_storage("alice~conflict", STORAGE_KV, "bob")
    resp = await client.post(
        "/v2/key-value-stores", json={"name": "conflict"}, headers=auth("alice")
    )
    assert resp.status_code == 409
    assert resp.json()["error"]["type"] == "resource-conflict"
    # The other owner's name is never leaked in the conflict response.
    assert "bob" not in resp.text


# -- Console (criteria 22-23) ---------------------------------------------
async def test_console_has_login_and_per_user_tabs(wired):
    client, _ = wired
    index = (await client.get("/")).text
    app_js = (await client.get("/console/app.js")).text
    # No longer the fixed single-user text.
    assert "(single local user)" not in index
    # Login affordance + current-user display.
    assert 'id="login-btn"' in index
    assert 'id="current-user"' in index
    # Three per-object-type top-level tabs.
    for tab in ('id="tab-actors"', 'id="tab-builds"', 'id="tab-runs"'):
        assert tab in index
    # Backed by the per-user aggregate endpoints and the token is sent.
    for endpoint in ("/v2/users/me/actors", "/v2/users/me/builds", "/v2/users/me/runs"):
        assert endpoint in app_js
    assert "Authorization" in app_js and "Bearer" in app_js

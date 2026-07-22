"""Multi-user and decoupled-identity behaviour: per-user ownership, isolation,
and namespaced storage creation. Storage-sharing (grant/revoke) coverage lives
in `tests/unit/test_storage_sharing.py`.

Identity (username) and credential (token) are decoupled: a user is created
explicitly (username == token for console-created users), the default user
``local-user`` is bootstrapped by the first token presented (or acts token-less),
and a token matching no user after bootstrap is rejected (401). Everything runs
Docker-free via the ``wired`` fixture; the acting user is chosen per request with
``Authorization: Bearer <token>``.
"""
from __future__ import annotations

import asyncio
import json

from app.service import STORAGE_KV

from _provisioning_harness import (  # noqa: F401 - `_seed_users` is autouse, applied via import
    _create_user,
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


# -- Decoupled identity, bootstrap, reject --------------------------------
async def test_token_selects_user_and_users_me_reflects_it(wired):
    client, _ = wired
    # alice/bob are real users (seeded); their tokens select them.
    alice = (await client.get("/v2/users/me", headers=auth("alice"))).json()["data"]
    bob = (await client.get("/v2/users/me", headers=auth("bob"))).json()["data"]
    assert alice["username"] == "alice"
    assert bob["username"] == "bob"
    assert alice["username"] != bob["username"]
    assert alice["username"] != "local-user"


async def test_username_and_token_are_decoupled(wired):
    # A console-created user has username == token; the default user, once
    # bootstrapped, has a token unequal to its username. The two identities are
    # independent -- neither username is derived from the other's token.
    client, _ = wired
    await _create_user(client, "n1")
    await client.get("/v2/users/me", headers=auth("boot-xyz"))  # bootstrap local-user
    users = {u["username"]: u["token"] for u in (await client.get("/v2/users")).json()["data"]["items"]}
    assert users["n1"] == "n1"
    assert users["local-user"] == "boot-xyz"
    assert users["local-user"] != "local-user"  # token != username for the default user
    # Each token resolves to its own username, not a derivation of the other.
    assert (await client.get("/v2/users/me", headers=auth("n1"))).json()["data"]["username"] == "n1"
    assert (await client.get("/v2/users/me", headers=auth("boot-xyz"))).json()["data"]["username"] == "local-user"


async def test_known_token_resolves_consistently(wired):
    client, _ = wired
    await _push(client, "sample-actor", "kt")
    # Repeated requests with the same known token resolve to the same user + object.
    for _ in range(2):
        me = (await client.get("/v2/users/me", headers=auth("kt"))).json()["data"]
        assert me["username"] == "kt"
        listing = (await client.get("/v2/users/me/actors", headers=auth("kt"))).json()["data"]
        assert [a["name"] for a in listing["items"]] == ["sample-actor"]


async def test_no_token_is_default_local_user(wired):
    client, _ = wired
    me = (await client.get("/v2/users/me")).json()["data"]
    assert me["username"] == "local-user"
    actor = (await client.post("/v2/acts", json={"name": "noauth"})).json()["data"]
    assert actor["id"] == "local-user~noauth"


async def test_bootstrap_first_token_binds_default_and_persists(wired):
    client, _ = wired
    # The first present token acts as the default user (not a new user, not the token).
    me = (await client.get("/v2/users/me", headers=auth("first-boot-tok"))).json()["data"]
    assert me["username"] == "local-user"
    actor = (await client.post("/v2/acts", json={"name": "boot"}, headers=auth("first-boot-tok"))).json()["data"]
    assert actor["id"] == "local-user~boot"
    assert actor["userId"] == "local-user"
    # A subsequent no-token request still resolves to the same default user + sees it.
    listing = (await client.get("/v2/users/me/actors")).json()["data"]
    assert "local-user~boot" in [a["id"] for a in listing["items"]]


async def test_unknown_token_rejected_after_claim(wired):
    client, _ = wired
    # Claim the default user's credential (bootstrap).
    claimed = await client.get("/v2/users/me", headers=auth("claim-tok"))
    assert claimed.status_code == 200 and claimed.json()["data"]["username"] == "local-user"
    # A different, never-seen token is now rejected with 401 + the Apify envelope.
    rejected = await client.get("/v2/users/me", headers=auth("intruder-xyz"))
    assert rejected.status_code == 401
    assert rejected.json()["error"]["type"] == "invalid-token"
    # No side effect: a create attempt is also rejected, and nothing was provisioned.
    created = await client.post("/v2/acts", json={"name": "sneaky"}, headers=auth("intruder-xyz"))
    assert created.status_code == 401
    users = (await client.get("/v2/users")).json()["data"]["items"]
    assert all(u["username"] != "intruder-xyz" for u in users)
    assert all(u["token"] != "intruder-xyz" for u in users)
    my_actors = (await client.get("/v2/users/me/actors")).json()["data"]["items"]
    assert all(a["name"] != "sneaky" for a in my_actors)


async def test_absent_header_is_never_rejected(wired):
    client, _ = wired
    # Even after a token is claimed and another rejected, a bare request succeeds.
    await client.get("/v2/users/me", headers=auth("claimer-tok"))
    assert (await client.get("/v2/users/me", headers=auth("stranger-tok"))).status_code == 401
    me = await client.get("/v2/users/me")
    assert me.status_code == 200
    assert me.json()["data"]["username"] == "local-user"


async def test_create_user_token_equals_name(wired):
    client, _ = wired
    created = await client.post("/v2/users", json={"name": "charlie"})
    assert created.status_code == 201
    body = created.json()["data"]
    assert body["username"] == "charlie" and body["token"] == "charlie"
    # The name works as a bearer token (token == name for console-created users).
    me = (await client.get("/v2/users/me", headers=auth("charlie"))).json()["data"]
    assert me["username"] == "charlie"
    # token == name does NOT apply to the default user's bootstrap credential.
    await client.get("/v2/users/me", headers=auth("some-bootstrap-token"))
    users = {u["username"]: u["token"] for u in (await client.get("/v2/users")).json()["data"]["items"]}
    assert users["local-user"] == "some-bootstrap-token" != "local-user"


async def test_duplicate_user_name_conflicts(wired):
    client, _ = wired
    assert (await client.post("/v2/users", json={"name": "dupe"})).status_code == 201
    second = await client.post("/v2/users", json={"name": "dupe"})
    assert second.status_code == 409
    assert second.json()["error"]["type"] == "resource-conflict"
    users = (await client.get("/v2/users")).json()["data"]["items"]
    assert sum(1 for u in users if u["username"] == "dupe") == 1


async def test_concurrent_bootstrap_binds_exactly_one_winner(wired):
    # Two concurrent first-tokens race for the bootstrap slot. Exactly one may win
    # the compare-and-swap; the loser must NOT be told it bootstrapped and then be
    # rejected later. Regression for the non-atomic get->check->set bind, which
    # could report True to both callers while only one token actually persisted.
    client, service = wired
    results = await asyncio.gather(
        service.bind_default_token("race-A"),
        service.bind_default_token("race-B"),
    )
    assert sum(1 for r in results if r) == 1  # exactly one caller won the CAS
    winner = (await service.get_user("local-user")).token
    assert winner in ("race-A", "race-B")
    loser = "race-B" if winner == "race-A" else "race-A"
    # The winner's token consistently resolves to the default user on a later request.
    me = await client.get("/v2/users/me", headers=auth(winner))
    assert me.status_code == 200 and me.json()["data"]["username"] == "local-user"
    # The loser's token is rejected (401) on a later request — never a "successful"
    # bootstrap that is later 401'd.
    rejected = await client.get("/v2/users/me", headers=auth(loser))
    assert rejected.status_code == 401
    assert rejected.json()["error"]["type"] == "invalid-token"


async def test_higher_concurrency_bootstrap_binds_exactly_one_winner(wired):
    # Beyond the 2-way race: 8 concurrent first-tokens contend for the single
    # bootstrap slot on a fresh DB. Exactly one wins the CAS, NONE raises (no
    # "database is locked" OperationalError propagating as a 500), the winner's
    # token later resolves to the default user, and every loser is rejected 401.
    # Deterministic and fast (one fresh DB, tiny UPDATEs serialized by the engine
    # busy timeout).
    client, service = wired
    tokens = [f"race-{i}" for i in range(8)]
    results = await asyncio.gather(
        *(service.bind_default_token(t) for t in tokens),
        return_exceptions=True,
    )
    assert not any(isinstance(r, BaseException) for r in results)  # no 500/exception
    assert sum(1 for r in results if r is True) == 1  # exactly one caller won the CAS
    winner = (await service.get_user("local-user")).token
    assert winner in tokens
    me = await client.get("/v2/users/me", headers=auth(winner))
    assert me.status_code == 200 and me.json()["data"]["username"] == "local-user"
    for loser in (t for t in tokens if t != winner):
        rejected = await client.get("/v2/users/me", headers=auth(loser))
        assert rejected.status_code == 401
        assert rejected.json()["error"]["type"] == "invalid-token"


async def test_create_user_rejects_non_string_name_no_500(wired):
    # A non-string ``name`` (int, null, list, dict, bool) must be rejected 400
    # invalid-request via the isinstance guard -- never an unhandled TypeError /
    # bare 500 -- and must create no user.
    client, _ = wired
    before = {u["username"] for u in (await client.get("/v2/users")).json()["data"]["items"]}
    for bad in (123, None, ["x"], {"k": "v"}, True):
        resp = await client.post("/v2/users", json={"name": bad})
        assert resp.status_code == 400, bad
        assert resp.json()["error"]["type"] == "invalid-request"
    after = {u["username"] for u in (await client.get("/v2/users")).json()["data"]["items"]}
    assert before == after  # no user created by any rejected request


async def test_create_user_rejects_all_punctuation_names(wired):
    # A "safe" name must contain at least one alphanumeric char; all-punctuation
    # names (``.``, ``..``, ``---``) are rejected 400 while a normal name works.
    client, _ = wired
    for bad in (".", "..", "---", "_", "._-"):
        resp = await client.post("/v2/users", json={"name": bad})
        assert resp.status_code == 400, bad
        assert resp.json()["error"]["type"] == "invalid-request"
    users = {u["username"] for u in (await client.get("/v2/users")).json()["data"]["items"]}
    assert not ({".", "..", "---", "_", "._-"} & users)
    ok = await client.post("/v2/users", json={"name": "normal-name.1"})
    assert ok.status_code == 201 and ok.json()["data"]["username"] == "normal-name.1"


async def test_create_user_rejects_unsafe_names_and_keeps_id_scheme(wired):
    # A ``~`` or ``/`` in a username would break the ``username~name`` id scheme and
    # storage-id namespacing (self-locking the user out of storage auto-create), so
    # such names are rejected 400 and no user is created.
    client, _ = wired
    for bad in ("carol~evil", "carol/evil", ""):
        resp = await client.post("/v2/users", json={"name": bad})
        assert resp.status_code == 400, bad
        assert resp.json()["error"]["type"] == "invalid-request"
    users = {u["username"] for u in (await client.get("/v2/users")).json()["data"]["items"]}
    assert "carol~evil" not in users and "carol/evil" not in users
    # A valid name works and can drive the full per-user storage flow.
    ok = await client.post("/v2/users", json={"name": "carol"})
    assert ok.status_code == 201
    put = await client.put(
        f"/v2/{KV}/carol~default/records/foo",
        content=json.dumps({"hi": 1}),
        headers={**auth("carol"), "content-type": "application/json"},
    )
    assert put.status_code == 200
    got = await client.get(f"/v2/{KV}/carol~default/records/foo", headers=auth("carol"))
    assert got.status_code == 200 and got.json() == {"hi": 1}


async def test_create_user_name_colliding_with_bound_token_reports_accurately(wired):
    # A create-user name may collide with an existing user's unique *token* rather
    # than a username (here the default user's bootstrap token). It is still a 409
    # resource-conflict, but the message must not claim a *user named X* exists.
    client, _ = wired
    boot = await client.get("/v2/users/me", headers=auth("shared"))
    assert boot.status_code == 200 and boot.json()["data"]["username"] == "local-user"
    resp = await client.post("/v2/users", json={"name": "shared"})
    assert resp.status_code == 409
    assert resp.json()["error"]["type"] == "resource-conflict"
    message = resp.json()["error"]["message"]
    assert "already exists" not in message  # no such *username* exists
    assert "token" in message
    # No corruption: no username "shared", and the default user keeps token "shared".
    users = {u["username"]: u["token"] for u in (await client.get("/v2/users")).json()["data"]["items"]}
    assert "shared" not in users
    assert users["local-user"] == "shared"


async def test_list_users_and_me_expose_tokens(wired):
    client, _ = wired
    await _create_user(client, "u1")
    await _create_user(client, "u2")
    users = {u["username"]: u for u in (await client.get("/v2/users")).json()["data"]["items"]}
    assert users["u1"]["token"] == "u1"
    assert users["u2"]["token"] == "u2"
    assert "local-user" in users  # the default user is listed too
    me = (await client.get("/v2/users/me", headers=auth("u1"))).json()["data"]
    assert me["username"] == "u1" and me["id"] == "u1" and me["token"] == "u1"


async def test_container_env_user_id_is_username(wired):
    client, service = wired
    _actor_id, _build, _run = await _provision(client, service, "alice")
    env = service.driver.captured_envs[-1]
    assert env["APIFY_USER_ID"] == "alice"


# -- GET /v2/users/{userIdOrUsername} (public profile, any user) ----------
# Id and username are the same value in this runtime (a `User` row's primary
# key IS its username -- see `test_container_env_user_id_is_username` above
# for the same fact from the container-env side), so "by id" and "by
# username" below exercise the identical lookup path.
async def test_get_user_by_id_or_username_returns_public_data(wired):
    client, _ = wired
    resp = await client.get("/v2/users/alice", headers=auth("bob"))
    assert resp.status_code == 200
    body = resp.json()["data"]
    assert body["username"] == "alice"
    assert body["id"] == "alice"
    # Public data only -- never the target's token, unlike /v2/users/me.
    assert "token" not in body


async def test_get_user_by_id_or_username_no_token_still_resolves(wired):
    client, _ = wired
    # No token is never rejected here either -- same policy as every other route.
    resp = await client.get("/v2/users/bob")
    assert resp.status_code == 200
    assert resp.json()["data"]["username"] == "bob"


async def test_get_user_unknown_id_or_username_is_404(wired):
    client, _ = wired
    resp = await client.get("/v2/users/does-not-exist", headers=auth("alice"))
    assert resp.status_code == 404
    assert resp.json()["error"]["type"] == "record-not-found"


async def test_get_user_by_id_rejects_unknown_token_after_bootstrap(wired):
    client, _ = wired
    # Same bootstrap-or-reject guard as every other authenticated route (see
    # test_unknown_token_rejected_after_claim): claim the default user's
    # credential first, then a genuinely unknown token is rejected.
    claimed = await client.get("/v2/users/me", headers=auth("claim-tok"))
    assert claimed.status_code == 200
    rejected = await client.get("/v2/users/alice", headers=auth("intruder-xyz"))
    assert rejected.status_code == 401
    assert rejected.json()["error"]["type"] == "invalid-token"


async def test_get_user_me_route_still_takes_priority_over_path_param(wired):
    client, _ = wired
    # Regression: the new `/v2/users/{user_id_or_username}` route must not
    # shadow the literal `/v2/users/me` route declared above it -- `me` must
    # keep resolving to the acting user (with `token`), not a public lookup
    # for a user literally named "me".
    resp = await client.get("/v2/users/me", headers=auth("alice"))
    assert resp.status_code == 200
    assert resp.json()["data"]["username"] == "alice"
    assert resp.json()["data"]["token"] == "alice"


# -- THE ANTI-LEAK GUARANTEE (narrowed) ------------------------------------
# Scope: this guarantee covers exactly the FIRST BOUND token -- the
# credential apify-cli's first-ever request presented, bound to the default
# local-user, which may be a real
# externally-issued secret. It does NOT cover every token in the system:
# every user's ``container_token`` (injected as APIFY_TOKEN -- see
# service._build_environment) is a runtime-fabricated credential and is BY
# DESIGN expected to appear in container env; that is exactly the mechanism
# the positive half of this test asserts below, not something this guarantee
# forbids.
async def test_secret_token_never_leaks_into_ids_responses_or_env(wired):
    client, service = wired
    secret = "apify_api_SECRET123"
    actor = (await client.post("/v2/acts", json={"name": "leaky"}, headers=auth(secret))).json()["data"]
    await client.post(
        f"/v2/actors/{actor['id']}/versions",
        json={
            "versionNumber": "0.0",
            "sourceType": "SOURCE_FILES",
            "sourceFiles": [{"name": "main.py", "format": "TEXT", "content": "print('hi')\n"}],
        },
        headers=auth(secret),
    )
    build = (
        await client.post(f"/v2/acts/{actor['id']}/builds?version=0.0", headers=auth(secret))
    ).json()["data"]
    await service.wait_idle()
    run = (
        await client.post(
            f"/v2/acts/{actor['id']}/runs",
            content=json.dumps({"greeting": "hi"}),
            headers={**auth(secret), "content-type": "application/json"},
        )
    ).json()["data"]
    await service.wait_idle()
    run = (await client.get(f"/v2/actor-runs/{run['id']}", headers=auth(secret))).json()["data"]
    fetched_build = (await client.get(f"/v2/actor-builds/{build['id']}", headers=auth(secret))).json()["data"]

    # Identity fields are the default username, never the token.
    assert actor["id"] == "local-user~leaky"
    for obj in (actor, fetched_build, run):
        assert obj["userId"] == "local-user"
        assert obj["username"] == "local-user"

    build_row = await service.get_build(build["id"])
    env = service.driver.captured_envs[-1]
    assert env["APIFY_USER_ID"] == "local-user"

    # -- Negative half: the bound secret appears NOWHERE, including as the
    # value of APIFY_TOKEN itself -- the one place it could plausibly have
    # coincided with the container credential had ``container_token`` not been
    # a distinct, second, fabricated value (this closes the gap the narrowed
    # scope note above calls out: local-user's own runs, where the bound token
    # and APIFY_TOKEN could otherwise coincide).
    haystacks = [
        actor["id"], actor["userId"], actor["username"],
        fetched_build["id"], fetched_build["userId"], fetched_build["username"],
        run["id"], run["userId"], run["username"], run["actId"],
        build_row.image_tag,
        run["defaultKeyValueStoreId"], run["defaultDatasetId"], run["defaultRequestQueueId"],
        *env.keys(), *[str(v) for v in env.values()],
    ]
    blob = "\n".join(str(h) for h in haystacks)
    assert secret not in blob, "raw token leaked into an id/response/tag/storage-id/env"
    assert "SECRET123" not in blob, "token fragment leaked"

    # -- Positive half: APIFY_TOKEN is nonetheless a WORKING credential for
    # local-user. The anti-leak guarantee narrows to the bound
    # secret; it does not (and must not) forbid a *different*, fabricated
    # token from doing its job as a real bearer credential.
    assert env["APIFY_TOKEN"]
    assert env["APIFY_TOKEN"] != secret
    me = (
        await client.get("/v2/users/me", headers={"Authorization": f"Bearer {env['APIFY_TOKEN']}"})
    ).json()["data"]
    assert me["username"] == "local-user"


# -- Per-user ownership ----------------------------------------------------
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


# -- Strict isolation, Actors/Builds/Runs ----------------------------------
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
        f"/v2/actors/{alice_actor}/input-schema",
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


# -- Owner drives own flow incl. storages ----------------------------------
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


# -- Run-storage isolation, READ -------------------------------------------
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


# -- Run-storage isolation, WRITE ------------------------------------------
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


async def test_write_autocreate_rejects_invalid_embedded_name(wired):
    """A write to an absent, caller-chosen namespaced id (``owner~name`` or
    ``owner~{type}~name``) must reject a ``name`` portion that would not pass
    `validate_storage_name` -- not only bare `POST .../key-value-stores?name=`
    calls, which already reject it.

    Unlike a name chosen through the documented ``POST ...?name=`` route, a
    write's target ``store_id`` is an arbitrary URL path segment: the caller
    can put anything after the owner's ``~`` prefix, including something that
    is not a valid storage name at all. Without this check, the write would
    still auto-create a row there, and a later ``GET`` would hand back that
    invalid string verbatim as the storage's ``name`` field -- exactly the
    shape crawlee's own domain objects reject the instant a real SDK Actor
    opens a storage by that name.
    """
    client, _ = wired
    for bad_id in (
        "alice~has_underscore",  # underscore is not in NAME_REGEX
        "alice~-leading-hyphen",
        "alice~fake-type~name",  # not a real type prefix -> derived name still has "~"
        "alice~",  # empty name
    ):
        resp = await client.put(
            f"/v2/{KV}/{bad_id}/records/X",
            content=json.dumps({"who": "alice"}),
            headers={**auth("alice"), "content-type": "application/json"},
        )
        assert resp.status_code == 404, f"{bad_id!r}: expected 404, got {resp.status_code} ({resp.text})"
        # Nothing was minted at that id -- not even visible to its own writer.
        assert (await client.get(f"/v2/{KV}/{bad_id}", headers=auth("alice"))).status_code == 404

    # A validly-named namespaced id is unaffected -- still auto-creates.
    ok = await client.put(
        f"/v2/{KV}/alice~valid-name/records/X",
        content=json.dumps({"who": "alice"}),
        headers={**auth("alice"), "content-type": "application/json"},
    )
    assert ok.status_code == 200
    assert (await client.get(f"/v2/{KV}/alice~valid-name", headers=auth("alice"))).status_code == 200


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
# write with no grant. `ensure_storage` must be
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


# -- Console (Users section + switch dropdown) ----------------------------
async def test_console_has_login_and_per_user_tabs(wired):
    client, _ = wired
    index = (await client.get("/")).text
    app_js = (await client.get("/console/app.js")).text
    # No longer the fixed single-user text.
    assert "(single local user)" not in index
    # Switch-user control is now a dropdown of existing users; current-user display kept.
    assert 'id="user-select"' in index
    assert 'id="current-user"' in index
    assert "prompt(" not in app_js or "Enter your API token" not in app_js  # no free-text token prompt
    # Top-level nav is the three new sections; Builds and Runs are no longer
    # top-level (they live under an actor's detail).
    for tab in ('id="tab-actors"', 'id="tab-storage"', 'id="tab-users"'):
        assert tab in index
    for gone in ('id="tab-builds"', 'id="tab-runs"'):
        assert gone not in index
    # The actors list is backed by the per-user aggregate endpoint; an actor's
    # builds/runs are fetched from that actor's own per-actor endpoints; the token
    # is sent.
    assert "/v2/users/me/actors" in app_js
    assert "/v2/acts/${actorId}/builds" in app_js
    assert "/v2/acts/${actorId}/runs" in app_js
    assert "Authorization" in app_js and "Bearer" in app_js


async def test_console_users_section_wires_list_reveal_switch_create(wired):
    client, _ = wired
    app_js = (await client.get("/console/app.js")).text
    # Users view + header dropdown are populated from GET /v2/users.
    assert "/v2/users" in app_js
    # Create-by-name posts to the users endpoint; switch sets the target's token.
    assert "createUser" in app_js and "switchTo" in app_js and "setToken" in app_js
    # Reveal/switch/create are wired with addEventListener, never inline handlers.
    assert "addEventListener" in app_js
    for handler in ("onclick=", "onload=", "onerror="):
        assert handler not in app_js.lower()
    # Every fetch still routes through the shared authenticated helper.
    assert "async function api(" in app_js

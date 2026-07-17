"""Standby-actor coverage: opt-in parsing, standbyUrl, env-dict alignment,
forwarding/readiness/auth/visibility, and idle reap -- all Docker-free via the
in-process ``wired`` / ``wired_fast_standby`` fixtures (StubDriver +
FakeStandbyServer, see tests/conftest.py).
"""
from __future__ import annotations

import asyncio
import json
import re
import time

from starlette.requests import Request

from app.routers.standby import forward_to_standby

NOT_FOUND = "record-not-found"


def auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


async def _create_user(client, name):
    await client.post("/v2/users", json={"name": name})


def _standby_manifest(name: str, uses_standby_mode: bool = True) -> str:
    return json.dumps(
        {
            "actorSpecification": 1,
            "name": name,
            "version": "0.0",
            "buildTag": "latest",
            "usesStandbyMode": uses_standby_mode,
        }
    )


async def _push_actor(client, token, *, name="an-actor", manifest=None, actor_standby=None):
    """Push an Actor (creating ``token`` as a user first) and return its serialized body.

    ``manifest`` (if given) is written inline as ``.actor/actor.json``, exactly
    as ``apify push`` would send it -- this is how standby opt-in is signalled.
    """
    await _create_user(client, token)
    source_files = [{"name": "main.py", "format": "TEXT", "content": "print('hi')\n"}]
    if manifest is not None:
        source_files.append({"name": ".actor/actor.json", "format": "TEXT", "content": manifest})
    body = {
        "name": name,
        "versions": [
            {"versionNumber": "0.0", "sourceType": "SOURCE_FILES", "sourceFiles": source_files}
        ],
    }
    if actor_standby is not None:
        body["actorStandby"] = actor_standby
    resp = await client.post("/v2/acts", json=body, headers=auth(token))
    return resp.json()["data"]


async def _build(client, service, actor_id, token):
    build = (
        await client.post(f"/v2/acts/{actor_id}/builds?version=0.0", headers=auth(token))
    ).json()["data"]
    await service.wait_idle()
    return build


async def _provision_standby_actor(client, service, token, name="standby-actor"):
    actor = await _push_actor(client, token, name=name, manifest=_standby_manifest(name))
    await _build(client, service, actor["id"], token)
    return actor["id"]


async def _provision_ondemand_run(client, service, token, name="on-demand-actor", greeting="hi"):
    actor = await _push_actor(client, token, name=name)
    await _build(client, service, actor["id"], token)
    run = (
        await client.post(
            f"/v2/acts/{actor['id']}/runs",
            content=json.dumps({"greeting": greeting}),
            headers={**auth(token), "content-type": "application/json"},
        )
    ).json()["data"]
    await service.wait_idle()
    run = (await client.get(f"/v2/actor-runs/{run['id']}", headers=auth(token))).json()["data"]
    return actor["id"], run


# -- A. Standby opt-in and actor metadata (criteria 1-3) -------------------
async def test_actor_json_uses_standby_mode_enables_standby_and_url(wired):
    client, service = wired
    actor_id = await _provision_standby_actor(client, service, "alice")
    actor = (await client.get(f"/v2/actors/{actor_id}", headers=auth("alice"))).json()["data"]
    assert actor.get("standbyUrl") == f"http://actor-runtime:3333/v2/actor-standby/{actor_id}"


async def test_actor_without_uses_standby_mode_has_no_standby_url(wired):
    client, _ = wired
    actor = await _push_actor(client, "bob", name="plain-actor")
    assert "standbyUrl" not in actor


async def test_explicit_api_field_overrides_actor_json_in_same_push(wired):
    """apify-core's own precedence rule: the API payload's ``actorStandby``
    always wins over ``.actor/actor.json``'s ``usesStandbyMode`` when both are
    present on the SAME create call."""
    client, _ = wired
    actor = await _push_actor(
        client, "carol", name="override-actor",
        manifest=_standby_manifest("override-actor", uses_standby_mode=True),
        actor_standby={"isEnabled": False},
    )
    assert "standbyUrl" not in actor


async def test_explicit_override_persists_across_later_actor_json_only_push(wired):
    """Regression: design decision 2 states an explicit ``actorStandby`` field
    "persists until the next call that carries an explicit actorStandby
    field" -- a LATER push that carries only ``.actor/actor.json`` (no
    ``actorStandby`` field on that call) must not silently revert a
    previously-set explicit override by re-inferring from ``usesStandbyMode``.
    """
    client, _ = wired
    manifest = _standby_manifest("explicit-actor", uses_standby_mode=True)

    # Call 1: explicit override disables standby even though actor.json says
    # usesStandbyMode: true.
    actor = await _push_actor(
        client, "erin", name="explicit-actor", manifest=manifest, actor_standby={"isEnabled": False},
    )
    assert "standbyUrl" not in actor

    # Call 2: a plain actor.json-only push (no actorStandby field at all) --
    # must NOT re-enable standby by inferring from usesStandbyMode again.
    actor = await _push_actor(client, "erin", name="explicit-actor", manifest=manifest)
    assert "standbyUrl" not in actor

    # A THIRD call with its own explicit field still takes precedence (the
    # override is not permanently frozen, only sticky until the next explicit
    # call, exactly as decision 2 says).
    actor = await _push_actor(
        client, "erin", name="explicit-actor", manifest=manifest, actor_standby={"isEnabled": True},
    )
    assert actor.get("standbyUrl")


async def test_non_standby_actor_behaves_exactly_as_before(wired):
    """Regression: an Actor pushed without usesStandbyMode still runs on-demand,
    with no standby container and no standbyUrl."""
    client, service = wired
    actor_id, run = await _provision_ondemand_run(client, service, "dave")
    assert run["status"] == "SUCCEEDED"
    actor = (await client.get(f"/v2/actors/{actor_id}", headers=auth("dave"))).json()["data"]
    assert "standbyUrl" not in actor


# -- D. Environment-variable alignment (criteria 15-19, 21) ----------------
async def test_env_dict_alignment_for_every_run(wired):
    client, service = wired
    actor_id, run = await _provision_ondemand_run(client, service, "alice")
    env = service.driver.captured_envs[-1]

    assert env["APIFY_IS_AT_HOME"] == "1"
    assert env["APIFY_API_BASE_URL"] == "http://actor-runtime:3333"
    assert env["APIFY_META_ORIGIN"] == "API"

    assert env["APIFY_DEFAULT_KEY_VALUE_STORE_ID"] == run["defaultKeyValueStoreId"]
    assert env["APIFY_DEFAULT_DATASET_ID"] == run["defaultDatasetId"]
    assert env["APIFY_DEFAULT_REQUEST_QUEUE_ID"] == run["defaultRequestQueueId"]

    assert env["ACTOR_ID"] == env["APIFY_ACTOR_ID"] == actor_id
    assert env["ACTOR_RUN_ID"] == env["APIFY_ACTOR_RUN_ID"] == run["id"]

    # APIFY_TOKEN is a WORKING bearer credential for the owner, distinct from
    # the bound token ("alice") used to authenticate the calls above.
    assert env["APIFY_TOKEN"] != "alice"
    me = (await client.get("/v2/users/me", headers={"Authorization": f"Bearer {env['APIFY_TOKEN']}"})).json()["data"]
    assert me["username"] == "alice"


async def test_apify_token_env_tracks_owner_across_users(wired):
    """The container token is per-owner, not a constant -- exercised for two
    different users so the value is shown to track ownership, not be fixed."""
    client, service = wired
    await _provision_ondemand_run(client, service, "alice")
    token_alice = service.driver.captured_envs[-1]["APIFY_TOKEN"]
    await _provision_ondemand_run(client, service, "bob")
    token_bob = service.driver.captured_envs[-1]["APIFY_TOKEN"]
    assert token_alice != token_bob

    me_alice = (await client.get("/v2/users/me", headers={"Authorization": f"Bearer {token_alice}"})).json()["data"]
    me_bob = (await client.get("/v2/users/me", headers={"Authorization": f"Bearer {token_bob}"})).json()["data"]
    assert me_alice["username"] == "alice"
    assert me_bob["username"] == "bob"


# -- B. Warm start, readiness, forwarding, authorization (criteria 4-11) ---
async def test_standby_cold_start_forwards_and_reuses_warm_container(wired_fast_standby):
    client, service = wired_fast_standby
    actor_id = await _provision_standby_actor(client, service, "alice")

    # Before any request: no run yet (criterion 4).
    runs = (await client.get(f"/v2/acts/{actor_id}/runs", headers=auth("alice"))).json()["data"]["items"]
    assert runs == []

    resp1 = await client.get(f"/v2/actor-standby/{actor_id}/echo?greeting=hi", headers=auth("alice"))
    assert resp1.status_code == 200
    body1 = resp1.json()
    assert body1["method"] == "GET"
    assert body1["path"] == "/echo?greeting=hi"
    assert body1["requestCount"] == 1

    # Standby-origin runs carry the platform-documented mode signal, so an
    # Actor can branch on standby vs standard start.
    standby_env = service.driver.captured_envs[-1]
    assert standby_env["APIFY_META_ORIGIN"] == "STANDBY"
    assert standby_env["ACTOR_STANDBY_PORT"]

    runs = (await client.get(f"/v2/acts/{actor_id}/runs", headers=auth("alice"))).json()["data"]["items"]
    assert len(runs) == 1
    assert runs[0]["status"] == "RUNNING"
    first_run_id = runs[0]["id"]

    # Second request while still warm reuses the SAME container: no new run,
    # and the fake Actor's in-memory counter proves it's the same process.
    resp2 = await client.get(f"/v2/actor-standby/{actor_id}/echo?greeting=hi", headers=auth("alice"))
    assert resp2.json()["requestCount"] == 2
    runs = (await client.get(f"/v2/acts/{actor_id}/runs", headers=auth("alice"))).json()["data"]["items"]
    assert len(runs) == 1
    assert runs[0]["id"] == first_run_id


async def test_standby_forwards_method_headers_query_and_body_exactly(wired_fast_standby):
    client, service = wired_fast_standby
    actor_id = await _provision_standby_actor(client, service, "alice")
    resp = await client.post(
        f"/v2/actor-standby/{actor_id}/submit?x=1&y=2",
        content=json.dumps({"hello": "world"}),
        headers={**auth("alice"), "content-type": "application/json", "x-custom-header": "abc123"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["method"] == "POST"
    assert body["path"] == "/submit?x=1&y=2"
    assert json.loads(body["body"]) == {"hello": "world"}
    assert body["headers"].get("x-custom-header") == "abc123"


async def test_standby_unset_memory_config_caps_container_at_the_same_1024_default(wired_fast_standby):
    """Regression: an unset ``memoryMbytes`` in the Actor's standby config must
    resolve to the SAME 1024 MB default in both the persisted
    ``run.options.memoryMbytes`` (what the API reports) and the actual value
    passed to the driver's ``start()`` (what would really cap the container) --
    previously these diverged, so a standby actor with no explicit memory
    config ran genuinely uncapped despite the API reporting a 1024 MB cap.
    """
    client, service = wired_fast_standby
    actor_id = await _provision_standby_actor(client, service, "alice")

    resp = await client.get(f"/v2/actor-standby/{actor_id}/echo", headers=auth("alice"))
    assert resp.status_code == 200

    runs = (await client.get(f"/v2/acts/{actor_id}/runs", headers=auth("alice"))).json()["data"]["items"]
    assert runs[0]["options"]["memoryMbytes"] == 1024
    assert service.driver.captured_mem_limits[-1] == 1024


def _standby_request(app, actor_id: str, path: str, token: str) -> Request:
    """A minimal ASGI request for driving ``forward_to_standby`` directly.

    httpx's ``ASGITransport`` (used by the ``client`` the ``wired*`` fixtures
    hand back) fully drains a ``StreamingResponse``'s body before returning
    ANYTHING to the caller -- see ``tests/unit/test_console_api_extensions.py``'s
    ``_stream_request`` helper, which documents and works around the exact
    same limitation for the build/run log-streaming endpoint. Proving the
    standby-forwarding response is genuinely streamed (not buffered) therefore
    requires calling the router function directly and iterating the returned
    ``StreamingResponse.body_iterator`` -- fed by the real (loopback-socket)
    connection to the fake standby target -- instead of going through the
    httpx client.
    """

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    scope = {
        "type": "http",
        "method": "GET",
        "path": f"/v2/actor-standby/{actor_id}/{path}",
        "query_string": b"",
        "headers": [(b"authorization", f"Bearer {token}".encode())],
        "app": app,
    }
    return Request(scope, receive=receive)


async def test_standby_response_streams_incrementally_not_fully_buffered(wired_fast_standby):
    """Criterion 7's streaming half: the forwarded response must reach the
    caller as it arrives, not be fully buffered by the runtime before the
    first byte is returned. The fake standby target's
    ``/stream-slow`` path (see ``_StandbyProbeHandler._handle_streamed`` in
    conftest.py) writes its body in three flushed chunks with a real 0.3s
    delay between them and closes the connection instead of declaring
    Content-Length. If the proxy buffered the whole body before returning
    anything, the first chunk would arrive at (approximately) the same time
    as the last one (~0.9s); observing it arrive well before that proves the
    proxy forwards bytes as they arrive instead.
    """
    client, service = wired_fast_standby
    app = client._transport.app
    actor_id = await _provision_standby_actor(client, service, "alice")

    request = _standby_request(app, actor_id, "stream-slow", "alice")
    response = await forward_to_standby(actor_id, "stream-slow", request)
    assert response.status_code == 200

    start = time.monotonic()
    chunk_times: list[float] = []
    chunks: list[bytes] = []
    async for part in response.body_iterator:
        chunk_times.append(time.monotonic() - start)
        chunks.append(part if isinstance(part, bytes) else part.encode())

    assert b"".join(chunks) == b"chunk-1\nchunk-2\nchunk-3\n"
    assert len(chunk_times) >= 2, chunk_times
    # A comfortable margin below the total elapsed time absorbs scheduling
    # jitter without making the test flaky, while still failing decisively if
    # the whole body were buffered before any of it were returned.
    assert chunk_times[0] < chunk_times[-1] * 0.6, chunk_times


async def test_standby_preserves_repeated_header_names_both_directions(wired_fast_standby):
    """Regression: forwarding must not silently drop repeated header names in
    either direction -- a plain dict comprehension keeps only the LAST value
    for a duplicated header name (e.g. two Cookie headers from the caller, or
    two Set-Cookie headers from the standby Actor), contradicting the
    "headers... unchanged" forwarding guarantee (criterion 7). Uses the same
    direct-router-call technique as the streaming test above (see
    ``_standby_request``) since httpx's ``ASGITransport`` would only expose
    the client's own multi-value request headers here, not let us inspect the
    proxy's OWN response headers object directly.
    """
    client, service = wired_fast_standby
    app = client._transport.app
    actor_id = await _provision_standby_actor(client, service, "alice")

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    scope = {
        "type": "http",
        "method": "GET",
        "path": f"/v2/actor-standby/{actor_id}/multi-header",
        "query_string": b"",
        "headers": [
            (b"authorization", b"Bearer alice"),
            (b"cookie", b"a=1"),
            (b"cookie", b"b=2"),
        ],
        "app": app,
    }
    request = Request(scope, receive=receive)

    response = await forward_to_standby(actor_id, "multi-header", request)
    assert response.status_code == 200

    # Response side: the fake standby target sent two Set-Cookie headers --
    # both must reach the original caller, not just the last one.
    assert response.headers.getlist("set-cookie") == ["a=1", "b=2"]

    # Request side: the fake standby target echoes exactly what it received
    # as an ordered list of pairs (never collapsed into a dict) -- both
    # Cookie headers sent by the caller must have reached it.
    body = b"".join([part async for part in response.body_iterator])
    received = json.loads(body)["receivedHeaderPairs"]
    cookie_values = [v for k, v in received if k.lower() == "cookie"]
    assert cookie_values == ["a=1", "b=2"], received


async def test_standby_never_ready_returns_503_not_hang(wired_fast_standby):
    client, service = wired_fast_standby
    actor_id = await _provision_standby_actor(client, service, "alice")
    service.driver.next_start_never_ready = True

    resp = await client.get(f"/v2/actor-standby/{actor_id}/echo", headers=auth("alice"))
    assert resp.status_code == 503

    # The failed attempt reaches a terminal status, never stuck RUNNING.
    runs = (await client.get(f"/v2/acts/{actor_id}/runs", headers=auth("alice"))).json()["data"]["items"]
    assert runs and runs[0]["status"] == "FAILED"


async def test_standby_never_ready_times_out_bounded_by_configured_setting(wired_fast_standby):
    """Regression: `_wait_standby_ready`'s per-attempt httpx timeout must scale
    with `settings.standby_ready_timeout_secs`, not be a fixed 5.0s -- otherwise
    a container that accepts the TCP connection but hangs before answering the
    readiness probe can make a single attempt block for the full fixed timeout
    regardless of a shrunk configured budget, so the configured value would not
    be a true upper bound on the total wait.

    `wired_fast_standby` sets `standby_ready_timeout_secs` to 1.0s. The fake
    standby server is made to hang for 8s before answering every readiness
    probe -- well past both the 1.0s configured budget and the old hardcoded
    5.0s per-attempt timeout. With the fix, the whole call must still return
    (503, never hang) within a couple of the configured seconds; the old,
    unbounded-by-setting 5.0s per-attempt timeout would instead make this take
    at least ~5s.
    """
    client, service = wired_fast_standby
    actor_id = await _provision_standby_actor(client, service, "alice")
    service.driver.next_start_readiness_hang_secs = 8.0

    started = time.monotonic()
    resp = await client.get(f"/v2/actor-standby/{actor_id}/echo", headers=auth("alice"))
    elapsed = time.monotonic() - started

    assert resp.status_code == 503
    # Bounded by (a small multiple of) the configured 1.0s readiness timeout,
    # not the old hardcoded 5.0s-per-attempt httpx client timeout.
    assert elapsed < 3.0, elapsed


async def test_standby_start_infra_failure_is_500_not_404(wired_fast_standby):
    """Regression: a `driver.start()` infrastructure failure (e.g. the shared
    Docker network never coming up at boot) must not collapse into the same
    404 used for "actor has no successful build" -- the build is fine, only
    launching its container failed, for a reason a developer debugging a
    "why won't my standby actor start" problem should not be misled about by
    a not-found response. It must surface as a 5xx naming the real cause.
    """
    client, service = wired_fast_standby
    actor_id = await _provision_standby_actor(client, service, "alice")

    def _boom(*args, **kwargs):
        raise RuntimeError("simulated docker network failure")

    service.driver.start = _boom

    resp = await client.get(f"/v2/actor-standby/{actor_id}/echo", headers=auth("alice"))
    assert resp.status_code == 500
    assert resp.json()["error"]["type"] != NOT_FOUND
    assert "simulated docker network failure" in resp.json()["error"]["message"]

    # The failed attempt still reaches a terminal status, never stuck RUNNING.
    runs = (await client.get(f"/v2/acts/{actor_id}/runs", headers=auth("alice"))).json()["data"]["items"]
    assert runs and runs[0]["status"] == "FAILED"


async def test_standby_missing_token_is_401_and_starts_nothing(wired_fast_standby):
    client, service = wired_fast_standby
    actor_id = await _provision_standby_actor(client, service, "alice")

    resp = await client.get(f"/v2/actor-standby/{actor_id}/echo")
    assert resp.status_code == 401

    runs = (await client.get(f"/v2/acts/{actor_id}/runs", headers=auth("alice"))).json()["data"]["items"]
    assert runs == []


async def test_standby_unknown_token_after_bootstrap_is_401_and_starts_nothing(wired_fast_standby):
    client, service = wired_fast_standby
    actor_id = await _provision_standby_actor(client, service, "alice")
    await client.get("/v2/users/me", headers=auth("claim-tok"))  # claim the bootstrap slot

    resp = await client.get(f"/v2/actor-standby/{actor_id}/echo", headers=auth("totally-unknown"))
    assert resp.status_code == 401

    runs = (await client.get(f"/v2/acts/{actor_id}/runs", headers=auth("alice"))).json()["data"]["items"]
    assert runs == []


async def test_standby_accepts_query_token_same_as_bearer(wired_fast_standby):
    client, service = wired_fast_standby
    actor_id = await _provision_standby_actor(client, service, "alice")
    resp = await client.get(f"/v2/actor-standby/{actor_id}/echo?token=alice")
    assert resp.status_code == 200


async def test_standby_cross_user_is_not_found_and_starts_nothing(wired_fast_standby):
    client, service = wired_fast_standby
    actor_id = await _provision_standby_actor(client, service, "alice")
    await _create_user(client, "bob")

    resp = await client.get(f"/v2/actor-standby/{actor_id}/echo", headers=auth("bob"))
    assert resp.status_code == 404
    assert resp.json()["error"]["type"] == NOT_FOUND

    runs = (await client.get(f"/v2/acts/{actor_id}/runs", headers=auth("alice"))).json()["data"]["items"]
    assert runs == []


async def test_standby_unknown_actor_id_is_not_found(wired_fast_standby):
    client, _ = wired_fast_standby
    resp = await client.get("/v2/actor-standby/local-user~does-not-exist/echo", headers=auth("whoever"))
    assert resp.status_code == 404
    assert resp.json()["error"]["type"] == NOT_FOUND


async def test_standby_non_standby_actor_is_not_found_and_starts_nothing(wired_fast_standby):
    client, service = wired_fast_standby
    actor = await _push_actor(client, "alice", name="plain-actor")
    await _build(client, service, actor["id"], "alice")

    resp = await client.get(f"/v2/actor-standby/{actor['id']}/echo", headers=auth("alice"))
    assert resp.status_code == 404
    assert resp.json()["error"]["type"] == NOT_FOUND

    runs = (await client.get(f"/v2/acts/{actor['id']}/runs", headers=auth("alice"))).json()["data"]["items"]
    assert runs == []


async def test_concurrent_first_requests_start_exactly_one_container(wired_fast_standby):
    client, service = wired_fast_standby
    actor_id = await _provision_standby_actor(client, service, "alice")

    results = await asyncio.gather(
        *(client.get(f"/v2/actor-standby/{actor_id}/echo", headers=auth("alice")) for _ in range(5))
    )
    assert all(r.status_code == 200 for r in results)

    runs = (await client.get(f"/v2/acts/{actor_id}/runs", headers=auth("alice"))).json()["data"]["items"]
    assert len(runs) == 1


# -- C. Idle timeout and teardown (criteria 12-14) -------------------------
async def test_reap_idle_standby_runs_single_pass_is_deterministic(wired_fast_standby):
    """A single, directly-invoked reap pass (no background timing involved) --
    proves the countdown logic itself, independent of the watchdog's own loop."""
    client, service = wired_fast_standby
    actor_id = await _provision_standby_actor(client, service, "alice")

    resp = await client.get(f"/v2/actor-standby/{actor_id}/echo", headers=auth("alice"))
    assert resp.status_code == 200

    await asyncio.sleep(0.25)  # exceed the fixture's 0.2s idle-timeout override
    await service.reap_idle_standby_runs()

    runs = (await client.get(f"/v2/acts/{actor_id}/runs", headers=auth("alice"))).json()["data"]["items"]
    assert runs[0]["status"] == "ABORTED"


async def test_standby_idle_teardown_captures_container_log(wired_fast_standby):
    """Regression: a standby run has no live log_sink like the blocking
    one-shot run path, so its container's stdout/stderr must be fetched
    explicitly at reap/teardown time instead of leaving Run.log permanently
    empty for the run's whole warm lifetime."""
    client, service = wired_fast_standby
    actor_id = await _provision_standby_actor(client, service, "alice")

    resp = await client.get(f"/v2/actor-standby/{actor_id}/echo", headers=auth("alice"))
    assert resp.status_code == 200
    runs = (await client.get(f"/v2/acts/{actor_id}/runs", headers=auth("alice"))).json()["data"]["items"]
    run_id = runs[0]["id"]

    await asyncio.sleep(0.25)  # exceed the fixture's 0.2s idle-timeout override
    await service.reap_idle_standby_runs()

    log = (await client.get(f"/v2/logs/{run_id}", headers=auth("alice"))).text
    assert f"stub container log for {service._container_name(run_id)}" in log
    assert "Standby Actor stopped after idle timeout." in log
    # Runtime-written log lines carry a UTC timestamp prefix (container output
    # gets its own per-line timestamps from Docker, which stubs don't emulate).
    assert re.search(
        r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z Standby Actor stopped after idle timeout\.$",
        log,
        re.MULTILINE,
    )


async def test_standby_warm_run_log_is_live_fetched_from_container(wired_fast_standby):
    """Regression: while a standby run is warm (RUNNING) its log exists only
    inside the container -- the log endpoint must fetch it live instead of
    serving the empty stored log until teardown persists it."""
    client, service = wired_fast_standby
    actor_id = await _provision_standby_actor(client, service, "alice")

    resp = await client.get(f"/v2/actor-standby/{actor_id}/echo", headers=auth("alice"))
    assert resp.status_code == 200
    runs = (await client.get(f"/v2/acts/{actor_id}/runs", headers=auth("alice"))).json()["data"]["items"]
    run_id = runs[0]["id"]
    assert runs[0]["status"] == "RUNNING"

    log = (await client.get(f"/v2/logs/{run_id}", headers=auth("alice"))).text
    assert f"stub container log for {service._container_name(run_id)}" in log


async def test_reap_idle_standby_runs_serializes_with_ensure_standby_run(wired_fast_standby):
    """Regression: reap_idle_standby_runs() must take the SAME per-actor lock
    ensure_standby_run() uses, so a request arriving right at the idle
    boundary can never have its warm endpoint reaped out from under it
    mid-flight. Racing a reap pass against a concurrent request for the same
    actor must always resolve to one of two consistent outcomes -- a clean
    cold start (if the reap wins) or a warm reuse (if the request wins) --
    and never surface as a broken/dropped request."""
    client, service = wired_fast_standby
    actor_id = await _provision_standby_actor(client, service, "alice")

    resp = await client.get(f"/v2/actor-standby/{actor_id}/echo", headers=auth("alice"))
    assert resp.status_code == 200

    # Force the entry to look idle right now, without waiting out the real
    # timeout, so the race is deterministic rather than timing-dependent.
    entry = service.standby.runs[actor_id]
    entry.last_request -= entry.idle_timeout + 1

    _, resp2 = await asyncio.gather(
        service.reap_idle_standby_runs(),
        client.get(f"/v2/actor-standby/{actor_id}/echo", headers=auth("alice")),
    )
    assert resp2.status_code == 200


async def test_standby_idle_clock_does_not_reap_mid_stream(wired_fast_standby):
    """Regression: a single forwarded request's OWN duration must never be
    treated as idle time, even if it legitimately outlives idleTimeoutSecs --
    e.g. a slow, multi-chunk streamed response (criterion 7 explicitly
    requires supporting this). The watchdog here polls every 0.05s against a
    0.2s idle-timeout override, so without in-flight tracking the ~0.9s
    `/stream-slow` response (three 0.3s-apart chunks, see
    ``_StandbyProbeHandler._handle_streamed``) would get its container reaped
    out from under it well before the stream finishes.
    """
    client, service = wired_fast_standby
    actor_id = await _provision_standby_actor(client, service, "alice")
    service.start_standby_watchdog(interval_secs=0.05)

    request_task = asyncio.create_task(
        client.get(f"/v2/actor-standby/{actor_id}/stream-slow", headers=auth("alice"))
    )

    # Let the request start (cold-start + readiness + at least the first
    # streamed chunk) and several idle-reap passes elapse while it is still
    # in flight -- comfortably past the 0.2s idle-timeout override, but
    # before the ~0.9s stream finishes.
    await asyncio.sleep(0.5)
    runs = (await client.get(f"/v2/acts/{actor_id}/runs", headers=auth("alice"))).json()["data"]["items"]
    assert runs and runs[0]["status"] == "RUNNING", (
        "container was reaped while a request was still being forwarded"
    )

    resp = await request_task
    assert resp.status_code == 200
    assert resp.content == b"chunk-1\nchunk-2\nchunk-3\n"

    # Once the request has actually finished, the idle clock (refreshed from
    # the completion time) resumes counting down normally.
    await asyncio.sleep(0.6)
    runs = (await client.get(f"/v2/acts/{actor_id}/runs", headers=auth("alice"))).json()["data"]["items"]
    assert runs[0]["status"] == "ABORTED"


async def test_watchdog_survives_reap_pass_exception(wired_fast_standby):
    """Regression: start_standby_watchdog()'s loop must not let one failing
    pass permanently kill background reaping for the rest of the process's
    life (the idempotency guard blocks ever restarting it) -- a failing pass
    must be logged and swallowed, and subsequent passes must still run,
    proven here by making the very first pass raise and confirming the
    standby run is STILL reaped by a later pass."""
    client, service = wired_fast_standby
    actor_id = await _provision_standby_actor(client, service, "alice")

    resp = await client.get(f"/v2/actor-standby/{actor_id}/echo", headers=auth("alice"))
    assert resp.status_code == 200

    original_reap = service.reap_idle_standby_runs
    calls = {"n": 0}

    async def _flaky_reap():
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("simulated reap-pass failure")
        await original_reap()

    service.reap_idle_standby_runs = _flaky_reap
    service.start_standby_watchdog(interval_secs=0.05)

    # Several passes: the first raises, later ones must still run and
    # eventually reap the (0.2s-override) idle standby run.
    await asyncio.sleep(0.6)

    assert calls["n"] > 1, "watchdog loop died after the first failing pass"
    runs = (await client.get(f"/v2/acts/{actor_id}/runs", headers=auth("alice"))).json()["data"]["items"]
    assert runs[0]["status"] == "ABORTED"


async def test_idle_watchdog_reaps_and_next_request_cold_starts(wired_fast_standby):
    client, service = wired_fast_standby
    actor_id = await _provision_standby_actor(client, service, "alice")
    service.start_standby_watchdog(interval_secs=0.05)

    resp1 = await client.get(f"/v2/actor-standby/{actor_id}/echo", headers=auth("alice"))
    assert resp1.status_code == 200
    runs = (await client.get(f"/v2/acts/{actor_id}/runs", headers=auth("alice"))).json()["data"]["items"]
    assert len(runs) == 1 and runs[0]["status"] == "RUNNING"
    first_run_id = runs[0]["id"]

    # Give the watchdog time to notice the (0.2s-override) idle timeout without
    # any further request being sent -- the teardown must happen on its own.
    await asyncio.sleep(0.6)

    runs = (await client.get(f"/v2/acts/{actor_id}/runs", headers=auth("alice"))).json()["data"]["items"]
    assert len(runs) == 1
    assert runs[0]["id"] == first_run_id
    assert runs[0]["status"] == "ABORTED"
    # Storage import ran on teardown too, exactly like a normal run's finish.
    output = await client.get(
        f"/v2/key-value-stores/{runs[0]['defaultKeyValueStoreId']}/records/OUTPUT", headers=auth("alice")
    )
    assert output.status_code == 200

    # A fresh request after teardown is a cold start: a NEW run, not a reuse
    # of the now-dead one.
    resp2 = await client.get(f"/v2/actor-standby/{actor_id}/echo", headers=auth("alice"))
    assert resp2.status_code == 200
    runs = (await client.get(f"/v2/acts/{actor_id}/runs", headers=auth("alice"))).json()["data"]["items"]
    assert len(runs) == 2
    new_run = next(r for r in runs if r["id"] != first_run_id)
    assert new_run["status"] == "RUNNING"


async def test_abort_run_on_standby_reaps_container_and_drops_bookkeeping(wired_fast_standby):
    """Aborting a standby run out-of-band must not leave the manager forwarding
    into a now-dead container on the next request."""
    client, service = wired_fast_standby
    actor_id = await _provision_standby_actor(client, service, "alice")

    resp1 = await client.get(f"/v2/actor-standby/{actor_id}/echo", headers=auth("alice"))
    assert resp1.status_code == 200
    runs = (await client.get(f"/v2/acts/{actor_id}/runs", headers=auth("alice"))).json()["data"]["items"]
    first_run_id = runs[0]["id"]

    aborted = await client.post(f"/v2/actor-runs/{first_run_id}/abort", headers=auth("alice"))
    assert aborted.status_code == 200 and aborted.json()["data"]["status"] == "ABORTED"

    resp2 = await client.get(f"/v2/actor-standby/{actor_id}/echo", headers=auth("alice"))
    assert resp2.status_code == 200
    runs = (await client.get(f"/v2/acts/{actor_id}/runs", headers=auth("alice"))).json()["data"]["items"]
    assert len(runs) == 2
    new_run = next(r for r in runs if r["id"] != first_run_id)
    assert new_run["status"] == "RUNNING"


async def test_abort_run_on_standby_preserves_storage_output(wired_fast_standby):
    """Regression: aborting a standby run must import whatever the Actor wrote
    during its warm lifetime into the runtime's storage, exactly like the
    idle-reap teardown path already does -- killing a warm standby run (e.g.
    to push a new build) is a routine developer action and must not silently
    discard its dataset/KV/request-queue output.
    """
    client, service = wired_fast_standby
    actor_id = await _provision_standby_actor(client, service, "alice")

    resp = await client.get(f"/v2/actor-standby/{actor_id}/echo", headers=auth("alice"))
    assert resp.status_code == 200
    runs = (await client.get(f"/v2/acts/{actor_id}/runs", headers=auth("alice"))).json()["data"]["items"]
    run_id = runs[0]["id"]
    kv_store_id = runs[0]["defaultKeyValueStoreId"]

    aborted = await client.post(f"/v2/actor-runs/{run_id}/abort", headers=auth("alice"))
    assert aborted.status_code == 200 and aborted.json()["data"]["status"] == "ABORTED"

    output = await client.get(
        f"/v2/key-value-stores/{kv_store_id}/records/OUTPUT", headers=auth("alice")
    )
    assert output.status_code == 200

"""Console/API extension behaviours: token-free user listing (no bootstrap),
live-streamed run/build logs, and top-level standalone storage management.

All Docker-free via the ``wired`` / ``wired_streaming`` fixtures; the acting user
is chosen per request with ``Authorization: Bearer <token>``. The real docker-py
live-streaming path is verified on a Docker-enabled host/CI, not here; the
streaming stub driver exercises the buffer, endpoint, terminal handoff, fallback
and console wiring, and a fake docker client exercises the concurrent
stream-plus-timeout path in ``DockerDriver.run`` (see the timeout regression test).
"""
from __future__ import annotations

import threading
import time

from starlette.requests import Request

from app.driver import DockerDriver
from app.routers.runs import stream_log


def _stream_request(app, job_id: str, token: str) -> Request:
    """A minimal ASGI request for driving the streaming endpoint's generator.

    httpx's ASGITransport buffers the whole response body, so it cannot surface a
    chunked response incrementally; iterating the ``StreamingResponse`` generator
    directly is the way to observe the endpoint emitting output over time.
    """
    scope = {
        "type": "http",
        "method": "GET",
        "path": f"/v2/logs/{job_id}/stream",
        "query_string": b"",
        "headers": [(b"authorization", f"Bearer {token}".encode())],
        "app": app,
    }
    return Request(scope)


def auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


async def _create_user(client, name):
    await client.post("/v2/users", json={"name": name})


async def _provision_run(client, service, token, name="act", greeting="hi"):
    """Push, build and run an Actor under ``token``; return its run dict."""
    await _create_user(client, token)
    actor_id = f"{token}~{name}"
    await client.post(
        "/v2/acts",
        json={"name": name, "versions": [{"versionNumber": "0.0", "buildTag": "latest"}]},
        headers=auth(token),
    )
    await client.post(
        f"/v2/actors/{actor_id}/versions",
        json={
            "versionNumber": "0.0",
            "sourceType": "SOURCE_FILES",
            "sourceFiles": [{"name": "main.py", "format": "TEXT", "content": "print('hi')\n"}],
        },
        headers=auth(token),
    )
    await client.post(f"/v2/acts/{actor_id}/builds?version=0.0", headers=auth(token))
    await service.wait_idle()
    resp = await client.post(
        f"/v2/acts/{actor_id}/runs",
        json={"greeting": greeting},
        headers=auth(token),
    )
    await service.wait_idle()
    return resp.json()["data"]


# ------------------------------------------------------------------ (1) users


async def test_list_users_no_auth_returns_200_and_no_bootstrap(wired):
    client, _service = wired
    # No Authorization header: 200 with a well-formed user list.
    resp = await client.get("/v2/users")
    assert resp.status_code == 200
    body = resp.json()["data"]
    assert "items" in body and isinstance(body["items"], list)

    # No bootstrap side effect: a brand-new token presented afterward to a real,
    # authenticated endpoint still bootstraps as the default user.
    me = await client.get("/v2/users/me", headers=auth("first-ever-token"))
    assert me.status_code == 200
    assert me.json()["data"]["username"] == "local-user"
    # A second, different fresh token is now rejected (default already claimed).
    assert (await client.get("/v2/users/me", headers=auth("second-token"))).status_code == 401


async def test_list_users_with_stale_token_does_not_bootstrap(wired):
    client, _service = wired
    # Sending a never-seen bearer to the (token-free) list endpoint must not bind it.
    resp = await client.get("/v2/users", headers=auth("stale-unknown-token"))
    assert resp.status_code == 200

    # Proof the stale token was never claimed: a *different* fresh token still
    # bootstraps as the first one.
    me = await client.get("/v2/users/me", headers=auth("real-first-token"))
    assert me.status_code == 200
    assert me.json()["data"]["username"] == "local-user"
    assert me.json()["data"]["token"] == "real-first-token"


async def test_me_and_real_work_still_bootstrap(wired):
    client, _service = wired
    # Real work through an authenticated endpoint still binds the first token.
    listing = await client.get("/v2/users/me/actors", headers=auth("work-token"))
    assert listing.status_code == 200
    me = await client.get("/v2/users/me", headers=auth("work-token"))
    assert me.json()["data"]["username"] == "local-user"
    assert (await client.get("/v2/users/me", headers=auth("other-token"))).status_code == 401


async def test_console_fetches_user_list_without_auth(wired):
    client, _service = wired
    js = (await client.get("/console/app.js")).text
    # api() honours a per-call skipAuth opt-out...
    assert "!options.skipAuth" in js
    # ...and the two /v2/users fetches use it.
    assert js.count('api("/v2/users", { skipAuth: true })') == 2


# ------------------------------------------------------------- (2) log stream


async def test_stream_delivers_incremental_chunks_while_running(wired_streaming):
    client, service = wired_streaming
    app = client._transport.app
    service.driver.chunks = ["alpha\n", "beta\n", "gamma\n"]
    service.driver.delay = 0.0  # fast build
    run = await _provision_run(client, service, "streamer")
    run_id = run["id"]

    # Re-arm the driver so the *run* streams slowly enough to observe >1 chunk.
    service.driver.delay = 0.5

    # Start a fresh run (not awaited) and tail it while it is still in progress.
    resp = await client.post(
        "/v2/acts/streamer~act/runs", json={"greeting": "hi"}, headers=auth("streamer")
    )
    live_run_id = resp.json()["data"]["id"]

    # Drive the endpoint's streaming generator directly (ASGITransport buffers the
    # whole body, so it can't surface the chunks incrementally).
    stream_resp = await stream_log(live_run_id, _stream_request(app, live_run_id, "streamer"))
    chunks = []
    async for part in stream_resp.body_iterator:
        text = part if isinstance(part, str) else part.decode()
        if text:
            chunks.append(text)

    await service.wait_idle()
    assert len(chunks) >= 2, chunks
    assert "".join(chunks) == "alpha\nbeta\ngamma\n"
    stored = (await client.get(f"/v2/logs/{live_run_id}", headers=auth("streamer"))).text
    assert stored == "alpha\nbeta\ngamma\n"
    assert run_id != live_run_id


async def test_stream_for_finished_job_returns_full_log(wired):
    client, service = wired
    run = await _provision_run(client, service, "finn", greeting="done")
    run_id = run["id"]
    # Buffer discarded on finish -> stream falls back to the stored full log.
    streamed = []
    async with client.stream(
        "GET", f"/v2/logs/{run_id}/stream", headers=auth("finn")
    ) as stream:
        async for piece in stream.aiter_text():
            streamed.append(piece)
    one_shot = (await client.get(f"/v2/logs/{run_id}", headers=auth("finn"))).text
    assert "".join(streamed) == one_shot
    assert one_shot  # non-empty stored log


async def test_stream_unknown_job_is_404(wired):
    client, _service = wired
    resp = await client.get("/v2/logs/does-not-exist/stream")
    assert resp.status_code == 404


async def test_build_log_streams_and_matches_stored(wired_streaming):
    client, service = wired_streaming
    service.driver.chunks = ["build-1\n", "build-2\n"]
    service.driver.delay = 0.0
    await _create_user(client, "builder")
    await client.post(
        "/v2/acts",
        json={"name": "b", "versions": [{"versionNumber": "0.0", "buildTag": "latest"}]},
        headers=auth("builder"),
    )
    await client.post(
        "/v2/actors/builder~b/versions",
        json={
            "versionNumber": "0.0",
            "sourceType": "SOURCE_FILES",
            "sourceFiles": [{"name": "main.py", "format": "TEXT", "content": "x=1\n"}],
        },
        headers=auth("builder"),
    )
    resp = await client.post("/v2/acts/builder~b/builds?version=0.0", headers=auth("builder"))
    build_id = resp.json()["data"]["id"]
    await service.wait_idle()
    streamed = []
    async with client.stream(
        "GET", f"/v2/logs/{build_id}/stream", headers=auth("builder")
    ) as stream:
        async for piece in stream.aiter_text():
            streamed.append(piece)
    assert "".join(streamed) == "build-1\nbuild-2\n"


async def test_console_log_view_consumes_stream(wired):
    client, _service = wired
    js = (await client.get("/console/app.js")).text
    assert "/stream" in js
    assert "getReader" in js
    assert "streamLogInto" in js


def test_docker_run_enforces_timeout_while_streaming_logs():
    """Regression for the real-run timeout path: with a ``log_sink`` set (the only
    path a real run takes), ``DockerDriver.run`` must enforce ``timeout_secs``
    CONCURRENTLY with following the log stream. This fake docker client's container
    emits log lines forever and never exits on its own; the follow generator would
    block indefinitely, so the timeout can only fire if ``container.wait`` runs
    alongside the log-follow thread. Proves: after the timeout, ``container.kill()``
    is called, ``run()`` returns with ``timed_out=True``, and the streamed chunks
    reached the sink. The live docker daemon path stays host/CI-verified.
    """

    class _FakeTimeout(Exception):
        pass

    class _FakeContainer:
        def __init__(self) -> None:
            self._killed = threading.Event()
            self.kill_calls = 0

        def logs(self, stream=False, follow=False):
            if not stream:
                return b""

            def _gen():
                i = 0
                while not self._killed.is_set():
                    i += 1
                    yield f"line-{i}\n".encode()
                    time.sleep(0.02)

            return _gen()

        def wait(self, timeout=None):
            deadline = time.time() + (timeout or 0)
            while time.time() < deadline:
                if self._killed.is_set():
                    return {"StatusCode": 0}
                time.sleep(0.01)
            raise _FakeTimeout("Read timed out.")

        def kill(self):
            self.kill_calls += 1
            self._killed.set()

        def remove(self, force=False):
            pass

    container = _FakeContainer()

    class _FakeContainers:
        def run(self, image_tag, **kwargs):
            return container

    class _FakeClient:
        containers = _FakeContainers()

    received: list[str] = []
    driver = DockerDriver(client=_FakeClient())
    result = driver.run("img:latest", "/tmp/nonexistent", {}, timeout_secs=1, log_sink=received.append)

    assert result.timed_out is True
    assert container.kill_calls >= 1
    assert result.exit_code == 1
    assert received, "streamed chunks were not delivered to the sink"
    assert "".join(received) == result.log


# ------------------------------------------------------------- (3) storages


async def test_create_and_list_standalone_storages(wired):
    client, _service = wired
    await _create_user(client, "sam")
    created = await client.post(
        "/v2/key-value-stores", json={"name": "mystore"}, headers=auth("sam")
    )
    assert created.status_code == 201
    store_id = created.json()["data"]["id"]
    assert store_id == "sam~mystore"

    listed = (await client.get("/v2/users/me/key-value-stores", headers=auth("sam"))).json()["data"]
    ids = [s["id"] for s in listed["items"]]
    assert store_id in ids
    entry = next(s for s in listed["items"] if s["id"] == store_id)
    assert entry["name"] == "mystore" and entry["type"] == "key-value-store"

    # Each type has its own aggregate endpoint.
    await client.post("/v2/datasets", json={"name": "d1"}, headers=auth("sam"))
    await client.post("/v2/request-queues", json={"name": "q1"}, headers=auth("sam"))
    ds = (await client.get("/v2/users/me/datasets", headers=auth("sam"))).json()["data"]
    rq = (await client.get("/v2/users/me/request-queues", headers=auth("sam"))).json()["data"]
    assert "sam~d1" in [s["id"] for s in ds["items"]]
    assert "sam~q1" in [s["id"] for s in rq["items"]]


async def test_storage_listing_is_scoped_to_acting_user(wired):
    client, _service = wired
    for u in ("ann", "ben"):
        await _create_user(client, u)
        await client.post("/v2/key-value-stores", json={"name": "s"}, headers=auth(u))
    ann_ids = [
        s["id"]
        for s in (await client.get("/v2/users/me/key-value-stores", headers=auth("ann")))
        .json()["data"]["items"]
    ]
    ben_ids = [
        s["id"]
        for s in (await client.get("/v2/users/me/key-value-stores", headers=auth("ben")))
        .json()["data"]["items"]
    ]
    assert ann_ids == ["ann~s"]
    assert ben_ids == ["ben~s"]


async def test_delete_storage_removes_listing_and_data(wired):
    client, _service = wired
    await _create_user(client, "deb")
    await client.post("/v2/key-value-stores", json={"name": "tmp"}, headers=auth("deb"))
    store_id = "deb~tmp"
    await client.put(
        f"/v2/key-value-stores/{store_id}/records/K",
        json={"v": 1},
        headers={**auth("deb"), "content-type": "application/json"},
    )
    assert (
        await client.get(f"/v2/key-value-stores/{store_id}/records/K", headers=auth("deb"))
    ).status_code == 200

    delete = await client.delete(f"/v2/key-value-stores/{store_id}", headers=auth("deb"))
    assert delete.status_code == 200

    listed = (
        await client.get("/v2/users/me/key-value-stores", headers=auth("deb"))
    ).json()["data"]["items"]
    assert store_id not in [s["id"] for s in listed]
    # Underlying data is gone: the id now reads as not-found.
    assert (
        await client.get(f"/v2/key-value-stores/{store_id}/records/K", headers=auth("deb"))
    ).status_code == 404


async def test_delete_storage_removes_access_rights(wired):
    client, service = wired
    await _create_user(client, "owner")
    await _create_user(client, "guest")
    await client.post("/v2/key-value-stores", json={"name": "shared"}, headers=auth("owner"))
    store_id = "owner~shared"
    await client.post(
        f"/v2/key-value-stores/{store_id}/access-rights",
        json={"grantee": "guest", "level": "READ"},
        headers=auth("owner"),
    )
    assert len(await service.list_access(store_id)) == 1

    await client.delete(f"/v2/key-value-stores/{store_id}", headers=auth("owner"))
    # No dangling grant survives.
    assert await service.list_access(store_id) == []
    # Listing access rights for the gone storage now 404s (owner-only path).
    assert (
        await client.get(f"/v2/key-value-stores/{store_id}/access-rights", headers=auth("owner"))
    ).status_code == 404
    # The previously-granted user can no longer reach it (as unknown id).
    assert (
        await client.get(f"/v2/key-value-stores/{store_id}", headers=auth("guest"))
    ).status_code == 404


async def test_delete_other_users_storage_is_404_and_no_effect(wired):
    client, _service = wired
    await _create_user(client, "aa")
    await _create_user(client, "bb")
    await client.post("/v2/key-value-stores", json={"name": "keep"}, headers=auth("aa"))
    store_id = "aa~keep"
    # bb cannot delete aa's storage; existence is not leaked.
    assert (await client.delete(f"/v2/key-value-stores/{store_id}", headers=auth("bb"))).status_code == 404
    # Unknown id is the same 404.
    assert (await client.delete("/v2/key-value-stores/aa~nope", headers=auth("bb"))).status_code == 404
    # aa's storage is untouched.
    listed = (await client.get("/v2/users/me/key-value-stores", headers=auth("aa"))).json()["data"]
    assert store_id in [s["id"] for s in listed["items"]]


async def test_run_derived_storages_excluded_and_undeletable(wired):
    client, service = wired
    run = await _provision_run(client, service, "runner")
    kv_id = run["defaultKeyValueStoreId"]
    assert kv_id.startswith("kv_")

    # The top-level list surfaces only standalone storages, never run-derived ones.
    listed = (
        await client.get("/v2/users/me/key-value-stores", headers=auth("runner"))
    ).json()["data"]["items"]
    assert kv_id not in [s["id"] for s in listed]

    # Deleting a run-derived storage via this view is refused (400), not silent.
    resp = await client.delete(f"/v2/key-value-stores/{kv_id}", headers=auth("runner"))
    assert resp.status_code == 400
    assert resp.json()["error"]["type"] == "invalid-request"
    # The run's storage is still intact/readable.
    assert (
        await client.get(f"/v2/key-value-stores/{kv_id}", headers=auth("runner"))
    ).status_code == 200


async def test_console_has_storages_tab(wired):
    client, _service = wired
    html = (await client.get("/")).text
    assert 'id="tab-storages"' in html
    js = (await client.get("/console/app.js")).text
    assert "loadStorages" in js
    assert "createStorage" in js
    assert "deleteStorage" in js
    assert "/v2/users/me/" in js

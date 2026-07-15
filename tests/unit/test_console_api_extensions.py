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


async def test_run_derived_storages_included_and_undeletable(wired):
    client, service = wired
    run = await _provision_run(client, service, "runner")
    kv_id = run["defaultKeyValueStoreId"]
    assert kv_id.startswith("kv_")

    # The top-level list now surfaces run-derived storages too, marked unnamed.
    listed = (
        await client.get("/v2/users/me/key-value-stores", headers=auth("runner"))
    ).json()["data"]["items"]
    assert kv_id in [s["id"] for s in listed]
    entry = next(s for s in listed if s["id"] == kv_id)
    assert entry["named"] is False

    # Deleting a run-derived storage via this view is refused (400), not silent.
    resp = await client.delete(f"/v2/key-value-stores/{kv_id}", headers=auth("runner"))
    assert resp.status_code == 400
    assert resp.json()["error"]["type"] == "invalid-request"
    # The run's storage is still intact/readable.
    assert (
        await client.get(f"/v2/key-value-stores/{kv_id}", headers=auth("runner"))
    ).status_code == 200


async def test_named_storage_marked_named_and_coexists_with_run_derived(wired):
    client, service = wired
    run = await _provision_run(client, service, "coexist")
    kv_id = run["defaultKeyValueStoreId"]
    ds_id = run["defaultDatasetId"]
    rq_id = run["defaultRequestQueueId"]

    created = await client.post(
        "/v2/key-value-stores", json={"name": "mystore"}, headers=auth("coexist")
    )
    named_id = created.json()["data"]["id"]

    kv_listed = (
        await client.get("/v2/users/me/key-value-stores", headers=auth("coexist"))
    ).json()["data"]["items"]
    ds_listed = (
        await client.get("/v2/users/me/datasets", headers=auth("coexist"))
    ).json()["data"]["items"]
    rq_listed = (
        await client.get("/v2/users/me/request-queues", headers=auth("coexist"))
    ).json()["data"]["items"]

    # The run's own default storage ids appear in their corresponding per-type lists.
    assert kv_id in [s["id"] for s in kv_listed]
    assert ds_id in [s["id"] for s in ds_listed]
    assert rq_id in [s["id"] for s in rq_listed]

    # The standalone storage coexists alongside the run-derived one, marked named.
    named_entry = next(s for s in kv_listed if s["id"] == named_id)
    run_entry = next(s for s in kv_listed if s["id"] == kv_id)
    assert named_entry["named"] is True
    assert run_entry["named"] is False

    # The named storage remains deletable as before.
    delete = await client.delete(f"/v2/key-value-stores/{named_id}", headers=auth("coexist"))
    assert delete.status_code == 200
    remaining = (
        await client.get("/v2/users/me/key-value-stores", headers=auth("coexist"))
    ).json()["data"]["items"]
    assert named_id not in [s["id"] for s in remaining]
    assert kv_id in [s["id"] for s in remaining]


async def test_run_derived_and_named_storages_scoped_per_user(wired):
    client, service = wired
    run_a = await _provision_run(client, service, "usera", name="acta")
    run_b = await _provision_run(client, service, "userb", name="actb")
    await client.post("/v2/key-value-stores", json={"name": "mine"}, headers=auth("usera"))
    await client.post("/v2/key-value-stores", json={"name": "mine"}, headers=auth("userb"))

    a_ids = [
        s["id"]
        for s in (
            await client.get("/v2/users/me/key-value-stores", headers=auth("usera"))
        ).json()["data"]["items"]
    ]
    b_ids = [
        s["id"]
        for s in (
            await client.get("/v2/users/me/key-value-stores", headers=auth("userb"))
        ).json()["data"]["items"]
    ]

    assert run_a["defaultKeyValueStoreId"] in a_ids
    assert "usera~mine" in a_ids
    assert run_b["defaultKeyValueStoreId"] not in a_ids
    assert "userb~mine" not in a_ids

    assert run_b["defaultKeyValueStoreId"] in b_ids
    assert "userb~mine" in b_ids
    assert run_a["defaultKeyValueStoreId"] not in b_ids
    assert "usera~mine" not in b_ids


async def test_console_has_storages_tab(wired):
    client, _service = wired
    html = (await client.get("/")).text
    # Storage is a single top-level nav entry now (singular), reached at /storage.
    assert 'id="tab-storage"' in html
    js = (await client.get("/console/app.js")).text
    assert "loadStorages" in js
    assert "createStorage" in js
    assert "deleteStorage" in js
    assert "/v2/users/me/" in js


async def test_console_storages_show_unnamed_checkbox_and_gated_delete(wired):
    client, _service = wired
    js = (await client.get("/console/app.js")).text

    # A checkbox exists for the Storages tab, defaulting to checked (show unnamed),
    # and is wired via addEventListener (no inline handler).
    assert 'type = "checkbox"' in js or "type=\"checkbox\"" in js
    assert "showUnnamedStorages" in js
    assert "let showUnnamedStorages = true;" in js
    assert "toggle.addEventListener(\"change\"" in js

    # Rows are not filtered out of the render path based on run-derived id shape --
    # every fetched item is mapped, filtering only happens against the checkbox state.
    assert "items.filter((st) => st.named === true)" in js
    assert "showUnnamedStorages ? items :" in js

    # The delete control is only constructed for named rows: locate the actual
    # gating conditional (not the unrelated marker-cell ternary) and confirm the
    # button construction follows it, so this assertion would fail if the delete
    # gating regressed to unconditional.
    del_idx = js.index("const del = st.named")
    assert 'mk("button"' in js[del_idx : del_idx + 200]

    # Toggling the checkbox is presentation-only: its change handler re-renders
    # from cached data (renderStorages) rather than refetching (loadStorages).
    toggle_wire_idx = js.index("toggle.addEventListener(\"change\"")
    change_handler = js[toggle_wire_idx : js.index("});", toggle_wire_idx)]
    assert "renderStorages()" in change_handler
    assert "loadStorages()" not in change_handler

    for handler in ("onclick=", "onload=", "onerror=", "onmouseover="):
        assert handler not in js


async def test_console_left_column_has_separate_nav_and_list_boxes(wired):
    client, _service = wired
    html = (await client.get("/")).text

    # Top-level nav is exactly the three new sections (Actors / Storage / Users);
    # Builds and Runs are no longer top-level destinations (they live under an
    # actor's detail).
    for tab_id in ("tab-actors", "tab-storage", "tab-users"):
        assert f'id="{tab_id}"' in html
    for gone in ("tab-builds", "tab-runs", "tab-storages"):
        assert f'id="{gone}"' not in html
    assert 'id="actor-list"' in html
    assert 'id="detail"' in html
    assert 'id="top-tabs"' in html

    # The nav (#top-tabs) and the list (#actor-list) sit in two distinct panel
    # boxes, not one shared wrapper holding both.
    nav_box_start = html.index('id="nav-panel"')
    nav_box_class = html[nav_box_start : nav_box_start + 200]
    assert "panel" in nav_box_class

    list_box_start = html.index('id="actors"')
    list_box_class = html[list_box_start : list_box_start + 200]
    assert "panel" in list_box_class

    # #top-tabs is inside the nav box, #actor-list is inside the (different) list box.
    top_tabs_pos = html.index('id="top-tabs"')
    actor_list_pos = html.index('id="actor-list"')
    assert nav_box_start < top_tabs_pos < list_box_start
    assert list_box_start < actor_list_pos


# --------------------------------------------------------- (4) console routing


async def test_console_uses_history_api_router(wired):
    client, _service = wired
    js = (await client.get("/console/app.js")).text
    # Real History-API routing off location.pathname (no hash routing).
    assert "location.pathname" in js
    assert "history.pushState" in js
    assert 'addEventListener("popstate"' in js
    assert "function navigate(" in js
    # No hash routing anywhere: neither reading nor writing location.hash.
    assert "location.hash" not in js
    # The slug→kind map that backs the /storage/{slug} paths.
    assert "STORAGE_SLUG_TO_KIND" in js
    assert '"key-value-stores": "kv"' in js


async def test_console_actor_row_navigates_via_pushstate(wired):
    client, _service = wired
    js = (await client.get("/console/app.js")).text
    # Clicking an actor builds the /actors/{id} path and navigates (pushState),
    # not location.href/window.open, and the run/build sub-paths are built too.
    assert "navigate(`/actors/${a.id}`)" in js
    assert "navigate(`/actors/${actorId}/runs`)" in js
    assert "navigate(`/actors/${actorId}/builds`)" in js
    assert "navigate(`/actors/${actorId}/runs/${r.id}`)" in js
    assert "location.href" not in js
    assert "window.open(" not in js


async def test_console_build_detail_resolves_by_build_number(wired):
    client, _service = wired
    js = (await client.get("/console/app.js")).text
    # Build detail is keyed by buildNumber in the path and resolved to a build id
    # client-side by fetching the actor's builds list and matching on buildNumber.
    assert "navigate(`/actors/${actorId}/builds/${b.buildNumber}`)" in js
    assert "await api(`/v2/acts/${actorId}/builds`)" in js
    assert "builds.find((b) => b.buildNumber === buildNumber)" in js


async def test_console_storage_marker_is_check_and_cross(wired):
    client, _service = wired
    js = (await client.get("/console/app.js")).text
    # The named/run-derived marker is a ✅/❌ glyph gated on st.named, not the
    # plain "run-derived" text label used before.
    assert 'st.named ? "✅" : "❌"' in js
    assert '"run-derived"' not in js


async def test_console_storage_detail_inspects_via_showstore(wired):
    client, _service = wired
    js = (await client.get("/console/app.js")).text
    # The /storage/{slug}/{id} detail route renders contents by reusing showStore
    # with a kind derived from the slug, and rows link to that detail path.
    assert "function showStorageDetail(" in js
    assert "STORAGE_SLUG_TO_KIND[slug]" in js
    assert "showStore(null, kind, resourceId)" in js
    assert "navigate(`/storage/${slug}/${st.id}`)" in js


# --------------------------------------------- (5) server serves the SPA shell


async def _provision_build_and_run(client, service, token="deep", name="act"):
    """Provision an actor with a build and a run; return (actor_id, run, build)."""
    run = await _provision_run(client, service, token, name=name)
    actor_id = f"{token}~{name}"
    builds = (
        await client.get(f"/v2/acts/{actor_id}/builds", headers=auth(token))
    ).json()["data"]["items"]
    return actor_id, run, builds[0]


async def test_server_serves_index_html_for_spa_paths(wired):
    client, service = wired
    actor_id, run, build = await _provision_build_and_run(client, service)
    run_id = run["id"]
    build_number = build["buildNumber"]

    spa_paths = [
        "/actors",
        f"/actors/{actor_id}",
        f"/actors/{actor_id}/runs/{run_id}",
        f"/actors/{actor_id}/builds/{build_number}",
        "/storage/datasets",
        f"/storage/datasets/{run['defaultDatasetId']}",
        "/users",
        # A resource that does not exist still serves the shell: "not found" is a
        # client-side concern, not a server 404.
        "/actors/no-such~actor",
    ]
    for path in spa_paths:
        resp = await client.get(path)
        assert resp.status_code == 200, f"{path} -> {resp.status_code}"
        assert 'id="detail"' in resp.text, f"{path} did not serve the console shell"
        assert '/console/app.js' in resp.text


async def test_server_spa_catch_all_does_not_shadow_api_or_assets(wired):
    client, _service = wired
    # An unknown /v2/* path is still a normal API 404 (Apify envelope), NOT the
    # console shell.
    bogus = await client.get("/v2/bogus")
    assert bogus.status_code == 404
    assert bogus.json()["error"]["type"] == "record-not-found"
    assert 'id="detail"' not in bogus.text

    # A non-SPA, non-API path is also a plain 404 (allowlist, not denylist).
    other = await client.get("/totally-unknown")
    assert other.status_code == 404
    assert 'id="detail"' not in other.text

    # A non-GET request to an unknown path answers a uniform 404 (Apify
    # envelope), NOT a 405: the catch-all must not make a nonexistent path look
    # like it exists-but-rejects-the-verb.
    for method in ("post", "put", "patch", "delete"):
        resp = await getattr(client, method)("/v2/bogus")
        assert resp.status_code == 404, f"{method.upper()} /v2/bogus -> {resp.status_code}"
        assert resp.json()["error"]["type"] == "record-not-found"

    # The literal asset path still returns the JS, unshadowed.
    app_js = await client.get("/console/app.js")
    assert app_js.status_code == 200
    assert "application/javascript" in app_js.headers.get("content-type", "")
    assert app_js.text.strip()

    # / still returns index.html.
    root = await client.get("/")
    assert root.status_code == 200
    assert 'id="detail"' in root.text


# --------------------------------------------- (6) storage serializer fold-ins


async def test_run_derived_storage_name_is_empty(wired):
    client, service = wired
    run = await _provision_run(client, service, "namer")
    for endpoint, key in (
        ("key-value-stores", "defaultKeyValueStoreId"),
        ("datasets", "defaultDatasetId"),
        ("request-queues", "defaultRequestQueueId"),
    ):
        listed = (
            await client.get(f"/v2/users/me/{endpoint}", headers=auth("namer"))
        ).json()["data"]["items"]
        entry = next(s for s in listed if s["id"] == run[key])
        assert entry["name"] == "", f"{endpoint}: expected empty name, got {entry['name']!r}"
        assert entry["named"] is False


async def test_named_storage_keeps_its_name(wired):
    client, _service = wired
    await _create_user(client, "keeper")
    await client.post("/v2/datasets", json={"name": "mydata"}, headers=auth("keeper"))
    listed = (
        await client.get("/v2/users/me/datasets", headers=auth("keeper"))
    ).json()["data"]["items"]
    entry = next(s for s in listed if s["id"] == "keeper~mydata")
    assert entry["name"] == "mydata"
    assert entry["named"] is True


async def test_build_number_resolves_to_correct_build(wired):
    """Console-facing data resolution: for an actor with multiple builds, matching
    on buildNumber selects the row whose buildNumber equals the target (5.4)."""
    client, service = wired
    await _create_user(client, "multi")
    actor_id = "multi~act"
    await client.post(
        "/v2/acts",
        json={"name": "act", "versions": [{"versionNumber": "0.0", "buildTag": "latest"}]},
        headers=auth("multi"),
    )
    await client.post(
        f"/v2/actors/{actor_id}/versions",
        json={
            "versionNumber": "0.0",
            "sourceType": "SOURCE_FILES",
            "sourceFiles": [{"name": "main.py", "format": "TEXT", "content": "print('hi')\n"}],
        },
        headers=auth("multi"),
    )
    await client.post(f"/v2/acts/{actor_id}/builds?version=0.0", headers=auth("multi"))
    await service.wait_idle()
    await client.post(f"/v2/acts/{actor_id}/builds?version=0.0", headers=auth("multi"))
    await service.wait_idle()

    builds = (
        await client.get(f"/v2/acts/{actor_id}/builds", headers=auth("multi"))
    ).json()["data"]["items"]
    numbers = {b["buildNumber"]: b["id"] for b in builds}
    assert len(numbers) >= 2, numbers

    # The client resolution (find the row whose buildNumber equals the target)
    # picks the matching build, and different numbers resolve to different ids.
    (num_a, num_b) = sorted(numbers)[:2]
    match_a = next(b for b in builds if b["buildNumber"] == num_a)
    match_b = next(b for b in builds if b["buildNumber"] == num_b)
    assert match_a["buildNumber"] == num_a
    assert match_b["buildNumber"] == num_b
    assert match_a["id"] != match_b["id"]


async def test_storage_detail_inspect_is_owner_scoped(wired):
    """Every storage is inspectable at its detail path via the existing per-storage
    read endpoints, and inspection stays scoped to the acting user (6.4/6.6)."""
    client, service = wired
    run = await _provision_run(client, service, "insp")
    kv_id = run["defaultKeyValueStoreId"]

    # A named storage is inspectable and its content matches what was written.
    await client.post("/v2/key-value-stores", json={"name": "named"}, headers=auth("insp"))
    await client.put(
        "/v2/key-value-stores/insp~named/records/greeting",
        json={"hello": "world"},
        headers={**auth("insp"), "content-type": "application/json"},
    )
    rec = await client.get(
        "/v2/key-value-stores/insp~named/records/greeting", headers=auth("insp")
    )
    assert rec.status_code == 200 and rec.json() == {"hello": "world"}

    # A run-derived storage is inspectable too (only its delete affordance differs).
    keys = (
        await client.get(f"/v2/key-value-stores/{kv_id}/keys", headers=auth("insp"))
    ).json()["data"]["items"]
    assert any(k["key"] == "OUTPUT" for k in keys)

    # Owner-scoping: another user cannot inspect insp's run-derived storage.
    await _create_user(client, "other")
    cross = await client.get(f"/v2/key-value-stores/{kv_id}/keys", headers=auth("other"))
    assert cross.status_code == 404

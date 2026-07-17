"""Integration tests for the API using an in-process app + stub driver."""
from __future__ import annotations

import json


async def _push_actor(client):
    # Mirrors what apify-cli's push does: create actor, then upload source files.
    await client.post(
        "/v2/acts",
        json={"name": "sample-actor", "versions": [{"versionNumber": "0.0", "buildTag": "latest"}]},
    )
    await client.post(
        "/v2/actors/local-user~sample-actor/versions",
        json={
            "versionNumber": "0.0",
            "sourceType": "SOURCE_FILES",
            "sourceFiles": [{"name": "main.py", "format": "TEXT", "content": "print('hi')\n"}],
        },
    )


async def test_users_me_no_auth(wired):
    client, _ = wired
    resp = await client.get("/v2/users/me")
    assert resp.status_code == 200
    assert resp.json()["data"]["username"] == "local-user"


async def test_missing_actor_returns_record_not_found(wired):
    client, _ = wired
    resp = await client.get("/v2/actors/local-user~nope")
    assert resp.status_code == 404
    assert resp.json()["error"]["type"] == "record-not-found"


async def test_full_flow_push_build_run_fetch(wired):
    client, service = wired
    await _push_actor(client)

    # Actor is listed.
    listing = (await client.get("/v2/acts")).json()["data"]
    assert any(a["name"] == "sample-actor" for a in listing["items"])

    # Trigger build and wait for it to finish.
    build = (await client.post("/v2/acts/local-user~sample-actor/builds?version=0.0")).json()["data"]
    await service.wait_idle()
    build = (await client.get(f"/v2/actor-builds/{build['id']}")).json()["data"]
    assert build["status"] == "SUCCEEDED"

    # Start a run with input; wait for completion.
    run = (
        await client.post(
            "/v2/acts/local-user~sample-actor/runs",
            content=json.dumps({"greeting": "howdy"}),
            headers={"content-type": "application/json"},
        )
    ).json()["data"]
    await service.wait_idle()
    run = (await client.get(f"/v2/actor-runs/{run['id']}")).json()["data"]
    assert run["status"] == "SUCCEEDED"

    kv_id = run["defaultKeyValueStoreId"]
    ds_id = run["defaultDatasetId"]
    rq_id = run["defaultRequestQueueId"]

    # Key-value store: OUTPUT echoes the input.
    output = (await client.get(f"/v2/key-value-stores/{kv_id}/records/OUTPUT")).json()
    assert output["greeting"] == "howdy"
    assert output["receivedInput"] == {"greeting": "howdy"}

    # Dataset: the pushed item is present.
    items = (await client.get(f"/v2/datasets/{ds_id}/items")).json()
    assert items == [{"message": "howdy world", "index": 1}]

    # Request queue: the enqueued request is present.
    meta = (await client.get(f"/v2/request-queues/{rq_id}")).json()["data"]
    assert meta["totalRequestCount"] == 1
    reqs = (await client.get(f"/v2/request-queues/{rq_id}/requests")).json()["data"]["items"]
    assert reqs[0]["url"] == "https://example.com/from-actor"


async def test_console_served(wired):
    client, _ = wired
    resp = await client.get("/")
    assert resp.status_code == 200
    assert "Actor Runtime Console" in resp.text


async def test_abort_build_while_running_sticks_and_discards_result(wired, monkeypatch):
    """Aborting a RUNNING build is terminal: `docker build` cannot be cancelled
    mid-flight, so when it eventually completes its finalization must respect
    the ABORTED status (not clobber it) and discard the unwanted image."""
    import threading

    client, service = wired
    await _push_actor(client)

    release = threading.Event()
    real_build = service.driver.build
    removed: list[str] = []

    def slow_build(build_dir, image_tag, log_sink=None):
        release.wait(timeout=10)
        return real_build(build_dir, image_tag, log_sink)

    monkeypatch.setattr(service.driver, "build", slow_build)
    monkeypatch.setattr(service.driver, "remove_image", lambda tag: removed.append(tag))

    build = (await client.post("/v2/acts/local-user~sample-actor/builds?version=0.0")).json()["data"]
    aborted = (await client.post(f"/v2/actor-builds/{build['id']}/abort")).json()["data"]
    assert aborted["status"] == "ABORTED"

    release.set()
    await service.wait_idle()

    final = (await client.get(f"/v2/actor-builds/{build['id']}")).json()["data"]
    assert final["status"] == "ABORTED"
    log = (await client.get(f"/v2/logs/{build['id']}")).text
    assert "Build aborted by user." in log
    assert "stub: built" in log  # docker output still appended for the record
    assert removed, "the completed-after-abort image must be discarded"


async def test_abort_finished_build_returns_it_unchanged(wired):
    client, service = wired
    await _push_actor(client)
    build = (await client.post("/v2/acts/local-user~sample-actor/builds?version=0.0")).json()["data"]
    await service.wait_idle()

    resp = (await client.post(f"/v2/actor-builds/{build['id']}/abort")).json()["data"]
    assert resp["status"] == "SUCCEEDED"

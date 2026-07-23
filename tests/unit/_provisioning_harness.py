"""Shared Actor-provisioning and storage read/write harness for the decoupled
multi-user test suites (`test_multi_user.py`, `test_storage_sharing.py`).

Deliberately a plain module rather than a `conftest.py`: an autouse fixture in
a directory-level `conftest.py` would apply to every test under `tests/unit/`,
not just these two files. A plain module's fixtures only take effect where a
test module imports them into its namespace, so `_seed_users` stays scoped to
its two callers.
"""
from __future__ import annotations

import json

import pytest_asyncio

KV = "key-value-stores"
DS = "datasets"
RQ = "request-queues"


def auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


async def _create_user(client, name):
    """Create a user (username == token == name) via the open, token-less endpoint.

    Sent without an Authorization header so it never bootstraps the default user's
    token; token-based resolution then treats ``name`` as a known user's token.
    """
    await client.post("/v2/users", json={"name": name})


@pytest_asyncio.fixture(autouse=True)
async def _seed_users(wired):
    """Pre-create the users whose tokens the tests present as bearer credentials.

    Under the decoupled model an unknown present token is bootstrap-or-reject, so
    ``alice``/``bob`` must exist as real users before their tokens resolve. Created
    token-less, leaving the default user unclaimed for the bootstrap tests.
    """
    client, _ = wired
    for name in ("alice", "bob"):
        await _create_user(client, name)
    yield


async def _push(client, name, token):
    await _create_user(client, token)
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

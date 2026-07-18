"""Field-complete storage/run metadata for the SDK's storage clients, plus the
key-value-store per-record DELETE/HEAD routes that round out that surface.

Dataset/KVS/RQ GET responses and `GET /v2/actor-runs/{id}` must carry every
field apify-sdk-python's own pydantic models require, so a real SDK Actor's
`Actor.get_input()`/`open_dataset()`/`open_request_queue()`/`Actor.init()`
calls succeed against this runtime instead of raising a validation error or
`KeyError`.

All Docker-free via the ``wired`` fixture (in-process app + StubDriver, see
tests/conftest.py); this module does not import ``apify`` itself, so it stays
hermetic to this repo's own `.venv`.
"""
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


async def test_storage_metadata_is_field_complete(wired):
    """Dataset/KVS/RQ GET responses must carry every field apify-client's
    response models require (non-optional, no default): id, name, userId,
    createdAt/modifiedAt/accessedAt, consoleUrl, plus itemCount/cleanItemCount
    (dataset) and totalRequestCount/hadMultipleClients/stats (request queue).

    Regression: before this change these responses carried only
    ``{id, name, itemCount}``, which apify-sdk-python's own storage-client
    metadata models (crawlee's ``DatasetMetadata``/``KeyValueStoreMetadata``/
    ``RequestQueueMetadata``, re-validated on every ``Actor.open_dataset()`` /
    ``Actor.get_input()`` / ``Actor.open_request_queue()`` call regardless of
    the apify-client version pinned) would reject with a
    ``pydantic.ValidationError`` on the very first call. Two further
    constraints apply beyond mere field presence: (1) a run-derived storage's
    ``name`` must NOT be the raw id verbatim -- crawlee's own domain objects
    validate a non-empty ``name``
    against ``^[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9]$``, and every id this
    runtime mints contains ``_`` or ``~``, so handing it back as-is made
    `Actor.get_input()` itself raise; (2) the request-queue metadata's
    ``stats`` key is read via direct dict indexing (``response['stats']``,
    not ``.get()``) by ``apify``'s own ``ApifyRequestQueueClient.get_metadata()``,
    so its total absence made `Actor.open_request_queue()` raise a `KeyError`.
    """
    client, service = wired
    await _push_actor(client)
    await client.post("/v2/acts/local-user~sample-actor/builds?version=0.0")
    await service.wait_idle()
    run = (
        await client.post(
            "/v2/acts/local-user~sample-actor/runs",
            content=json.dumps({"greeting": "howdy"}),
            headers={"content-type": "application/json"},
        )
    ).json()["data"]
    await service.wait_idle()

    kv = (await client.get(f"/v2/key-value-stores/{run['defaultKeyValueStoreId']}")).json()["data"]
    ds = (await client.get(f"/v2/datasets/{run['defaultDatasetId']}")).json()["data"]
    rq = (await client.get(f"/v2/request-queues/{run['defaultRequestQueueId']}")).json()["data"]

    for meta, label in ((kv, "kv"), (ds, "ds"), (rq, "rq")):
        for field in ("id", "name", "userId", "createdAt", "modifiedAt", "accessedAt", "consoleUrl"):
            assert field in meta, f"{label}: missing {field!r} in {meta!r}"
        # A run-derived storage's name must be empty, never the raw
        # underscore-containing id (crawlee rejects non-alphanumeric/hyphen
        # names the instant an SDK Actor opens its default storage).
        assert meta["name"] == "", f"{label}: run-derived storage name must be empty, got {meta['name']!r}"
    assert "itemCount" in ds and "cleanItemCount" in ds
    assert "hadMultipleClients" in rq and "totalRequestCount" in rq and "stats" in rq


async def test_run_metadata_includes_disk_mbytes_meta_and_stats(wired):
    """`GET /v2/actor-runs/{id}` must carry ``options.diskMbytes``, ``meta``
    and ``stats`` -- all three required (no default) by apify-sdk-python's
    own ``apify._models.ActorRun``/``ActorRunOptions`` pydantic models, which
    `Actor.init()`'s charging manager re-validates the response against on
    every run, regardless of which ``apify-client`` version is pinned. These
    fields (added in `app/serializers.py::run_dict`) previously had no unit
    coverage at all -- only the (here unrunnable) e2e suite defended them.
    This only exercises the presence/value of these fields over HTTP through
    the wired stub-driver app (no Docker); it does not import ``apify``
    itself, so it stays hermetic to this repo's own `.venv` (which does not
    have the ``apify``/``apify-client`` packages installed -- those are only
    ever pip-installed inside the sample-actor Docker images at build time).
    """
    client, service = wired
    await _push_actor(client)
    await client.post("/v2/acts/local-user~sample-actor/builds?version=0.0")
    await service.wait_idle()
    run = (
        await client.post(
            "/v2/acts/local-user~sample-actor/runs",
            content=json.dumps({"greeting": "howdy"}),
            headers={"content-type": "application/json"},
        )
    ).json()["data"]
    await service.wait_idle()

    run = (await client.get(f"/v2/actor-runs/{run['id']}")).json()["data"]
    assert run["options"]["diskMbytes"] == 2048
    assert run["meta"] == {"origin": "API"}
    assert run["stats"] == {"restartCount": 0, "resurrectCount": 0, "computeUnits": 0.0}


def test_run_dict_reports_standby_origin():
    """Pure-unit companion to the HTTP round-trip above, for the ``STANDBY``
    branch of ``run_dict``'s ``meta.origin`` -- deliberately NOT exercised via
    a real standby run (the standby e2e/timing tests are flaky by the task's
    own admission; `is_standby` is a plain boolean column, so constructing a
    bare ``Run`` row directly is a fully adequate, deterministic substitute).
    """
    from app.db import Run
    from app.serializers import run_dict

    run = Run(
        id="r1",
        actor_id="a1",
        username="local-user",
        build_id="b1",
        build_number="0.0.1",
        status="RUNNING",
        kv_store_id="kv_r1",
        dataset_id="ds_r1",
        request_queue_id="rq_r1",
        is_standby=True,
    )
    out = run_dict(run)
    assert out["meta"] == {"origin": "STANDBY"}
    assert out["options"]["diskMbytes"] == 2048
    assert out["stats"] == {"restartCount": 0, "resurrectCount": 0, "computeUnits": 0.0}

async def test_kv_record_delete_and_head(wired):
    """KVS per-record DELETE and HEAD, matching apify-client's
    ``delete_record``/``record_exists``, which have no existing coverage.
    """
    client, _service = wired
    kv = (await client.post("/v2/key-value-stores", json={"name": "recordops"})).json()["data"]
    kv_id = kv["id"]

    await client.put(
        f"/v2/key-value-stores/{kv_id}/records/FOO",
        content=json.dumps({"a": 1}),
        headers={"content-type": "application/json"},
    )
    assert (await client.head(f"/v2/key-value-stores/{kv_id}/records/FOO")).status_code == 200
    assert (await client.head(f"/v2/key-value-stores/{kv_id}/records/MISSING")).status_code == 404

    deleted = await client.delete(f"/v2/key-value-stores/{kv_id}/records/FOO")
    assert deleted.status_code == 200
    assert (await client.get(f"/v2/key-value-stores/{kv_id}/records/FOO")).status_code == 404
    assert (await client.head(f"/v2/key-value-stores/{kv_id}/records/FOO")).status_code == 404


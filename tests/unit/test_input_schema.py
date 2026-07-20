"""Coverage for the actor input-schema resolver and its
``GET /{actor_id}/input-schema`` endpoint.

All run Docker-free through the ``wired`` fixture (in-process app +
StubDriver, see ``tests/conftest.py``). Mirrors ``test_api.py``'s
``_push_actor`` two-call push shape (create, then set the version's source),
extended with the extra knobs (version number/tag, source type) these tests
need that the plain fixture doesn't expose.
"""
from __future__ import annotations

import base64
import json
from pathlib import Path

import pytest

from app.input_schema import resolve_input_schema

REPO = Path(__file__).resolve().parents[2]
SAMPLE_ACTOR_DIRS = [
    "sample_actor",
    "sample_actor_caller",
    "sample_actor_isathome",
    "sample_actor_standby",
]

NOT_FOUND = "record-not-found"

# A minimal-but-real input schema shared by most tests below; asserted via
# Python dict `==` against the endpoint's response, which proves shape/
# content equality only. Dict `==` is order-insensitive
# (`{"a": 1, "b": 2} == {"b": 2, "a": 1}` is `True`), so none of the `==
# INPUT_SCHEMA` assertions below prove key order survives resolution --
# see `test_schema_property_key_order_is_preserved_not_just_shape` for a
# genuine, serialization-based order check.
INPUT_SCHEMA = {
    "title": "Test schema",
    "type": "object",
    "properties": {
        "greeting": {"title": "Greeting", "type": "string", "default": "hi"},
    },
    "required": ["greeting"],
}


async def _push_actor(
    client,
    name: str,
    source_files: list[dict],
    *,
    version_number: str = "0.0",
    build_tag: str = "latest",
    source_type: str = "SOURCE_FILES",
    tarball_url: str | None = None,
) -> str:
    """Create an Actor, then upsert its version with the given inline source
    files (or, for a ``TARBALL`` version, a ``tarballUrl``). Returns the
    actor id."""
    created = await client.post(
        "/v2/acts",
        json={"name": name, "versions": [{"versionNumber": version_number, "buildTag": build_tag}]},
    )
    actor_id = created.json()["data"]["id"]
    payload: dict = {
        "versionNumber": version_number,
        "buildTag": build_tag,
        "sourceType": source_type,
    }
    if source_type == "TARBALL":
        payload["tarballUrl"] = tarball_url
    else:
        payload["sourceFiles"] = source_files
    await client.post(f"/v2/actors/{actor_id}/versions", json=payload)
    return actor_id


# -- Resolution order: .actor/input_schema.json ------------------------------
async def test_resolves_inline_input_schema_json(wired):
    client, _ = wired
    actor_id = await _push_actor(
        client,
        "schema-actor",
        [
            {"name": "main.py", "format": "TEXT", "content": "print('hi')\n"},
            {"name": ".actor/input_schema.json", "format": "TEXT", "content": json.dumps(INPUT_SCHEMA)},
        ],
    )
    resp = await client.get(f"/v2/acts/{actor_id}/input-schema")
    assert resp.status_code == 200
    assert resp.json()["data"] == INPUT_SCHEMA


async def test_input_schema_endpoint_mounted_under_actors_prefix_too(wired):
    """The router is registered under both /v2/acts and /v2/actors (main.py) --
    the CLI uses /v2/actors, the console has historically used /v2/acts."""
    client, _ = wired
    actor_id = await _push_actor(
        client,
        "schema-actor-actors-prefix",
        [{"name": ".actor/input_schema.json", "format": "TEXT", "content": json.dumps(INPUT_SCHEMA)}],
    )
    resp = await client.get(f"/v2/actors/{actor_id}/input-schema")
    assert resp.status_code == 200
    assert resp.json()["data"] == INPUT_SCHEMA


async def test_schema_property_key_order_is_preserved_not_just_shape(wired):
    """Every other test in this file compares via Python dict `==`, which is
    order-insensitive and so proves shape/content equality only (see the
    comment on INPUT_SCHEMA above). This test uses a schema with multiple,
    deliberately non-alphabetical property keys and compares the response's
    *serialized* key order (both directly via `list(...keys())` and via a
    full `json.dumps` string comparison) to genuinely prove
    resolution/response does not reorder schema properties."""
    client, _ = wired
    ordered_schema = {
        "title": "Order-sensitive schema",
        "type": "object",
        "properties": {
            "zeta": {"type": "string"},
            "alpha": {"type": "string"},
            "middle": {"type": "string"},
        },
        "required": [],
    }
    actor_id = await _push_actor(
        client,
        "order-actor",
        [{"name": ".actor/input_schema.json", "format": "TEXT", "content": json.dumps(ordered_schema)}],
    )
    resp = await client.get(f"/v2/acts/{actor_id}/input-schema")
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data == ordered_schema  # shape (order-insensitive, as above)
    assert list(data["properties"].keys()) == ["zeta", "alpha", "middle"]  # order, genuinely
    assert json.dumps(data) == json.dumps(ordered_schema)  # belt-and-suspenders full-order match


# -- Resolution order: .actor/actor.json's `input` field ---------------------
async def test_actor_json_input_field_as_relative_path(wired):
    """`input` as a string co-located with actor.json inside `.actor/` --
    resolved via the ".actor/"-context candidate."""
    client, _ = wired
    manifest = json.dumps(
        {
            "actorSpecification": 1,
            "name": "x",
            "version": "0.0",
            "buildTag": "latest",
            "input": "./input_schema.json",
        }
    )
    actor_id = await _push_actor(
        client,
        "relpath-actor",
        [
            {"name": ".actor/actor.json", "format": "TEXT", "content": manifest},
            {"name": ".actor/input_schema.json", "format": "TEXT", "content": json.dumps(INPUT_SCHEMA)},
        ],
    )
    resp = await client.get(f"/v2/acts/{actor_id}/input-schema")
    assert resp.json()["data"] == INPUT_SCHEMA


async def test_actor_json_input_field_relative_to_project_root(wired):
    """`input` as a string pointing at a file outside `.actor/` entirely --
    resolved via the as-given (no ".actor/" prefix) candidate."""
    client, _ = wired
    manifest = json.dumps(
        {
            "actorSpecification": 1,
            "name": "x",
            "version": "0.0",
            "buildTag": "latest",
            "input": "schemas/input.json",
        }
    )
    actor_id = await _push_actor(
        client,
        "rootpath-actor",
        [
            {"name": ".actor/actor.json", "format": "TEXT", "content": manifest},
            {"name": "schemas/input.json", "format": "TEXT", "content": json.dumps(INPUT_SCHEMA)},
        ],
    )
    resp = await client.get(f"/v2/acts/{actor_id}/input-schema")
    assert resp.json()["data"] == INPUT_SCHEMA


async def test_actor_json_input_field_inline_object(wired):
    client, _ = wired
    manifest = json.dumps(
        {
            "actorSpecification": 1,
            "name": "x",
            "version": "0.0",
            "buildTag": "latest",
            "input": INPUT_SCHEMA,
        }
    )
    actor_id = await _push_actor(
        client, "inline-actor", [{"name": ".actor/actor.json", "format": "TEXT", "content": manifest}]
    )
    resp = await client.get(f"/v2/acts/{actor_id}/input-schema")
    assert resp.json()["data"] == INPUT_SCHEMA


async def test_input_field_pointing_at_missing_file_falls_back_to_default_schema_file(wired):
    """An `input` string that resolves to no pushed file is a soft miss for
    step 1 -- resolution then falls through to `.actor/input_schema.json`
    (step 2), it does not give up entirely."""
    client, _ = wired
    manifest = json.dumps(
        {
            "actorSpecification": 1,
            "name": "x",
            "version": "0.0",
            "buildTag": "latest",
            "input": "does-not-exist.json",
        }
    )
    actor_id = await _push_actor(
        client,
        "fallback-actor",
        [
            {"name": ".actor/actor.json", "format": "TEXT", "content": manifest},
            {"name": ".actor/input_schema.json", "format": "TEXT", "content": json.dumps(INPUT_SCHEMA)},
        ],
    )
    resp = await client.get(f"/v2/acts/{actor_id}/input-schema")
    assert resp.json()["data"] == INPUT_SCHEMA


# -- Encoding ------------------------------------------------------------
async def test_resolves_base64_encoded_schema_file(wired):
    client, _ = wired
    encoded = base64.b64encode(json.dumps(INPUT_SCHEMA).encode()).decode()
    actor_id = await _push_actor(
        client, "b64-actor", [{"name": ".actor/input_schema.json", "format": "BASE64", "content": encoded}]
    )
    resp = await client.get(f"/v2/acts/{actor_id}/input-schema")
    assert resp.json()["data"] == INPUT_SCHEMA


# -- Fail-soft / fallback cases -----------------------------------------
async def test_no_schema_returns_null(wired):
    client, _ = wired
    actor_id = await _push_actor(
        client, "no-schema-actor", [{"name": "main.py", "format": "TEXT", "content": "print('hi')\n"}]
    )
    resp = await client.get(f"/v2/acts/{actor_id}/input-schema")
    assert resp.status_code == 200
    assert resp.json()["data"] is None


async def test_tarball_version_falls_back_to_null(wired):
    """A TARBALL version's archive isn't inspectable pre-build (see
    ``Service.get_input_schema``'s docstring) -- always `null`, regardless of
    what the (unread) archive might contain."""
    client, _ = wired
    actor_id = await _push_actor(
        client,
        "tarball-actor",
        [],
        source_type="TARBALL",
        tarball_url="http://test/key-value-stores/store123/records/source.zip",
    )
    resp = await client.get(f"/v2/acts/{actor_id}/input-schema")
    assert resp.status_code == 200
    assert resp.json()["data"] is None


async def test_malformed_schema_json_fails_soft(wired):
    client, _ = wired
    actor_id = await _push_actor(
        client, "malformed-actor", [{"name": ".actor/input_schema.json", "format": "TEXT", "content": "{not valid json"}]
    )
    resp = await client.get(f"/v2/acts/{actor_id}/input-schema")
    assert resp.status_code == 200
    assert resp.json()["data"] is None


async def test_schema_file_that_is_not_a_json_object_fails_soft(wired):
    """Valid JSON that isn't an object (e.g. a bare array) is not a valid
    schema shape -- fails soft to `null`, same as unparseable JSON."""
    client, _ = wired
    actor_id = await _push_actor(
        client,
        "list-schema-actor",
        [{"name": ".actor/input_schema.json", "format": "TEXT", "content": json.dumps([1, 2, 3])}],
    )
    resp = await client.get(f"/v2/acts/{actor_id}/input-schema")
    assert resp.status_code == 200
    assert resp.json()["data"] is None


async def test_unknown_actor_returns_not_found(wired):
    client, _ = wired
    resp = await client.get("/v2/acts/local-user~does-not-exist/input-schema")
    assert resp.status_code == 404
    assert resp.json()["error"]["type"] == NOT_FOUND


# -- Version resolution: the actor's latest-tagged version ---------------
async def test_schema_resolved_from_latest_tagged_version_not_arbitrary_one(wired):
    """A higher version number tagged something other than "latest" must
    NOT win over a lower-numbered version that IS tagged "latest" -- the
    resolver follows the tag, not push order or version-number size alone."""
    client, _ = wired
    created = await client.post("/v2/acts", json={"name": "multi-version-actor", "versions": []})
    actor_id = created.json()["data"]["id"]

    old_schema = {"type": "object", "properties": {"old": {"type": "string"}}}
    new_schema = {"type": "object", "properties": {"new": {"type": "string"}}}

    # Pushed first, but tagged "beta" (not "latest") and numbered higher.
    await client.post(
        f"/v2/actors/{actor_id}/versions",
        json={
            "versionNumber": "2.0",
            "buildTag": "beta",
            "sourceType": "SOURCE_FILES",
            "sourceFiles": [
                {"name": ".actor/input_schema.json", "format": "TEXT", "content": json.dumps(new_schema)}
            ],
        },
    )
    # Pushed second, numbered lower, but tagged "latest" -- this is the one
    # a default `build=latest` run would use, so its schema must win.
    await client.post(
        f"/v2/actors/{actor_id}/versions",
        json={
            "versionNumber": "1.0",
            "buildTag": "latest",
            "sourceType": "SOURCE_FILES",
            "sourceFiles": [
                {"name": ".actor/input_schema.json", "format": "TEXT", "content": json.dumps(old_schema)}
            ],
        },
    )

    resp = await client.get(f"/v2/acts/{actor_id}/input-schema")
    assert resp.json()["data"] == old_schema


async def test_schema_matches_the_build_a_default_run_actually_executes(wired):
    """Regression coverage: `Service.start_run`'s default (no explicit
    build/version override) path never consults any version's `buildTag` at
    all -- it calls `latest_build()`, which returns
    the most recently *started* successful `Build` row, tag-blind. So the
    schema endpoint must resolve from THAT build's version, not merely
    whichever version currently carries the "latest" tag.

    Push v1.0 tagged "latest" (schema A) and build it; then push v2.0 tagged
    "beta" (schema B, NOT "latest") and build it LATER -- v2.0's build is now
    the actor's `latest_build()`, i.e. what a default Start actually runs.
    The schema shown must be v2.0's, even though v1.0 still carries the
    "latest" tag.
    """
    client, service = wired
    created = await client.post("/v2/acts", json={"name": "build-vs-tag-actor", "versions": []})
    actor_id = created.json()["data"]["id"]

    schema_v1 = {"type": "object", "properties": {"v1": {"type": "string"}}}
    schema_v2 = {"type": "object", "properties": {"v2": {"type": "string"}}}

    # v1.0, tagged "latest", pushed AND BUILT first.
    await client.post(
        f"/v2/actors/{actor_id}/versions",
        json={
            "versionNumber": "1.0",
            "buildTag": "latest",
            "sourceType": "SOURCE_FILES",
            "sourceFiles": [
                {"name": ".actor/input_schema.json", "format": "TEXT", "content": json.dumps(schema_v1)}
            ],
        },
    )
    await client.post(f"/v2/acts/{actor_id}/builds?version=1.0")
    await service.wait_idle()

    # Before v2.0 is built, the resolved schema must still be v1.0's -- it is
    # the only successful build that exists so far.
    resp = await client.get(f"/v2/acts/{actor_id}/input-schema")
    assert resp.json()["data"] == schema_v1

    # v2.0, tagged "beta" (NOT "latest"), pushed AND BUILT second -- now the
    # actor's `latest_build()`, even though v1.0 still carries "latest".
    await client.post(
        f"/v2/actors/{actor_id}/versions",
        json={
            "versionNumber": "2.0",
            "buildTag": "beta",
            "sourceType": "SOURCE_FILES",
            "sourceFiles": [
                {"name": ".actor/input_schema.json", "format": "TEXT", "content": json.dumps(schema_v2)}
            ],
        },
    )
    await client.post(f"/v2/acts/{actor_id}/builds?version=2.0")
    await service.wait_idle()

    resp = await client.get(f"/v2/acts/{actor_id}/input-schema")
    assert resp.json()["data"] == schema_v2, (
        "schema endpoint must follow the build a default Start actually runs "
        "(v2.0's, the more recently built one), not the version still tagged "
        '"latest" (v1.0)'
    )


async def test_falls_back_to_highest_version_when_none_tagged_latest(wired):
    client, _ = wired
    created = await client.post("/v2/acts", json={"name": "no-latest-actor", "versions": []})
    actor_id = created.json()["data"]["id"]

    schema_v1 = {"type": "object", "properties": {"v1": {"type": "string"}}}
    schema_v2 = {"type": "object", "properties": {"v2": {"type": "string"}}}

    for version_number, schema in (("1.0", schema_v1), ("2.0", schema_v2)):
        await client.post(
            f"/v2/actors/{actor_id}/versions",
            json={
                "versionNumber": version_number,
                "buildTag": "beta",
                "sourceType": "SOURCE_FILES",
                "sourceFiles": [
                    {"name": ".actor/input_schema.json", "format": "TEXT", "content": json.dumps(schema)}
                ],
            },
        )

    resp = await client.get(f"/v2/acts/{actor_id}/input-schema")
    assert resp.json()["data"] == schema_v2


# -- The run-start endpoint stays permissive -------------------------------
async def test_start_run_stays_permissive_despite_required_schema_field(wired):
    """A schema `required` property is enforced client-side only: the
    server keeps accepting a body missing it, and even an unknown extra key,
    exactly as before -- no new server-side schema validation/rejection."""
    client, service = wired
    actor_id = await _push_actor(
        client,
        "permissive-actor",
        [
            {"name": "main.py", "format": "TEXT", "content": "print('hi')\n"},
            {"name": ".actor/input_schema.json", "format": "TEXT", "content": json.dumps(INPUT_SCHEMA)},
        ],
    )
    resp = await client.post(
        f"/v2/acts/{actor_id}/runs",
        content=json.dumps({"unexpectedKey": "nope"}),  # missing required "greeting"; unknown key present
        headers={"content-type": "application/json"},
    )
    assert resp.status_code == 201
    assert resp.json()["data"]["status"] == "RUNNING"
    # Let the spawned run finish before the fixture tears the app down, so a
    # background task doesn't outlive the test (mirrors test_api.py's own
    # full-flow test).
    await service.wait_idle()


# -- Every on-disk sample Actor tree resolves a real schema ------------------
def _source_files_from_actor_tree(actor_dir: Path) -> list[dict]:
    """Read every file under ``actor_dir/.actor`` -- the only tree
    ``resolve_input_schema`` ever looks at -- into the same source-file shape
    (``name``/``format``/``content``) the tests above build by hand, with
    ``name`` rooted the way a real push roots it: relative to the Actor
    project directory, e.g. ``.actor/actor.json``, ``.actor/input_schema.json``.
    """
    actor_subdir = actor_dir / ".actor"
    source_files = []
    for path in sorted(actor_subdir.rglob("*")):
        if path.is_file():
            name = f".actor/{path.relative_to(actor_subdir).as_posix()}"
            source_files.append({"name": name, "format": "TEXT", "content": path.read_text()})
    return source_files


@pytest.mark.parametrize("actor_dir_name", SAMPLE_ACTOR_DIRS)
def test_resolves_a_schema_for_every_on_disk_sample_actor(actor_dir_name):
    """Every ``sample_actor*`` tree actually checked into this repo -- not
    just ``sample_actor`` -- must resolve a real, non-null input schema from
    its actual on-disk ``.actor/actor.json`` + ``.actor/input_schema.json``.
    Reads the real files from the repo checkout (no synthetic content), so a
    malformed or misnamed schema file in any of the four trees fails this
    test directly, with no Docker build involved.
    """
    source_files = _source_files_from_actor_tree(REPO / actor_dir_name)
    schema = resolve_input_schema(source_files)
    assert schema is not None
    assert isinstance(schema, dict)


# -- Re-push regression: a schema added later shows up without a rebuild ----
async def test_repush_of_same_version_updates_schema_without_a_new_build(wired):
    """The exact mechanism behind "an Actor pushed before it had a schema
    keeps showing plain JSON until re-pushed": ``Service._upsert_version_in_
    session`` overwrites a version's ``source_files`` IN PLACE, and
    ``get_input_schema`` always re-reads that version row live -- so pushing
    the SAME version number again, now with a schema, changes what
    ``GET /input-schema`` returns without triggering, or needing, any new
    build. A plain ``apify push --force`` is enough."""
    client, service = wired
    actor_id = await _push_actor(
        client,
        "repush-actor",
        [{"name": "main.py", "format": "TEXT", "content": "print('hi')\n"}],
    )

    # No schema yet -- confirm the pre-schema baseline (plain-JSON fallback).
    resp = await client.get(f"/v2/acts/{actor_id}/input-schema")
    assert resp.json()["data"] is None

    await client.post(f"/v2/acts/{actor_id}/builds?version=0.0")
    await service.wait_idle()

    builds_before = (await client.get(f"/v2/acts/{actor_id}/builds")).json()["data"]
    assert builds_before["total"] == 1

    # Re-push the SAME version number, now including a schema -- a plain
    # `apify push` from the CLI, not a new version and not a new build.
    await client.post(
        f"/v2/actors/{actor_id}/versions",
        json={
            "versionNumber": "0.0",
            "buildTag": "latest",
            "sourceType": "SOURCE_FILES",
            "sourceFiles": [
                {"name": "main.py", "format": "TEXT", "content": "print('hi')\n"},
                {"name": ".actor/input_schema.json", "format": "TEXT", "content": json.dumps(INPUT_SCHEMA)},
            ],
        },
    )

    resp = await client.get(f"/v2/acts/{actor_id}/input-schema")
    assert resp.json()["data"] == INPUT_SCHEMA

    builds_after = (await client.get(f"/v2/acts/{actor_id}/builds")).json()["data"]
    assert builds_after["total"] == 1, "re-pushing the same version must not trigger a new build"

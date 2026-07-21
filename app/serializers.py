"""Serialize domain objects into public-Apify-API-shaped JSON envelopes."""
from __future__ import annotations

from typing import Any

from .config import Settings
from .db import Actor, Build, Run, Storage, User, Version
from .service import _RUN_STORAGE_PREFIXES, storage_name_from_id


def user_dict(u: User) -> dict[str, Any]:
    return {
        "id": u.username,
        "username": u.username,
        "token": u.token,
        "createdAt": u.created_at,
    }


def storage_dict(st: Storage) -> dict[str, Any]:
    # Shared with ``routers/storages.py::_storage_meta`` (see
    # ``constants.storage_name_from_id``'s docstring) so a type-qualified
    # ``username~{type}~name`` id derives the same bare ``name`` here as it
    # does in the single-storage GET response, everywhere ``name`` is served.
    name = storage_name_from_id(st.id, st.type)
    return {
        "id": st.id,
        "name": name,
        "type": st.type,
        "createdAt": st.created_at,
        "named": not st.id.startswith(_RUN_STORAGE_PREFIXES),
    }


def version_dict(v: Version) -> dict[str, Any]:
    out = {
        "versionNumber": v.version_number,
        "buildTag": v.build_tag,
        "sourceType": v.source_type,
        "sourceFiles": v.source_files,
    }
    if v.tarball_url:
        out["tarballUrl"] = v.tarball_url
    return out


def actor_dict(
    a: Actor,
    versions: list[Version],
    tagged_builds: dict[str, dict],
    settings: Settings,
) -> dict[str, Any]:
    out = {
        "id": a.id,
        "userId": a.username,
        "name": a.name,
        "username": a.username,
        "createdAt": a.created_at,
        "modifiedAt": a.modified_at,
        "defaultRunOptions": a.default_run_options
        or {"build": "latest", "timeoutSecs": 300, "memoryMbytes": 1024},
        "versions": [version_dict(v) for v in versions],
        "taggedBuilds": tagged_builds,
        # `isPublic`/`stats` are required (no default) by apify-client's own
        # `Actor` response model -- `client.actor(id).get()` re-validates
        # every GET through that model regardless of which SDK Actor code
        # calls it, so a response missing either field fails the call itself
        # before an Actor even sees the result. This runtime never marks
        # anything public, and tracks none of the platform's aggregate usage
        # stats, so both are synthesized: `isPublic: False` and an empty
        # `stats` object (every field of the model's `ActorStats` sub-model is
        # itself optional, so `{}` satisfies it).
        "isPublic": False,
        "stats": {},
    }
    # `standbyUrl` is present only for a standby-enabled actor (matching the
    # real platform: a non-standby actor has no such field at all, not a
    # null one). The model's own `standby_url` field is `Optional[str] = None`,
    # so its absence here is already tolerated -- this is a realism choice,
    # not a validation requirement.
    if (a.actor_standby or {}).get("isEnabled"):
        out["standbyUrl"] = f"{settings.container_api_base_url}/v2/actor-standby/{a.id}"
    return out


def build_dict(b: Build) -> dict[str, Any]:
    return {
        "id": b.id,
        "actId": b.actor_id,
        "userId": b.username,
        "username": b.username,
        "status": b.status,
        "buildNumber": b.build_number,
        "buildTag": b.build_tag,
        "startedAt": b.started_at,
        "finishedAt": b.finished_at,
    }


def run_dict(r: Run) -> dict[str, Any]:
    options = dict(r.options or {})
    options.setdefault("build", "latest")
    options.setdefault("timeoutSecs", 300)
    options.setdefault("memoryMbytes", 1024)
    # `diskMbytes` is required (no default) by apify-client's own `RunOptions`
    # sub-model (nested under `Run.options`) -- see `meta`/`stats`/
    # `generalAccess` below for why this matters.
    options.setdefault("diskMbytes", 2048)
    return {
        "id": r.id,
        "actId": r.actor_id,
        "actorId": r.actor_id,
        "userId": r.username,
        "username": r.username,
        "status": r.status,
        "buildId": r.build_id,
        "buildNumber": r.build_number,
        "exitCode": r.exit_code,
        "startedAt": r.started_at,
        "finishedAt": r.finished_at,
        "options": options,
        "containerUrl": f"http://localhost/{r.id}",
        "defaultKeyValueStoreId": r.kv_store_id,
        "defaultDatasetId": r.dataset_id,
        "defaultRequestQueueId": r.request_queue_id,
        # `meta`/`stats` are required (no default) by apify-client's own
        # `Run` response model: `Actor.init()`'s charging manager always
        # calls `client.run(run_id).get()`, re-validated through that model
        # whenever the Actor is running "at home" (this runtime always sets
        # `APIFY_IS_AT_HOME=1`) and no pricing info was supplied via env vars
        # -- true for every fixture here -- so a response missing either
        # field would crash `Actor.init()` itself before an Actor even
        # reaches its own code. `origin` mirrors the same STANDBY-vs-API
        # distinction `_build_environment` sets as `APIFY_META_ORIGIN`; the
        # other `stats` fields have no local equivalent to source, so they're
        # synthesized as zero/empty.
        "meta": {"origin": "STANDBY" if r.is_standby else "API"},
        "stats": {"restartCount": 0, "resurrectCount": 0, "computeUnits": 0.0},
        # `generalAccess` is likewise required (no default) by the same
        # model, typed as a specific literal set of strings *or* any other
        # string -- so any value satisfies it, but the key must be present.
        # `FOLLOW_USER_SETTING` is the real platform's own default general
        # access level when nothing overrides it (also one of the model's own
        # named literal values, not just a permissive fallback string).
        "generalAccess": "FOLLOW_USER_SETTING",
    }

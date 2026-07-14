"""Serialize domain objects into public-Apify-API-shaped JSON envelopes."""
from __future__ import annotations

from typing import Any

from .db import Actor, Build, Run, Storage, User, Version
from .service import _RUN_STORAGE_PREFIXES


def user_dict(u: User) -> dict[str, Any]:
    return {
        "id": u.username,
        "username": u.username,
        "token": u.token,
        "createdAt": u.created_at,
    }


def storage_dict(st: Storage) -> dict[str, Any]:
    name = st.id.split("~", 1)[1] if "~" in st.id else st.id
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


def actor_dict(a: Actor, versions: list[Version], tagged_builds: dict[str, dict]) -> dict[str, Any]:
    return {
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
    }


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
    }

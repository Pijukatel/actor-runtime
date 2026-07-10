"""Actor, version and build-trigger endpoints (Apify /v2/acts + /v2/actors)."""
from __future__ import annotations

from fastapi import APIRouter, Request

from ..config import USER_ID, USERNAME
from ..responses import data, get_service, not_found, read_json
from ..serializers import actor_dict, build_dict, version_dict

# Registered under both /v2/acts and /v2/actors (the CLI uses /v2/actors).
router = APIRouter()

user_router = APIRouter()


@user_router.get("/v2/users/me")
async def get_me() -> object:
    return data({"id": USER_ID, "username": USERNAME})


async def _actor_payload(svc, actor) -> dict:
    versions = await svc.list_versions(actor.id)
    tagged = await svc.tagged_builds(actor.id)
    return actor_dict(actor, versions, tagged)


@router.get("")
async def list_actors(request: Request) -> object:
    svc = get_service(request)
    actors = await svc.list_actors()
    items = [await _actor_payload(svc, a) for a in actors]
    return data({"total": len(items), "count": len(items), "items": items})


@router.post("")
async def create_actor(request: Request) -> object:
    svc = get_service(request)
    body = await read_json(request)
    actor = await svc.create_actor(
        name=body.get("name", "actor"),
        default_run_options=body.get("defaultRunOptions", {}),
        versions=body.get("versions", []),
    )
    return data(await _actor_payload(svc, actor), status_code=201)


@router.get("/{actor_id}")
async def get_actor(actor_id: str, request: Request) -> object:
    svc = get_service(request)
    actor = await svc.get_actor(actor_id)
    if actor is None:
        return not_found(f"Actor '{actor_id}' was not found.")
    return data(await _actor_payload(svc, actor))


@router.put("/{actor_id}")
async def update_actor(actor_id: str, request: Request) -> object:
    svc = get_service(request)
    body = await read_json(request)
    actor = await svc.update_actor(actor_id, body if isinstance(body, dict) else {})
    if actor is None:
        return not_found(f"Actor '{actor_id}' was not found.")
    return data(await _actor_payload(svc, actor))


@router.get("/{actor_id}/versions/{version_number}")
async def get_version(actor_id: str, version_number: str, request: Request) -> object:
    svc = get_service(request)
    version = await svc.get_version(actor_id, version_number)
    if version is None:
        return not_found(f"Version '{version_number}' was not found.")
    return data(version_dict(version))


@router.post("/{actor_id}/versions")
async def create_version(actor_id: str, request: Request) -> object:
    svc = get_service(request)
    if await svc.get_actor(actor_id) is None:
        return not_found(f"Actor '{actor_id}' was not found.")
    body = await read_json(request)
    version = await svc.upsert_version(actor_id, body)
    return data(version_dict(version), status_code=201)


@router.put("/{actor_id}/versions/{version_number}")
async def update_version(actor_id: str, version_number: str, request: Request) -> object:
    svc = get_service(request)
    if await svc.get_actor(actor_id) is None:
        return not_found(f"Actor '{actor_id}' was not found.")
    body = await read_json(request)
    body.setdefault("versionNumber", version_number)
    version = await svc.upsert_version(actor_id, body)
    return data(version_dict(version))


@router.get("/{actor_id}/builds")
async def list_builds(actor_id: str, request: Request) -> object:
    svc = get_service(request)
    builds = await svc.list_builds(actor_id)
    items = [build_dict(b) for b in builds]
    return data({"total": len(items), "count": len(items), "items": items})


@router.post("/{actor_id}/builds")
async def trigger_build(actor_id: str, request: Request, version: str = "0.0", tag: str = "latest") -> object:
    svc = get_service(request)
    actor = await svc.get_actor(actor_id)
    if actor is None:
        return not_found(f"Actor '{actor_id}' was not found.")
    ver = await svc.get_version(actor_id, version)
    build_tag = ver.build_tag if ver else tag
    build = await svc.start_build(actor_id, version, build_tag)
    return data(build_dict(build), status_code=201)

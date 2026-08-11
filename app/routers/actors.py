"""Actor, version and build-trigger endpoints (Apify /v2/acts + /v2/actors)."""
from __future__ import annotations

from fastapi import APIRouter, Request

from ..auth import resolve_user
from ..responses import data, get_service, not_found, paged_envelope, parse_page, read_json
from ..serializers import actor_dict, build_dict, run_dict, storage_dict, version_dict
from ..service import STORAGE_DS, STORAGE_KV, STORAGE_RQ

# Registered under both /v2/acts and /v2/actors (the CLI uses /v2/actors).
router = APIRouter()

user_router = APIRouter()


async def _my_storages(request: Request, storage_type: str) -> object:
    svc = get_service(request)
    user = await resolve_user(request)
    storages = await svc.list_storages_for_user(user, type=storage_type)
    items = [storage_dict(st) for st in storages]
    limit, offset = parse_page(request)
    return data(paged_envelope(items, limit, offset, echo_limit=False, always_total=True))


@user_router.get("/v2/users/me")
async def get_me(request: Request) -> object:
    svc = get_service(request)
    user = await resolve_user(request)
    row = await svc.get_user(user)
    token = row.token if row is not None else None
    return data({"id": user, "username": user, "token": token})


@user_router.get("/v2/users/{user_id_or_username}")
async def get_user_public(user_id_or_username: str, request: Request) -> object:
    """Public profile lookup for ANY user, by id or username.

    Id and username are the same value in this runtime, so one lookup
    serves both. Response is always the public shape (no `token`), even
    for self-lookups. Unknown id/username -> 404 envelope. `resolve_user`
    here is just the bootstrap-or-reject auth guard, not identity resolution.
    """
    svc = get_service(request)
    await resolve_user(request)
    row = await svc.get_user(user_id_or_username)
    if row is None:
        return not_found(f"User '{user_id_or_username}' was not found.")
    return data({"id": row.username, "username": row.username})


@user_router.get("/v2/users/me/actors")
async def my_actors(request: Request) -> object:
    svc = get_service(request)
    user = await resolve_user(request)
    actors = await svc.list_actors(username=user)
    items = [await _actor_payload(svc, a) for a in actors]
    return data({"total": len(items), "count": len(items), "items": items})


@user_router.get("/v2/users/me/builds")
async def my_builds(request: Request) -> object:
    svc = get_service(request)
    user = await resolve_user(request)
    builds = await svc.list_builds_for_user(user)
    items = [build_dict(b) for b in builds]
    return data({"total": len(items), "count": len(items), "items": items})


@user_router.get("/v2/users/me/runs")
async def my_runs(request: Request) -> object:
    svc = get_service(request)
    user = await resolve_user(request)
    runs = await svc.list_runs_for_user(user)
    items = [run_dict(r) for r in runs]
    return data({"total": len(items), "count": len(items), "items": items})


@user_router.get("/v2/users/me/key-value-stores")
async def my_key_value_stores(request: Request) -> object:
    return await _my_storages(request, STORAGE_KV)


@user_router.get("/v2/users/me/datasets")
async def my_datasets(request: Request) -> object:
    return await _my_storages(request, STORAGE_DS)


@user_router.get("/v2/users/me/request-queues")
async def my_request_queues(request: Request) -> object:
    return await _my_storages(request, STORAGE_RQ)


async def _actor_payload(svc, actor) -> dict:
    versions = await svc.list_versions(actor.id)
    tagged = await svc.tagged_builds(actor.id)
    return actor_dict(actor, versions, tagged, svc.settings)


@router.get("")
async def list_actors(request: Request) -> object:
    svc = get_service(request)
    user = await resolve_user(request)
    actors = await svc.list_actors(username=user)
    items = [await _actor_payload(svc, a) for a in actors]
    return data({"total": len(items), "count": len(items), "items": items})


@router.post("")
async def create_actor(request: Request) -> object:
    svc = get_service(request)
    user = await resolve_user(request)
    body = await read_json(request)
    actor = await svc.create_actor(
        name=body.get("name", "actor"),
        default_run_options=body.get("defaultRunOptions", {}),
        versions=body.get("versions", []),
        username=user,
        actor_standby=body.get("actorStandby"),
    )
    return data(await _actor_payload(svc, actor), status_code=201)


@router.get("/{actor_id}")
async def get_actor(actor_id: str, request: Request) -> object:
    svc = get_service(request)
    user = await resolve_user(request)
    actor = await svc.get_actor(actor_id, username=user)
    if actor is None:
        return not_found(f"Actor '{actor_id}' was not found.")
    return data(await _actor_payload(svc, actor))


@router.put("/{actor_id}")
async def update_actor(actor_id: str, request: Request) -> object:
    svc = get_service(request)
    user = await resolve_user(request)
    body = await read_json(request)
    actor = await svc.update_actor(actor_id, body if isinstance(body, dict) else {}, username=user)
    if actor is None:
        return not_found(f"Actor '{actor_id}' was not found.")
    return data(await _actor_payload(svc, actor))


@router.get("/{actor_id}/input-schema")
async def get_input_schema(actor_id: str, request: Request) -> object:
    """Resolve the actor's input schema for the console's Input tab.

    Resolved from the SAME version a default (``build=latest``) run would
    actually execute -- the version behind the actor's most recent
    successful build, falling back to its latest-tagged version only when no
    build exists yet (see ``Service.get_input_schema``'s docstring for why).
    Returns ``data(None)`` -- not a 404 -- whenever no schema can be resolved
    (no versions, no manifest/schema file, a TARBALL version, or a malformed
    schema file), matching ``.actor/actor.json``'s own fail-soft inference
    contract. Only an unknown/inaccessible actor id is a 404.
    """
    svc = get_service(request)
    user = await resolve_user(request)
    actor = await svc.get_actor(actor_id, username=user)
    if actor is None:
        return not_found(f"Actor '{actor_id}' was not found.")
    schema = await svc.get_input_schema(actor_id)
    return data(schema)


@router.get("/{actor_id}/versions/{version_number}")
async def get_version(actor_id: str, version_number: str, request: Request) -> object:
    svc = get_service(request)
    user = await resolve_user(request)
    if await svc.get_actor(actor_id, username=user) is None:
        return not_found(f"Actor '{actor_id}' was not found.")
    version = await svc.get_version(actor_id, version_number)
    if version is None:
        return not_found(f"Version '{version_number}' was not found.")
    return data(version_dict(version))


@router.post("/{actor_id}/versions")
async def create_version(actor_id: str, request: Request) -> object:
    svc = get_service(request)
    user = await resolve_user(request)
    if await svc.get_actor(actor_id, username=user) is None:
        return not_found(f"Actor '{actor_id}' was not found.")
    body = await read_json(request)
    version = await svc.upsert_version(actor_id, body)
    return data(version_dict(version), status_code=201)


@router.put("/{actor_id}/versions/{version_number}")
async def update_version(actor_id: str, version_number: str, request: Request) -> object:
    svc = get_service(request)
    user = await resolve_user(request)
    if await svc.get_actor(actor_id, username=user) is None:
        return not_found(f"Actor '{actor_id}' was not found.")
    body = await read_json(request)
    body.setdefault("versionNumber", version_number)
    version = await svc.upsert_version(actor_id, body)
    return data(version_dict(version))


@router.get("/{actor_id}/builds")
async def list_builds(actor_id: str, request: Request) -> object:
    svc = get_service(request)
    user = await resolve_user(request)
    builds = await svc.list_builds(actor_id, username=user)
    items = [build_dict(b) for b in builds]
    return data({"total": len(items), "count": len(items), "items": items})


@router.post("/{actor_id}/builds")
async def trigger_build(actor_id: str, request: Request, version: str = "0.0", tag: str = "latest") -> object:
    svc = get_service(request)
    user = await resolve_user(request)
    actor = await svc.get_actor(actor_id, username=user)
    if actor is None:
        return not_found(f"Actor '{actor_id}' was not found.")
    ver = await svc.get_version(actor_id, version)
    build_tag = ver.build_tag if ver else tag
    build = await svc.start_build(actor_id, version, build_tag)
    return data(build_dict(build), status_code=201)

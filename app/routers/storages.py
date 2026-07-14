"""Key-value store, dataset and request-queue endpoints."""
from __future__ import annotations

import json

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse, PlainTextResponse, Response

from ..auth import resolve_user
from ..responses import bad_request, conflict, data, forbidden, get_service, not_found, read_body, read_json
from ..service import (
    _RUN_STORAGE_PREFIXES,
    ACCESS_ABSENT,
    ACCESS_ALLOW,
    ACCESS_FORBIDDEN,
    LEVEL_READ,
    LEVEL_WRITE,
    STORAGE_DS,
    STORAGE_KV,
    STORAGE_RQ,
)

router = APIRouter()


def _namespace_owner(storage_id: str) -> str | None:
    """Return the user a namespaced storage id (``owner~name``) belongs to, else None."""
    if "~" in storage_id:
        return storage_id.split("~", 1)[0]
    return None


def _can_autocreate(storage_id: str, user: str) -> bool:
    """Whether an absent-id write may auto-create a storage owned by ``user``.

    Airtight rule: a write may only ever create a storage the writer owns under
    the writer's own space. It must never mint an id another user would be handed
    by the documented flow -- i.e. another user's namespaced ``owner~name`` id, or
    a run-derived ``kv_/ds_/rq_`` id (always created at run start, never here).
    """
    if storage_id.startswith(_RUN_STORAGE_PREFIXES):
        return False
    owner = _namespace_owner(storage_id)
    return owner is None or owner == user


def _is_textual(content_type: str) -> bool:
    ct = content_type.lower()
    return (
        ct.startswith("text/")
        or "json" in ct
        or "xml" in ct
        or "javascript" in ct
        or "x-www-form-urlencoded" in ct
    )


async def _guard(request: Request, storage_id: str, need: str, storage_type: str):
    """Return ``(user, denial_response_or_None)`` for a storage read/write.

    A read denial (another user's storage, or an unknown/absent id) hides existence
    with ``not_found()`` (404). An id that exists as a different storage type than
    ``storage_type`` is also ``not_found()`` (404) -- as this type it does not exist.
    A write to an absent id auto-creates the storage owned by the writer -- but only
    for an id the writer may legitimately own (see ``_can_autocreate``); a write to
    an absent id that belongs to another user's namespace (or a run-derived id) is
    ``not_found()`` (404), never seized. If the auto-create loses a race (another
    caller won ownership of the same fresh id), the caller has no access to what now
    exists there, so the write is denied ``not_found()`` (404) rather than landing in
    the winner's storage. A write denial on a storage the caller can already see
    (READ-only grantee) returns ``forbidden()`` (403); a write to a storage the
    caller cannot see at all returns ``not_found()`` (404).
    """
    svc = get_service(request)
    user = await resolve_user(request)
    decision = await svc.check_storage_access(storage_id, user, need, storage_type)
    if decision == ACCESS_ALLOW:
        return user, None
    if decision == ACCESS_ABSENT:
        if need == LEVEL_WRITE and _can_autocreate(storage_id, user):
            owner = await svc.ensure_storage(storage_id, storage_type, user)
            if owner != user:
                return user, not_found("We did not find the resource you were looking for.")
            return user, None
        return user, not_found("We did not find the resource you were looking for.")
    if decision == ACCESS_FORBIDDEN:
        return user, forbidden("You do not have permission to write to this storage.")
    return user, not_found("We did not find the resource you were looking for.")


async def _owner_or_forbidden(request: Request, storage_id: str):
    """Return ``(storage, denial_response_or_None)``; management is owner-only.

    An id with no backing storage row hides existence with ``not_found()`` (404),
    like every other unknown-resource path; ``forbidden()`` (403) is reserved for a
    row that exists but is not owned by the caller.
    """
    svc = get_service(request)
    user = await resolve_user(request)
    storage = await svc.get_storage(storage_id)
    if storage is None:
        return None, not_found("We did not find the resource you were looking for.")
    if storage.owner != user:
        return None, forbidden("Only the storage owner can manage its access rights.")
    return storage, None


async def _create_storage(request: Request, storage_type: str) -> object:
    """Create-echo a standalone storage, namespaced per user like Actors.

    The returned id is ``username~name`` so two users never collide on a global
    id (e.g. ``default``). Creating again as the same owner is idempotent (200);
    an id that already resolves to another user's row is a conflict (409), never a
    misleading 201 that fails to grant ownership.
    """
    svc = get_service(request)
    user = await resolve_user(request)
    body = await read_json(request)
    name = body.get("name", "default")
    storage_id = f"{user}~{name}"
    existing = await svc.get_storage(storage_id)
    if existing is not None:
        if existing.owner != user:
            return conflict("A storage with this id already exists under another owner.")
        return data({"id": storage_id, "name": name}, status_code=200)
    await svc.ensure_storage(storage_id, storage_type, user)
    return data({"id": storage_id, "name": name}, status_code=201)


async def _delete_storage(request: Request, storage_id: str, storage_type: str) -> object:
    """Owner-only hard delete of a standalone storage of ``storage_type``.

    Cross-user or unknown ids are hidden as ``404 record-not-found`` (existence is
    never leaked), exactly like every other cross-user access. A run-derived id
    (``kv_/ds_/rq_<run_id>``) owned by the caller is refused ``400 invalid-request``:
    it is managed with its run and deleting it would orphan the run's storage
    references. Success removes the row, its access-rights grants and the data.
    """
    svc = get_service(request)
    user = await resolve_user(request)
    storage = await svc.get_storage(storage_id)
    if storage is None or storage.owner != user or storage.type != storage_type:
        return not_found("We did not find the resource you were looking for.")
    if storage_id.startswith(_RUN_STORAGE_PREFIXES):
        return bad_request(
            "This storage belongs to an Actor run and is managed with its run; it cannot be deleted here."
        )
    result = await svc.delete_storage(storage_id, user)
    if result != ACCESS_ALLOW:
        return not_found("We did not find the resource you were looking for.")
    return data({"id": storage_id})


# -- key-value stores -----------------------------------------------------
@router.post("/v2/key-value-stores")
async def create_kvs(request: Request) -> object:
    return await _create_storage(request, STORAGE_KV)


@router.get("/v2/key-value-stores/{store_id}")
async def get_kvs(store_id: str, request: Request) -> object:
    svc = get_service(request)
    _user, denied = await _guard(request, store_id, LEVEL_READ, STORAGE_KV)
    if denied:
        return denied
    keys = await svc.storage.kv_keys(store_id)
    return data({"id": store_id, "name": store_id, "itemCount": len(keys)})


@router.get("/v2/key-value-stores/{store_id}/keys")
async def list_keys(store_id: str, request: Request) -> object:
    svc = get_service(request)
    _user, denied = await _guard(request, store_id, LEVEL_READ, STORAGE_KV)
    if denied:
        return denied
    keys = await svc.storage.kv_keys(store_id)
    return data({"items": keys, "count": len(keys), "limit": len(keys), "isTruncated": False})


@router.get("/v2/key-value-stores/{store_id}/records/{key}")
async def get_record(store_id: str, key: str, request: Request) -> Response:
    svc = get_service(request)
    _user, denied = await _guard(request, store_id, LEVEL_READ, STORAGE_KV)
    if denied:
        return denied
    record = await svc.storage.kv_record(store_id, key)
    if record is None:
        return not_found(f"Record '{key}' was not found.")
    value, content_type = record
    if "json" in content_type:
        return JSONResponse(value)
    if isinstance(value, (dict, list)):
        return JSONResponse(value)
    if isinstance(value, bytes):
        return Response(content=value, media_type=content_type)
    return PlainTextResponse(str(value), media_type=content_type)


@router.put("/v2/key-value-stores/{store_id}/records/{key}")
async def put_record(store_id: str, key: str, request: Request) -> object:
    svc = get_service(request)
    _user, denied = await _guard(request, store_id, LEVEL_WRITE, STORAGE_KV)
    if denied:
        return denied
    content_type = request.headers.get("content-type", "application/octet-stream")
    raw = await read_body(request)
    if "json" in content_type:
        try:
            value = json.loads(raw) if raw else None
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            raise HTTPException(status_code=400, detail=f"Malformed JSON record body: {exc}")
    elif _is_textual(content_type):
        # Decode only genuinely textual payloads; binary (PNG, PDF, ...) must be
        # stored as raw bytes so it round-trips through PUT/GET unchanged.
        value = raw.decode("utf-8", errors="replace")
    else:
        value = raw
    await svc.storage.kv_set(store_id, key, value, content_type)
    return data({"key": key})


@router.delete("/v2/key-value-stores/{store_id}")
async def delete_kvs(store_id: str, request: Request) -> object:
    return await _delete_storage(request, store_id, STORAGE_KV)


# -- datasets -------------------------------------------------------------
@router.post("/v2/datasets")
async def create_dataset(request: Request) -> object:
    return await _create_storage(request, STORAGE_DS)


@router.get("/v2/datasets/{dataset_id}")
async def get_dataset(dataset_id: str, request: Request) -> object:
    svc = get_service(request)
    _user, denied = await _guard(request, dataset_id, LEVEL_READ, STORAGE_DS)
    if denied:
        return denied
    result = await svc.storage.dataset_items(dataset_id)
    return data({"id": dataset_id, "name": dataset_id, "itemCount": result["total"]})


@router.get("/v2/datasets/{dataset_id}/items")
async def get_items(dataset_id: str, request: Request) -> JSONResponse:
    svc = get_service(request)
    _user, denied = await _guard(request, dataset_id, LEVEL_READ, STORAGE_DS)
    if denied:
        return denied
    result = await svc.storage.dataset_items(dataset_id)
    return JSONResponse(result["items"])


@router.post("/v2/datasets/{dataset_id}/items")
async def push_items(dataset_id: str, request: Request) -> object:
    svc = get_service(request)
    _user, denied = await _guard(request, dataset_id, LEVEL_WRITE, STORAGE_DS)
    if denied:
        return denied
    payload = await read_json(request)
    items = payload if isinstance(payload, list) else [payload]
    await svc.storage.dataset_push(dataset_id, items)
    return data({"count": len(items)}, status_code=201)


@router.delete("/v2/datasets/{dataset_id}")
async def delete_dataset(dataset_id: str, request: Request) -> object:
    return await _delete_storage(request, dataset_id, STORAGE_DS)


# -- request queues -------------------------------------------------------
@router.post("/v2/request-queues")
async def create_request_queue(request: Request) -> object:
    return await _create_storage(request, STORAGE_RQ)


@router.get("/v2/request-queues/{queue_id}")
async def get_queue(queue_id: str, request: Request) -> object:
    svc = get_service(request)
    _user, denied = await _guard(request, queue_id, LEVEL_READ, STORAGE_RQ)
    if denied:
        return denied
    return data(await svc.storage.rq_metadata(queue_id))


@router.get("/v2/request-queues/{queue_id}/requests")
async def list_requests(queue_id: str, request: Request) -> object:
    svc = get_service(request)
    _user, denied = await _guard(request, queue_id, LEVEL_READ, STORAGE_RQ)
    if denied:
        return denied
    items = await svc.storage.rq_requests(queue_id)
    return data({"items": items, "count": len(items), "limit": len(items)})


@router.post("/v2/request-queues/{queue_id}/requests")
async def add_request(queue_id: str, request: Request) -> object:
    svc = get_service(request)
    _user, denied = await _guard(request, queue_id, LEVEL_WRITE, STORAGE_RQ)
    if denied:
        return denied
    body = await read_json(request)
    await svc.storage.rq_add(queue_id, [body])
    return data({"requestId": body.get("uniqueKey") or body.get("url")}, status_code=201)


@router.delete("/v2/request-queues/{queue_id}")
async def delete_request_queue(queue_id: str, request: Request) -> object:
    return await _delete_storage(request, queue_id, STORAGE_RQ)


# -- access rights (sharing) ----------------------------------------------
# Nested under each storage type; all three routes are owner-only (403 otherwise).
@router.post("/v2/key-value-stores/{storage_id}/access-rights")
@router.post("/v2/datasets/{storage_id}/access-rights")
@router.post("/v2/request-queues/{storage_id}/access-rights")
async def grant_access_right(storage_id: str, request: Request) -> object:
    svc = get_service(request)
    storage, denied = await _owner_or_forbidden(request, storage_id)
    if denied:
        return denied
    body = await read_json(request)
    grantee = body.get("grantee")
    level = body.get("level")
    if not grantee or level not in (LEVEL_READ, LEVEL_WRITE):
        raise HTTPException(
            status_code=400, detail="Body must include 'grantee' and 'level' (READ or WRITE)."
        )
    await svc.grant_access(storage_id, storage.type, grantee, level)
    return data({"resourceId": storage_id, "grantee": grantee, "level": level}, status_code=201)


@router.get("/v2/key-value-stores/{storage_id}/access-rights")
@router.get("/v2/datasets/{storage_id}/access-rights")
@router.get("/v2/request-queues/{storage_id}/access-rights")
async def list_access_rights(storage_id: str, request: Request) -> object:
    svc = get_service(request)
    _storage, denied = await _owner_or_forbidden(request, storage_id)
    if denied:
        return denied
    rights = await svc.list_access(storage_id)
    items = [{"grantee": r.grantee, "level": r.level} for r in rights]
    return data({"total": len(items), "count": len(items), "items": items})


@router.delete("/v2/key-value-stores/{storage_id}/access-rights/{grantee}")
@router.delete("/v2/datasets/{storage_id}/access-rights/{grantee}")
@router.delete("/v2/request-queues/{storage_id}/access-rights/{grantee}")
async def revoke_access_right(storage_id: str, grantee: str, request: Request) -> object:
    svc = get_service(request)
    _storage, denied = await _owner_or_forbidden(request, storage_id)
    if denied:
        return denied
    await svc.revoke_access(storage_id, grantee)
    return data({"resourceId": storage_id, "grantee": grantee})

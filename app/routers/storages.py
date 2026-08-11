"""Key-value store, dataset and request-queue endpoints."""
from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse, PlainTextResponse, Response

from ..auth import resolve_user
from ..pagination import paged_envelope, parse_page
from ..responses import (
    bad_request,
    conflict,
    data,
    forbidden,
    get_service,
    not_found,
    read_body,
    read_json,
)
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
    InvalidStorageNameError,
    StorageTypeCollisionError,
    storage_name_from_id,
    validate_storage_name,
)
from ..storage import DEFAULT_HEAD_LIMIT, DEFAULT_ITEM_LIMIT

router = APIRouter()


def _storage_meta(svc, storage, kind: str) -> dict:
    """Field-complete base metadata shared by dataset/KVS/RQ GET responses.

    ``id``/``userId``/``createdAt`` are sourced from the storage's own row; this
    runtime does not track separate modification/access timestamps, so
    ``modifiedAt``/``accessedAt`` are synthesized equal to ``createdAt`` --
    still valid, present datetimes, which is all apify-client's response models
    require (and keeps the shape a superset apify-client 3.x's stricter models
    would also accept, per the design's version-pin decision). ``consoleUrl`` is
    likewise synthesized (the runtime never sets a real public console host).

    ``name`` is derived by the single shared helper,
    ``constants.storage_name_from_id`` (also used by
    ``serializers.storage_dict()``, so the two paths can never drift apart):
    empty for a run-derived ``kv_/ds_/rq_<run_id>`` id, the ``name`` half of a
    ``username~name`` id, or -- for a type-qualified
    ``username~{storage_type}~name`` id, minted when a second storage type
    collides with an existing owner+name (see ``_create_storage`` below) --
    the part after the type prefix, NOT the raw id and NOT a blind first-``~``
    split (which would leave the type prefix attached): crawlee's own
    ``KeyValueStore``/``Dataset``/``RequestQueue`` domain objects validate a
    non-empty ``name`` against ``^[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9]$`` the
    instant an SDK Actor opens its default storage, and every id this runtime
    mints contains ``_`` or ``~`` -- neither is a legal storage name, so
    handing back the id (or an under-stripped id) verbatim as ``name`` would
    make `Actor.get_input()` itself raise `ValueError` before any Actor code
    runs.
    """
    name = storage_name_from_id(storage.id, storage.type)
    return {
        "id": storage.id,
        "name": name,
        "userId": storage.owner,
        "createdAt": storage.created_at,
        "modifiedAt": storage.created_at,
        "accessedAt": storage.created_at,
        "consoleUrl": f"{svc.settings.container_api_base_url}/storage/{kind}/{storage.id}",
    }


def _namespace_owner(storage_id: str) -> str | None:
    """Return the user a namespaced storage id (``owner~name``) belongs to, else None."""
    if "~" in storage_id:
        return storage_id.split("~", 1)[0]
    return None


def _can_autocreate(storage_id: str, user: str, storage_type: str) -> bool:
    """Whether an absent-id write may auto-create a storage owned by ``user``.

    Airtight rule: a write may only ever create a storage the writer owns under
    the writer's own space. It must never mint an id another user would be handed
    by the documented flow -- i.e. another user's namespaced ``owner~name`` id, or
    a run-derived ``kv_/ds_/rq_`` id (always created at run start, never here).

    A namespaced id (``owner~name`` or ``owner~{type}~name``) is additionally
    checked against the same naming rule the by-name create route enforces
    (`validate_storage_name`, applied to whatever ``name`` this id would
    report via `storage_name_from_id`): this write-auto-create path can
    address ANY caller-chosen id, not only ones produced by
    `get_or_create_named_storage`, so without this check a caller could mint
    a storage here whose derived ``name`` field is not a valid storage name
    -- crawlee's own domain objects reject exactly that name the instant a
    real SDK Actor opens a storage by it.
    """
    if storage_id.startswith(_RUN_STORAGE_PREFIXES):
        return False
    owner = _namespace_owner(storage_id)
    if owner is not None and owner != user:
        return False
    if "~" in storage_id:
        try:
            validate_storage_name(storage_name_from_id(storage_id, storage_type))
        except InvalidStorageNameError:
            return False
    return True


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
    """Return ``(user, storage, denial_response_or_None)`` for a storage read/write.

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

    ``storage`` is the row ``check_storage_access`` already read to decide access --
    present whenever the call is allowed against an existing row, ``None`` otherwise
    (denied, or a write that auto-created a fresh id -- no caller needs the row on
    that branch). Handing it back lets a caller that also needs the row for its
    response (the per-storage metadata GET routes below) reuse this single read
    instead of issuing a second, independent one.
    """
    svc = get_service(request)
    user = await resolve_user(request)
    decision, storage = await svc.check_storage_access(storage_id, user, need, storage_type)
    if decision == ACCESS_ALLOW:
        return user, storage, None
    if decision == ACCESS_ABSENT:
        if need == LEVEL_WRITE and _can_autocreate(storage_id, user, storage_type):
            owner = await svc.ensure_storage(storage_id, storage_type, user)
            if owner != user:
                return user, None, not_found("We did not find the resource you were looking for.")
            return user, None, None
        return user, None, not_found("We did not find the resource you were looking for.")
    if decision == ACCESS_FORBIDDEN:
        return user, None, forbidden("You do not have permission to write to this storage.")
    return user, None, not_found("We did not find the resource you were looking for.")


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
    """Create-echo (get-or-create) a standalone storage, namespaced per user
    like Actors.

    ``name`` is read from the query string first: the real apify-client's
    ``ResourceCollectionClientAsync._get_or_create()`` -- which backs
    ``key_value_stores().get_or_create()``/``datasets().get_or_create()``/
    ``request_queues().get_or_create()``, i.e. exactly what
    ``Actor.open_dataset(name=...)``/``open_key_value_store(name=...)``/
    ``open_request_queue(name=...)`` call underneath -- sends
    ``params=self._params(name=name), json=resource`` with ``resource`` empty
    (``None`` for request queues, ``{}`` for datasets/KVS with no schema), so a
    real SDK Actor opening a named storage never puts ``name`` in the JSON
    body at all. The JSON body ``name`` key is kept as a fallback (query param
    wins if both are present) so this runtime's own tests/console, which POST
    ``{"name": ...}`` in the body, keep working unchanged.

    The returned id is normally ``username~name`` so two users never collide
    on a global id (e.g. ``default``). Two *different* storage types sharing
    the same owner+name would otherwise collide on that same unqualified id
    (this runtime's ``storages`` table has one row per id, regardless of
    type) -- misrouting a get to the wrong type, or (worse) silently
    reporting success without actually creating the requested type. Instead,
    whichever type claims the unqualified id first keeps it; every other type
    sharing that owner+name gets its own deterministic, type-qualified id
    (``username~{storage_type}~name``), so a KV store and a dataset (etc.)
    can coexist under an identical name.

    The read-decide-create sequence that picks between the unqualified and
    type-qualified id is delegated whole to
    ``svc.get_or_create_named_storage()`` (``app/storage_access.py``), which
    runs it under a per-(owner, name) in-process lock -- required so that
    concurrent get-or-create calls for DIFFERENT types sharing the same
    not-yet-existing owner+name serialize instead of racing: without the
    lock, every racer could read the unqualified id as absent before any of
    them committed, so more than one type would try to claim it and every
    loser after the first would silently get back a "success" response for
    an id that does not hold its requested type. See that function's
    docstring for the full race and fix description.

    Creating again as the same owner+type is idempotent (200); an id that
    already resolves to another user's row is a conflict (409), never a
    misleading 201 that fails to grant ownership.

    ``name`` is validated server-side before ``get_or_create_named_storage``
    does anything else with it: a name containing ``~`` could otherwise
    deterministically collide with an unrelated storage's literal id via
    this runtime's own qualified-id scheme above, silently reporting success
    while misrouting to the wrong storage. An invalid name is ``400
    invalid-request``; the (now normally unreachable, defence-in-depth) case
    where the qualified id nonetheless resolves to a different type is
    ``409 resource-conflict`` rather than a silent misroute.
    """
    svc = get_service(request)
    user = await resolve_user(request)
    body = await read_json(request)
    if not isinstance(body, dict):
        body = {}
    name = request.query_params.get("name") or body.get("name") or "default"
    try:
        storage_id, actual_owner, created = await svc.get_or_create_named_storage(name, storage_type, user)
    except InvalidStorageNameError as exc:
        return bad_request(str(exc))
    except StorageTypeCollisionError as exc:
        return conflict(str(exc))
    if not created:
        if actual_owner != user:
            return conflict("A storage with this id already exists under another owner.")
        return data({"id": storage_id, "name": name}, status_code=200)
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
    _user, storage, denied = await _guard(request, store_id, LEVEL_READ, STORAGE_KV)
    if denied:
        return denied
    if storage is None:
        return not_found("We did not find the resource you were looking for.")
    keys = await svc.storage.kv_keys(store_id)
    meta = _storage_meta(svc, storage, "key-value-stores")
    meta["itemCount"] = len(keys)
    return data(meta)


async def _kv_keys_cursor_envelope(
    svc, request: Request, store_id: str, exclusive_start_key: str | None, limit: int | None
) -> dict[str, Any]:
    """Cursor-mode envelope for ``GET /v2/key-value-stores/{id}/keys``: pushes
    ``exclusiveStartKey``/``limit`` straight through to crawlee's own
    ascending ``iterate_keys(exclusive_start_key=, limit=)`` (see
    ``Storage.kv_keys_page``), matching the real API's ``ListOfKeys`` cursor
    contract closely enough for the pinned apify-client's ``iterate_keys()``
    to page correctly at any store size.

    A bare call (``exclusive_start_key`` and ``limit`` both ``None``) returns
    every key as a plain ``{key, size}`` pair, with ``isTruncated: False`` and
    no ``exclusiveStartKey``/``nextExclusiveStartKey`` fields at all --
    byte-for-byte the same shape this surface had before cursor support
    existed. Either param present is real cursor-mode paging: each item
    additionally carries a ``recordPublicUrl`` (the pinned apify-client's
    ``KeyValueStoreKey`` model requires it on every item it validates), and
    the envelope never gains a ``total`` field -- unlike the offset-sliced
    path below, which already holds the full list and can report one for
    free, computing a store-wide count here would force exactly the
    full-store scan the cursor pushdown exists to avoid, turning an O(page)
    read into an O(store) one on every page.

    ``recordPublicUrl`` is built from ``request.base_url`` -- the host/port
    this same request actually arrived on -- rather than
    ``Settings.container_api_base_url`` (the fixed Docker-network hostname
    ``standbyUrl``/``consoleUrl`` use): this route's callers are typically
    host-side (curl, or apify-client pointed at the published API port), and
    a Docker-internal hostname would not resolve for them at all. Reusing the
    request's own origin resolves correctly for both a host-side caller and
    one reaching this route from inside another Actor container.
    """
    page, is_truncated, next_key = await svc.storage.kv_keys_page(
        store_id, exclusive_start_key=exclusive_start_key, limit=limit
    )
    paginated = limit is not None or exclusive_start_key is not None
    if paginated:
        base = str(request.base_url).rstrip("/")
        page = [
            {**item, "recordPublicUrl": f"{base}/v2/key-value-stores/{store_id}/records/{item['key']}"}
            for item in page
        ]
    envelope: dict[str, Any] = {"items": page, "count": len(page)}
    envelope["limit"] = limit if limit is not None else len(page)
    if exclusive_start_key is not None:
        envelope["exclusiveStartKey"] = exclusive_start_key
    envelope["isTruncated"] = is_truncated
    if next_key is not None:
        envelope["nextExclusiveStartKey"] = next_key
    return envelope


@router.get("/v2/key-value-stores/{store_id}/keys")
async def list_keys(store_id: str, request: Request) -> object:
    """List a KV store's keys.

    Two independent, mutually-exclusive-in-practice paging mechanisms share
    this one endpoint: a caller-supplied ``exclusiveStartKey`` cursor (pushed
    down to crawlee, ascending, real-API-shaped ``isTruncated``/
    ``nextExclusiveStartKey`` -- see ``_kv_keys_cursor_envelope``) and the
    console's own ``offset``-based paging (an already-fetched full list
    sliced in Python, unaffected by cursor support). ``offset`` has no
    equivalent in the real API's own KV-keys contract, so a request naming
    BOTH ``exclusiveStartKey`` and ``offset`` treats the cursor as
    authoritative and ignores ``offset`` entirely, rather than mixing two
    incompatible notions of "where to start". A bare request (neither param,
    nor ``limit``) takes the cursor path with everything ``None``, which
    reproduces today's unpaginated shape exactly.
    """
    svc = get_service(request)
    _user, _storage, denied = await _guard(request, store_id, LEVEL_READ, STORAGE_KV)
    if denied:
        return denied
    limit, offset = parse_page(request)
    exclusive_start_key = request.query_params.get("exclusiveStartKey") or None
    if exclusive_start_key is not None or offset is None:
        return data(await _kv_keys_cursor_envelope(svc, request, store_id, exclusive_start_key, limit))
    keys = await svc.storage.kv_keys(store_id)
    is_truncated = limit is not None and offset + limit < len(keys)
    return data(paged_envelope(keys, limit, offset, isTruncated=is_truncated))


@router.get("/v2/key-value-stores/{store_id}/records/{key}")
async def get_record(store_id: str, key: str, request: Request) -> Response:
    svc = get_service(request)
    _user, _storage, denied = await _guard(request, store_id, LEVEL_READ, STORAGE_KV)
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
    _user, _storage, denied = await _guard(request, store_id, LEVEL_WRITE, STORAGE_KV)
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


@router.delete("/v2/key-value-stores/{store_id}/records/{key}")
async def delete_record(store_id: str, key: str, request: Request) -> object:
    svc = get_service(request)
    _user, _storage, denied = await _guard(request, store_id, LEVEL_WRITE, STORAGE_KV)
    if denied:
        return denied
    await svc.storage.kv_delete_record(store_id, key)
    return data({"key": key})


@router.head("/v2/key-value-stores/{store_id}/records/{key}")
async def head_record(store_id: str, key: str, request: Request) -> Response:
    svc = get_service(request)
    _user, _storage, denied = await _guard(request, store_id, LEVEL_READ, STORAGE_KV)
    if denied:
        return Response(status_code=denied.status_code)
    record = await svc.storage.kv_record(store_id, key)
    return Response(status_code=200 if record is not None else 404)


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
    _user, storage, denied = await _guard(request, dataset_id, LEVEL_READ, STORAGE_DS)
    if denied:
        return denied
    if storage is None:
        return not_found("We did not find the resource you were looking for.")
    result = await svc.storage.dataset_items(dataset_id)
    meta = _storage_meta(svc, storage, "datasets")
    # No separate "clean" (non-empty/non-hidden-field) count is tracked; the
    # full item count is a reasonable, always-present stand-in.
    meta["itemCount"] = result["total"]
    meta["cleanItemCount"] = result["total"]
    return data(meta)


@router.get("/v2/datasets/{dataset_id}/items")
async def get_items(dataset_id: str, request: Request) -> JSONResponse:
    svc = get_service(request)
    _user, _storage, denied = await _guard(request, dataset_id, LEVEL_READ, STORAGE_DS)
    if denied:
        return denied
    limit, offset = parse_page(request)
    paginated = limit is not None or offset is not None
    result = await svc.storage.dataset_items(
        dataset_id, offset=offset or 0, limit=limit if limit is not None else DEFAULT_ITEM_LIMIT
    )
    response = JSONResponse(result["items"])
    # Bare (no limit/offset) requests stay byte-for-byte identical to today --
    # no new headers -- matching the real API's own `format=json` convention
    # only once a caller actually asks to page (`X-Apify-Pagination-*`).
    if paginated:
        response.headers["X-Apify-Pagination-Offset"] = str(result["offset"])
        response.headers["X-Apify-Pagination-Count"] = str(result["count"])
        response.headers["X-Apify-Pagination-Total"] = str(result["total"])
        # Effective limit -- the requested value, or (when only `offset` was
        # given) the slice's own returned length, never the internal
        # DEFAULT_ITEM_LIMIT sentinel used to mean "no cap" to the storage
        # layer -- matching `paged_envelope`'s own convention for the same
        # "no limit given" case on the other three listing surfaces.
        response.headers["X-Apify-Pagination-Limit"] = str(limit if limit is not None else result["count"])
    return response


@router.post("/v2/datasets/{dataset_id}/items")
async def push_items(dataset_id: str, request: Request) -> object:
    svc = get_service(request)
    _user, _storage, denied = await _guard(request, dataset_id, LEVEL_WRITE, STORAGE_DS)
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
    _user, storage, denied = await _guard(request, queue_id, LEVEL_READ, STORAGE_RQ)
    if denied:
        return denied
    if storage is None:
        return not_found("We did not find the resource you were looking for.")
    meta = _storage_meta(svc, storage, "request-queues")
    meta.update(await svc.storage.rq_metadata(queue_id))
    return data(meta)


@router.get("/v2/request-queues/{queue_id}/head")
async def rq_head(queue_id: str, request: Request, limit: int = DEFAULT_HEAD_LIMIT) -> object:
    svc = get_service(request)
    _user, _storage, denied = await _guard(request, queue_id, LEVEL_READ, STORAGE_RQ)
    if denied:
        return denied
    return data(await svc.storage.rq_head(queue_id, limit=limit))


@router.post("/v2/request-queues/{queue_id}/head/lock")
async def rq_head_and_lock(
    queue_id: str, request: Request, lockSecs: int = 60, limit: int = DEFAULT_HEAD_LIMIT
) -> object:
    svc = get_service(request)
    _user, _storage, denied = await _guard(request, queue_id, LEVEL_WRITE, STORAGE_RQ)
    if denied:
        return denied
    return data(await svc.storage.rq_head_and_lock(queue_id, limit=limit, lock_secs=lockSecs))


@router.get("/v2/request-queues/{queue_id}/requests")
async def list_requests(queue_id: str, request: Request) -> object:
    svc = get_service(request)
    _user, _storage, denied = await _guard(request, queue_id, LEVEL_READ, STORAGE_RQ)
    if denied:
        return denied
    items = await svc.storage.rq_requests(queue_id)
    limit, offset = parse_page(request)
    return data(paged_envelope(items, limit, offset))


@router.post("/v2/request-queues/{queue_id}/requests")
async def add_request(queue_id: str, request: Request, forefront: bool = False) -> object:
    svc = get_service(request)
    _user, _storage, denied = await _guard(request, queue_id, LEVEL_WRITE, STORAGE_RQ)
    if denied:
        return denied
    body = await read_json(request)
    result = await svc.storage.rq_add_batch(queue_id, [body], forefront=forefront)
    processed = result["processedRequests"]
    if processed:
        return data(processed[0], status_code=201)
    unprocessed = result["unprocessedRequests"]
    detail = unprocessed[0] if unprocessed else body
    return bad_request(f"Could not add request: {detail!r}")


@router.post("/v2/request-queues/{queue_id}/requests/batch")
async def batch_add_requests(queue_id: str, request: Request, forefront: bool = False) -> object:
    svc = get_service(request)
    _user, _storage, denied = await _guard(request, queue_id, LEVEL_WRITE, STORAGE_RQ)
    if denied:
        return denied
    payload = await read_json(request)
    requests = payload if isinstance(payload, list) else [payload]
    result = await svc.storage.rq_add_batch(queue_id, requests, forefront=forefront)
    return data(result, status_code=201)


@router.delete("/v2/request-queues/{queue_id}/requests/batch")
async def batch_delete_requests(queue_id: str, request: Request) -> object:
    svc = get_service(request)
    _user, _storage, denied = await _guard(request, queue_id, LEVEL_WRITE, STORAGE_RQ)
    if denied:
        return denied
    payload = await read_json(request)
    requests = payload if isinstance(payload, list) else [payload]
    result = await svc.storage.rq_batch_delete(queue_id, requests)
    return data(result)


@router.post("/v2/request-queues/{queue_id}/requests/unlock")
async def unlock_requests(queue_id: str, request: Request) -> object:
    svc = get_service(request)
    _user, _storage, denied = await _guard(request, queue_id, LEVEL_WRITE, STORAGE_RQ)
    if denied:
        return denied
    count = await svc.storage.rq_unlock_all(queue_id)
    return data({"unlockedCount": count})


@router.get("/v2/request-queues/{queue_id}/requests/{request_id}")
async def get_request(queue_id: str, request_id: str, request: Request) -> object:
    svc = get_service(request)
    _user, _storage, denied = await _guard(request, queue_id, LEVEL_READ, STORAGE_RQ)
    if denied:
        return denied
    found = await svc.storage.rq_get_request(queue_id, request_id)
    if found is None:
        return not_found(f"Request '{request_id}' was not found.")
    return data(found)


@router.put("/v2/request-queues/{queue_id}/requests/{request_id}")
async def update_request(queue_id: str, request_id: str, request: Request, forefront: bool = False) -> object:
    svc = get_service(request)
    _user, _storage, denied = await _guard(request, queue_id, LEVEL_WRITE, STORAGE_RQ)
    if denied:
        return denied
    body = await read_json(request)
    result = await svc.storage.rq_update_request(queue_id, request_id, body, forefront=forefront)
    if result is None:
        return bad_request(f"Request body must include a 'url' (and 'uniqueKey'): {body!r}")
    return data(result)


@router.delete("/v2/request-queues/{queue_id}/requests/{request_id}")
async def delete_request(queue_id: str, request_id: str, request: Request) -> object:
    svc = get_service(request)
    _user, _storage, denied = await _guard(request, queue_id, LEVEL_WRITE, STORAGE_RQ)
    if denied:
        return denied
    await svc.storage.rq_delete_request(queue_id, request_id)
    return data({"id": request_id})


@router.put("/v2/request-queues/{queue_id}/requests/{request_id}/lock")
async def lock_request(queue_id: str, request_id: str, request: Request, lockSecs: int = 60) -> object:
    svc = get_service(request)
    _user, _storage, denied = await _guard(request, queue_id, LEVEL_WRITE, STORAGE_RQ)
    if denied:
        return denied
    result = await svc.storage.rq_lock_request(queue_id, request_id, lockSecs)
    if result is None:
        return not_found(f"Request '{request_id}' was not found.")
    return data(result)


@router.delete("/v2/request-queues/{queue_id}/requests/{request_id}/lock")
async def delete_request_lock(queue_id: str, request_id: str, request: Request) -> object:
    svc = get_service(request)
    _user, _storage, denied = await _guard(request, queue_id, LEVEL_WRITE, STORAGE_RQ)
    if denied:
        return denied
    await svc.storage.rq_delete_request_lock(queue_id, request_id)
    return data({"id": request_id})


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

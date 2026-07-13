"""Key-value store, dataset and request-queue endpoints."""
from __future__ import annotations

import json

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse, PlainTextResponse, Response

from ..responses import data, get_service, not_found, read_body, read_json

router = APIRouter()


def _is_textual(content_type: str) -> bool:
    ct = content_type.lower()
    return (
        ct.startswith("text/")
        or "json" in ct
        or "xml" in ct
        or "javascript" in ct
        or "x-www-form-urlencoded" in ct
    )


# -- key-value stores -----------------------------------------------------
@router.post("/v2/key-value-stores")
async def create_kvs(request: Request) -> object:
    body = await read_json(request)
    name = body.get("name", "default")
    return data({"id": name, "name": name}, status_code=201)


@router.get("/v2/key-value-stores/{store_id}")
async def get_kvs(store_id: str, request: Request) -> object:
    svc = get_service(request)
    keys = await svc.storage.kv_keys(store_id)
    return data({"id": store_id, "name": store_id, "itemCount": len(keys)})


@router.get("/v2/key-value-stores/{store_id}/keys")
async def list_keys(store_id: str, request: Request) -> object:
    svc = get_service(request)
    keys = await svc.storage.kv_keys(store_id)
    return data({"items": keys, "count": len(keys), "limit": len(keys), "isTruncated": False})


@router.get("/v2/key-value-stores/{store_id}/records/{key}")
async def get_record(store_id: str, key: str, request: Request) -> Response:
    svc = get_service(request)
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


# -- datasets -------------------------------------------------------------
@router.post("/v2/datasets")
async def create_dataset(request: Request) -> object:
    body = await read_json(request)
    name = body.get("name", "default")
    return data({"id": name, "name": name}, status_code=201)


@router.get("/v2/datasets/{dataset_id}")
async def get_dataset(dataset_id: str, request: Request) -> object:
    svc = get_service(request)
    result = await svc.storage.dataset_items(dataset_id)
    return data({"id": dataset_id, "name": dataset_id, "itemCount": result["total"]})


@router.get("/v2/datasets/{dataset_id}/items")
async def get_items(dataset_id: str, request: Request) -> JSONResponse:
    svc = get_service(request)
    result = await svc.storage.dataset_items(dataset_id)
    return JSONResponse(result["items"])


@router.post("/v2/datasets/{dataset_id}/items")
async def push_items(dataset_id: str, request: Request) -> object:
    svc = get_service(request)
    payload = await read_json(request)
    items = payload if isinstance(payload, list) else [payload]
    await svc.storage.dataset_push(dataset_id, items)
    return data({"count": len(items)}, status_code=201)


# -- request queues -------------------------------------------------------
@router.get("/v2/request-queues/{queue_id}")
async def get_queue(queue_id: str, request: Request) -> object:
    svc = get_service(request)
    return data(await svc.storage.rq_metadata(queue_id))


@router.get("/v2/request-queues/{queue_id}/requests")
async def list_requests(queue_id: str, request: Request) -> object:
    svc = get_service(request)
    items = await svc.storage.rq_requests(queue_id)
    return data({"items": items, "count": len(items), "limit": len(items)})


@router.post("/v2/request-queues/{queue_id}/requests")
async def add_request(queue_id: str, request: Request) -> object:
    svc = get_service(request)
    body = await read_json(request)
    await svc.storage.rq_add(queue_id, [body])
    return data({"requestId": body.get("uniqueKey") or body.get("url")}, status_code=201)

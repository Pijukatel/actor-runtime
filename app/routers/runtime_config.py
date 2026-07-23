"""Runtime-global upstream-fallback toggle: GET/PUT /v2/runtime-config.

A single in-memory boolean on the shared `Service` instance
(`Service.upstream_fallback_enabled`) -- not persisted, resets to `False` on
every restart. Both endpoints are token-free (no bootstrap side effect), like
`GET /v2/users`: this is a runtime-wide operational switch, not per-user data.
`PUT` takes effect immediately for every user and both ports, since both serve
the same `Service` instance (see app/server.py).
"""
from __future__ import annotations

from fastapi import APIRouter, Request

from ..responses import bad_request, data, get_service, read_json

router = APIRouter()


def _payload(svc) -> dict:
    return {"upstreamFallbackEnabled": svc.upstream_fallback_enabled}


@router.get("/v2/runtime-config")
async def get_runtime_config(request: Request) -> object:
    return data(_payload(get_service(request)))


@router.put("/v2/runtime-config")
async def put_runtime_config(request: Request) -> object:
    svc = get_service(request)
    body = await read_json(request)
    enabled = body.get("upstreamFallbackEnabled") if isinstance(body, dict) else None
    if not isinstance(enabled, bool):
        return bad_request("Body must include 'upstreamFallbackEnabled' as a boolean.")
    svc.upstream_fallback_enabled = enabled
    return data(_payload(svc))

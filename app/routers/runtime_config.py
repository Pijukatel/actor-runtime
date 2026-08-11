"""Runtime-global upstream-fallback toggle: GET/PUT /v2/runtime-config.

A single in-memory boolean on the shared `Service` instance
(`Service.upstream_fallback_enabled`) -- not persisted, resets to `False` on
every restart. `PUT` takes effect immediately for every user and both ports,
since both serve the same `Service` instance (see app/server.py).

`GET` is token-free (no bootstrap side effect), like `GET /v2/users`: merely
reading the runtime-wide switch is not per-user data and must never claim a
token as a side effect. `PUT` is NOT token-free: like `POST /v2/users`, it
calls `resolve_user()` and discards the result purely as a token-validity
check (401 on no/invalid token) -- because this is the one switch that, once
on, causes the runtime to forward the caller's own real Apify credential to
the public internet on a local 404, it must require the same valid-token
proof every other mutating endpoint does, not the console's own bearer-
carrying `api()` call being merely incidental.
"""
from __future__ import annotations

from fastapi import APIRouter, Request

from ..auth import resolve_user
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
    await resolve_user(request)  # token-validity check only; see module docstring
    body = await read_json(request)
    enabled = body.get("upstreamFallbackEnabled") if isinstance(body, dict) else None
    if not isinstance(enabled, bool):
        return bad_request("Body must include 'upstreamFallbackEnabled' as a boolean.")
    svc.upstream_fallback_enabled = enabled
    return data(_payload(svc))

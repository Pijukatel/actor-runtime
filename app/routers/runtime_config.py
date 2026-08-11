"""Runtime-global upstream-fallback toggle: GET/PUT /v2/runtime-config.

A single in-memory boolean on the shared `Service` instance
(`Service.upstream_fallback_enabled`) -- not persisted, resets to `False` on
every restart. `PUT` takes effect immediately for every user and both ports,
since both serve the same `Service` instance (see app/server.py).

`GET` is token-free (no bootstrap side effect), like `GET /v2/users`: merely
reading the runtime-wide switch is not per-user data and must never claim a
token as a side effect. `PUT` is NOT token-free: it validates the presented
credential and discards the result purely as a token-validity check, resolving
an absent token to the default user (never rejected for lacking a credential),
same as every other mutating endpoint. Unlike every other mutating endpoint,
though, it resolves a PRESENT token via `resolve_user(request, bootstrap=False)`
(`app/auth.py`) -- a PURE lookup -- rather than the bootstrap-or-reject every
other handler uses: a token matching no existing user is `401 invalid-token`
with NO state mutation, never a silent bootstrap of the default user's
credential. Because this is the one switch that, once on, causes the runtime
to forward the caller's own real Apify credential to the public internet on
a local 404, it must never let an unrecognized token presented here get bound
as that credential -- doing so would both hand whoever presented it control
over every future anonymous fallback attempt and permanently lock the
operator's own later, real login out.
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
    await resolve_user(request, bootstrap=False)  # token-validity check only, never a bootstrap; see module docstring
    body = await read_json(request)
    enabled = body.get("upstreamFallbackEnabled") if isinstance(body, dict) else None
    if not isinstance(enabled, bool):
        return bad_request("Body must include 'upstreamFallbackEnabled' as a boolean.")
    svc.upstream_fallback_enabled = enabled
    return data(_payload(svc))

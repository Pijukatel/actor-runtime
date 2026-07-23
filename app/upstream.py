"""Fallback proxy to the real Apify API on a local 404.

Opt-in (``Service.upstream_fallback_enabled``, default off): when a request to
an allowlisted by-id ``/v2`` resource route -- an Actor, run, build, or one of
the three storage types, reached by its id -- resolves locally to a 404, the
same request (method, query string, body) is replayed against
``settings.apify_upstream_base_url`` using the caller's own bound token. A 2xx
upstream reply is relayed back verbatim; any failure (non-2xx, timeout, connect
error) falls back to the original local 404, logged for debuggability.

Registered as a Starlette middleware in app/main.py -- see that module and
.shepherd/2-design.md for the full contract. Deliberately excludes standby
forwarding (``/v2/actor-standby/...``, a local-only route with no equivalent
reachable the same way), logs, console and the runtime-config toggle itself.
"""
from __future__ import annotations

import logging
import re

import httpx
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

from .auth import resolve_user
from .responses import get_service

logger = logging.getLogger(__name__)

# Headers that only make sense for the upstream hop: httpx has already decoded
# the body (so a forwarded content-encoding would describe bytes that are no
# longer encoded) or Starlette recomputes its own response framing.
_HOP_BY_HOP_RESPONSE_HEADERS = {"content-encoding", "content-length", "transfer-encoding", "connection"}

# Connect-only bound, mirroring app/routers/standby.py's own upstream proxy:
# a legitimately slow upstream response is never cut short, only a connect
# that never completes fails fast.
_CONNECT_TIMEOUT_SECS = 10.0
_TOTAL_TIMEOUT_SECS = 30.0

# By-id `/v2` resource routes: an Actor, run, build or storage reached by its
# id, plus any nested subpath (versions, records, items, requests, ...).
# Deliberately excludes a bare collection (`POST /v2/acts`, no id yet to be
# "missing"), and every local-only route (actor-standby forwarding, logs,
# console, the runtime-config toggle) -- none of those have a real-platform
# equivalent reachable the same way.
_ALLOWLISTED_PATTERNS = [
    re.compile(r"^/v2/(?:acts|actors)/[^/]+"),
    re.compile(r"^/v2/actor-runs/[^/]+"),
    re.compile(r"^/v2/actor-builds/[^/]+"),
    re.compile(r"^/v2/key-value-stores/[^/]+"),
    re.compile(r"^/v2/datasets/[^/]+"),
    re.compile(r"^/v2/request-queues/[^/]+"),
]


def is_fallback_allowlisted(path: str) -> bool:
    return any(pattern.match(path) for pattern in _ALLOWLISTED_PATTERNS)


async def fetch_upstream_fallback(request: Request, body: bytes, settings) -> Response | None:
    """Replay ``request`` against the real API; ``None`` on any failure.

    The caller (the middleware below) already confirmed the local response was
    a 404 before calling this -- a ``None`` return means "return that original
    404 unchanged", never an upstream error status/body of its own.
    """
    svc = get_service(request)
    user = await resolve_user(request)
    row = await svc.get_user(user)
    token = row.token if row is not None else None

    url = f"{settings.apify_upstream_base_url}{request.url.path}"
    if request.url.query:
        url += f"?{request.url.query}"

    headers = {}
    content_type = request.headers.get("content-type")
    if content_type:
        headers["content-type"] = content_type
    # Never a different, shared or hardcoded credential -- only the token this
    # same request's own caller is already bound to. An unbound caller (no
    # token ever claimed) forwards no Authorization header at all.
    if token:
        headers["authorization"] = f"Bearer {token}"

    timeout = httpx.Timeout(_TOTAL_TIMEOUT_SECS, connect=_CONNECT_TIMEOUT_SECS)
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            upstream = await client.request(request.method, url, headers=headers, content=body or None)
    except httpx.HTTPError as exc:
        logger.info("Upstream fallback %s %s failed: %s", request.method, request.url.path, exc)
        return None

    if not (200 <= upstream.status_code < 300):
        logger.info(
            "Upstream fallback %s %s got %s; keeping the local 404",
            request.method, request.url.path, upstream.status_code,
        )
        return None

    response_headers = {
        k: v for k, v in upstream.headers.items() if k.lower() not in _HOP_BY_HOP_RESPONSE_HEADERS
    }
    return Response(content=upstream.content, status_code=upstream.status_code, headers=response_headers)


class UpstreamFallbackMiddleware(BaseHTTPMiddleware):
    """On a local 404 for an allowlisted by-id route, with the toggle on,
    replay the request upstream and relay a 2xx reply verbatim; any upstream
    failure returns the original local 404 unchanged. See the module
    docstring for the full contract.
    """

    async def dispatch(self, request: Request, call_next):
        svc = get_service(request)
        if not (svc.upstream_fallback_enabled and is_fallback_allowlisted(request.url.path)):
            return await call_next(request)

        # The downstream route handler must consume the request body to
        # produce its own (possibly-404) response before this middleware
        # knows whether to proxy, and a BaseHTTPMiddleware-wrapped Request
        # doesn't share its body cache with the handler's own Request
        # instance -- so the raw bytes are captured here as they stream past
        # the handler's own read, rather than pre-read-and-reinjected. Scoped
        # to this allowlisted branch only: every other request pays nothing.
        captured = bytearray()
        original_receive = request.receive

        async def receive():
            message = await original_receive()
            if message["type"] == "http.request":
                captured.extend(message.get("body", b""))
            return message

        request._receive = receive
        response = await call_next(request)
        if response.status_code != 404:
            return response

        fallback = await fetch_upstream_fallback(request, bytes(captured), svc.settings)
        return fallback if fallback is not None else response

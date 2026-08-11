"""Fallback proxy to the real Apify API on a local 404.

Opt-in (``Service.upstream_fallback_enabled``, default off): when a request to
an allowlisted by-id ``/v2`` resource route -- an Actor, run, build, or one of
the three storage types, reached by its id -- resolves locally to a 404, the
same request (method, query string, body) is replayed against
``settings.apify_upstream_base_url`` using the caller's own bound token. A 2xx
upstream reply is relayed back verbatim; any failure -- non-2xx, timeout,
connect error, a malformed upstream base URL, or a caller identity that fails
to resolve -- falls back to the original local 404, logged for debuggability.

Registered as a Starlette middleware in app/main.py -- see that module and
requirements/api.md's "Upstream fallback" section for the full contract.
Deliberately excludes standby forwarding (``/v2/actor-standby/...``, a
local-only route with no equivalent reachable the same way), logs, console
and the runtime-config toggle itself.
"""
from __future__ import annotations

import logging
import re

import httpx
from starlette.datastructures import MutableHeaders
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

from .auth import InvalidTokenError, resolve_user
from .responses import get_service

logger = logging.getLogger(__name__)

# Headers that only make sense for the upstream hop: httpx has already decoded
# the body (so a forwarded content-encoding would describe bytes that are no
# longer encoded) or Starlette recomputes its own response framing. The
# RFC 7230 hop-by-hop set (`connection`, `keep-alive`, `proxy-authenticate`,
# `proxy-authorization`, `te`, `trailer(s)`, `transfer-encoding`, `upgrade`) is
# included in full, not just the two members this proxy happened to need so
# far, so this is genuinely *the* exclusion list for a "verbatim" relay rather
# than a partial one that merely hasn't bitten yet.
_HOP_BY_HOP_RESPONSE_HEADERS = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "trailers",
    "transfer-encoding",
    "upgrade",
    "content-encoding",
    "content-length",
}

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
    404 unchanged", never an upstream error status/body, and never an
    exception, of its own. That "any failure" umbrella has to cover more than
    the upstream HTTP call itself: resolving the caller's own identity
    (``resolve_user``, below) can fail too. Every registered route handler on
    the allowlisted prefixes already calls ``resolve_user`` before it can
    produce a 404, so an unresolvable token there raises inside
    ``call_next()`` and is caught by FastAPI's own ``InvalidTokenError``
    handler (a clean 401) -- this function is never reached with a non-404
    response. But the SPA catch-all (``app/routers/console.py``'s
    ``spa_catch_all``) 404s an unmatched allowlisted-prefix path WITHOUT ever
    calling ``resolve_user`` itself, so this function's own call is sometimes
    the FIRST resolution attempt for the request -- and its
    ``InvalidTokenError`` needs to collapse to the local 404 the same as every
    other failure below, in the same ``try``, rather than escape uncaught
    (nothing past ``call_next()`` returning is wrapped by that handler).
    """
    svc = get_service(request)

    url = f"{settings.apify_upstream_base_url}{request.url.path}"
    if request.url.query:
        url += f"?{request.url.query}"

    headers = {}
    content_type = request.headers.get("content-type")
    if content_type:
        headers["content-type"] = content_type
    # `body` is replayed exactly as captured -- still compressed, if it was.
    # Every apify-client 3.x storage write (`set_value`/`push_data`/
    # `add_request`/...) sends `Content-Encoding: br` by default, so a write
    # replay that drops this header hands the upstream API compressed bytes
    # under a plain `content-type`, which it cannot parse: the call fails and
    # collapses to the original local 404 (see the module docstring), silently
    # turning a should-have-succeeded write into a false "not found".
    content_encoding = request.headers.get("content-encoding")
    if content_encoding:
        headers["content-encoding"] = content_encoding

    timeout = httpx.Timeout(_TOTAL_TIMEOUT_SECS, connect=_CONNECT_TIMEOUT_SECS)
    try:
        # Never a different, shared or hardcoded credential -- only the token
        # this same request's own caller is already bound to. An unbound
        # caller (no token ever claimed) forwards no Authorization header at
        # all. Resolved inside this `try`, not before it, so a token that
        # fails to resolve joins every other fallback failure below instead of
        # raising out of this function.
        user = await resolve_user(request)
        row = await svc.get_user(user)
        if row is not None and row.token:
            headers["authorization"] = f"Bearer {row.token}"
        async with httpx.AsyncClient(timeout=timeout) as client:
            upstream = await client.request(request.method, url, headers=headers, content=body or None)
    except (InvalidTokenError, httpx.HTTPError, httpx.InvalidURL) as exc:
        # `httpx.InvalidURL` (e.g. a misconfigured `APIFY_UPSTREAM_BASE_URL`)
        # is not an `httpx.HTTPError` subclass -- it's raised while building
        # the request, before any connection is attempted -- so it needs its
        # own name here rather than being (wrongly) assumed covered by
        # `HTTPError` alone.
        logger.info("Upstream fallback %s %s failed: %s", request.method, request.url.path, exc)
        return None

    if not (200 <= upstream.status_code < 300):
        logger.info(
            "Upstream fallback %s %s got %s; keeping the local 404",
            request.method, request.url.path, upstream.status_code,
        )
        return None

    # Built via MutableHeaders.append() (which explicitly preserves
    # duplicates, per its own docstring) rather than a dict comprehension,
    # which would silently keep only the last value for any header name the
    # upstream repeats (e.g. two Set-Cookie headers) -- following the same
    # precedent already established by app/routers/standby.py's own upstream
    # proxy for exactly this reason.
    response_headers = MutableHeaders()
    for k, v in upstream.headers.multi_items():
        if k.lower() not in _HOP_BY_HOP_RESPONSE_HEADERS:
            response_headers.append(k, v)
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

        # Read (and thereby cache) the body here, scoped to this
        # allowlisted+enabled branch only, so every other request pays
        # nothing. Many handlers on this allowlist 404 from a denied `_guard`
        # (an ownership/existence check) BEFORE ever reading the body
        # themselves, so there is nothing to "stream past" downstream to tee
        # in that -- the common -- case; reading it here is the only way to
        # still have the caller's actual body available to forward upstream.
        # Starlette's own BaseHTTPMiddleware request wrapper recognizes a
        # `.body()` call made from a dispatch function and replays that SAME
        # cached body to the downstream handler instead of re-reading (and
        # duplicating) the wire, so the handler's own response is unaffected.
        body = await request.body()
        response = await call_next(request)
        if response.status_code != 404:
            return response

        fallback = await fetch_upstream_fallback(request, body, svc.settings)
        return fallback if fallback is not None else response

"""Fallback proxy to the real Apify API on a local 404.

Opt-in (``Service.upstream_fallback_enabled``, default off): when a request to
an allowlisted by-id ``/v2`` resource route -- an Actor, run, build, or one of
the three storage types, reached by its id -- resolves locally to a 404, the
same request (method, query string, body) is replayed against
``settings.apify_upstream_base_url`` using the caller's own bound token. A 2xx
upstream reply is relayed back verbatim; any failure -- non-2xx, timeout,
connect error, a malformed upstream base URL, or a caller identity that fails
to resolve -- falls back to the original local 404, logged for debuggability.

Identity for that bearer credential is resolved by ``app/auth.py``'s
``resolve_forwardable_token`` -- see its own docstring for the full contract
(why it is a pure lookup, never ``resolve_user``'s bootstrap-or-reject).

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

from .auth import resolve_forwardable_token
from .responses import get_service

logger = logging.getLogger(__name__)

# The full RFC 7230 hop-by-hop set: headers whose scope is the single
# connection they were sent on, never meaningful once copied onto the
# brand-new response this proxy builds for the original caller. This is the
# only proxy in this runtime that needs the full set -- app/routers/standby.py
# keeps its own narrower, historical exclusion set instead (see that module's
# own comment for why).
HOP_BY_HOP = frozenset(
    {
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailer",
        "trailers",
        "transfer-encoding",
        "upgrade",
    }
)

# This proxy's one fixed exclusion set for the relayed response: the full
# RFC 7230 hop-by-hop set above, plus two headers that only make sense for
# THIS upstream hop -- httpx has already decoded the body (so a forwarded
# `content-encoding` would describe bytes that are no longer encoded) and
# Starlette recomputes its own response framing (so a forwarded
# `content-length` could describe the wrong body).
_EXCLUDED_RESPONSE_HEADERS = HOP_BY_HOP | {"content-encoding", "content-length"}

# Connect-only bound, mirroring app/routers/standby.py's own upstream proxy:
# a legitimately slow upstream response is never cut short, only a connect
# that never completes fails fast.
_CONNECT_TIMEOUT_SECS = 10.0

# By-id `/v2` resource routes: an Actor, run, build or storage reached by its
# id, plus any nested subpath (versions, records, items, requests, ...).
# Deliberately excludes a bare collection (`POST /v2/acts`, no id yet to be
# "missing"), and every local-only route (actor-standby forwarding, logs,
# console, the runtime-config toggle) -- none of those have a real-platform
# equivalent reachable the same way.
_ALLOWLISTED = re.compile(
    r"^/v2/(?:acts|actors|actor-runs|actor-builds|key-value-stores|datasets|request-queues)/[^/]+"
)


def is_fallback_allowlisted(path: str) -> bool:
    return _ALLOWLISTED.match(path) is not None


def _raw_path(request: Request) -> str:
    """The request's path exactly as it arrived on the wire, still percent-encoded.

    ``request.url.path`` is ASGI's already-decoded ``scope['path']`` -- a key
    containing an encoded ``%2F`` would decode to a literal ``/`` there, so
    replaying it upstream would hit a different resource (an extra path
    segment) than the one the caller actually asked for. ``scope['raw_path']``
    is the still-encoded bytes Starlette also received, so replaying THAT
    keeps the byte-for-byte fidelity this proxy's own contract promises.
    """
    raw_path = request.scope.get("raw_path")
    return raw_path.decode("ascii") if raw_path else request.url.path


async def fetch_upstream_fallback(request: Request, body: bytes) -> Response | None:
    """Replay ``request`` against the real API; ``None`` on any failure.

    The caller (the middleware below) already confirmed the local response was
    a 404 before calling this -- a ``None`` return means "return that original
    404 unchanged", never an upstream error status/body, and never an
    exception, of its own. That "any failure" umbrella covers more than the
    upstream HTTP call itself: it also covers whatever ``app/auth.py``'s
    ``resolve_forwardable_token`` raises or returns while looking the caller
    up (see its own docstring for the full contract), including a transient
    DB error from ``svc.get_user``.

    Everything below -- identity resolution, building the outgoing request,
    the upstream call itself, and building the relayed response -- is
    therefore one single, deliberate trust boundary: the whole attempt lives
    in one ``try`` guarded by one broad ``except Exception``. That breadth is
    the contract here, not defensive slop -- this function's entire reason to
    exist is that NOTHING past the point the middleware already decided "this
    was a local 404" is allowed to surface its own failure mode to the caller.
    A narrower except tuple would leave exactly the kind of fault this exists
    to guard against (e.g. that DB error) to escape as an uncaught 500 instead
    of the promised 404.
    """
    svc = get_service(request)

    try:
        url = f"{svc.settings.apify_upstream_base_url}{_raw_path(request)}"
        if request.url.query:
            url += f"?{request.url.query}"

        headers = {}
        content_type = request.headers.get("content-type")
        if content_type:
            headers["content-type"] = content_type
        # `body` is replayed exactly as captured -- still compressed, if it
        # was. Every apify-client 3.x storage write (`set_value`/`push_data`/
        # `add_request`/...) sends `Content-Encoding: br` by default, so a
        # write replay that drops this header hands the upstream API
        # compressed bytes under a plain `content-type`, which it cannot
        # parse: the call fails and collapses to the original local 404 (see
        # the module docstring), silently turning a should-have-succeeded
        # write into a false "not found".
        content_encoding = request.headers.get("content-encoding")
        if content_encoding:
            headers["content-encoding"] = content_encoding

        # `None` means nothing to forward -- abandon the attempt; `""` means a
        # resolved caller with no bound token yet, forwarded anonymously. See
        # `auth.resolve_forwardable_token`'s docstring for the full contract.
        forward_token = await resolve_forwardable_token(request)
        if forward_token is None:
            return None
        if forward_token:
            headers["authorization"] = f"Bearer {forward_token}"

        timeout = httpx.Timeout(connect=_CONNECT_TIMEOUT_SECS, read=None, write=None, pool=None)
        async with httpx.AsyncClient(timeout=timeout) as client:
            upstream = await client.request(request.method, url, headers=headers, content=body or None)

        if not (200 <= upstream.status_code < 300):
            # `warning`, not `info`: the shipped uvicorn config (app/server.py)
            # leaves every app logger at its default (WARNING, no root
            # handler) -- only `uvicorn.*` loggers get `log_level="info"` --
            # so `info` here would never actually reach an operator, leaving
            # the design's one mitigation for this failure mode ("a clear log
            # line so it's debuggable") inert in practice.
            logger.warning(
                "Upstream fallback %s %s got %s; keeping the local 404",
                request.method, request.url.path, upstream.status_code,
            )
            return None

        # Built via `.append()` (which explicitly preserves duplicates) rather
        # than a dict comprehension, which would silently keep only the last
        # value for a header name the upstream repeats (e.g. two Set-Cookie
        # headers) -- the same precedent app/routers/standby.py's own upstream
        # proxy follows for its own relayed response.
        response_headers = MutableHeaders()
        for k, v in upstream.headers.multi_items():
            if k.lower() not in _EXCLUDED_RESPONSE_HEADERS:
                response_headers.append(k, v)
        return Response(content=upstream.content, status_code=upstream.status_code, headers=response_headers)
    except Exception as exc:
        # Deliberately broad -- see the docstring above. Covers (non-
        # exhaustively): any fault raised while looking the caller up (e.g. a
        # DB error from `svc.user_for_token`/`get_user`), `httpx.InvalidURL`
        # (e.g. a misconfigured `APIFY_UPSTREAM_BASE_URL` -- notably NOT a
        # subclass of `httpx.HTTPError`, so a narrower tuple built from that
        # alone would miss it), and every `httpx.HTTPError` from the upstream
        # call itself (timeout, connect error, ...).
        logger.warning("Upstream fallback %s %s failed: %s", request.method, request.url.path, exc)
        return None


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

        fallback = await fetch_upstream_fallback(request, body)
        return fallback if fallback is not None else response

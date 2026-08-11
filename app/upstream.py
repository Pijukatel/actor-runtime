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
``resolve_forwardable_token`` -- a PURE lookup, never ``resolve_user``'s
bootstrap-or-reject: a token that matches no existing user is never bound or
used to create one here -- it simply has nothing to forward, so the attempt
collapses to the local 404 like any other failure. This matters because the
SPA catch-all (``app/routers/console.py``) can 404 an allowlisted path
WITHOUT ever calling ``resolve_user`` itself, making that lookup the first
identity resolution a request like that gets -- a read-through toggle must
never let that first attempt silently bootstrap local identity state. See
``resolve_forwardable_token``'s own docstring for the full contract.

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
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

from .auth import resolve_forwardable_token
from .http_relay import relay_response_headers
from .responses import get_service

logger = logging.getLogger(__name__)

# Headers that only make sense for THIS upstream hop, beyond the shared
# app/http_relay.py's RFC 7230 hop-by-hop set: httpx has already decoded the
# body (so a forwarded `content-encoding` would describe bytes that are no
# longer encoded) and Starlette recomputes its own response framing (so a
# forwarded `content-length` could describe the wrong body).
_EXTRA_EXCLUDED_RESPONSE_HEADERS = frozenset({"content-encoding", "content-length"})

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


async def fetch_upstream_fallback(request: Request, body: bytes) -> Response | None:
    """Replay ``request`` against the real API; ``None`` on any failure.

    The caller (the middleware below) already confirmed the local response was
    a 404 before calling this -- a ``None`` return means "return that original
    404 unchanged", never an upstream error status/body, and never an
    exception, of its own. That "any failure" umbrella covers more than the
    upstream HTTP call itself: identity resolution below goes through
    ``app/auth.py``'s ``resolve_forwardable_token`` -- a PURE lookup, never
    ``resolve_user``'s bootstrap-or-reject -- see its own docstring for why a
    token matching no existing user resolves to ``None`` here (abandoning the
    whole attempt) rather than binding one. Anything else that can go wrong
    looking a caller up (e.g. a transient DB error from ``svc.get_user``) is
    covered too.

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
        url = f"{svc.settings.apify_upstream_base_url}{request.url.path}"
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

        # Never a different, shared or hardcoded credential -- only the token
        # this same request's own caller is already bound to, resolved by
        # `auth.resolve_forwardable_token` (a pure lookup -- see its
        # docstring and the module docstring above): `None` means a present
        # token matched no existing user, so there is nothing to forward and
        # the whole attempt is abandoned right here -- never a bind; an empty
        # string means a resolved caller with no token yet (e.g. the
        # still-unclaimed default user), forwarded anonymously rather than
        # aborted.
        forward_token = await resolve_forwardable_token(request)
        if forward_token is None:
            return None
        if forward_token:
            headers["authorization"] = f"Bearer {forward_token}"

        timeout = httpx.Timeout(_TOTAL_TIMEOUT_SECS, connect=_CONNECT_TIMEOUT_SECS)
        async with httpx.AsyncClient(timeout=timeout) as client:
            upstream = await client.request(request.method, url, headers=headers, content=body or None)

        if not (200 <= upstream.status_code < 300):
            logger.info(
                "Upstream fallback %s %s got %s; keeping the local 404",
                request.method, request.url.path, upstream.status_code,
            )
            return None

        # Preserves duplicate header names (e.g. two Set-Cookie headers) --
        # see app/http_relay.py's own docstring -- following the same
        # precedent already established by app/routers/standby.py's own
        # upstream proxy, which shares this same helper.
        response_headers = relay_response_headers(
            upstream.headers.multi_items(), _EXTRA_EXCLUDED_RESPONSE_HEADERS
        )
        return Response(content=upstream.content, status_code=upstream.status_code, headers=response_headers)
    except Exception as exc:
        # Deliberately broad -- see the docstring above. Covers (non-
        # exhaustively): any fault raised while looking the caller up (e.g. a
        # DB error from `svc.user_for_token`/`get_user`), `httpx.InvalidURL`
        # (e.g. a misconfigured `APIFY_UPSTREAM_BASE_URL` -- notably NOT a
        # subclass of `httpx.HTTPError`, so a narrower tuple built from that
        # alone would miss it), and every `httpx.HTTPError` from the upstream
        # call itself (timeout, connect error, ...).
        logger.info("Upstream fallback %s %s failed: %s", request.method, request.url.path, exc)
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

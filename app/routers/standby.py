"""Standby-actor request forwarding: flat ``/v2/actor-standby/{actorId}/{path}``.

A path-based route -- rather than the real platform's per-actor DNS hostname,
which needs a wildcard DNS zone this runtime does not provision -- that
resolves and authorizes the caller exactly like every other Actor endpoint,
lazily warms the actor's standby container, waits for its readiness probe, and
reverse-proxies the request with a streamed response.
"""
from __future__ import annotations

from collections.abc import AsyncIterator

import httpx
from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

from ..auth import resolve_standby_caller
from ..http_relay import MINIMAL_HOP_BY_HOP, filtered_header_pairs, relay_response_headers
from ..responses import get_service, not_found, standby_start_failed, standby_unavailable
from ..standby import StandbyReadinessTimeout, StandbyStartError

router = APIRouter()

# Headers excluded on BOTH the outgoing request to the container and the
# relayed response, beyond `MINIMAL_HOP_BY_HOP` (this proxy's own base, see
# below): `host` would otherwise name this runtime's own address instead of
# the container's once httpx builds the request against `target_url`, and
# `content-length` is recomputed on each leg (by httpx from `content=body`
# below, by Starlette from the streamed response body).
_EXTRA_EXCLUDED_HEADERS = frozenset({"host", "content-length"})

# Deliberately NOT `app/http_relay.py`'s fuller `HOP_BY_HOP` (the full RFC
# 7230 set `app/upstream.py` uses): this proxy's own historical exclusion set
# predates that module and forwarding-wise this route is a black box to
# whatever the standby Actor's own HTTP server does with e.g. `Keep-Alive`/
# `TE`/`Upgrade` -- widening it is a deliberate future call, not a side
# effect of sharing code with a different proxy. See http_relay.py's own
# docstring and `MINIMAL_HOP_BY_HOP`'s.

# Connect-only bound on the standby-forwarding proxy's upstream request below.
# Read/write/pool intentionally stay unbounded so a legitimately long-lived or
# slowly-streamed response is never cut off (multi-chunk streaming is a
# supported case); only the initial TCP connect -- to a container that just
# answered its readiness probe moments earlier, so this can't false-positive
# on a merely-slow response -- is bounded, so a container that goes
# unreachable between the probe and the forward fails fast instead
# of hanging the caller (and the runtime worker handling it) indefinitely. A
# plain module constant (not a `Settings` field): unlike its neighbors
# `standby_idle_override_secs`/`standby_ready_timeout_secs`, nothing -- no env
# var, no test -- has ever needed to override this value; if that changes, it
# can be promoted to a `Settings` field again at that point.
_STANDBY_FORWARD_CONNECT_TIMEOUT_SECS = 10.0


@router.api_route(
    "/v2/actor-standby/{actor_id}/{path:path}",
    methods=["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
)
async def forward_to_standby(actor_id: str, path: str, request: Request):
    svc = get_service(request)
    user = await resolve_standby_caller(request)
    # `get_actor(..., username=user)` is the SAME ownership check every other
    # Actor endpoint uses: a cross-user or unknown actor id is 404 here too,
    # so standby access follows the rest of the API's visibility rules exactly
    # (no separate, standby-only access model).
    actor = await svc.get_actor(actor_id, username=user)
    if actor is None or not (actor.actor_standby or {}).get("isEnabled"):
        # Identical 404 for "no such actor", "someone else's actor" and "not
        # standby-enabled" -- never a silent on-demand run as a fallback.
        return not_found(f"Actor '{actor_id}' has no standby endpoint.")

    try:
        endpoint = await svc.ensure_standby_run(actor_id)
    except StandbyReadinessTimeout:
        return standby_unavailable(f"Actor '{actor_id}' never became ready.")
    except StandbyStartError as exc:
        # Distinct from "no successful build" (404, below): the Actor DOES
        # have a build, but launching its container failed for an
        # infrastructure reason (e.g. the shared Docker network never came up
        # at boot). Report it as the run failure it actually is -- a 5xx with
        # the real cause -- instead of a misleading "has no successful build".
        return standby_start_failed(str(exc))
    if endpoint is None:
        return not_found(f"Actor '{actor_id}' has no successful build to serve from standby.")

    # Tracked for the ENTIRE duration of the forward below, including while a
    # streamed response is still being read -- see
    # Service.mark_standby_request_started's docstring. This is what stops the
    # idle-reap watchdog from tearing down a container out from under a
    # single request that legitimately outlives idleTimeoutSecs (multi-chunk
    # streamed responses are a supported case).
    svc.mark_standby_request_started(actor_id)
    try:
        body = await request.body()
        # A LIST of pairs, not a dict: a dict comprehension would keep only
        # the last value for any header name the caller repeats (e.g. two
        # Cookie headers), silently breaking the "headers... unchanged"
        # forwarding guarantee. httpx accepts a sequence of pairs directly and
        # preserves duplicates through to the wire.
        forward_headers = filtered_header_pairs(
            request.headers.items(), _EXTRA_EXCLUDED_HEADERS, base=MINIMAL_HOP_BY_HOP
        )
        target_url = f"{endpoint}/{path}"
        if request.url.query:
            target_url += f"?{request.url.query}"

        # Only the initial connect is bounded (see the constant's docstring
        # above): the container just answered its readiness probe moments
        # earlier, so a connect can't legitimately take long, but the
        # read/write/pool timeouts stay unbounded so a long-lived or
        # slowly-streamed response is never cut short.
        client = httpx.AsyncClient(
            timeout=httpx.Timeout(
                connect=_STANDBY_FORWARD_CONNECT_TIMEOUT_SECS,
                read=None,
                write=None,
                pool=None,
            )
        )
        try:
            # `client.send(..., stream=True)` returns as soon as the upstream
            # response headers arrive, deferring the body to the generator
            # below -- this is what makes the response genuinely streamed
            # rather than fully buffered before any bytes reach the original
            # caller.
            upstream_request = client.build_request(
                request.method, target_url, headers=forward_headers, content=body
            )
            upstream = await client.send(upstream_request, stream=True)
        except Exception:
            # Any failure building/sending the request must still close the
            # client deterministically -- not just the httpx.HTTPError subset
            # handled below, so a construction error (e.g. a malformed header)
            # can never leak the connection pool.
            await client.aclose()
            raise
    except httpx.HTTPError as exc:
        # A container that was ready an instant ago but died/dropped the
        # connection before this specific call -- surface it observably
        # rather than a bare 500.
        svc.mark_standby_request_finished(actor_id)
        return standby_unavailable(f"Actor '{actor_id}' did not respond: {exc}")
    except BaseException:
        svc.mark_standby_request_finished(actor_id)
        raise

    async def _body() -> AsyncIterator[bytes]:
        try:
            async for chunk in upstream.aiter_raw():
                yield chunk
        finally:
            await upstream.aclose()
            await client.aclose()
            svc.mark_standby_request_finished(actor_id)

    # Preserves duplicate header names (e.g. more than one Set-Cookie), so a
    # standby Actor emitting several reaches the original caller intact --
    # see app/http_relay.py's own docstring.
    response_headers = relay_response_headers(
        upstream.headers.multi_items(), _EXTRA_EXCLUDED_HEADERS, base=MINIMAL_HOP_BY_HOP
    )
    return StreamingResponse(_body(), status_code=upstream.status_code, headers=response_headers)

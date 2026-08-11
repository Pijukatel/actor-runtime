"""Shared HTTP-relay helpers for the two proxies that copy headers verbatim
between the original caller and a second hop: the standby-forwarding proxy
(``app/routers/standby.py``, caller <-> Actor container) and the
upstream-fallback proxy (``app/upstream.py``, caller <-> api.apify.com).

Both need the same hop-by-hop-exclusion MECHANISM (build one fixed
``excluded`` frozenset, filter headers by it) -- shared here so a fix to that
mechanism lands in both places at once. They do NOT share one exclusion SET,
though: ``app/upstream.py`` (new code introduced by this same feature) uses
the full RFC 7230 set below (``HOP_BY_HOP``) plus its own hop-specific extras.
``app/routers/standby.py`` predates this module and keeps its own, narrower,
historical exclusion set as a literal in that file instead -- reusing this
module's mechanism must never silently widen what standby forwards.
"""
from __future__ import annotations

from collections.abc import Iterable

from starlette.datastructures import MutableHeaders

# The full RFC 7230 hop-by-hop set: headers whose scope is the single
# connection they were sent on, never meaningful once copied onto a
# different one (a new connection to a container, or a brand-new response
# built for the original caller). `app/upstream.py` unions this with its own
# extra excluded headers (e.g. `content-length`/`content-encoding`,
# describing bytes that no longer apply once the body has been re-framed or
# decoded) into the one fixed set it passes to every call below.
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


def filtered_header_pairs(headers: Iterable[tuple[str, str]], excluded: frozenset[str]) -> list[tuple[str, str]]:
    """Every ``(name, value)`` pair from ``headers`` except ``excluded``, in
    order, duplicates included -- the caller decides what to build from the
    result (e.g. a plain list for an outgoing httpx request). ``excluded`` is
    the caller's own single, fixed union (its hop-by-hop base plus its own
    hop-specific extras) -- each proxy has exactly one such set, so there is
    nothing left for this function itself to combine.
    """
    return [(k, v) for k, v in headers if k.lower() not in excluded]


def relay_response_headers(headers: Iterable[tuple[str, str]], excluded: frozenset[str]) -> MutableHeaders:
    """``filtered_header_pairs`` built into a ``MutableHeaders`` via
    ``.append()`` (which explicitly preserves duplicates, per its own
    docstring) rather than a dict comprehension, which would silently keep
    only the last value for any header name the far side repeats (e.g. two
    ``Set-Cookie`` headers).
    """
    result = MutableHeaders()
    for k, v in filtered_header_pairs(headers, excluded):
        result.append(k, v)
    return result

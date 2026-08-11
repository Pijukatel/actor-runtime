"""Shared HTTP-relay helpers for the two proxies that copy headers verbatim
between the original caller and a second hop: the standby-forwarding proxy
(``app/routers/standby.py``, caller <-> Actor container) and the
upstream-fallback proxy (``app/upstream.py``, caller <-> api.apify.com).

Both need the same hop-by-hop exclusion concept on the headers they copy
across in either direction. Sharing it here means a fix to what "hop-by-hop"
covers lands in both places at once, not just the one it happened to be
patched in.

The two proxies do NOT share the same exclusion set, though -- only the
mechanism. ``app/upstream.py`` is new code introduced by this same feature, so
it uses the full RFC 7230 set (``HOP_BY_HOP`` below). ``app/routers/
standby.py`` predates it and already had its own, narrower, historical set
(``MINIMAL_HOP_BY_HOP``); reusing this module must never silently widen what
standby forwards, so every call here takes its exclusion set as an explicit
``base`` argument rather than hardcoding one.
"""
from __future__ import annotations

from collections.abc import Iterable

from starlette.datastructures import MutableHeaders

# The full RFC 7230 hop-by-hop set: headers whose scope is the single
# connection they were sent on, never meaningful once copied onto a
# different one (a new connection to a container, or a brand-new response
# built for the original caller). Used as the default `base` below --
# currently by `app/upstream.py` only, see this module's own docstring for
# why `app/routers/standby.py` passes `MINIMAL_HOP_BY_HOP` instead. Each call
# site also adds its own EXTRA excluded headers on top for whatever that
# particular hop additionally needs (e.g. `host` naming the wrong destination
# once forwarded, or `content-length`/`content-encoding` describing bytes
# that no longer apply once the body has been re-framed or decoded) -- so
# this stays genuinely *the* hop-by-hop set, not a dumping ground for
# hop-specific exclusions too.
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

# `app/routers/standby.py`'s own historical exclusion set, predating this
# module: before the two proxies shared any code, standby forwarded
# everything except exactly `{host, content-length, transfer-encoding,
# connection}` (the first two supplied as standby's own `extra_excluded`,
# these two as its base) -- keep-alive/proxy-authenticate/proxy-
# authorization/te/trailer/trailers/upgrade all passed through unchanged.
# Preserved here, unchanged, as `base` for standby's own calls so sharing
# this module's mechanism with `app/upstream.py` never widens what standby
# forwards as a side effect.
MINIMAL_HOP_BY_HOP = frozenset({"connection", "transfer-encoding"})


def filtered_header_pairs(
    headers: Iterable[tuple[str, str]],
    extra_excluded: frozenset[str] = frozenset(),
    base: frozenset[str] = HOP_BY_HOP,
) -> list[tuple[str, str]]:
    """Every ``(name, value)`` pair from ``headers`` except ``base`` and
    ``extra_excluded``, in order, duplicates included -- the caller decides
    what to build from the result (e.g. a plain list for an outgoing httpx
    request).
    """
    excluded = base | extra_excluded
    return [(k, v) for k, v in headers if k.lower() not in excluded]


def relay_response_headers(
    headers: Iterable[tuple[str, str]],
    extra_excluded: frozenset[str] = frozenset(),
    base: frozenset[str] = HOP_BY_HOP,
) -> MutableHeaders:
    """``filtered_header_pairs`` built into a ``MutableHeaders`` via
    ``.append()`` (which explicitly preserves duplicates, per its own
    docstring) rather than a dict comprehension, which would silently keep
    only the last value for any header name the far side repeats (e.g. two
    ``Set-Cookie`` headers).
    """
    result = MutableHeaders()
    for k, v in filtered_header_pairs(headers, extra_excluded, base):
        result.append(k, v)
    return result

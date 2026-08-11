"""Query-param parsing and slicing for the optional `limit`/`offset` pagination
shared by the four listing surfaces (dataset items, KV keys, RQ requests, the
per-user storage lists) and the pre-existing bounded-int query params
(`runs.py`'s `memoryMbytes`/`timeoutSecs`) — none of which is a response-shape
concern, so it lives here rather than in `app/responses.py`.
"""
from __future__ import annotations

from typing import Any

from fastapi import HTTPException, Request


def _parse_int(raw: str, key: str, minimum: int, message: str) -> int:
    try:
        value = int(raw)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail=f"Query parameter '{key}' must be an integer.")
    if value < minimum:
        raise HTTPException(status_code=400, detail=message)
    return value


def bounded_int(params, key: str, default: int, minimum: int, message: str) -> int:
    """Parse an integer query param with a lower bound, or raise a 400 (never a bare 500).

    Mirrors the malformed-body handling: a non-integer or out-of-range value is
    caller error, so it maps to HTTP 400 in the Apify error shape rather than an
    uncaught ``ValueError`` that FastAPI would surface as a 500. ``minimum=1``
    yields "must be positive" semantics; ``minimum=0`` yields "must not be
    negative" semantics.
    """
    raw = params.get(key)
    if raw is None or raw == "":
        return default
    return _parse_int(raw, key, minimum, message)


def parse_page(request: Request) -> tuple[int | None, int | None]:
    """Return ``(limit, offset)`` from the query string, each ``None`` when
    absent -- "absent" stays distinguishable from any concrete integer,
    including ``0``, so callers can tell "keep today's unpaginated behaviour"
    apart from "an explicit zero". Shared by every listing surface that
    supports optional `limit`/`offset` slicing (dataset items, KV keys, RQ
    requests, per-user storage lists) so "both omitted" -- the
    byte-for-byte-unchanged contract every non-console caller relies on -- is
    decided identically everywhere.
    """
    params = request.query_params

    def optional(key: str) -> int | None:
        raw = params.get(key)
        if raw is None or raw == "":
            return None
        return _parse_int(raw, key, minimum=0, message=f"Query parameter '{key}' must not be negative.")

    return optional("limit"), optional("offset")


def paginate(items: list, limit: int | None, offset: int | None) -> list:
    """Slice ``items`` by ``(limit, offset)``: an absent ``offset`` defaults to
    0; an absent ``limit`` means "no cap", matching the real API's own
    ``dataset-items-get`` documented default.
    """
    start = offset or 0
    return items[start : start + limit] if limit is not None else items[start:]


def paged_envelope(items: list, limit: int | None, offset: int | None, **extra: Any) -> dict:
    """Build the ``{items, count, limit, ...}`` envelope shared by KV keys and
    RQ requests -- the one place that decides "which shape does a bare
    request return" so the two copies of this branch can't quietly drift
    apart. The per-user aggregate listings (`total` always present, no
    `limit`) build their own envelope directly instead -- their shape never
    matched this one closely enough to be worth a shared, flag-branching
    helper.

    A bare request (``limit`` and ``offset`` both absent) returns every item
    unsliced, with `limit` echoing the slice's own length -- the SAME key
    order (`items, count, limit, ...`) each surface's response had before
    optional pagination existed, so a bare request stays byte-for-byte
    identical, key order included. Supplying either adds an additive `total`
    field, appended last so it never disturbs that order. ``extra`` (e.g. KV
    keys' offset-mode ``isTruncated``, computed by the caller from the same
    `(items, limit, offset)` this call already has) is merged in right after
    `limit`, preserving each surface's own original field order.
    """
    paginated = limit is not None or offset is not None
    page = paginate(items, limit, offset) if paginated else items
    envelope: dict[str, Any] = {"items": page, "count": len(page)}
    envelope["limit"] = limit if limit is not None else len(page)
    envelope.update(extra)
    if paginated:
        envelope["total"] = len(items)
    return envelope

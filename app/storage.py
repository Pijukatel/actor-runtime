"""Storage layer backed by crawlee-python's experimental SQL storage client.

Provides the runtime's dataset, key-value store and request-queue storages, all
persisted in a single SQLite file. Storages are addressed by a stable string id
(used verbatim as the crawlee storage ``name``), so they can be reopened across
process restarts.
"""
from __future__ import annotations

import base64
import hashlib
import json
import logging
import mimetypes
import os
import re
import warnings
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from crawlee import Request
from crawlee.storage_clients import SqlStorageClient
from crawlee.storage_clients._sql._db_models import RequestDb
from sqlalchemy import select, update

warnings.filterwarnings("ignore", message="The SqlStorageClient is experimental.*")

logger = logging.getLogger(__name__)

# Effective "no cap" default applied when a dataset-items request omits
# `limit` -- large enough that no real local dataset exceeds it, so a bare
# (unpaginated) request keeps returning every item, exactly as it always has.
# The console's own 100-item paging always sends an explicit `limit`, so it
# never falls through to this default.
DEFAULT_ITEM_LIMIT = 999999

# Default number of items a request-queue "head" read returns when the caller
# does not specify a limit (matches a reasonable single API-call page size).
DEFAULT_HEAD_LIMIT = 100


def _request_id_for(unique_key: str) -> str:
    """Deterministic request id for ``unique_key``, matching the Apify SDK's own
    client-side ``unique_key_to_request_id`` hash (SHA-256 -> URL-safe base64,
    truncated to 15 chars; see ``apify.storage_clients._apify._utils`` in the
    ``apify`` package). The SDK's request-queue client computes this same hash
    itself for every ``get_request``/``fetch_next_request``/lock call instead of
    trusting a server-returned id, so this runtime must independently compute the
    identical id from a request's ``uniqueKey`` for those per-request routes to
    resolve to the request the SDK means.
    """
    digest = hashlib.sha256(unique_key.encode("utf-8")).digest()
    url_safe = re.sub(r"[+/=]", "", base64.b64encode(digest).decode("utf-8"))
    return url_safe[:15]


def _fmt_dt(value: Any) -> Any:
    """Render a ``datetime`` the same string style as the rest of this runtime's
    timestamps (``app/db.py::utcnow()``); anything else passes through unchanged.
    """
    if isinstance(value, datetime):
        return value.strftime("%Y-%m-%dT%H:%M:%S.%fZ")
    return value


def _row_id(row: RequestDb) -> str:
    raw = json.loads(row.data) if isinstance(row.data, str) else row.data
    unique_key = raw.get("uniqueKey") or raw.get("unique_key")
    return _request_id_for(unique_key) if unique_key else str(row.request_id)


async def _rq_rows(session: Any, queue_md_id: Any) -> list[RequestDb]:
    """Every ``RequestDb`` row persisted for a request queue's ``get_metadata().id``.

    Shared by every per-request/batch operation below that must locate a row
    by its derived ``_row_id`` rather than a stored, indexable column (see
    ``_request_id_for``'s docstring for why a full scan is unavoidable here):
    each of them would otherwise repeat this identical
    ``select(...).scalars().all()`` fetch against an already-open ``session``.
    """
    return (
        await session.execute(select(RequestDb).where(RequestDb.request_queue_id == queue_md_id))
    ).scalars().all()


def _find_row(rows: list[RequestDb], request_id: str) -> RequestDb | None:
    """The row in ``rows`` whose derived ``_row_id`` equals ``request_id``, else ``None``."""
    return next((r for r in rows if _row_id(r) == request_id), None)


async def _available_unhandled(session: Any, queue_md_id: Any, now: datetime) -> tuple[list[RequestDb], list[RequestDb]]:
    """Every unhandled row for ``queue_md_id`` ordered by ``sequence_number``,
    alongside the subset of those not currently lock-blocked (no
    ``time_blocked_until``, or one already in the past).

    Shared by ``rq_head`` and ``rq_head_and_lock``, which both start from this
    same ordered, lock-filtered view before diverging on whether to also lock
    what they return; ``rq_head_and_lock`` additionally needs the unfiltered
    ``rows`` to tell "everything is currently locked" apart from "nothing is
    queued at all".
    """
    rows = (
        await session.execute(
            select(RequestDb)
            .where(RequestDb.request_queue_id == queue_md_id, RequestDb.is_handled.is_(False))
            .order_by(RequestDb.sequence_number)
        )
    ).scalars().all()
    available = [r for r in rows if not (r.time_blocked_until and r.time_blocked_until > now)]
    return rows, available


def _row_dict(row: RequestDb) -> dict[str, Any]:
    """A queued request in the Apify API's own camelCase wire shape, plus the
    deterministic ``id`` every per-request route addresses it by.

    ``row.data`` is crawlee's own ``Request.model_dump_json()``, which -- unlike
    this runtime's HTTP layer -- serializes by Python field name
    (``unique_key``, ``retry_count``, ...), not by alias; both spellings are
    accepted here so this only depends on crawlee's current default, not a
    guarantee of it.
    """
    raw = json.loads(row.data) if isinstance(row.data, str) else dict(row.data)

    def pick(camel: str, snake: str, default: Any = None) -> Any:
        if camel in raw:
            return raw[camel]
        return raw.get(snake, default)

    unique_key = pick("uniqueKey", "unique_key", "")
    return {
        "id": _request_id_for(unique_key) if unique_key else str(row.request_id),
        "url": raw.get("url"),
        "uniqueKey": unique_key,
        "method": raw.get("method", "GET"),
        "retryCount": pick("retryCount", "retry_count", 0),
        "noRetry": pick("noRetry", "no_retry", False),
        "loadedUrl": pick("loadedUrl", "loaded_url"),
        "handledAt": pick("handledAt", "handled_at"),
        "headers": raw.get("headers", {}),
        "userData": pick("userData", "user_data", {}),
        "payload": raw.get("payload"),
    }

# Suffixes that are safe to decode as UTF-8 text when importing a KV record from
# disk. Anything else (images, PDFs, archives, ...) is imported as raw bytes so it
# round-trips unchanged, matching the HTTP put_record/get_record behaviour.
_TEXT_KV_SUFFIXES = {".txt", ".html", ".htm", ".csv", ".xml", ".md", ".log", ".yaml", ".yml"}


def _rq_request_kwargs(payload: dict[str, Any]) -> dict[str, Any]:
    """Extract the ``Request.from_url`` kwargs a caller-supplied request dict
    may carry beyond ``url``/``method``/``uniqueKey``, in the wire's
    camelCase shape: ``headers``/``payload``/``userData``/``retryCount``/
    ``noRetry``/``loadedUrl``.

    Used by both ``rq_add_batch`` and ``rq_update_request``, since a real
    Actor's SDK can set any of these on a request it hands to either route
    (a fresh request via ``add_requests``, or the full current request dict
    via ``mark_request_as_handled``/``reclaim_request``) and expects them
    to round-trip on the next read.

    ``retryCount``/``noRetry`` are typed ``int``/``bool`` (no ``None``
    default) on crawlee's own ``Request`` model, so they are only forwarded
    when actually present in ``payload`` -- passing an explicit ``None`` for
    either would fail pydantic validation instead of falling back to
    ``Request.from_url``'s own default (``0``/``False``).

    ``handledAt`` is threaded through the same way as ``headers``/``payload``/
    ``userData`` (unconditionally, defaulting to ``None``): crawlee's
    ``Request.handled_at`` is itself typed ``datetime | None`` with a ``None``
    default, so passing it through as ``None`` when absent is a no-op, not a
    validation error. Forwarding the caller's own value here -- rather than
    leaving it for ``mark_request_as_handled`` to fill in with its own
    call-time ``datetime.now()`` -- preserves the exact ``handledAt`` the real
    ``apify`` SDK actually PUT, matching the round-trip fidelity every other
    field on this same call already gets.
    """
    kwargs: dict[str, Any] = {
        "headers": payload.get("headers"),
        "payload": payload.get("payload"),
        "user_data": payload.get("userData") or payload.get("user_data"),
        "handled_at": payload.get("handledAt") or payload.get("handled_at"),
    }
    if "retryCount" in payload or "retry_count" in payload:
        kwargs["retry_count"] = payload.get("retryCount", payload.get("retry_count"))
    if "noRetry" in payload or "no_retry" in payload:
        kwargs["no_retry"] = payload.get("noRetry", payload.get("no_retry"))
    if "loadedUrl" in payload or "loaded_url" in payload:
        kwargs["loaded_url"] = payload.get("loadedUrl", payload.get("loaded_url"))
    return kwargs


async def _resync_rq_metadata(rq: Any, session: Any) -> None:
    """Re-derive ``totalRequestCount``/``pendingRequestCount``/``handledRequestCount``
    from a live ``COUNT(*)`` over the request rows still in ``session``, after a
    direct ``RequestDb`` row delete.

    Crawlee's ``SqlRequestQueueClient`` keeps those three counters in a metadata
    row that is normally kept in sync only through its own mutation methods
    (``add_batch_of_requests``, ``mark_request_as_handled``, ``reclaim_request``,
    ...), via its metadata-buffer machinery (``SqlClientMixin._add_buffer_record``/
    ``_apply_buffer_updates``). It exposes no public per-request delete at all
    (its request-queue client's only mutation surface is
    add/get/fetch_next/mark_handled/reclaim), so deleting ``RequestDb`` rows
    directly -- the only way to implement per-request/batch delete against this
    client -- bypasses that machinery entirely and leaves the counters stale
    (permanently too high) unless corrected here.

    ``_update_metadata(..., recalculate=True)`` runs the same live-recount
    ``UPDATE`` (one ``COUNT(*)`` subquery per counter) that crawlee's own
    ``SqlClientMixin._purge()`` issues after its own direct row deletes, so this
    mirrors crawlee's existing recovery path rather than inventing a new one.

    This storage client's sessions are created with ``autoflush=False`` (see
    ``SqlStorageClient``'s ``async_sessionmaker``), so any pending
    ``session.delete(...)`` calls on ``session`` must be flushed before the
    recalculation runs, or the ``COUNT(*)`` subqueries below would still see
    the not-yet-deleted rows.
    """
    await session.flush()
    await rq._update_metadata(session, modified_at=datetime.now(timezone.utc), recalculate=True)


class Storage:
    """Thin async facade over crawlee's SQL storage clients."""

    def __init__(self, connection_string: str) -> None:
        self._client = SqlStorageClient(connection_string=connection_string)

    async def start(self) -> None:
        await self._client.__aenter__()

    async def stop(self) -> None:
        await self._client.__aexit__(None, None, None)

    # -- key-value store ---------------------------------------------------
    async def kv_set(self, store_id: str, key: str, value: Any, content_type: str) -> None:
        kv = await self._client.create_kvs_client(name=store_id)
        await kv.set_value(key=key, value=value, content_type=content_type)

    async def kv_keys(self, store_id: str) -> list[dict[str, Any]]:
        """Every key in the store, unpaginated -- exactly `kv_keys_page`'s own
        ``limit=None, exclusive_start_key=None`` case, so this delegates to it
        instead of re-implementing the same open+iterate+map loop."""
        return (await self.kv_keys_page(store_id))[0]

    async def kv_keys_page(
        self, store_id: str, exclusive_start_key: str | None = None, limit: int | None = None
    ) -> tuple[list[dict[str, Any]], bool, str | None]:
        """Cursor-aware page of KV keys, pushed straight through to crawlee's
        own ascending ``key > exclusive_start_key`` filter and ``limit``
        clause (``iterate_keys``) rather than slicing an already-fetched full
        list -- so this scales with the page size, not the store size.

        Fetches one key beyond ``limit`` (when ``limit`` is given and
        positive) to detect whether more keys remain: if so, that extra key
        is dropped from the returned page and the call reports
        ``is_truncated=True`` with the last kept key as the next cursor;
        otherwise ``is_truncated=False`` and there is no next cursor.
        ``limit=None`` returns every remaining key (from
        ``exclusive_start_key`` onward, or from the start) with
        ``is_truncated=False``, matching a bare request's own no-cap
        behaviour. ``limit=0`` is a zero-width window that by definition has
        nothing to truncate -- it short-circuits to an empty,
        non-truncated page without probing at all, rather than reporting a
        truncation with no real key to resume from (or, given a cursor,
        handing back the unchanged input cursor, which would loop a naive
        "keep following the next cursor" caller forever).

        Returns ``(page, is_truncated, next_exclusive_start_key)``.
        """
        if limit == 0:
            return [], False, None
        kv = await self._client.create_kvs_client(name=store_id)
        probe_limit = limit + 1 if limit is not None else None
        fetched = []
        async for meta in kv.iterate_keys(exclusive_start_key=exclusive_start_key, limit=probe_limit):
            fetched.append({"key": meta.key, "size": meta.size})
        if limit is not None and len(fetched) > limit:
            page = fetched[:limit]
            return page, True, page[-1]["key"]
        return fetched, False, None

    async def kv_record(self, store_id: str, key: str) -> tuple[Any, str] | None:
        kv = await self._client.create_kvs_client(name=store_id)
        rec = await kv.get_value(key=key)
        if rec is None:
            return None
        return rec.value, rec.content_type or "application/octet-stream"

    async def kv_delete_record(self, store_id: str, key: str) -> None:
        kv = await self._client.create_kvs_client(name=store_id)
        await kv.delete_value(key=key)

    # -- dataset -----------------------------------------------------------
    async def dataset_push(self, dataset_id: str, items: list[dict[str, Any]]) -> None:
        ds = await self._client.create_dataset_client(name=dataset_id)
        if items:
            await ds.push_data(items)

    async def dataset_items(self, dataset_id: str, offset: int = 0, limit: int = DEFAULT_ITEM_LIMIT) -> dict[str, Any]:
        ds = await self._client.create_dataset_client(name=dataset_id)
        page = await ds.get_data(offset=offset, limit=limit)
        return {"items": list(page.items), "total": page.total, "count": page.count, "offset": page.offset}

    # -- request queue -----------------------------------------------------
    async def rq_add(self, queue_id: str, requests: list[dict[str, Any]]) -> None:
        """Fire-and-forget add: used only by the post-run disk-import fallback
        (``_import_request_queue_dir``), which has no caller waiting on a
        per-request processed/unprocessed result. The single-add HTTP route
        uses ``rq_add_batch`` instead, since its response must carry
        ``wasAlreadyPresent``/``wasAlreadyHandled`` per request.
        """
        rq = await self._client.create_rq_client(name=queue_id)
        built = []
        for r in requests:
            url = r.get("url")
            if not url:
                continue
            built.append(Request.from_url(url, method=r.get("method", "GET"), unique_key=r.get("uniqueKey")))
        if built:
            await rq.add_batch_of_requests(built)

    async def rq_add_batch(
        self, queue_id: str, requests: list[dict[str, Any]], forefront: bool = False
    ) -> dict[str, Any]:
        """Backing implementation for ``POST /request-queues/{id}/requests/batch``
        (and, via a one-element list, the single-add ``POST .../requests`` route).

        Returns the ``processedRequests``/``unprocessedRequests`` shape
        ``apify_client``'s ``batch_add_requests`` (and the ``apify`` SDK's
        ``AddRequestsResponse.model_validate``) expects.

        ``headers``/``payload``/``userData``/``retryCount``/``noRetry``/
        ``loadedUrl`` are threaded through to ``Request.from_url`` (via
        ``_rq_request_kwargs``): every one of these is a field the real
        ``apify`` SDK's request-queue client actually sets and sends on the
        wire (``request.model_dump(by_alias=True)``), so dropping any of
        them here would silently discard state a real Actor depends on --
        most importantly ``userData``, the standard Crawlee/Apify mechanism
        for per-request state. ``Request.from_url`` accepts a plain
        ``payload`` string (encoding it to ``bytes`` itself) and merges a
        given ``user_data`` dict with its own ``__crawlee`` bookkeeping key
        -- this matches exactly what the real ``apify`` SDK sends (verified
        against the installed ``apify`` package: a plain string ``payload``,
        never base64), so this is not a new/local encoding, just accepting
        what the real client already produces.
        """
        rq = await self._client.create_rq_client(name=queue_id)
        built = []
        unprocessed: list[dict[str, Any]] = []
        for r in requests:
            url = r.get("url")
            if not url:
                unprocessed.append(
                    {"uniqueKey": r.get("uniqueKey", ""), "url": url or "", "method": r.get("method", "GET")}
                )
                continue
            built.append(
                Request.from_url(
                    url,
                    method=r.get("method", "GET"),
                    unique_key=r.get("uniqueKey"),
                    **_rq_request_kwargs(r),
                )
            )
        response = await rq.add_batch_of_requests(built, forefront=forefront)
        processed = [
            {
                "requestId": _request_id_for(pr.unique_key),
                "uniqueKey": pr.unique_key,
                "wasAlreadyPresent": pr.was_already_present,
                "wasAlreadyHandled": pr.was_already_handled,
            }
            for pr in response.processed_requests
        ]
        unprocessed.extend(
            {"uniqueKey": u.unique_key, "url": u.url, "method": u.method} for u in response.unprocessed_requests
        )
        return {"processedRequests": processed, "unprocessedRequests": unprocessed}

    async def rq_batch_delete(self, queue_id: str, requests: list[dict[str, Any]]) -> dict[str, Any]:
        """Backing implementation for ``DELETE /request-queues/{id}/requests/batch``.

        Each entry may identify the request by ``id`` or by ``uniqueKey``.
        """
        wanted: set[str] = set()
        for r in requests:
            if r.get("id"):
                wanted.add(r["id"])
            elif r.get("uniqueKey"):
                wanted.add(_request_id_for(r["uniqueKey"]))
        rq = await self._client.create_rq_client(name=queue_id)
        md = await rq.get_metadata()
        processed = []
        async with rq.get_session() as session:
            rows = await _rq_rows(session, md.id)
            for row in rows:
                rid = _row_id(row)
                if rid in wanted:
                    d = _row_dict(row)
                    processed.append({"requestId": rid, "uniqueKey": d.get("uniqueKey")})
                    await session.delete(row)
            if processed:
                await _resync_rq_metadata(rq, session)
            await session.commit()
        return {"processedRequests": processed, "unprocessedRequests": []}

    async def rq_metadata(self, queue_id: str) -> dict[str, Any]:
        rq = await self._client.create_rq_client(name=queue_id)
        md = await rq.get_metadata()
        return {
            "id": queue_id,
            "totalRequestCount": md.total_request_count,
            "pendingRequestCount": md.pending_request_count,
            "handledRequestCount": md.handled_request_count,
            "hadMultipleClients": md.had_multiple_clients,
            # Required (no default) by the apify SDK's own
            # ApifyRequestQueueClient.get_metadata(), which indexes
            # `response['stats']` directly rather than `.get()`-ing it, so a
            # response missing this key entirely raises `KeyError` before the
            # SDK's own code runs. This runtime tracks no separate
            # read/write/delete counters, so an empty dict is the honest
            # value (RequestQueueStats' own fields all default to 0).
            "stats": {},
        }

    async def rq_requests(self, queue_id: str) -> list[dict[str, Any]]:
        """Backing implementation for ``GET /request-queues/{id}/requests``.

        Returns each row via ``_row_dict`` -- the same wire-standard shape
        (``headers``/``payload``/``userData``/``retryCount``/``noRetry``/
        ``loadedUrl``, and critically ``handledAt``) every other per-request
        route in this module already returns, not an ad hoc subset.

        This matters beyond consistency: the real ``apify`` SDK's
        ``ApifyRequestQueueSingleClient._init_caches()`` calls this exact
        route (``list_requests(limit=10_000)``) on the first
        ``add_batch_of_requests`` against a request queue that already has
        rows in it (a persisted/named queue reused across runs, or a resumed
        crawl), and classifies each returned item by feeding it straight
        through ``crawlee.Request.model_validate(request_data)`` --
        ``was_already_handled`` is a computed property reading
        ``handled_at is not None``. Omitting ``handledAt`` here (as the
        previous ``{id, url, uniqueKey, method, handled: bool}`` shape did --
        a non-standard ``handled`` key ``Request.model_validate`` tolerates
        under ``extra='allow'`` but never consumes) makes every already-
        handled request parse as ``handled_at=None``, silently corrupting the
        SDK's local dedup cache with no crash or error.
        """
        rq = await self._client.create_rq_client(name=queue_id)
        md = await rq.get_metadata()
        async with rq.get_session() as session:
            rows = (
                await session.execute(
                    select(RequestDb)
                    .where(RequestDb.request_queue_id == md.id)
                    .order_by(RequestDb.sequence_number)
                )
            ).scalars().all()
        return [_row_dict(row) for row in rows]

    async def rq_get_request(self, queue_id: str, request_id: str) -> dict[str, Any] | None:
        rq = await self._client.create_rq_client(name=queue_id)
        md = await rq.get_metadata()
        async with rq.get_session() as session:
            rows = await _rq_rows(session, md.id)
        row = _find_row(rows, request_id)
        return _row_dict(row) if row is not None else None

    async def rq_update_request(
        self, queue_id: str, request_id: str, body: dict[str, Any], forefront: bool = False
    ) -> dict[str, Any] | None:
        """Backing implementation for ``PUT /request-queues/{id}/requests/{requestId}``.

        Acts as an upsert (matching the real API): a ``request_id`` with no
        existing row adds the request. An existing row is either marked
        handled (``handledAt`` set) or reclaimed (``handledAt`` absent) --
        this is the route the real ``apify`` SDK's
        ``request_queue.reclaim_request(request)`` PUTs to on every retry
        after a processing failure, always with ``forefront=False`` (its
        default), so that path must actually do something: reclaiming an
        existing request calls crawlee's own
        ``SqlRequestQueueClient.reclaim_request(forefront=...)``
        unconditionally, passing the caller's real ``forefront`` value
        through rather than gating the call on it being ``True``. Per
        crawlee's own implementation, ``forefront=False`` still clears the
        row's lock (``time_blocked_until``/``client_key``) and persists the
        given request data -- it only additionally re-sequences the request
        to the back of the queue instead of the front. Treating
        ``forefront=False`` as a no-op leaves the request's lock in place
        for the rest of its TTL, so it silently stops appearing in any
        subsequent ``head``/``head/lock`` read even though the PUT reports
        success.

        ``headers``/``payload``/``userData``/``retryCount``/``noRetry``/
        ``loadedUrl``/``handledAt`` from ``body`` are threaded through to
        ``Request.from_url`` (via ``_rq_request_kwargs``) for the same
        reason as ``rq_add_batch``: the real ``apify`` SDK always PUTs the
        FULL request dict here (``request.model_dump(by_alias=True)``, e.g.
        from ``mark_request_as_handled``/``reclaim_request``), so dropping
        these fields would silently discard them from every handled/
        reclaimed request, not just newly-added ones.

        Threading ``handledAt`` through matters specifically for the
        mark-handled branch below: crawlee's own
        ``SqlRequestQueueClient.mark_request_as_handled`` only substitutes its
        own call-time ``datetime.now()`` ``if request.handled_at is None``.
        Building ``req`` with the caller's ``handledAt`` already set (via
        ``_rq_request_kwargs``) means that branch preserves the exact
        timestamp the real SDK PUT, instead of silently overwriting it with
        the server's own call time.
        """
        existing = await self.rq_get_request(queue_id, request_id)
        unique_key = body.get("uniqueKey") or (existing or {}).get("uniqueKey")
        url = body.get("url") or (existing or {}).get("url")
        if not unique_key or not url:
            return None
        was_already_present = existing is not None
        was_already_handled = bool(existing.get("handledAt")) if existing else False

        rq = await self._client.create_rq_client(name=queue_id)
        req = Request.from_url(
            url,
            method=body.get("method", "GET"),
            unique_key=unique_key,
            **_rq_request_kwargs(body),
        )
        if not was_already_present:
            await rq.add_batch_of_requests([req], forefront=forefront)
        if body.get("handledAt"):
            await rq.mark_request_as_handled(req)
        elif was_already_present:
            await rq.reclaim_request(req, forefront=forefront)
        return {
            "requestId": request_id,
            "uniqueKey": unique_key,
            "wasAlreadyPresent": was_already_present,
            "wasAlreadyHandled": was_already_handled,
        }

    async def rq_delete_request(self, queue_id: str, request_id: str) -> bool:
        rq = await self._client.create_rq_client(name=queue_id)
        md = await rq.get_metadata()
        async with rq.get_session() as session:
            rows = await _rq_rows(session, md.id)
            target = _find_row(rows, request_id)
            if target is None:
                return False
            await session.delete(target)
            await _resync_rq_metadata(rq, session)
            await session.commit()
        return True

    async def rq_head(self, queue_id: str, limit: int = DEFAULT_HEAD_LIMIT) -> dict[str, Any]:
        rq = await self._client.create_rq_client(name=queue_id)
        md = await rq.get_metadata()
        now = datetime.now(timezone.utc)
        async with rq.get_session() as session:
            _rows, available = await _available_unhandled(session, md.id, now)
        available = available[:limit]
        return {
            "limit": limit,
            "hadMultipleClients": md.had_multiple_clients,
            "queueModifiedAt": _fmt_dt(md.modified_at),
            "items": [_row_dict(r) for r in available],
        }

    async def rq_head_and_lock(self, queue_id: str, limit: int, lock_secs: int) -> dict[str, Any]:
        rq = await self._client.create_rq_client(name=queue_id)
        md = await rq.get_metadata()
        now = datetime.now(timezone.utc)
        lock_until = now + timedelta(seconds=lock_secs)
        async with rq.get_session() as session:
            rows, available = await _available_unhandled(session, md.id, now)
            to_lock = available[:limit]
            for row in to_lock:
                row.time_blocked_until = lock_until
            await session.commit()
            # "Does this queue have any locked, unhandled request" -- whether
            # locked by this call (`to_lock`) or already locked by a PRIOR call
            # (a row in `rows` that isn't in `available`, i.e. still within its
            # lock window). `len(available) > len(to_lock)` (the previous
            # formula) instead measured "is there unlocked inventory left over
            # the limit" -- an unrelated quantity that happens to agree with
            # this one whenever `to_lock` is non-empty, which is exactly why a
            # single-call test never caught it: the bug only shows up when a
            # *previous* call already locked everything and this call has
            # nothing new to lock (`to_lock` empty, `available` empty too, but
            # `rows` still contains the still-locked request). This flag backs
            # `apify`'s own shared request-queue client's `is_finished` check
            # (`len(head.items) == 0 and not queue_has_locked_requests`), so
            # under-reporting it here would make a multi-consumer crawl think
            # it's finished while another consumer still holds locked work.
            has_locked_requests = len(rows) > len(available) or bool(to_lock)
        return {
            "limit": limit,
            "hadMultipleClients": md.had_multiple_clients,
            "queueHasLockedRequests": has_locked_requests,
            "queueModifiedAt": _fmt_dt(md.modified_at),
            "items": [_row_dict(r) for r in to_lock],
        }

    async def rq_lock_request(self, queue_id: str, request_id: str, lock_secs: int) -> dict[str, Any] | None:
        rq = await self._client.create_rq_client(name=queue_id)
        md = await rq.get_metadata()
        lock_until = datetime.now(timezone.utc) + timedelta(seconds=lock_secs)
        async with rq.get_session() as session:
            rows = await _rq_rows(session, md.id)
            target = _find_row(rows, request_id)
            if target is None:
                return None
            target.time_blocked_until = lock_until
            await session.commit()
        return {"lockExpiresAt": _fmt_dt(lock_until)}

    async def rq_delete_request_lock(self, queue_id: str, request_id: str) -> bool:
        rq = await self._client.create_rq_client(name=queue_id)
        md = await rq.get_metadata()
        async with rq.get_session() as session:
            rows = await _rq_rows(session, md.id)
            target = _find_row(rows, request_id)
            if target is None:
                return False
            target.time_blocked_until = None
            await session.commit()
        return True

    async def rq_unlock_all(self, queue_id: str) -> int:
        rq = await self._client.create_rq_client(name=queue_id)
        md = await rq.get_metadata()
        now = datetime.now(timezone.utc)
        async with rq.get_session() as session:
            # Only rows with a currently-active (not yet expired) lock count as
            # "unlocked" -- without the `IS NOT NULL` filter every row in the
            # queue (locked or not, handled or not) matches the UPDATE and
            # inflates `rowcount` into a count that has nothing to do with how
            # many locks this call actually released. The `> now` bound catches
            # the remaining gap: a row whose lock already expired still has a
            # non-null `time_blocked_until` (nothing proactively clears it on
            # expiry -- `rq_head`/`rq_head_and_lock` only *treat* such rows as
            # available again), so it was already effectively unlocked before
            # this call and must not be counted as unlocked *by* it. Both
            # together make `rowcount` match what apify-client's
            # `unlock_requests()` hands straight back to the caller as
            # `unlockedCount`.
            result = await session.execute(
                update(RequestDb)
                .where(
                    RequestDb.request_queue_id == md.id,
                    RequestDb.time_blocked_until.isnot(None),
                    RequestDb.time_blocked_until > now,
                )
                .values(time_blocked_until=None)
            )
            await session.commit()
        return result.rowcount or 0

    # -- drop (hard-delete underlying data) --------------------------------
    async def kv_drop(self, store_id: str) -> None:
        kv = await self._client.create_kvs_client(name=store_id)
        await kv.drop()

    async def dataset_drop(self, dataset_id: str) -> None:
        ds = await self._client.create_dataset_client(name=dataset_id)
        await ds.drop()

    async def rq_drop(self, queue_id: str) -> None:
        rq = await self._client.create_rq_client(name=queue_id)
        await rq.drop()

    # -- import from an Actor run's local storage directory ----------------
    async def import_run_storage(
        self,
        storage_dir: Path,
        kv_store_id: str,
        dataset_id: str,
        request_queue_id: str,
        trusted_root: str | None = None,
    ) -> None:
        """Import the Apify-style local storage a finished Actor wrote on disk.

        Layout (Apify/crawlee local storage convention):
          storage/key_value_stores/default/<key>.<ext>
          storage/datasets/default/*.json         (one item per file)
          storage/request_queues/default/*.json   (one request per file)

        ``trusted_root`` is the real (``os.path.realpath``) path of ``storage_dir``
        captured at a trusted time, before any Actor code ran. Every imported file
        is validated against this fixed anchor - the anchor is NOT re-derived from
        ``storage_dir`` at import time, because by then the untrusted Actor may have
        swapped a directory below it for a symlink pointing outside the run dir.
        """
        storage_dir = Path(storage_dir)
        # Fall back to resolving storage_dir now only when no captured anchor was
        # supplied (e.g. direct unit-test calls); the caller in _run_actor always
        # passes the anchor recorded when the run dir was created.
        anchor = trusted_root if trusted_root is not None else os.path.realpath(storage_dir)

        # Each phase (and each file within a phase) is isolated: a single malformed
        # or binary file must not take down the other stores. One Actor-controlled
        # file being unreadable (bad encoding, corrupt JSON, ...) should cost that
        # one record, not the whole run's KV store, dataset and request queue.
        try:
            await self._import_kv_dir(storage_dir, anchor, kv_store_id)
        except Exception:
            logger.exception("Failed to import key-value store from %s", storage_dir)

        try:
            await self._import_dataset_dir(storage_dir, anchor, dataset_id)
        except Exception:
            logger.exception("Failed to import dataset from %s", storage_dir)

        try:
            await self._import_request_queue_dir(storage_dir, anchor, request_queue_id)
        except Exception:
            logger.exception("Failed to import request queue from %s", storage_dir)

    async def _import_kv_dir(self, storage_dir: Path, anchor: str, kv_store_id: str) -> None:
        kv_dir = storage_dir / "key_value_stores" / "default"
        if not kv_dir.is_dir():
            return
        for path in sorted(kv_dir.iterdir()):
            if not _safe_file(path, storage_dir, anchor) or path.name.startswith("__"):
                continue
            try:
                key = path.stem
                value, content_type = _read_kv_file(path)
                await self.kv_set(kv_store_id, key, value, content_type)
            except Exception:
                logger.exception("Failed to import key-value record %s", path)

    async def _import_dataset_dir(self, storage_dir: Path, anchor: str, dataset_id: str) -> None:
        ds_dir = storage_dir / "datasets" / "default"
        if not ds_dir.is_dir():
            return
        items = []
        for path in sorted(ds_dir.iterdir()):
            if not (
                _safe_file(path, storage_dir, anchor)
                and path.suffix == ".json"
                and not path.name.startswith("__")
            ):
                continue
            try:
                items.append(json.loads(path.read_text()))
            except Exception:
                logger.exception("Failed to import dataset item %s", path)
        await self.dataset_push(dataset_id, items)

    async def _import_request_queue_dir(self, storage_dir: Path, anchor: str, request_queue_id: str) -> None:
        rq_dir = storage_dir / "request_queues" / "default"
        if not rq_dir.is_dir():
            return
        reqs = []
        for path in sorted(rq_dir.iterdir()):
            if not (
                _safe_file(path, storage_dir, anchor)
                and path.suffix == ".json"
                and not path.name.startswith("__")
            ):
                continue
            try:
                reqs.append(json.loads(path.read_text()))
            except Exception:
                logger.exception("Failed to import queued request %s", path)
        await self.rq_add(request_queue_id, reqs)


def _read_kv_file(path: Path) -> tuple[Any, str]:
    """Read one on-disk KV record, matching ``routers/storages.py``'s HTTP handling.

    ``.json`` files are parsed and stored as JSON, same as before. Other known-text
    suffixes are decoded as UTF-8. Everything else (screenshots, PDFs, archives -
    anything an Actor can legitimately write into its KV store) is read as raw bytes
    with a content type guessed from the extension, so it round-trips unchanged
    instead of raising ``UnicodeDecodeError`` and aborting the whole import.
    """
    if path.suffix == ".json":
        return json.loads(path.read_text() or "null"), "application/json"
    if path.suffix in _TEXT_KV_SUFFIXES:
        guessed, _ = mimetypes.guess_type(path.name)
        return path.read_text(), guessed or "text/plain"
    guessed, _ = mimetypes.guess_type(path.name)
    return path.read_bytes(), guessed or "application/octet-stream"


def _safe_file(path: Path, storage_root: Path, trusted_root: str) -> bool:
    """True only for a regular file reachable from ``storage_root`` with no symlink.

    The Actor's own (untrusted) container has read-write access to the bind-mounted
    run storage dir, so it can plant symlinks - not only on a leaf file, but by
    replacing an entire intermediate directory (e.g. ``key_value_stores/default``)
    with a symlink to an arbitrary location such as ``/etc`` or the runtime's own
    source. Following any of those would let a malicious Actor exfiltrate host files
    back through the KV/dataset/queue API.

    Defence: walk every path component from the trusted ``storage_root`` down to the
    file and reject if ANY of them (including the leaf) is a symlink; then confirm
    the file's real path still lives under ``trusted_root`` - the anchor captured
    before any Actor code ran, never re-derived from the possibly-swapped tree.
    """
    try:
        storage_root = Path(storage_root)
        rel = path.relative_to(storage_root)
        current = storage_root
        for part in rel.parts:
            current = current / part
            if os.path.islink(current):
                return False
        if not path.is_file():
            return False
        real = os.path.realpath(path)
        return real == trusted_root or real.startswith(trusted_root + os.sep)
    except (OSError, ValueError):
        return False

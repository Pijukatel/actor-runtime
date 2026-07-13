"""Storage layer backed by crawlee-python's experimental SQL storage client.

Provides the runtime's dataset, key-value store and request-queue storages, all
persisted in a single SQLite file. Storages are addressed by a stable string id
(used verbatim as the crawlee storage ``name``), so they can be reopened across
process restarts.
"""
from __future__ import annotations

import json
import logging
import mimetypes
import os
import warnings
from pathlib import Path
from typing import Any

from crawlee import Request
from crawlee.storage_clients import SqlStorageClient
from crawlee.storage_clients._sql._db_models import RequestDb
from sqlalchemy import select

warnings.filterwarnings("ignore", message="The SqlStorageClient is experimental.*")

logger = logging.getLogger(__name__)

# "All items" default for dataset reads - the prototype has no pagination UI/consumer
# yet, so this is just a large-enough cap rather than a real page size.
DEFAULT_ITEM_LIMIT = 999999

# Suffixes that are safe to decode as UTF-8 text when importing a KV record from
# disk. Anything else (images, PDFs, archives, ...) is imported as raw bytes so it
# round-trips unchanged, matching the HTTP put_record/get_record behaviour.
_TEXT_KV_SUFFIXES = {".txt", ".html", ".htm", ".csv", ".xml", ".md", ".log", ".yaml", ".yml"}


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
        kv = await self._client.create_kvs_client(name=store_id)
        items = []
        async for meta in kv.iterate_keys():
            items.append({"key": meta.key, "size": meta.size})
        return items

    async def kv_record(self, store_id: str, key: str) -> tuple[Any, str] | None:
        kv = await self._client.create_kvs_client(name=store_id)
        rec = await kv.get_value(key=key)
        if rec is None:
            return None
        return rec.value, rec.content_type or "application/octet-stream"

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
        rq = await self._client.create_rq_client(name=queue_id)
        built = []
        for r in requests:
            url = r.get("url")
            if not url:
                continue
            built.append(Request.from_url(url, method=r.get("method", "GET"), unique_key=r.get("uniqueKey")))
        if built:
            await rq.add_batch_of_requests(built)

    async def rq_metadata(self, queue_id: str) -> dict[str, Any]:
        rq = await self._client.create_rq_client(name=queue_id)
        md = await rq.get_metadata()
        return {
            "id": queue_id,
            "totalRequestCount": md.total_request_count,
            "pendingRequestCount": md.pending_request_count,
            "handledRequestCount": md.handled_request_count,
        }

    async def rq_requests(self, queue_id: str) -> list[dict[str, Any]]:
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
        out = []
        for row in rows:
            data = json.loads(row.data) if isinstance(row.data, str) else row.data
            out.append(
                {
                    "id": data.get("id", row.request_id),
                    "url": data.get("url"),
                    "uniqueKey": data.get("uniqueKey") or data.get("unique_key"),
                    "method": data.get("method", "GET"),
                    "handled": bool(row.is_handled),
                }
            )
        return out

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

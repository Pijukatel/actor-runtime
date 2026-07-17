"""Storage ownership and access-rights: create-if-missing, owner/grant-based
authorization decisions, and sharing (grant/list/revoke).

Extracted out of ``app/service.py`` alongside the standby-subsystem split
(see ``app/standby.py``'s module docstring for the same rationale) once
removing standby alone still left ``service.py`` marginally over the
1000-line maintainability ceiling: this is an equally self-contained,
cohesive unit -- storage ownership/sharing decisions -- coupled to the rest
of the app only through the ``Service`` instance it is constructed with
(``db`` and ``storage``). ``Service`` keeps a thin delegation surface (see
the "-- storage ownership & sharing --" section of ``app/service.py``) so
routers and tests keep going through ``Service`` exactly as before.
"""
from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from .constants import STORAGE_DS, STORAGE_KV, STORAGE_RQ, short_id
from .db import AccessRight, Storage as StorageRow

if TYPE_CHECKING:
    # Type-only -- see app/standby.py's identical note on why this must not
    # be a real top-level import (it would recreate the service<->storage_access
    # circular import this split exists to avoid).
    from .service import Service

logger = logging.getLogger(__name__)

LEVEL_READ = "READ"
LEVEL_WRITE = "WRITE"

ACCESS_ALLOW = "allow"
ACCESS_NOT_FOUND = "not_found"
ACCESS_FORBIDDEN = "forbidden"
ACCESS_ABSENT = "absent"  # no storage row exists for this id


class StorageAccessManager:
    """Owner/grant-based access decisions and sharing for first-class storages.

    Constructed once by ``Service.__init__`` (``self.storage_access =
    StorageAccessManager(self)``); reaches the DB and the physical storage
    backend through ``self.service``.
    """

    def __init__(self, service: "Service") -> None:
        self.service = service

    async def get_storage(self, storage_id: str) -> StorageRow | None:
        async with self.service.db.session() as s:
            return await s.get(StorageRow, storage_id)

    async def ensure_storage(self, storage_id: str, storage_type: str, owner: str) -> str:
        """Create-if-missing a first-class storage record; return its actual owner.

        The returned owner is authoritative -- read back from the DB after the
        commit -- so a caller that lost a create race (its INSERT hit the unique
        PK and rolled back) learns the winner's identity instead of assuming it
        won. The ``storages`` PK is the single source of truth about who owns the id.
        """
        async with self.service.db.session() as s:
            existing = await s.get(StorageRow, storage_id)
            if existing is not None:
                return existing.owner
            s.add(StorageRow(id=storage_id, type=storage_type, owner=owner))
            try:
                await s.commit()
            except IntegrityError:
                await s.rollback()
            row = await s.get(StorageRow, storage_id)
            return row.owner if row is not None else owner

    async def check_storage_access(
        self, storage_id: str, username: str, need: str, expected_type: str | None = None
    ) -> str:
        """Decide access for ``username`` against ``storage_id`` at ``need`` level.

        owner -> allow; a matching-or-stronger grant -> allow (WRITE satisfies
        READ); a weaker grant than needed -> forbidden (grantee can see it but may
        not act); no grant at all -> not_found (invisible). A storage id with no row
        yet -> absent, which the caller resolves by direction (a write auto-creates
        the storage owned by the writer; a read is a 404, so an unknown/invented id
        is indistinguishable from another user's).
        """
        async with self.service.db.session() as s:
            storage = await s.get(StorageRow, storage_id)
            if storage is None:
                return ACCESS_ABSENT
            # The id exists, but not as the type this endpoint addresses -- as that
            # type it does not exist, so hide it exactly like a missing id (404).
            if expected_type is not None and storage.type != expected_type:
                return ACCESS_NOT_FOUND
            if storage.owner == username:
                return ACCESS_ALLOW
            grant = (
                await s.execute(
                    select(AccessRight).where(
                        AccessRight.resource_id == storage_id,
                        AccessRight.grantee == username,
                    )
                )
            ).scalar_one_or_none()
            if grant is None:
                return ACCESS_NOT_FOUND
            if grant.level == LEVEL_WRITE or need == LEVEL_READ:
                return ACCESS_ALLOW
            return ACCESS_FORBIDDEN

    async def grant_access(self, storage_id: str, resource_type: str, grantee: str, level: str) -> None:
        async with self.service.db.session() as s:
            existing = (
                await s.execute(
                    select(AccessRight).where(
                        AccessRight.resource_id == storage_id,
                        AccessRight.grantee == grantee,
                    )
                )
            ).scalar_one_or_none()
            if existing is not None:
                existing.level = level
            else:
                s.add(
                    AccessRight(
                        id=short_id(),
                        resource_type=resource_type,
                        resource_id=storage_id,
                        grantee=grantee,
                        level=level,
                    )
                )
            await s.commit()

    async def list_access(self, storage_id: str) -> list[AccessRight]:
        async with self.service.db.session() as s:
            return list(
                (
                    await s.execute(
                        select(AccessRight).where(AccessRight.resource_id == storage_id)
                    )
                ).scalars()
            )

    async def revoke_access(self, storage_id: str, grantee: str) -> bool:
        async with self.service.db.session() as s:
            existing = (
                await s.execute(
                    select(AccessRight).where(
                        AccessRight.resource_id == storage_id,
                        AccessRight.grantee == grantee,
                    )
                )
            ).scalar_one_or_none()
            if existing is None:
                return False
            await s.delete(existing)
            await s.commit()
            return True

    async def list_storages_for_user(self, username: str, type: str | None = None) -> list[StorageRow]:
        async with self.service.db.session() as s:
            stmt = select(StorageRow).where(StorageRow.owner == username).order_by(StorageRow.created_at)
            if type is not None:
                stmt = stmt.where(StorageRow.type == type)
            return list((await s.execute(stmt)).scalars())

    async def delete_storage(self, storage_id: str, username: str) -> str:
        """Delete an owned storage: its row, its access-rights grants and its data.

        Returns ``ACCESS_NOT_FOUND`` for an unknown id, ``ACCESS_FORBIDDEN`` for a
        storage the caller does not own (the router maps cross-user to 404 to keep
        existence hidden), or ``ACCESS_ALLOW`` on success. ``AccessRight`` rows are
        not FK-linked to ``storages``, so matching grants are removed explicitly to
        avoid dangling shares pointing at a deleted storage.

        The metadata (row + grants) is the source of truth for listings and
        isolation, so it is removed authoritatively. The underlying crawlee data is
        then dropped best-effort: a physical-cleanup failure is logged but does not
        turn a successful logical delete into a 500 (the storage is already gone
        from every listing/access path, and an orphaned data blob is invisible and
        harmless).
        """
        async with self.service.db.session() as s:
            storage = await s.get(StorageRow, storage_id)
            if storage is None:
                return ACCESS_NOT_FOUND
            if storage.owner != username:
                return ACCESS_FORBIDDEN
            storage_type = storage.type
            await s.delete(storage)
            grants = (
                await s.execute(select(AccessRight).where(AccessRight.resource_id == storage_id))
            ).scalars()
            for grant in grants:
                await s.delete(grant)
            await s.commit()
        try:
            if storage_type == STORAGE_KV:
                await self.service.storage.kv_drop(storage_id)
            elif storage_type == STORAGE_DS:
                await self.service.storage.dataset_drop(storage_id)
            elif storage_type == STORAGE_RQ:
                await self.service.storage.rq_drop(storage_id)
        except Exception:  # noqa: BLE001 - metadata is gone; physical drop is best-effort
            logger.exception("Best-effort data drop failed for storage %s", storage_id)
        return ACCESS_ALLOW

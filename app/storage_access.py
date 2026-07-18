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

import asyncio
import contextlib
import logging
import re
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

# Mirrors crawlee's own client-side ``crawlee.storages._utils.validate_storage_name``
# regex EXACTLY (verified against the installed ``crawlee`` package: letters, digits,
# and a hyphen -- but a hyphen only strictly BETWEEN two alphanumerics, never leading
# or trailing) -- the same constraint the real Apify API enforces server-side on
# dataset/KVS/RQ names. See ``validate_storage_name`` below for why this runtime must
# also enforce it server-side, not rely on crawlee's client-side check alone.
NAME_REGEX = re.compile(r"^([a-zA-Z0-9]|[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9])$")


class InvalidStorageNameError(ValueError):
    """A caller-supplied storage ``name`` (the create-storage query/body param,
    or the presumptive name embedded in a write-auto-created namespaced id)
    fails the platform's naming rule (see ``NAME_REGEX``).

    Matters specifically because a name containing ``~`` -- the very
    separator this runtime's own id-qualification scheme (unqualified
    ``owner~name``, type-qualified ``owner~{type}~name``) uses to keep
    same-named different-typed storages apart -- could otherwise
    deterministically collide with another storage's literal id (e.g.
    ``name="key-value-store~shared"``; see `get_or_create_named_storage`'s
    docstring for the exact collision this closes at the source). A real SDK
    Actor can never trigger this through the by-name create routes (crawlee
    validates storage names client-side before ever sending one over the
    wire), but a raw HTTP caller could -- either directly, or by writing to
    an absent, caller-chosen namespaced id (see
    ``routers/storages.py::_can_autocreate``).
    """


class StorageTypeCollisionError(Exception):
    """`get_or_create_named_storage` resolved ``name`` to an id whose existing
    row is not ``storage_type`` -- defence in depth, kept for when that
    should be structurally impossible.

    Once `validate_storage_name` rejects every ``~``-containing name, neither
    the unqualified nor the type-qualified id this method computes can
    collide with a DIFFERENT, validly-named storage's id, so this should
    never actually raise in normal operation. It exists so a violation of
    that invariant (pre-existing ``~``-containing data written before
    validation existed, or a future bug) fails loudly with a clear cause
    instead of silently handing back an id that does not hold the type the
    caller asked for.
    """

    def __init__(self, storage_id: str, actual_type: str, requested_type: str) -> None:
        super().__init__(
            f"Storage id {storage_id!r} already exists as a {actual_type!r} storage, "
            f"not the requested {requested_type!r}."
        )


def validate_storage_name(name: str) -> None:
    """Reject a storage ``name`` that does not match ``NAME_REGEX``.

    Two call sites, both validating a caller-influenced ``name`` before it
    can be baked into a storage id:

    1. `get_or_create_named_storage`, for the USER-SUPPLIED ``name``
       query/body param every named-storage create route (``POST
       /v2/key-value-stores``, ``/v2/datasets``, ``/v2/request-queues``)
       funnels through.
    2. ``routers/storages.py::_can_autocreate``, for the presumptive
       ``name`` embedded in any namespaced (``owner~name`` or
       ``owner~{type}~name`` shaped) id a write may auto-create -- a raw
       HTTP write can address ANY caller-chosen id, not only ones produced
       by (1), so without this check a namespaced id with an invalid
       embedded name could still be minted and later handed back verbatim
       as that storage's ``name`` field.

    Never applied to a run-derived id (``kv_/ds_/rq_<runId>``, blocked
    earlier in both call sites since it never has a meaningful ``name`` to
    extract) or a bare, non-namespaced id (no ``~`` at all, so there is no
    presumptive name to extract either).
    """
    if not NAME_REGEX.match(name):
        raise InvalidStorageNameError(
            f'Invalid storage name "{name}". Name can only contain letters "a" through "z", the digits "0" '
            'through "9", and the hyphen ("-") but only in the middle of the string (e.g. "my-value-1").'
        )


class StorageAccessManager:
    """Owner/grant-based access decisions and sharing for first-class storages.

    Constructed once by ``Service.__init__`` (``self.storage_access =
    StorageAccessManager(self)``); reaches the DB and the physical storage
    backend through ``self.service``.
    """

    def __init__(self, service: "Service") -> None:
        self.service = service
        # Per-(owner, name) locks serializing the named-storage get-or-create
        # sequence (`get_or_create_named_storage` below) across concurrent
        # callers -- same in-process pattern as `StandbyManager.locks`/
        # `actor_lock()` (see app/standby.py): a plain dict of `asyncio.Lock`,
        # created lazily via `setdefault`, keyed by the identity the race is
        # actually over, and never removed once created (same as
        # `StandbyManager.locks`). That is fine here: this dict can only ever
        # hold one entry per DISTINCT owner+name pair that has actually been
        # get-or-created, so its size is bounded by the number of named
        # storages this runtime holds, not by how many requests or racers hit
        # this path -- negligible growth for a single-process runtime, not
        # worth the extra bookkeeping a refcounted cleanup would add. Purely
        # in-process -- correct only because this runtime is single-process
        # (one `Service`/`StorageAccessManager` per running instance, no
        # multi-worker/multi-replica deployment); a multi-process deployment
        # would need a DB-level lock (e.g. a SELECT ... FOR UPDATE or a unique
        # "name claim" row) instead.
        self._named_storage_locks: dict[str, asyncio.Lock] = {}

    @contextlib.asynccontextmanager
    async def _named_storage_lock(self, owner: str, name: str):
        """Async context manager holding the lock serializing get-or-create
        calls for ``owner``'s ``name``.

        Keyed by (owner, name) -- NOT also by storage type -- because the race
        this guards against (see `get_or_create_named_storage`) is exactly
        between DIFFERENT types sharing an owner+name: they must serialize
        against EACH OTHER, not just against same-type retries, or two
        concurrent different-typed creates can both observe the unqualified id
        as absent and both take it. ``\\x00`` is not a legal character in
        either a username or a storage name, so it cannot collide two distinct
        (owner, name) pairs onto the same key.
        """
        key = f"{owner}\x00{name}"
        lock = self._named_storage_locks.setdefault(key, asyncio.Lock())
        async with lock:
            yield

    async def get_storage(self, storage_id: str) -> StorageRow | None:
        async with self.service.db.session() as s:
            return await s.get(StorageRow, storage_id)

    async def ensure_storage(self, storage_id: str, storage_type: str, owner: str) -> str:
        """Create-if-missing a first-class storage record; return its actual owner.

        The returned owner is authoritative -- read back from the DB after the
        commit -- so a caller that lost a create race (its INSERT hit the unique
        PK and rolled back) learns the winner's identity instead of assuming it
        won. The ``storages`` PK is the single source of truth about who owns the id.

        Type-blind by design: it creates/reads exactly the given ``storage_id``
        and never inspects an existing row's type. That is safe for its two
        call sites (``_guard``'s absent-write auto-create, keyed on a literal
        id named by the URL path with no by-name type-qualification choice to
        make; and the type-qualified id `get_or_create_named_storage` has
        already computed below) but NOT safe to call directly with a
        caller-chosen, not-yet-type-qualified ``storage_id`` derived from a
        user-supplied name -- see `get_or_create_named_storage` for that case.
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

    async def get_or_create_named_storage(self, name: str, storage_type: str, owner: str) -> tuple[str, str, bool]:
        """Atomic get-or-create for a user-named storage; returns ``(storage_id,
        actual_owner, created)``.

        This closes a TOCTOU race: two different storage types (e.g. a
        key-value store and a dataset) racing to get-or-create the SAME
        not-yet-existing ``owner``+``name`` used to each read
        ``get_storage(f"{owner}~{name}")`` as absent BEFORE either had
        committed, so both took the unqualified-id branch and both called
        the type-blind ``ensure_storage`` with the SAME id -- only the first
        writer's row actually held its type; the second's "success" response
        carried an id that silently did not hold the type it asked for (a
        subsequent GET/write through that type's own route then 404s). That
        is invisible to a sequential caller (claiming the unqualified id for
        whichever type asks first, and a deterministic ``owner~{type}~name``
        id for every other type, is correct and is preserved below
        verbatim); it only reproduces under concurrency, because the bug is
        in the WINDOW between reading "does a row exist here yet" and
        committing one, not in the id-selection logic itself.

        The fix: run the entire read-decide-create sequence for a given
        ``owner``+``name`` under a single per-(owner, name) in-process lock
        (`_named_storage_lock`), so it is impossible for two calls to
        interleave inside that window. The first type to acquire the lock for
        a fresh ``owner``+``name`` claims the unqualified id and commits
        before releasing the lock; every other type that was waiting on the
        lock then sees that id already taken (by a different type) and moves
        to its own qualified id, still inside the same atomic section. Racing
        calls for the SAME type serialize through the same lock too (harmless
        -- `ensure_storage`'s own DB unique-constraint/rollback/read-back
        already made that case safe; the lock just makes it uncontended rather
        than relying on that fallback).

        A lock held across two DB round-trips (this method's ``get_storage``
        calls plus ``ensure_storage``'s own session) is fine here: it is an
        in-process ``asyncio.Lock``, not a DB-level lock, so it only blocks
        OTHER asyncio tasks in this same process from entering the critical
        section for the same (owner, name) -- it never blocks the event loop
        itself, and it does not hold a DB transaction open across the await.

        Two more invariants enforced here, both about the id-derivation
        scheme itself rather than the concurrency window above:

        1. ``name`` is validated (`validate_storage_name`) before anything
           else. Without this, a caller-chosen name containing ``~`` (e.g.
           ``"key-value-store~shared"``) could deterministically -- no race
           needed -- make the qualified-id scheme collide with an unrelated
           storage's literal id (that dataset's id, ``owner~key-value-
           store~shared``, IS the exact qualified id a key-value store named
           plain ``"shared"`` would compute). Rejecting ``~`` in every name
           closes that collision at the source.
        2. Even so, after re-fetching ``existing`` at the type-qualified id,
           its ``type`` is now checked against ``storage_type`` before
           declaring success (`StorageTypeCollisionError` if it disagrees).
           This is pure defence in depth -- with (1) in place it should be
           unreachable -- for pre-existing ``~``-containing data or any future
           regression of the same invariant, so this method can never again
           silently hand back an id that does not hold the type the caller
           asked for.
        """
        validate_storage_name(name)
        async with self._named_storage_lock(owner, name):
            storage_id = f"{owner}~{name}"
            existing = await self.get_storage(storage_id)
            if existing is not None and existing.type != storage_type:
                storage_id = f"{owner}~{storage_type}~{name}"
                existing = await self.get_storage(storage_id)
            if existing is not None:
                if existing.type != storage_type:
                    raise StorageTypeCollisionError(storage_id, existing.type, storage_type)
                return storage_id, existing.owner, False
            await self.ensure_storage(storage_id, storage_type, owner)
            return storage_id, owner, True

    async def check_storage_access(
        self, storage_id: str, username: str, need: str, expected_type: str | None = None
    ) -> tuple[str, StorageRow | None]:
        """Decide access for ``username`` against ``storage_id`` at ``need`` level.

        owner -> allow; a matching-or-stronger grant -> allow (WRITE satisfies
        READ); a weaker grant than needed -> forbidden (grantee can see it but may
        not act); no grant at all -> not_found (invisible). A storage id with no row
        yet -> absent, which the caller resolves by direction (a write auto-creates
        the storage owned by the writer; a read is a 404, so an unknown/invented id
        is indistinguishable from another user's).

        Returns ``(decision, storage_row)``: the row this method already read to
        make the decision, alongside the decision itself, so a caller that also
        needs the row (e.g. a metadata GET building its response body) can reuse
        it instead of issuing a second, independent read for the same id.
        ``storage_row`` is ``None`` whenever no row was found (``ACCESS_ABSENT``).
        """
        async with self.service.db.session() as s:
            storage = await s.get(StorageRow, storage_id)
            if storage is None:
                return ACCESS_ABSENT, None
            # The id exists, but not as the type this endpoint addresses -- as that
            # type it does not exist, so hide it exactly like a missing id (404).
            if expected_type is not None and storage.type != expected_type:
                return ACCESS_NOT_FOUND, storage
            if storage.owner == username:
                return ACCESS_ALLOW, storage
            grant = (
                await s.execute(
                    select(AccessRight).where(
                        AccessRight.resource_id == storage_id,
                        AccessRight.grantee == username,
                    )
                )
            ).scalar_one_or_none()
            if grant is None:
                return ACCESS_NOT_FOUND, storage
            if grant.level == LEVEL_WRITE or need == LEVEL_READ:
                return ACCESS_ALLOW, storage
            return ACCESS_FORBIDDEN, storage

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

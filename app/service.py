"""Application service: orchestrates Actors, versions, builds and runs.

Owns the metadata DB, the storage backend and the Actor driver. Builds and runs
execute asynchronously; the blocking Docker work runs in a worker thread while
status transitions are persisted to the metadata DB.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import shutil
import threading
from pathlib import Path
from typing import Any, Callable
from urllib.parse import unquote, urlsplit

from sqlalchemy import or_, select, update
from sqlalchemy.exc import IntegrityError, OperationalError

from .config import DEFAULT_USERNAME, Settings
# TERMINAL_*/STORAGE_*/short_id are re-exported from `app/constants.py` (a
# dependency-free leaf module), purely so existing `from .service import
# STORAGE_KV` etc. call sites (routers, tests) keep working unchanged now
# that `app/standby.py`/`app/storage_access.py` import them directly from
# that module -- see its docstring.
from .constants import (
    STORAGE_DS,
    STORAGE_KV,
    STORAGE_RQ,
    TERMINAL_ABORTED,
    TERMINAL_FAIL,
    TERMINAL_OK,
    TERMINAL_TIMED_OUT,
    log_stamp,
    short_id,
    storage_name_from_id,
)
from .db import AccessRight, Actor, Build, Database, Run, Storage as StorageRow, User, Version, utcnow
from .driver import Driver, extract_zip, write_source_files
from .input_schema import resolve_input_schema
from .standby import StandbyManager, _extract_uses_standby_mode, _normalize_standby_config
from .storage import Storage
# ACCESS_*/LEVEL_* are re-exported from `app/storage_access.py` (imported,
# not redefined) purely so existing `from .service import ACCESS_ALLOW` etc.
# call sites (routers, tests) keep working unchanged now that the
# storage-ownership/sharing logic itself lives there -- see that module's
# docstring.
from .storage_access import (
    ACCESS_ABSENT,
    ACCESS_ALLOW,
    ACCESS_FORBIDDEN,
    ACCESS_NOT_FOUND,
    LEVEL_READ,
    LEVEL_WRITE,
    InvalidStorageNameError,
    StorageAccessManager,
    StorageTypeCollisionError,
    validate_storage_name,
)

logger = logging.getLogger(__name__)

# Ids minted by ``start_run`` for a run's default storages. These are internal to
# their run: never auto-created by an absent-write, and never surfaced in (or
# deletable through) the standalone top-level Storages view.
_RUN_STORAGE_PREFIXES = ("kv_", "ds_", "rq_")


def _sanitize(text: str) -> str:
    return re.sub(r"[^a-z0-9_.-]+", "-", text.lower()).strip("-") or "actor"


def _parse_tarball_url(url: str) -> tuple[str, str]:
    """Extract ``(store_id, key)`` from a tarball URL's path.

    The path segment ``/key-value-stores/{store_id}/records/{key}`` is parsed
    verbatim; scheme, host and query string are ignored. The store id is used as
    given (the id the CLI was handed at store creation), never recomputed.
    """
    path = urlsplit(url).path
    match = re.search(r"/key-value-stores/([^/]+)/records/(.+)$", path)
    if match is None:
        raise ValueError(f"Cannot parse store id and record key from tarballUrl: {url!r}")
    return unquote(match.group(1)), unquote(match.group(2))


def _version_sort_key(version: Version) -> list[tuple[int, Any]]:
    """Best-effort numeric ordering of a dotted version number (so ``"1.2"``
    sorts after ``"0.9"``, unlike a plain string compare), falling back to
    the raw string per-segment for anything that doesn't parse as an int.

    Only used to break ties among versions with no other signal (see
    ``_select_schema_version``) -- good enough for a small,
    developer-authored set of version numbers, never load-bearing for
    anything else.
    """
    segments: list[tuple[int, Any]] = []
    for piece in (version.version_number or "").split("."):
        try:
            segments.append((0, int(piece)))
        except ValueError:
            segments.append((1, piece))
    return segments


def _select_schema_version(versions: list[Version]) -> Version | None:
    """Best-effort schema-version GUESS for an actor with NO successful build
    yet: the version tagged ``latest`` (its own ``buildTag``, not a build's),
    or the highest-numbered one if several share that tag, else the
    highest-numbered version overall when none carries the ``latest`` tag.

    This is only ever a fallback -- see ``Service.get_input_schema``. Once an
    actor has a successful build, that build's OWN version is the only thing
    that determines what a default (``build=latest``) run actually executes:
    ``Service.start_run`` -> ``self.latest_build()`` picks the most recently
    *started* successful ``Build`` row outright and never consults any
    version's ``buildTag``. Before a first build exists there is no such
    build to mirror, so this tag-based guess is the best available signal for
    what an eventual first run would use. Returns ``None`` only when the
    actor has no versions at all.
    """
    if not versions:
        return None
    tagged_latest = [v for v in versions if (v.build_tag or "latest") == "latest"]
    pool = tagged_latest or versions
    return max(pool, key=_version_sort_key)


class Service:
    def __init__(self, settings: Settings, db: Database, storage: Storage, driver: Driver) -> None:
        self.settings = settings
        self.db = db
        self.storage = storage
        self.driver = driver
        self._tasks: set[asyncio.Task] = set()
        # Per-job live log buffers, keyed by run/build id. The driver worker thread
        # appends chunks under the lock; the streaming log endpoint snapshots them.
        self._log_buffers: dict[str, list[str]] = {}
        self._log_lock = threading.Lock()
        # The standby-actor subsystem (warm-run state, per-actor locks, the
        # idle-reap watchdog) is a self-contained unit extracted into its own
        # module -- see app/standby.py's module docstring. Composed here
        # (rather than constructed by main.py) so every Service, including
        # the ones tests build directly without going through main.py's
        # lifespan, gets one automatically.
        self.standby = StandbyManager(self)
        # Same extraction, same reasoning, for storage ownership/sharing --
        # see app/storage_access.py's module docstring.
        self.storage_access = StorageAccessManager(self)

    def _make_log_sink(self, job_id: str) -> Callable[[str], None]:
        """Create the job's live log buffer and return a thread-safe append sink."""
        with self._log_lock:
            self._log_buffers[job_id] = []

        def sink(chunk: str) -> None:
            with self._log_lock:
                buf = self._log_buffers.get(job_id)
                if buf is not None:
                    buf.append(chunk)

        return sink

    def _discard_log_buffer(self, job_id: str) -> None:
        with self._log_lock:
            self._log_buffers.pop(job_id, None)

    def read_log_buffer(self, job_id: str) -> str | None:
        """Return the job's live log so far, or None if no live buffer exists."""
        with self._log_lock:
            buf = self._log_buffers.get(job_id)
            return None if buf is None else "".join(buf)

    def _spawn(self, coro) -> None:
        task = asyncio.create_task(coro)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def wait_idle(self) -> None:
        """Await all in-flight build/run tasks (used by tests)."""
        while self._tasks:
            await asyncio.gather(*list(self._tasks), return_exceptions=True)

    # -- users -------------------------------------------------------------
    async def ensure_default_user(self) -> None:
        """Ensure the default user exists (unclaimed, token is null; idempotent).

        ``container_token`` is minted immediately, unlike ``token`` -- it is
        never claimed by an inbound request, only ever generated locally, so
        there is nothing to wait to bind.
        """
        async with self.db.session() as s:
            if await s.get(User, DEFAULT_USERNAME) is not None:
                return
            s.add(User(username=DEFAULT_USERNAME, container_token=short_id()))
            try:
                await s.commit()
            except IntegrityError:
                await s.rollback()

    async def user_for_token(self, token: str) -> str | None:
        """Return the username whose ``token`` OR ``container_token`` equals
        ``token``, else None.

        Resolving either column is what makes a container's own injected
        ``APIFY_TOKEN`` (always ``container_token``, never the bound ``token``
        -- see ``_build_environment``) a working bearer credential against the
        runtime's own API, e.g. for an on-demand Actor's standby lookup.
        """
        async with self.db.session() as s:
            row = (
                await s.execute(
                    select(User).where(or_(User.token == token, User.container_token == token))
                )
            ).scalar_one_or_none()
            return row.username if row is not None else None

    async def container_token_for(self, username: str) -> str:
        """Return ``username``'s ``container_token``, minting one lazily if absent.

        Both known user-creation paths (``ensure_default_user``, ``create_user``)
        already mint this at insert time; the lazy mint here is a defensive
        fallback so a run can never be started with no container credential at
        all, not a path exercised in normal operation.
        """
        async with self.db.session() as s:
            user = await s.get(User, username)
            if user is not None and user.container_token:
                return user.container_token
            token = short_id()
            if user is None:
                s.add(User(username=username, container_token=token))
            else:
                user.container_token = token
            await s.commit()
            return token

    async def bind_default_token(self, token: str) -> bool:
        """Bootstrap: atomically claim the default user's credential with ``token``.

        Performed as a single conditional UPDATE
        (``... WHERE username = default AND token IS NULL``), i.e. a compare-and-swap:
        the one caller whose statement affects a row wins the bootstrap (returns
        True); any concurrent first-token caller sees zero rows affected and must
        NOT treat itself as bootstrapped (returns False), so only the winner ever
        resolves to the default user and every loser follows the normal path (an
        unknown token against a now-claimed default user is rejected). Safe under
        the existing commit/rollback pattern.
        """
        await self.ensure_default_user()
        async with self.db.session() as s:
            try:
                result = await s.execute(
                    update(User)
                    .where(User.username == DEFAULT_USERNAME, User.token.is_(None))
                    .values(token=token)
                )
                await s.commit()
            except (IntegrityError, OperationalError):
                # IntegrityError: the token became another user's credential
                # between the check and the bind. OperationalError: a residual
                # SQLite lock survived the busy timeout under heavy concurrency.
                # Either way this caller did not win the bind -> treat as a loser
                # (return False) so it 401s and can retry, never a bare 500.
                await s.rollback()
                return False
            return result.rowcount == 1

    async def get_user(self, username: str) -> User | None:
        async with self.db.session() as s:
            return await s.get(User, username)

    async def list_users(self) -> list[User]:
        async with self.db.session() as s:
            return list((await s.execute(select(User).order_by(User.created_at))).scalars())

    async def create_user(self, name: str) -> User | None:
        """Create a user whose username and token both equal ``name``.

        Returns the created user, or None if the username already exists (the
        caller renders a 409). The token-equals-name convenience applies only to
        users created here, never to the default user's bootstrap credential.
        """
        async with self.db.session() as s:
            if await s.get(User, name) is not None:
                return None
            user = User(username=name, token=name, container_token=short_id())
            s.add(user)
            try:
                await s.commit()
            except IntegrityError:
                await s.rollback()
                return None
            await s.refresh(user)
            return user

    # -- actors / versions -------------------------------------------------
    async def get_actor(self, actor_id: str, username: str | None = None) -> Actor | None:
        async with self.db.session() as s:
            actor = await s.get(Actor, actor_id)
            if actor is None or (username is not None and actor.username != username):
                return None
            return actor

    async def list_actors(self, username: str | None = None) -> list[Actor]:
        async with self.db.session() as s:
            stmt = select(Actor).order_by(Actor.created_at)
            if username is not None:
                stmt = stmt.where(Actor.username == username)
            return list((await s.execute(stmt)).scalars())

    async def create_actor(
        self,
        name: str,
        default_run_options: dict,
        versions: list[dict],
        username: str | None = None,
        actor_standby: dict | None = None,
    ) -> Actor:
        username = username or DEFAULT_USERNAME
        actor_id = f"{username}~{name}"
        # An explicit ``actorStandby`` field on THIS call always wins over
        # whatever ``.actor/actor.json`` inference the version pushes below
        # would otherwise apply (matches apify-core: "the payload from the API
        # takes precedence over actor.json").
        explicit_standby = actor_standby is not None
        async with self.db.session() as s:
            actor = await s.get(Actor, actor_id)
            if actor is None:
                actor = Actor(
                    id=actor_id,
                    name=name,
                    username=username,
                    default_run_options=default_run_options or {},
                    actor_standby=(
                        _normalize_standby_config(actor_standby, explicit=True) if explicit_standby else {}
                    ),
                )
                s.add(actor)
            elif explicit_standby:
                actor.actor_standby = _normalize_standby_config(actor_standby, explicit=True)
            for v in versions or []:
                await self._upsert_version_in_session(s, actor_id, v, infer_standby=not explicit_standby)
            await s.commit()
            return await s.get(Actor, actor_id)

    async def _upsert_version_in_session(
        self, s, actor_id: str, payload: dict, infer_standby: bool = True
    ) -> Version:
        vn = payload.get("versionNumber", "0.0")
        version = await s.get(Version, (actor_id, vn))
        if version is None:
            version = Version(actor_id=actor_id, version_number=vn)
            s.add(version)
        version.build_tag = payload.get("buildTag", version.build_tag or "latest")
        source_type = payload.get("sourceType", version.source_type or "SOURCE_FILES")
        version.source_type = source_type
        # Replace source wholesale on every create/update so a re-push in the other
        # mode can never leave the previous shape's source behind: a TARBALL push
        # clears the inline files, an inline push clears the tarball pointer.
        if source_type == "TARBALL":
            version.tarball_url = payload.get("tarballUrl")
            version.source_files = []
        else:
            version.source_files = payload.get("sourceFiles", [])
            version.tarball_url = None

        # Standby opt-in mirrors apify-core: parsed from the pushed
        # ``.actor/actor.json``'s ``usesStandbyMode``, unless this call's
        # caller already supplied an explicit ``actorStandby`` field
        # (``infer_standby=False``), which always takes precedence. Only a
        # SOURCE_FILES push carries an inspectable manifest at push time; a
        # TARBALL's manifest is inside the (not yet unzipped) archive.
        #
        # An explicit override from an EARLIER call must also survive a later,
        # plain actor.json-only push (design decision 2: "persists until the
        # next call that carries an explicit actorStandby field") -- so
        # inference is skipped entirely once the actor's persisted config
        # already carries the ``explicitlySet`` marker, regardless of what
        # THIS call's own ``infer_standby`` flag says.
        if infer_standby and source_type != "TARBALL":
            actor = await s.get(Actor, actor_id)
            if actor is not None and not (actor.actor_standby or {}).get("explicitlySet"):
                uses_standby = _extract_uses_standby_mode(version.source_files)
                if uses_standby is not None:
                    cfg = dict(actor.actor_standby or {})
                    cfg["isEnabled"] = uses_standby
                    actor.actor_standby = _normalize_standby_config(cfg)
        return version

    async def upsert_version(self, actor_id: str, payload: dict) -> Version:
        async with self.db.session() as s:
            version = await self._upsert_version_in_session(s, actor_id, payload)
            await s.commit()
            await s.refresh(version)
            return version

    async def get_version(self, actor_id: str, version_number: str) -> Version | None:
        async with self.db.session() as s:
            return await s.get(Version, (actor_id, version_number))

    async def list_versions(self, actor_id: str) -> list[Version]:
        async with self.db.session() as s:
            return list(
                (await s.execute(select(Version).where(Version.actor_id == actor_id))).scalars()
            )

    async def get_input_schema(self, actor_id: str) -> dict | None:
        """Resolve the actor's input schema for the console's Input tab (and
        for ``GET /{actor_id}/input-schema`` directly).

        Mirrors the SAME selection a default (``build=latest``) run actually
        executes, not merely the version currently tagged ``latest``:
        ``Service.start_run`` calls ``self.latest_build(actor_id)``, which
        returns the most recently *started* successful ``Build`` row --
        tag-blind, regardless of which version (if any) is tagged ``latest``
        right now. This method resolves that SAME build's version and reads
        its schema, so the schema shown always matches what actually runs --
        e.g. if v1.0 is tagged ``latest`` and built, then v2.0 is pushed
        tagged ``beta`` (not ``latest``) and built *later*, the schema shown
        is v2.0's, because v2.0's build is what ``latest_build()`` -- and
        therefore a default Start -- would run.

        Falls back to ``_select_schema_version`` (the version tagged
        ``latest``, else the highest-numbered one) only when the actor has
        no successful build yet -- there is no build to mirror before that
        point, so the tag-based guess is the best available signal for what
        an eventual first run would use.

        A ``TARBALL`` version's pushed archive isn't inspectable until a
        build unpacks it (mirrors the standby opt-in inference's own gate in
        ``_upsert_version_in_session``), so it always falls back to ``None``
        here regardless of what it contains. Fails soft to ``None`` for
        every other reason too (no versions, no manifest/schema file,
        malformed JSON) -- never raises.
        """
        build = await self.latest_build(actor_id)
        if build is not None:
            version = await self.get_version(actor_id, build.version_number)
        else:
            versions = await self.list_versions(actor_id)
            version = _select_schema_version(versions)
        if version is None or version.source_type == "TARBALL":
            return None
        return resolve_input_schema(version.source_files)

    async def latest_build(self, actor_id: str) -> Build | None:
        async with self.db.session() as s:
            rows = (
                await s.execute(
                    select(Build).where(Build.actor_id == actor_id).order_by(Build.started_at.desc())
                )
            ).scalars()
            for b in rows:
                if b.status == TERMINAL_OK:
                    return b
            return None

    async def update_actor(self, actor_id: str, payload: dict, username: str | None = None) -> Actor | None:
        """Apply an in-place update (name / defaultRunOptions) to an Actor.

        The id (``username~name``) is kept stable so existing references remain
        valid; only the mutable ``name`` and ``defaultRunOptions`` fields change.
        """
        async with self.db.session() as s:
            actor = await s.get(Actor, actor_id)
            if actor is None or (username is not None and actor.username != username):
                return None
            if payload.get("name"):
                actor.name = payload["name"]
            if "defaultRunOptions" in payload and payload["defaultRunOptions"] is not None:
                actor.default_run_options = payload["defaultRunOptions"]
            if "actorStandby" in payload and payload["actorStandby"] is not None:
                actor.actor_standby = _normalize_standby_config(payload["actorStandby"], explicit=True)
            actor.modified_at = utcnow()
            await s.commit()
            return await s.get(Actor, actor_id)

    def _container_name(self, run_id: str) -> str:
        return f"ar-run-{run_id}"

    async def reconcile_stale_jobs(self) -> None:
        """On boot, sweep Build/Run rows left RUNNING by an unclean shutdown.

        After a ``docker stop`` mid-build/run there is no live task behind the
        row, so it would otherwise stay RUNNING forever. Builds become FAILED,
        runs become ABORTED, both with a terminal ``finished_at``.
        """
        standby_container_names: list[str] = []
        async with self.db.session() as s:
            for b in (await s.execute(select(Build).where(Build.status == "RUNNING"))).scalars():
                b.status = TERMINAL_FAIL
                b.log = (b.log or "") + f"\n{log_stamp()} Build interrupted by runtime restart.\n"
                b.finished_at = utcnow()
            for r in (await s.execute(select(Run).where(Run.status == "RUNNING"))).scalars():
                r.status = TERMINAL_ABORTED
                r.finished_at = utcnow()
                if r.is_standby:
                    standby_container_names.append(self._container_name(r.id))
            await s.commit()
        # Best-effort: unlike an on-demand run() container (whose blocking
        # driver.run() call was itself killed with the crashed process), a
        # standby container is long-lived and detached, so it can easily
        # still be running after the Run row above is swept to ABORTED --
        # the in-memory standby bookkeeping that tracked it was lost with the
        # previous process, but the container name is deterministic from the
        # run id, so it can still be reaped by name alone.
        for container_name in standby_container_names:
            try:
                await asyncio.to_thread(self.driver.reap, container_name)
            except Exception:  # noqa: BLE001 - never block boot on this
                pass

    # -- builds ------------------------------------------------------------
    async def start_build(self, actor_id: str, version_number: str, build_tag: str) -> Build:
        async with self.db.session() as s:
            # NOTE: build_number is allocated as count+1 without row locking. Two
            # concurrent build triggers for the same Actor could race and produce
            # duplicate numbers; acceptable for the single-local-user threat model
            # (no concurrent pushers). Harden with SELECT ... FOR UPDATE if shared.
            actor = await s.get(Actor, actor_id)
            owner = actor.username if actor else DEFAULT_USERNAME
            count = len(
                list((await s.execute(select(Build).where(Build.actor_id == actor_id))).scalars())
            )
            build = Build(
                id=short_id(),
                actor_id=actor_id,
                username=owner,
                version_number=version_number,
                build_number=f"0.0.{count + 1}",
                build_tag=build_tag,
                status="RUNNING",
                image_tag=f"ar-{_sanitize(actor_id)}:0.0.{count + 1}",
            )
            s.add(build)
            await s.commit()
            await s.refresh(build)
        self._spawn(self._run_build(build.id))
        return build

    async def _fetch_tarball_source(self, tarball_url: str | None) -> bytes:
        """Read the pushed source zip's raw bytes from local key-value storage.

        The store id and record key are parsed from the persisted ``tarball_url``
        and read directly via ``self.storage.kv_record`` (no self-HTTP). A missing
        record or a value that is not archive bytes raises, so the build worker's
        exception handler marks the build FAILED with the error in the log.
        """
        if not tarball_url:
            raise ValueError("TARBALL version has no tarballUrl to fetch source from.")
        store_id, key = _parse_tarball_url(tarball_url)
        record = await self.storage.kv_record(store_id, key)
        if record is None:
            raise ValueError(
                f"Tarball source record not found (store {store_id!r}, key {key!r})."
            )
        value, _content_type = record
        if not isinstance(value, (bytes, bytearray)):
            raise ValueError(
                f"Tarball source is not archive bytes (store {store_id!r}, key {key!r})."
            )
        return bytes(value)

    async def _run_build(self, build_id: str) -> None:
        build_dir = self.settings.builds_dir / build_id
        try:
            async with self.db.session() as s:
                build = await s.get(Build, build_id)
                version = await s.get(Version, (build.actor_id, build.version_number))
                source_type = version.source_type if version else "SOURCE_FILES"
                source_files = version.source_files if version else []
                tarball_url = version.tarball_url if version else None
                image_tag = build.image_tag
            # Materialize whichever source shape was pushed. Synchronous prep can
            # raise (bad base64, illegal name, missing/corrupt tarball); run it
            # inside the guarded block so it transitions the build to FAILED
            # instead of leaving it stuck RUNNING. A TARBALL that resolves to no
            # usable source raises here rather than building an empty tree.
            if source_type == "TARBALL":
                zip_bytes = await self._fetch_tarball_source(tarball_url)
                await asyncio.to_thread(extract_zip, zip_bytes, build_dir)
            else:
                await asyncio.to_thread(write_source_files, source_files, build_dir)
            log_sink = self._make_log_sink(build_id)
            result = await asyncio.to_thread(self.driver.build, build_dir, image_tag, log_sink)
            async with self.db.session() as s:
                build = await s.get(Build, build_id)
                # An abort can land while `docker build` is still running (it
                # cannot be cancelled mid-flight); the abort's terminal status
                # must win, so only finalize a build that is still RUNNING and
                # otherwise just append the docker output for the record.
                aborted = build.status != "RUNNING"
                if aborted:
                    build.log = (build.log or "") + result.log
                else:
                    build.status = TERMINAL_OK if result.ok else TERMINAL_FAIL
                    build.log = result.log
                    build.finished_at = utcnow()
                await s.commit()
            if not result.ok or aborted:
                # Best-effort cleanup: drop the image of a failed build, or of
                # one that completed after being aborted (its result is unwanted).
                await asyncio.to_thread(self.driver.remove_image, image_tag)
        except Exception as exc:  # noqa: BLE001 - never leave a build stuck RUNNING
            async with self.db.session() as s:
                build = await s.get(Build, build_id)
                if build is not None and build.status == "RUNNING":
                    build.status = TERMINAL_FAIL
                    build.log = (build.log or "") + f"\n{log_stamp()} BUILD ERROR: {exc}\n"
                    build.finished_at = utcnow()
                    await s.commit()
        finally:
            self._discard_log_buffer(build_id)
            # The per-build source tree is only needed during `docker build`;
            # remove it afterwards so builds don't accumulate unbounded copies.
            await asyncio.to_thread(shutil.rmtree, build_dir, True)

    async def get_build(self, build_id: str, username: str | None = None) -> Build | None:
        async with self.db.session() as s:
            build = await s.get(Build, build_id)
            if build is None or (username is not None and build.username != username):
                return None
            return build

    async def abort_build(self, build_id: str, username: str | None = None) -> Build | None:
        """Mark a RUNNING build ABORTED; a finished build is returned unchanged.

        The underlying ``docker build`` cannot be cancelled mid-flight -- it
        runs to completion in its worker thread, but ``_run_build``'s
        finalization respects the already-terminal status and discards the
        resulting image, so the abort is what sticks.
        """
        async with self.db.session() as s:
            build = await s.get(Build, build_id)
            if build is None or (username is not None and build.username != username):
                return None
            if build.status == "RUNNING":
                build.status = TERMINAL_ABORTED
                build.log = (build.log or "") + f"\n{log_stamp()} Build aborted by user.\n"
                build.finished_at = utcnow()
                await s.commit()
            return build

    async def list_builds(self, actor_id: str, username: str | None = None) -> list[Build]:
        async with self.db.session() as s:
            stmt = select(Build).where(Build.actor_id == actor_id).order_by(Build.started_at.desc())
            if username is not None:
                stmt = stmt.where(Build.username == username)
            return list((await s.execute(stmt)).scalars())

    async def list_builds_for_user(self, username: str) -> list[Build]:
        async with self.db.session() as s:
            return list(
                (
                    await s.execute(
                        select(Build).where(Build.username == username).order_by(Build.started_at.desc())
                    )
                ).scalars()
            )

    async def tagged_builds(self, actor_id: str) -> dict[str, dict]:
        builds = await self.list_builds(actor_id)
        tagged: dict[str, dict] = {}
        for b in builds:
            if b.status == TERMINAL_OK and b.build_tag not in tagged:
                tagged[b.build_tag] = {"buildId": b.id, "buildNumber": b.build_number}
        return tagged

    # -- runs --------------------------------------------------------------
    async def start_run(self, actor_id: str, run_input: Any, options: dict) -> Run:
        build = await self.latest_build(actor_id)
        run_id = short_id()
        kv_store_id = f"kv_{run_id}"
        dataset_id = f"ds_{run_id}"
        request_queue_id = f"rq_{run_id}"
        async with self.db.session() as s:
            actor = await s.get(Actor, actor_id)
            owner = actor.username if actor else DEFAULT_USERNAME
            run = Run(
                id=run_id,
                actor_id=actor_id,
                username=owner,
                build_id=build.id if build else "",
                build_number=build.build_number if build else "0.0.0",
                status="RUNNING",
                options=options,
                run_input=run_input if isinstance(run_input, dict) else {"_raw": run_input},
                kv_store_id=kv_store_id,
                dataset_id=dataset_id,
                request_queue_id=request_queue_id,
            )
            s.add(run)
            # A run's default storages are first-class owned records: create one
            # row per storage now (synchronously, before the run task spawns) so
            # ownership and sharing are checkable independently of the run.
            s.add(StorageRow(id=kv_store_id, type=STORAGE_KV, owner=owner))
            s.add(StorageRow(id=dataset_id, type=STORAGE_DS, owner=owner))
            s.add(StorageRow(id=request_queue_id, type=STORAGE_RQ, owner=owner))
            await s.commit()
            await s.refresh(run)
        # Seed INPUT into the SQL-backed key-value store too (alongside the
        # existing disk write in `_prepare_run_storage`), synchronously before
        # the run task is even spawned -- so `GET .../records/INPUT` (what an
        # SDK Actor's `Actor.get_input()` calls) already sees it the moment the
        # run starts, not only after the run finishes and disk import runs.
        await self.storage.kv_set(
            kv_store_id, "INPUT", run_input if run_input is not None else {}, "application/json"
        )
        self._spawn(self._run_actor(run_id, build.image_tag if build else None, run_input))
        return run

    def _prepare_run_storage(self, run_id: str, run_input: Any) -> tuple[Path, str]:
        storage_dir = self.settings.runs_dir / run_id / "storage"
        kv_dir = storage_dir / "key_value_stores" / "default"
        (storage_dir / "datasets" / "default").mkdir(parents=True, exist_ok=True)
        (storage_dir / "request_queues" / "default").mkdir(parents=True, exist_ok=True)
        kv_dir.mkdir(parents=True, exist_ok=True)
        (kv_dir / "INPUT.json").write_text(json.dumps(run_input if run_input is not None else {}))
        # The runtime process is root, so these dirs are created root-owned 0755.
        # Real Apify Actor images run as a NON-root user (e.g. uid 1000), and the
        # bind mount preserves host ownership - so without this the Actor cannot
        # create files under /apify_storage and crashes on first write. Make the
        # whole per-run tree world-writable so any container user can write; the
        # runtime (root) can still read the results back for import afterwards.
        for path in (storage_dir, *storage_dir.rglob("*")):
            try:
                path.chmod(0o777 if path.is_dir() else 0o666)
            except OSError:
                pass
        # Capture the real storage root ONCE, now, before the untrusted Actor
        # container runs and could swap a subdirectory for a symlink. This is the
        # trusted anchor every imported file is later validated against.
        trusted_root = os.path.realpath(storage_dir)
        return storage_dir, trusted_root

    def _build_environment(
        self,
        *,
        owner: str,
        container_token: str,
        actor_id: str,
        run_id: str,
        kv_store_id: str,
        dataset_id: str,
        request_queue_id: str,
    ) -> dict[str, str]:
        """The env dict every Actor container gets, on-demand or standby alike.

        Mirrors the real platform: ``APIFY_IS_AT_HOME=1``, a working API
        callback URL, real storage ids, and both the legacy ``APIFY_``-prefixed
        and modern unprefixed id vars. ``APIFY_TOKEN`` is always the owner's
        fabricated ``container_token`` -- never the bound ``token`` used to
        authenticate inbound requests, which for local-user may be a real
        externally-issued secret (see requirements/test.md's anti-leak
        guarantee). ``APIFY_META_ORIGIN`` defaults to ``API`` (every local run
        arrives through the API, apify-cli included); the standby manager
        overrides it to ``STANDBY`` -- the platform-documented signal an Actor
        uses to detect standby mode.
        """
        return {
            "APIFY_IS_AT_HOME": "1",
            "APIFY_META_ORIGIN": "API",
            "APIFY_API_BASE_URL": self.settings.container_api_base_url,
            "APIFY_TOKEN": container_token,
            "APIFY_USER_ID": owner,
            "APIFY_ACTOR_ID": actor_id,
            "ACTOR_ID": actor_id,
            "APIFY_ACTOR_RUN_ID": run_id,
            "ACTOR_RUN_ID": run_id,
            "APIFY_DEFAULT_KEY_VALUE_STORE_ID": kv_store_id,
            "APIFY_DEFAULT_DATASET_ID": dataset_id,
            "APIFY_DEFAULT_REQUEST_QUEUE_ID": request_queue_id,
            "APIFY_INPUT_KEY": "INPUT",
            "CRAWLEE_STORAGE_DIR": "/apify_storage",
            "APIFY_LOCAL_STORAGE_DIR": "/apify_storage",
            "ACTOR_STORAGE_DIR": "/apify_storage",
        }

    async def _run_actor(self, run_id: str, image_tag: str | None, run_input: Any) -> None:
        # The whole body runs inside a guarded block: any unexpected error (bad
        # options JSON, transient DB read, storage prep failure) transitions the
        # run to a terminal FAILED state instead of leaving the row stuck RUNNING.
        try:
            storage_dir, trusted_root = await asyncio.to_thread(
                self._prepare_run_storage, run_id, run_input
            )
            host_storage_dir = str(self.settings.host_runs_dir / run_id / "storage")

            async with self.db.session() as s:
                run = await s.get(Run, run_id)
                timeout_secs = int(run.options.get("timeoutSecs") or 300) or 300
                mem_limit_mb = int(run.options.get("memoryMbytes") or 0) or None
                actor_id = run.actor_id
                owner = run.username or DEFAULT_USERNAME
                kv_store_id, dataset_id, request_queue_id = (
                    run.kv_store_id, run.dataset_id, run.request_queue_id,
                )

            if not image_tag:
                await self._finish_run(
                    run_id, exit_code=1, log=f"{log_stamp()} No successful build available to run.\n"
                )
                return

            container_token = await self.container_token_for(owner)
            environment = self._build_environment(
                owner=owner,
                container_token=container_token,
                actor_id=actor_id,
                run_id=run_id,
                kv_store_id=kv_store_id,
                dataset_id=dataset_id,
                request_queue_id=request_queue_id,
            )
            log_sink = self._make_log_sink(run_id)
            try:
                result = await asyncio.to_thread(
                    self.driver.run,
                    image_tag,
                    host_storage_dir,
                    environment,
                    timeout_secs,
                    self._container_name(run_id),
                    mem_limit_mb,
                    log_sink,
                )
            except Exception as exc:  # noqa: BLE001
                await self._finish_run(run_id, exit_code=1, log=f"{log_stamp()} RUN ERROR: {exc}\n")
                return

            # Import whatever the Actor wrote into the runtime's SQL storage.
            run = await self.get_run(run_id)
            try:
                await self.storage.import_run_storage(
                    storage_dir,
                    run.kv_store_id,
                    run.dataset_id,
                    run.request_queue_id,
                    trusted_root=trusted_root,
                )
            except Exception as exc:  # noqa: BLE001
                result.log += f"\n{log_stamp()} STORAGE IMPORT ERROR: {exc}\n"
            status = TERMINAL_TIMED_OUT if result.timed_out else None
            await self._finish_run(
                run_id, exit_code=result.exit_code, log=result.log, status=status
            )
        except Exception as exc:  # noqa: BLE001 - never leave a run stuck RUNNING
            await self._finish_run(run_id, exit_code=1, log=f"{log_stamp()} RUN ERROR: {exc}\n")

    async def _finish_run(
        self, run_id: str, exit_code: int, log: str, status: str | None = None
    ) -> None:
        try:
            async with self.db.session() as s:
                run = await s.get(Run, run_id)
                # Only transition from RUNNING. A terminal status set out-of-band
                # (e.g. ABORTED via abort_run) must not be clobbered by the natural
                # finish path once the container exits.
                if run is None or run.status != "RUNNING":
                    return
                run.exit_code = exit_code
                if status is not None:
                    run.status = status
                else:
                    run.status = TERMINAL_OK if exit_code == 0 else TERMINAL_FAIL
                run.log = log
                run.finished_at = utcnow()
                await s.commit()
        finally:
            self._discard_log_buffer(run_id)

    async def get_run(self, run_id: str, username: str | None = None) -> Run | None:
        async with self.db.session() as s:
            run = await s.get(Run, run_id)
            if run is None or (username is not None and run.username != username):
                return None
            return run

    async def list_runs(self, actor_id: str, username: str | None = None) -> list[Run]:
        async with self.db.session() as s:
            stmt = select(Run).where(Run.actor_id == actor_id).order_by(Run.started_at.desc())
            if username is not None:
                stmt = stmt.where(Run.username == username)
            return list((await s.execute(stmt)).scalars())

    async def list_runs_for_user(self, username: str) -> list[Run]:
        async with self.db.session() as s:
            return list(
                (
                    await s.execute(
                        select(Run).where(Run.username == username).order_by(Run.started_at.desc())
                    )
                ).scalars()
            )

    async def abort_run(self, run_id: str, username: str | None = None) -> Run | None:
        # A quick, unlocked peek: only used to learn whether this run is a
        # standby run (and its actor_id), so we know whether the per-actor
        # standby lock below is needed at all -- ordinary runs are unaffected
        # and still need no lock. Both fields are fixed for a run's whole
        # lifetime, so this early, separate read can never itself go stale.
        async with self.db.session() as s:
            probe = await s.get(Run, run_id)
            if probe is None or (username is not None and probe.username != username):
                return None
            is_standby, actor_id = probe.is_standby, probe.actor_id

        if is_standby:
            # Acquire the SAME per-actor lock `ensure_standby_run()` /
            # `reap_idle_standby_runs()` use BEFORE the status check-and-commit
            # below (not just around the teardown, as before this fix) --
            # otherwise this method's ABORTED commit and a concurrent
            # `ensure_standby_run()` readiness-timeout's own terminal-status
            # commit (via `_finish_run`) could each act on a stale "still
            # RUNNING" snapshot without ever seeing each other, so whichever
            # terminal status (ABORTED vs FAILED) ended up stuck depended on
            # scheduling alone rather than which happened first. Holding the
            # lock across the whole check-and-commit makes the two mutually
            # exclusive: whichever happens first commits, and the loser's own
            # already-terminal check (`was_running` below, or `_finish_run`'s
            # `status != "RUNNING"` guard) then reliably sees the winner's
            # committed status and no-ops instead of racing it.
            lock = self.standby.actor_lock(actor_id)
            async with lock:
                return await self._abort_run_locked(run_id, username)
        return await self._abort_run_locked(run_id, username)

    async def _abort_run_locked(self, run_id: str, username: str | None) -> Run | None:
        """The status check-and-commit plus teardown for ``abort_run``.

        Called by ``abort_run`` above, either under the per-actor standby
        lock (standby runs) or lock-free (ordinary runs).
        """
        async with self.db.session() as s:
            run = await s.get(Run, run_id)
            if run is None or (username is not None and run.username != username):
                return None
            was_running = run.status == "RUNNING"
            is_standby = run.is_standby
            if was_running:
                run.status = TERMINAL_ABORTED
                run.finished_at = utcnow()
                await s.commit()
                await s.refresh(run)
        if was_running:
            if is_standby:
                # A standby run has no in-flight `driver.run()` call whose
                # `finally` removes the container, so it needs the full
                # kill+remove reap; its warm-run bookkeeping must also be
                # dropped so the next standbyUrl request starts a fresh
                # container instead of forwarding into this now-dead one.
                # (The per-actor lock guarding this whole method -- see
                # `abort_run` -- also still serializes this bookkeeping
                # update against a concurrent `ensure_standby_run()`/
                # `reap_idle_standby_runs()` exactly as before this fix.)
                # See app/standby.py::StandbyManager.teardown_aborted_run for
                # the actual container/storage teardown (shared with the
                # idle-reap path via `_teardown_container`).
                await self.standby.teardown_aborted_run(run)
            else:
                # Actually stop the container so it stops consuming resources; the
                # in-flight task's _finish_run is now a no-op (status != RUNNING), so
                # the ABORTED state set above survives the container's natural exit.
                try:
                    await asyncio.to_thread(self.driver.stop, self._container_name(run_id))
                except Exception:  # noqa: BLE001 - best effort
                    pass
        return run

    # -- standby -------------------------------------------------------------
    # The standby-actor subsystem (warm-run lifecycle, idle-reap watchdog,
    # opt-in config parsing, the standby half of abort) lives in
    # `app/standby.py`'s `StandbyManager` (`self.standby`, constructed in
    # `__init__` above) -- see that module's docstring for why it was split
    # out. These thin delegators are kept on `Service` so `main.py`, the
    # standby router and existing tests keep reaching standby behavior
    # through the same `Service` object as everything else, with no caller
    # needing to know a `StandbyManager` exists at all.
    async def ensure_standby_run(self, actor_id: str) -> str | None:
        return await self.standby.ensure_standby_run(actor_id)

    def mark_standby_request_started(self, actor_id: str) -> None:
        self.standby.mark_standby_request_started(actor_id)

    def mark_standby_request_finished(self, actor_id: str) -> None:
        self.standby.mark_standby_request_finished(actor_id)

    async def reap_idle_standby_runs(self) -> None:
        await self.standby.reap_idle_standby_runs()

    def start_standby_watchdog(self, interval_secs: float = 0.5) -> None:
        self.standby.start_standby_watchdog(interval_secs)

    async def stop_standby_watchdog(self) -> None:
        await self.standby.stop_standby_watchdog()

    # -- storage ownership & sharing --------------------------------------
    # Owner/grant-based access decisions and sharing live in
    # `app/storage_access.py`'s `StorageAccessManager` (`self.storage_access`,
    # constructed in `__init__` above) -- see that module's docstring. Thin
    # delegators, same rationale as the "-- standby --" section above.
    async def get_storage(self, storage_id: str) -> StorageRow | None:
        return await self.storage_access.get_storage(storage_id)

    async def ensure_storage(self, storage_id: str, storage_type: str, owner: str) -> str:
        return await self.storage_access.ensure_storage(storage_id, storage_type, owner)

    async def get_or_create_named_storage(self, name: str, storage_type: str, owner: str) -> tuple[str, str, bool]:
        return await self.storage_access.get_or_create_named_storage(name, storage_type, owner)

    async def check_storage_access(
        self, storage_id: str, username: str, need: str, expected_type: str | None = None
    ) -> tuple[str, StorageRow | None]:
        return await self.storage_access.check_storage_access(storage_id, username, need, expected_type)

    async def grant_access(self, storage_id: str, resource_type: str, grantee: str, level: str) -> None:
        await self.storage_access.grant_access(storage_id, resource_type, grantee, level)

    async def list_access(self, storage_id: str) -> list[AccessRight]:
        return await self.storage_access.list_access(storage_id)

    async def revoke_access(self, storage_id: str, grantee: str) -> bool:
        return await self.storage_access.revoke_access(storage_id, grantee)

    async def list_storages_for_user(self, username: str, type: str | None = None) -> list[StorageRow]:
        return await self.storage_access.list_storages_for_user(username, type)

    async def delete_storage(self, storage_id: str, username: str) -> str:
        return await self.storage_access.delete_storage(storage_id, username)

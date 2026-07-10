"""Application service: orchestrates Actors, versions, builds and runs.

Owns the metadata DB, the storage backend and the Actor driver. Builds and runs
execute asynchronously; the blocking Docker work runs in a worker thread while
status transitions are persisted to the metadata DB.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import uuid
from pathlib import Path
from typing import Any

from sqlalchemy import select

from .config import Settings
from .db import Actor, Build, Database, Run, Version, utcnow
from .driver import Driver, write_source_files
from .storage import Storage

TERMINAL_OK = "SUCCEEDED"
TERMINAL_FAIL = "FAILED"
TERMINAL_ABORTED = "ABORTED"
TERMINAL_TIMED_OUT = "TIMED-OUT"


def _sanitize(text: str) -> str:
    return re.sub(r"[^a-z0-9_.-]+", "-", text.lower()).strip("-") or "actor"


def short_id() -> str:
    return uuid.uuid4().hex[:17]


class Service:
    def __init__(self, settings: Settings, db: Database, storage: Storage, driver: Driver) -> None:
        self.settings = settings
        self.db = db
        self.storage = storage
        self.driver = driver
        self._tasks: set[asyncio.Task] = set()

    def _spawn(self, coro) -> None:
        task = asyncio.create_task(coro)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def wait_idle(self) -> None:
        """Await all in-flight build/run tasks (used by tests)."""
        while self._tasks:
            await asyncio.gather(*list(self._tasks), return_exceptions=True)

    # -- actors / versions -------------------------------------------------
    def _username(self) -> str:
        from .config import USERNAME

        return USERNAME

    async def get_actor(self, actor_id: str) -> Actor | None:
        async with self.db.session() as s:
            return await s.get(Actor, actor_id)

    async def list_actors(self) -> list[Actor]:
        async with self.db.session() as s:
            return list((await s.execute(select(Actor).order_by(Actor.created_at))).scalars())

    async def create_actor(self, name: str, default_run_options: dict, versions: list[dict]) -> Actor:
        actor_id = f"{self._username()}~{name}"
        async with self.db.session() as s:
            actor = await s.get(Actor, actor_id)
            if actor is None:
                actor = Actor(
                    id=actor_id,
                    name=name,
                    username=self._username(),
                    default_run_options=default_run_options or {},
                )
                s.add(actor)
            for v in versions or []:
                await self._upsert_version_in_session(s, actor_id, v)
            await s.commit()
            return await s.get(Actor, actor_id)

    async def _upsert_version_in_session(self, s, actor_id: str, payload: dict) -> Version:
        vn = payload.get("versionNumber", "0.0")
        version = await s.get(Version, (actor_id, vn))
        if version is None:
            version = Version(actor_id=actor_id, version_number=vn)
            s.add(version)
        version.build_tag = payload.get("buildTag", version.build_tag or "latest")
        version.source_type = payload.get("sourceType", version.source_type or "SOURCE_FILES")
        if "sourceFiles" in payload:
            version.source_files = payload["sourceFiles"]
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

    async def update_actor(self, actor_id: str, payload: dict) -> Actor | None:
        """Apply an in-place update (name / defaultRunOptions) to an Actor.

        The id (``username~name``) is kept stable so existing references remain
        valid; only the mutable ``name`` and ``defaultRunOptions`` fields change.
        """
        async with self.db.session() as s:
            actor = await s.get(Actor, actor_id)
            if actor is None:
                return None
            if payload.get("name"):
                actor.name = payload["name"]
            if "defaultRunOptions" in payload and payload["defaultRunOptions"] is not None:
                actor.default_run_options = payload["defaultRunOptions"]
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
        async with self.db.session() as s:
            for b in (await s.execute(select(Build).where(Build.status == "RUNNING"))).scalars():
                b.status = TERMINAL_FAIL
                b.log = (b.log or "") + "\nBuild interrupted by runtime restart.\n"
                b.finished_at = utcnow()
            for r in (await s.execute(select(Run).where(Run.status == "RUNNING"))).scalars():
                r.status = TERMINAL_ABORTED
                r.finished_at = utcnow()
            await s.commit()

    # -- builds ------------------------------------------------------------
    async def start_build(self, actor_id: str, version_number: str, build_tag: str) -> Build:
        async with self.db.session() as s:
            # NOTE: build_number is allocated as count+1 without row locking. Two
            # concurrent build triggers for the same Actor could race and produce
            # duplicate numbers; acceptable for the single-local-user threat model
            # (no concurrent pushers). Harden with SELECT ... FOR UPDATE if shared.
            count = len(
                list((await s.execute(select(Build).where(Build.actor_id == actor_id))).scalars())
            )
            build = Build(
                id=short_id(),
                actor_id=actor_id,
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

    async def _run_build(self, build_id: str) -> None:
        build_dir = self.settings.builds_dir / build_id
        try:
            async with self.db.session() as s:
                build = await s.get(Build, build_id)
                version = await s.get(Version, (build.actor_id, build.version_number))
                source_files = version.source_files if version else []
                image_tag = build.image_tag
            # Synchronous prep can raise (bad base64, disk full, illegal name);
            # run it inside the guarded block so it transitions the build to
            # FAILED instead of leaving it stuck RUNNING.
            await asyncio.to_thread(write_source_files, source_files, build_dir)
            result = await asyncio.to_thread(self.driver.build, build_dir, image_tag)
            async with self.db.session() as s:
                build = await s.get(Build, build_id)
                build.status = TERMINAL_OK if result.ok else TERMINAL_FAIL
                build.log = result.log
                build.finished_at = utcnow()
                await s.commit()
            if not result.ok:
                # Best-effort cleanup: drop any dangling image tag from a failed build.
                await asyncio.to_thread(self.driver.remove_image, image_tag)
        except Exception as exc:  # noqa: BLE001 - never leave a build stuck RUNNING
            async with self.db.session() as s:
                build = await s.get(Build, build_id)
                if build is not None and build.status == "RUNNING":
                    build.status = TERMINAL_FAIL
                    build.log = (build.log or "") + f"\nBUILD ERROR: {exc}\n"
                    build.finished_at = utcnow()
                    await s.commit()
        finally:
            # The per-build source tree is only needed during `docker build`;
            # remove it afterwards so builds don't accumulate unbounded copies.
            await asyncio.to_thread(shutil.rmtree, build_dir, True)

    async def get_build(self, build_id: str) -> Build | None:
        async with self.db.session() as s:
            return await s.get(Build, build_id)

    async def list_builds(self, actor_id: str) -> list[Build]:
        async with self.db.session() as s:
            return list(
                (
                    await s.execute(
                        select(Build).where(Build.actor_id == actor_id).order_by(Build.started_at.desc())
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
        run = Run(
            id=run_id,
            actor_id=actor_id,
            build_id=build.id if build else "",
            build_number=build.build_number if build else "0.0.0",
            status="RUNNING",
            options=options,
            run_input=run_input if isinstance(run_input, dict) else {"_raw": run_input},
            kv_store_id=f"kv_{run_id}",
            dataset_id=f"ds_{run_id}",
            request_queue_id=f"rq_{run_id}",
        )
        async with self.db.session() as s:
            s.add(run)
            await s.commit()
            await s.refresh(run)
        self._spawn(self._run_actor(run_id, build.image_tag if build else None, run_input))
        return run

    def _prepare_run_storage(self, run_id: str, run_input: Any) -> tuple[Path, str]:
        storage_dir = self.settings.runs_dir / run_id / "storage"
        kv_dir = storage_dir / "key_value_stores" / "default"
        (storage_dir / "datasets" / "default").mkdir(parents=True, exist_ok=True)
        (storage_dir / "request_queues" / "default").mkdir(parents=True, exist_ok=True)
        kv_dir.mkdir(parents=True, exist_ok=True)
        (kv_dir / "INPUT.json").write_text(json.dumps(run_input if run_input is not None else {}))
        # Capture the real storage root ONCE, now, before the untrusted Actor
        # container runs and could swap a subdirectory for a symlink. This is the
        # trusted anchor every imported file is later validated against.
        trusted_root = os.path.realpath(storage_dir)
        return storage_dir, trusted_root

    async def _run_actor(self, run_id: str, image_tag: str | None, run_input: Any) -> None:
        from .config import USER_ID

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

            if not image_tag:
                await self._finish_run(
                    run_id, exit_code=1, log="No successful build available to run.\n"
                )
                return

            environment = {
                "APIFY_IS_AT_HOME": "0",
                "APIFY_TOKEN": "local-runtime-token",
                "APIFY_USER_ID": USER_ID,
                "APIFY_ACTOR_ID": actor_id,
                "APIFY_ACTOR_RUN_ID": run_id,
                "APIFY_DEFAULT_KEY_VALUE_STORE_ID": "default",
                "APIFY_DEFAULT_DATASET_ID": "default",
                "APIFY_DEFAULT_REQUEST_QUEUE_ID": "default",
                "APIFY_INPUT_KEY": "INPUT",
                "CRAWLEE_STORAGE_DIR": "/apify_storage",
                "APIFY_LOCAL_STORAGE_DIR": "/apify_storage",
                "ACTOR_STORAGE_DIR": "/apify_storage",
            }
            try:
                result = await asyncio.to_thread(
                    self.driver.run,
                    image_tag,
                    host_storage_dir,
                    environment,
                    timeout_secs,
                    self._container_name(run_id),
                    mem_limit_mb,
                )
            except Exception as exc:  # noqa: BLE001
                await self._finish_run(run_id, exit_code=1, log=f"RUN ERROR: {exc}\n")
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
                result.log += f"\nSTORAGE IMPORT ERROR: {exc}\n"
            status = TERMINAL_TIMED_OUT if result.timed_out else None
            await self._finish_run(
                run_id, exit_code=result.exit_code, log=result.log, status=status
            )
        except Exception as exc:  # noqa: BLE001 - never leave a run stuck RUNNING
            await self._finish_run(run_id, exit_code=1, log=f"RUN ERROR: {exc}\n")

    async def _finish_run(
        self, run_id: str, exit_code: int, log: str, status: str | None = None
    ) -> None:
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

    async def get_run(self, run_id: str) -> Run | None:
        async with self.db.session() as s:
            return await s.get(Run, run_id)

    async def list_runs(self, actor_id: str) -> list[Run]:
        async with self.db.session() as s:
            return list(
                (
                    await s.execute(
                        select(Run).where(Run.actor_id == actor_id).order_by(Run.started_at.desc())
                    )
                ).scalars()
            )

    async def abort_run(self, run_id: str) -> Run | None:
        async with self.db.session() as s:
            run = await s.get(Run, run_id)
            if run is None:
                return None
            was_running = run.status == "RUNNING"
            if was_running:
                run.status = TERMINAL_ABORTED
                run.finished_at = utcnow()
                await s.commit()
                await s.refresh(run)
        if was_running:
            # Actually stop the container so it stops consuming resources; the
            # in-flight task's _finish_run is now a no-op (status != RUNNING), so
            # the ABORTED state set above survives the container's natural exit.
            try:
                await asyncio.to_thread(self.driver.stop, self._container_name(run_id))
            except Exception:  # noqa: BLE001 - best effort
                pass
        return run

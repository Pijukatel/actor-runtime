"""Standby-actor subsystem: warm-run lifecycle, idle-reap watchdog, and the
``.actor/actor.json`` opt-in config parsing.

Extracted out of ``app/service.py`` (which grew past a 1000-line
maintainability ceiling once standby support landed) so that file's other
responsibilities -- users/actors/versions/builds/on-demand runs/storage
ownership -- stay readable on their own. Standby is a genuinely self-contained
subsystem: its own in-memory state (one warm run per actor, a per-actor lock
map, the background reap-watchdog task) and its own exceptions, coupled to the
rest of the app only through the ``Service`` instance a ``StandbyManager`` is
constructed with -- db/storage/driver/settings and a handful of its helper
methods (``get_run``, ``_finish_run``, ``_prepare_run_storage``,
``_build_environment``, ``container_token_for``, ``tagged_builds``,
``latest_build``, ``get_build``, ``_container_name``), all reached via
``self.service``.

``Service`` builds one ``StandbyManager`` in its own ``__init__`` (composition,
not inheritance) and keeps a thin delegation surface -- see the "-- standby --"
section of ``app/service.py`` -- so ``main.py``, the standby router and
existing tests keep going through the same ``Service`` object exactly as
before; only this module needs to know a ``StandbyManager`` exists at all.
"""
from __future__ import annotations

import asyncio
import base64
import contextlib
import json
import logging
import time
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

import httpx

from .config import (
    ACTOR_STANDBY_PORT,
    STANDBY_IDLE_TIMEOUT_DEFAULT_SECS,
    STANDBY_IDLE_TIMEOUT_MIN_SECS,
)
from .constants import STORAGE_DS, STORAGE_KV, STORAGE_RQ, TERMINAL_ABORTED, short_id
from .db import Actor, Run, Storage as StorageRow

if TYPE_CHECKING:
    # Type-only: importing ``Service`` for real would re-create the exact
    # circular import (``service`` <-> ``standby``) this split is meant to
    # avoid. ``from __future__ import annotations`` (above) means this
    # annotation is never evaluated at runtime, so the cycle never actually
    # forms.
    from .service import Service

logger = logging.getLogger(__name__)

# How often ensure_standby_run() polls a freshly-started container's readiness
# probe endpoint (see StandbyManager._wait_standby_ready).
STANDBY_READY_POLL_SECS = 0.1


class StandbyReadinessTimeout(Exception):
    """A started standby container never answered the readiness probe in time."""

    def __init__(self, actor_id: str) -> None:
        super().__init__(f"Standby Actor {actor_id!r} never became ready.")


class StandbyStartError(Exception):
    """A standby container failed to start for an infrastructure/driver reason.

    Deliberately distinct from ``ensure_standby_run`` returning ``None`` (which
    means "the Actor has no successful build") -- e.g. ``DockerDriver.start()``
    raising because the shared Docker network never came up at boot. The build
    exists and is fine; the run failed for an unrelated reason. Kept as its own
    exception (rather than reusing the return-None sentinel) so the router can
    report a 5xx with the real cause instead of the misleading "no successful
    build" 404 both cases previously shared.
    """

    def __init__(self, actor_id: str, detail: str) -> None:
        super().__init__(f"Standby Actor {actor_id!r} failed to start: {detail}")


def _extract_uses_standby_mode(source_files: list[dict]) -> bool | None:
    """Return ``.actor/actor.json``'s ``usesStandbyMode`` from pushed inline
    source files, or ``None`` if there is no signal (no manifest present, or it
    fails to parse) -- callers must leave the existing config alone in that
    case, never treat "can't read it" as "opted out".
    """
    for entry in source_files or []:
        if entry.get("name") != ".actor/actor.json":
            continue
        content = entry.get("content", "")
        if entry.get("format") == "BASE64":
            try:
                content = base64.b64decode(content).decode("utf-8")
            except Exception:  # noqa: BLE001 - unreadable manifest -> no signal
                return None
        try:
            manifest = json.loads(content)
        except (json.JSONDecodeError, TypeError):
            return None
        if not isinstance(manifest, dict):
            return None
        value = manifest.get("usesStandbyMode")
        return value if isinstance(value, bool) else None
    return None


def _normalize_standby_config(cfg: dict | None, *, explicit: bool | None = None) -> dict:
    """Fill in the apify-core-mirrored defaults for any field the caller omitted.

    ``explicit`` records provenance: pass ``True`` when ``cfg`` comes from an
    explicit API ``actorStandby`` field on this call (stamps the persistent
    ``explicitlySet`` marker), leave it ``None`` when merely (re)normalizing an
    already-stored config (e.g. from ``.actor/actor.json`` inference), which
    preserves whatever ``explicitlySet`` value -- if any -- was already there.
    Callers MUST check that marker before letting actor.json inference
    overwrite ``isEnabled`` (design decision 2: an explicit override persists
    until the next call that itself carries an explicit field -- see
    ``Service._upsert_version_in_session``).
    """
    cfg = dict(cfg or {})
    cfg.setdefault("isEnabled", False)
    cfg.setdefault("idleTimeoutSecs", STANDBY_IDLE_TIMEOUT_DEFAULT_SECS)
    cfg.setdefault("build", None)
    cfg.setdefault("memoryMbytes", None)
    cfg.setdefault("shouldPassActorInput", False)
    if explicit is not None:
        cfg["explicitlySet"] = explicit
    else:
        cfg.setdefault("explicitlySet", False)
    return cfg


@dataclass
class StandbyRun:
    """Bookkeeping for one actor's currently-warm standby run.

    A mutable dataclass (not frozen): ``last_request`` and ``in_flight`` are
    updated in place by ``mark_standby_request_started/finished`` for the
    lifetime of the entry. Replaces a former untyped ``dict[str, Any]`` bag
    (eight keys accessed positionally-by-string, with defensive
    ``entry.get("in_flight", 0)`` reads because the shape wasn't guaranteed by
    a type) -- every field here is guaranteed to exist and be the given type,
    so callers read the attributes directly with no fallback needed.
    """

    run_id: str
    container_name: str
    endpoint: str
    last_request: float
    idle_timeout: float
    storage_dir: Path
    trusted_root: str
    # Count of forwarded requests currently being served by this container
    # (see mark_standby_request_started/_finished). A positive count means
    # "busy right now", which reap_idle_standby_runs() treats as non-idle
    # regardless of how stale last_request looks -- this is what lets a single
    # long-lived/streamed response (success criterion 7) outlive
    # idleTimeoutSecs without being torn down mid-flight.
    in_flight: int = 0


class StandbyManager:
    """At most one warm run per standby actor: start-if-absent, readiness
    wait, idle-reap watchdog, and the standby-specific half of aborting a run.

    Constructed once by ``Service.__init__`` (``self.standby = StandbyManager(self)``);
    reaches everything it needs -- db, storage, driver, settings, and a
    handful of ``Service`` helper methods -- through ``self.service``.
    """

    def __init__(self, service: "Service") -> None:
        self.service = service
        # At most one warm standby run per actor: actor_id -> StandbyRun.
        # Purely in-memory -- a restart loses this bookkeeping, but
        # reconcile_stale_jobs() has already swept the underlying Run row to a
        # terminal state, so the next request simply starts fresh.
        self.runs: dict[str, StandbyRun] = {}
        # Per-actor locks so concurrent first-callers for the same not-yet-warm
        # actor serialize instead of racing to start two containers.
        self.locks: dict[str, asyncio.Lock] = {}
        self.watchdog_task: asyncio.Task | None = None

    def actor_lock(self, actor_id: str) -> asyncio.Lock:
        """The per-actor lock serializing standby start/reap/abort for ``actor_id``.

        Creates it on first use. Exposed so ``Service.abort_run`` can
        serialize on the SAME lock this class uses internally without
        reaching into ``self.locks`` directly.
        """
        return self.locks.setdefault(actor_id, asyncio.Lock())

    def _idle_timeout_secs(self, standby_cfg: dict) -> float:
        """Resolve the idle timeout to enforce for a standby run.

        The ``Settings``/env override (see ``config.load_settings``) always
        wins when set -- deliberately bypassing even the platform-mirrored 5s
        floor below, so tests can reap in a fraction of a second. Otherwise
        the per-actor config applies, clamped to the platform's minimum.
        """
        settings = self.service.settings
        if settings.standby_idle_override_secs is not None:
            return max(settings.standby_idle_override_secs, 0)
        value = int(standby_cfg.get("idleTimeoutSecs") or STANDBY_IDLE_TIMEOUT_DEFAULT_SECS)
        return max(value, STANDBY_IDLE_TIMEOUT_MIN_SECS)

    async def _wait_standby_ready(self, endpoint: str) -> bool:
        """Poll ``endpoint`` with the readiness-probe header until it answers
        200, or ``settings.standby_ready_timeout_secs`` elapses (returns False).
        """
        deadline = time.monotonic() + self.service.settings.standby_ready_timeout_secs
        async with httpx.AsyncClient() as client:
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return False
                try:
                    resp = await client.get(
                        endpoint + "/",
                        headers={"x-apify-container-server-readiness-probe": "1"},
                        # Bound each attempt by whatever's left of the overall
                        # readiness budget (capped at 5s) rather than a fixed
                        # 5.0s -- otherwise a container that accepts the TCP
                        # connection but hangs before answering could make a
                        # single attempt block up to 5 real seconds regardless
                        # of a shrunk `standby_ready_timeout_secs` (e.g. tests'
                        # 1.0s), so the configured value would not be a true
                        # upper bound on the total wait.
                        timeout=min(5.0, remaining),
                    )
                    if resp.status_code == 200:
                        return True
                except httpx.HTTPError:
                    pass
                await asyncio.sleep(STANDBY_READY_POLL_SECS)

    async def ensure_standby_run(self, actor_id: str) -> str | None:
        """Return the actor's warm standby endpoint, lazily starting one.

        At most one warm run exists per actor at a time. Concurrent first
        callers for the same not-yet-warm actor serialize on a per-actor lock:
        the first starts the container and waits for readiness; the rest reuse
        whatever it produced. Returns ``None`` if the actor has no successful
        build to run. Raises ``StandbyReadinessTimeout`` if a newly-started
        container never answers the readiness probe.
        """
        svc = self.service
        lock = self.locks.setdefault(actor_id, asyncio.Lock())
        async with lock:
            entry = self.runs.get(actor_id)
            if entry is not None:
                # Confirm the tracked run is still actually alive server-side
                # (e.g. not aborted out-of-band) before reusing it.
                run = await svc.get_run(entry.run_id)
                if run is not None and run.status == "RUNNING":
                    entry.last_request = time.monotonic()
                    return entry.endpoint
                self.runs.pop(actor_id, None)

            async with svc.db.session() as s:
                actor = await s.get(Actor, actor_id)
                if actor is None:
                    return None
                owner = actor.username
                standby_cfg = _normalize_standby_config(actor.actor_standby)

            build_tag = standby_cfg.get("build") or "latest"
            tagged = await svc.tagged_builds(actor_id)
            build_info = tagged.get(build_tag)
            build = (
                await svc.get_build(build_info["buildId"]) if build_info else await svc.latest_build(actor_id)
            )
            if build is None:
                return None

            run_id = short_id()
            kv_store_id, dataset_id, request_queue_id = f"kv_{run_id}", f"ds_{run_id}", f"rq_{run_id}"
            # Resolved ONCE and reused for both the persisted run options AND
            # the actual container's memory cap below. Previously these
            # diverged: the persisted `run.options.memoryMbytes` always said
            # 1024 when unset, while the raw (possibly ``None``) value was
            # passed to ``driver.start`` -- so an unset standby memory config
            # ran the (long-lived, no-timeout) container with NO memory cap
            # at all despite the API reporting one.
            mem_limit_mb = int(standby_cfg.get("memoryMbytes") or 0) or 1024
            # Forced options mirror apify-core: standby config always takes
            # precedence over caller-provided run options, and the run has no
            # wall-clock timeout (the idle watchdog supersedes it).
            forced_options = {
                "build": build_tag,
                "timeoutSecs": 0,
                "memoryMbytes": mem_limit_mb,
            }
            # NOTE (documented skip): `shouldPassActorInput` has nothing to
            # gate here. On the real platform it decides whether the caller's
            # HTTP request body is also exposed as the Actor's `INPUT` record;
            # this runtime's standby containers never receive per-start input
            # in the first place (there is no "start a standby run" API call,
            # only the forwarded HTTP requests), so INPUT is always empty.
            run_input: dict = {}

            async with svc.db.session() as s:
                run = Run(
                    id=run_id,
                    actor_id=actor_id,
                    username=owner,
                    build_id=build.id,
                    build_number=build.build_number,
                    status="RUNNING",
                    options=forced_options,
                    run_input=run_input,
                    kv_store_id=kv_store_id,
                    dataset_id=dataset_id,
                    request_queue_id=request_queue_id,
                    is_standby=True,
                )
                s.add(run)
                s.add(StorageRow(id=kv_store_id, type=STORAGE_KV, owner=owner))
                s.add(StorageRow(id=dataset_id, type=STORAGE_DS, owner=owner))
                s.add(StorageRow(id=request_queue_id, type=STORAGE_RQ, owner=owner))
                await s.commit()

            storage_dir, trusted_root = await asyncio.to_thread(
                svc._prepare_run_storage, run_id, run_input
            )
            host_storage_dir = str(svc.settings.host_runs_dir / run_id / "storage")
            container_token = await svc.container_token_for(owner)
            environment = svc._build_environment(
                owner=owner,
                container_token=container_token,
                actor_id=actor_id,
                run_id=run_id,
                kv_store_id=kv_store_id,
                dataset_id=dataset_id,
                request_queue_id=request_queue_id,
            )
            environment["ACTOR_STANDBY_PORT"] = str(ACTOR_STANDBY_PORT)
            container_name = svc._container_name(run_id)

            try:
                endpoint = await asyncio.to_thread(
                    svc.driver.start, build.image_tag, host_storage_dir, environment,
                    container_name, mem_limit_mb,
                )
            except Exception as exc:  # noqa: BLE001
                await svc._finish_run(run_id, exit_code=1, log=f"STANDBY START ERROR: {exc}\n")
                # Distinct from `return None` ("no successful build"): the
                # build IS fine, launching its container failed for an
                # infrastructure reason (e.g. the shared Docker network never
                # came up at boot -- see DockerDriver.start()'s own
                # RuntimeError). Raising a distinct exception lets the router
                # report a 5xx with the real cause instead of reusing the
                # same 404 both cases used to collapse into.
                raise StandbyStartError(actor_id, str(exc)) from exc

            ready = await self._wait_standby_ready(endpoint)
            if not ready:
                # Capture whatever the container printed before killing it --
                # useful to see WHY it never answered the readiness probe
                # (see the reap_idle_standby_runs docstring for why standby
                # runs need this explicit fetch instead of a live log_sink).
                # Routed through the shared teardown core (entry=None: no
                # StandbyRun was ever tracked for this attempt, so no storage
                # import) instead of hand-rolling the same logs+reap pair.
                container_log = await self._teardown_container(container_name=container_name, entry=None)
                await svc._finish_run(
                    run_id, exit_code=1,
                    log=container_log + "Standby container never answered the readiness probe.\n",
                )
                raise StandbyReadinessTimeout(actor_id)

            self.runs[actor_id] = StandbyRun(
                run_id=run_id,
                container_name=container_name,
                endpoint=endpoint,
                last_request=time.monotonic(),
                idle_timeout=self._idle_timeout_secs(standby_cfg),
                storage_dir=storage_dir,
                trusted_root=trusted_root,
            )
            return endpoint

    def mark_standby_request_started(self, actor_id: str) -> None:
        """Record that a forwarded request is actively being served for ``actor_id``.

        Called by the standby router right after ``ensure_standby_run`` hands
        back an endpoint, for the entire duration of the forward -- including
        while a streamed response is still being read chunk by chunk. Paired
        with ``mark_standby_request_finished``; the two bracket the request so
        ``reap_idle_standby_runs`` can tell "idle" (no in-flight requests, and
        none recently) apart from "quiet clock, busy container" (a single
        long-running/streamed request that has simply been going on longer
        than ``idleTimeoutSecs`` -- success criterion 7 explicitly requires
        supporting multi-chunk streamed responses, which can legitimately
        outlive the idle window).

        A no-op if the actor has no tracked entry (e.g. a race with a
        concurrent reap/abort) -- the forward itself still proceeds against
        the endpoint the caller already has; there is simply no bookkeeping
        entry left to mark busy, so the in-flight guarantee only applies once
        an entry exists, same as every other per-entry field.
        """
        entry = self.runs.get(actor_id)
        if entry is not None:
            entry.in_flight += 1

    def mark_standby_request_finished(self, actor_id: str) -> None:
        """Counterpart to ``mark_standby_request_started``.

        Decrements the in-flight count and refreshes ``last_request`` from the
        moment the request actually finished (not from when it started), so
        the idle countdown for the NEXT idle period is measured from a
        truthful "last active" time rather than from before a long request
        even began.
        """
        entry = self.runs.get(actor_id)
        if entry is not None:
            entry.in_flight = max(0, entry.in_flight - 1)
            entry.last_request = time.monotonic()

    async def _teardown_container(
        self, *, container_name: str, entry: StandbyRun | None,
    ) -> str:
        """Shared teardown core: best-effort capture container logs, reap
        (kill+remove) the container, and -- only when ``entry`` is given --
        best-effort import whatever the Actor wrote into the runtime's
        storage.

        Used by both ``reap_idle_standby_runs`` (idle timeout -- ``entry`` is
        always the tracked entry being torn down) and ``teardown_aborted_run``
        (explicit abort -- ``entry`` is ``None`` whenever the aborted run is
        not, or is no longer, the actor's currently tracked warm run, e.g.
        re-aborting an already idle-reaped run). Callers are responsible for
        finalizing the ``Run`` row's own terminal status/log; this only
        handles the container/storage plumbing the two teardown paths shared
        (previously copy-pasted between them). Returns the captured container
        log text (possibly empty).
        """
        try:
            container_log = await asyncio.to_thread(self.service.driver.logs, container_name)
        except Exception:  # noqa: BLE001 - best effort
            container_log = ""
        try:
            await asyncio.to_thread(self.service.driver.reap, container_name)
        except Exception:  # noqa: BLE001 - best effort
            pass
        if entry is not None:
            run = await self.service.get_run(entry.run_id)
            if run is not None:
                try:
                    await self.service.storage.import_run_storage(
                        entry.storage_dir, run.kv_store_id, run.dataset_id, run.request_queue_id,
                        trusted_root=entry.trusted_root,
                    )
                except Exception:  # noqa: BLE001 - best-effort, mirrors the normal run path
                    pass
        return container_log

    async def reap_idle_standby_runs(self) -> None:
        """Single reap pass: tear down every warm standby run idle past its timeout.

        Exposed as its own coroutine (rather than only reachable through the
        watchdog loop) so tests can drive one deterministic pass instead of
        racing a background task's sleep interval.

        Acquires the SAME per-actor lock ``ensure_standby_run()`` takes before
        popping/reaping an actor's warm entry. Without this, a request arriving
        right at the idle boundary could race this pass: ``ensure_standby_run``
        reads the (still-present) entry, this method reaps and pops it, and the
        request then forwards into a container that is already being killed --
        a spurious 503 instead of a clean cold start. Sharing the lock makes
        the two paths fully serialize per actor, so whichever runs first always
        leaves the other with a consistent view (either "still warm, refresh
        last_request" or "gone, cold-start a new one").
        """
        for actor_id in list(self.runs.keys()):
            lock = self.locks.setdefault(actor_id, asyncio.Lock())
            async with lock:
                entry = self.runs.get(actor_id)
                if entry is None:
                    continue  # already reaped/reused by a concurrent caller
                if entry.in_flight > 0:
                    # A forwarded request (possibly a long-lived/streamed one,
                    # per success criterion 7) is actively using this
                    # container right now -- never reap out from under it,
                    # no matter how stale last_request looks.
                    continue
                if time.monotonic() - entry.last_request < entry.idle_timeout:
                    continue  # a concurrent request refreshed it after our snapshot
                self.runs.pop(actor_id, None)
                # Standby runs have no live log_sink like the blocking `run()`
                # path (see `Service._run_actor`), so their container's
                # stdout/stderr is otherwise never captured -- fetch it now,
                # before `reap` kills and removes the container, so it lands
                # in Run.log instead of the log staying permanently empty.
                container_log = await self._teardown_container(
                    container_name=entry.container_name, entry=entry,
                )
                await self.service._finish_run(
                    entry.run_id, exit_code=0,
                    log=container_log + "Standby Actor stopped after idle timeout.\n",
                    status=TERMINAL_ABORTED,
                )

    async def teardown_aborted_run(self, run: Run) -> None:
        """Standby-specific teardown for an explicitly aborted run.

        Called by ``Service._abort_run_locked`` once it has already committed
        the Run row's ``ABORTED`` status. Mirrors ``reap_idle_standby_runs``'s
        natural-idle teardown (the same logs -> reap -> storage-import core,
        via ``_teardown_container``) so an explicit abort is not a
        silent-data-loss path: killing a warm standby run (e.g. to push a new
        build) is a routine developer action, and its dataset/KV/request-queue
        output up to that point must survive it, same as it would survive an
        idle-timeout teardown. Appends the captured container log to the Run
        directly (not via ``_finish_run``, which would no-op: the row is
        already non-RUNNING by the time this runs).

        Handles ``run`` not being -- or no longer being -- the actor's
        CURRENTLY tracked warm run (e.g. re-aborting an already idle-reaped
        run) by skipping the storage import and the bookkeeping pop in that
        case; the container is still reaped either way.
        """
        entry = self.runs.get(run.actor_id)
        is_current_entry = entry is not None and entry.run_id == run.id
        if is_current_entry:
            self.runs.pop(run.actor_id, None)
        container_name = self.service._container_name(run.id)
        container_log = await self._teardown_container(
            container_name=container_name,
            entry=entry if is_current_entry else None,
        )
        if container_log:
            async with self.service.db.session() as s:
                r = await s.get(Run, run.id)
                if r is not None:
                    r.log = (r.log or "") + container_log
                    await s.commit()

    def start_standby_watchdog(self, interval_secs: float = 0.5) -> None:
        """Start the background idle-reap loop exactly once (idempotent)."""
        if self.watchdog_task is not None:
            return

        async def _loop() -> None:
            while True:
                await asyncio.sleep(interval_secs)
                try:
                    # Via `self.service.reap_idle_standby_runs()` (the
                    # `Service`-level delegator -- see `app/service.py`'s
                    # "-- standby --" section) rather than
                    # `self.reap_idle_standby_runs()` directly, so a caller
                    # that monkeypatches `service.reap_idle_standby_runs`
                    # (e.g. tests simulating a flaky pass) actually changes
                    # what the watchdog invokes -- the `Service` method is the
                    # one every call site patches.
                    await self.service.reap_idle_standby_runs()
                except Exception:  # noqa: BLE001 - one bad pass must never kill the loop
                    # Without this, an uncaught exception here would silently
                    # end the task; `watchdog_task` stays set to the now-dead
                    # task, and this method's own idempotency guard (`if
                    # self.watchdog_task is not None: return`) would then
                    # permanently block ever restarting it, so NO standby
                    # actor would ever be auto-reaped again for the rest of
                    # the process's life.
                    logger.exception("Standby idle-reap pass failed; will retry next interval.")

        self.watchdog_task = asyncio.create_task(_loop())

    async def stop_standby_watchdog(self) -> None:
        if self.watchdog_task is not None:
            self.watchdog_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self.watchdog_task
            self.watchdog_task = None

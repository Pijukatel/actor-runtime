/**
 * Standby-actor subsystem: warm-run lifecycle, idle-reap watchdog, and the
 * `.actor/actor.json` opt-in config parsing.
 *
 * Standby is a genuinely self-contained subsystem: its own in-memory state
 * (one warm run per actor, a per-actor lock map, the background reap-watchdog
 * timer) and its own exceptions, coupled to the rest of the app only through
 * the `Service` instance a `StandbyManager` is constructed with.
 */
import path from 'node:path';

import {
    ACTOR_STANDBY_PORT,
    STANDBY_IDLE_TIMEOUT_DEFAULT_SECS,
    STANDBY_IDLE_TIMEOUT_MIN_SECS,
} from './config.js';
import { STORAGE_DS, STORAGE_KV, STORAGE_RQ, TERMINAL_ABORTED, logStamp, shortId, utcNow } from './constants.js';

// How often ensureStandbyRun() polls a freshly-started container's readiness
// probe endpoint (see StandbyManager.#waitStandbyReady).
export const STANDBY_READY_POLL_SECS = 0.1;

/** A started standby container never answered the readiness probe in time. */
export class StandbyReadinessTimeout extends Error {
    constructor(actorId) {
        super(`Standby Actor '${actorId}' never became ready.`);
    }
}

/**
 * A standby container failed to start for an infrastructure/driver reason.
 *
 * Deliberately distinct from `ensureStandbyRun` returning `null` (which means
 * "the Actor has no successful build") -- e.g. `DockerDriver.start()`
 * throwing because the shared Docker network never came up at boot. The build
 * exists and is fine; the run failed for an unrelated reason. Kept as its own
 * error (rather than reusing the return-null sentinel) so the route can
 * report a 5xx with the real cause instead of the misleading "no successful
 * build" 404 both cases would otherwise share.
 */
export class StandbyStartError extends Error {
    constructor(actorId, detail) {
        super(`Standby Actor '${actorId}' failed to start: ${detail}`);
    }
}

/**
 * A minimal promise-chain mutex: `runExclusive(fn)` serializes callers.
 * The single-process equivalent of the per-actor asyncio locks the
 * runtime's design calls for.
 */
export class AsyncLock {
    #tail = Promise.resolve();

    runExclusive(fn) {
        const result = this.#tail.then(fn, fn);
        // Keep the chain alive regardless of fn's outcome.
        this.#tail = result.then(
            () => undefined,
            () => undefined,
        );
        return result;
    }
}

/**
 * Return `.actor/actor.json`'s `usesStandbyMode` from pushed inline source
 * files, or `null` if there is no signal (no manifest present, or it fails
 * to parse) -- callers must leave the existing config alone in that case,
 * never treat "can't read it" as "opted out".
 */
export function extractUsesStandbyMode(sourceFiles) {
    for (const entry of sourceFiles ?? []) {
        if (entry?.name !== '.actor/actor.json') continue;
        let content = entry.content ?? '';
        if (entry.format === 'BASE64') {
            try {
                content = Buffer.from(content, 'base64').toString('utf8');
            } catch {
                return null;
            }
        }
        let manifest;
        try {
            manifest = JSON.parse(content);
        } catch {
            return null;
        }
        if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
            return null;
        }
        const value = manifest.usesStandbyMode;
        return typeof value === 'boolean' ? value : null;
    }
    return null;
}

/**
 * Fill in the apify-core-mirrored defaults for any field the caller omitted.
 *
 * `explicit` records provenance: pass `true` when `cfg` comes from an
 * explicit API `actorStandby` field on this call (stamps the persistent
 * `explicitlySet` marker), leave it `null` when merely (re)normalizing an
 * already-stored config (e.g. from `.actor/actor.json` inference), which
 * preserves whatever `explicitlySet` value -- if any -- was already there.
 * Callers MUST check that marker before letting actor.json inference
 * overwrite `isEnabled` (an explicit override persists until the next call
 * that itself carries an explicit field).
 */
export function normalizeStandbyConfig(cfg, { explicit = null } = {}) {
    const out = { ...(cfg ?? {}) };
    out.isEnabled ??= false;
    out.idleTimeoutSecs ??= STANDBY_IDLE_TIMEOUT_DEFAULT_SECS;
    out.build ??= null;
    out.memoryMbytes ??= null;
    out.shouldPassActorInput ??= false;
    if (explicit !== null) {
        out.explicitlySet = explicit;
    } else {
        out.explicitlySet ??= false;
    }
    return out;
}

/**
 * At most one warm run per standby actor: start-if-absent, readiness wait,
 * idle-reap watchdog, and the standby-specific half of aborting a run.
 *
 * Constructed once by `Service`'s constructor; reaches everything it needs
 * -- db, storage, driver, settings, and a handful of `Service` helper
 * methods -- through `this.service`.
 */
export class StandbyManager {
    constructor(service) {
        this.service = service;
        // At most one warm standby run per actor: actorId -> entry. Purely
        // in-memory -- a restart loses this bookkeeping, but
        // reconcileStaleJobs() has already swept the underlying run row to a
        // terminal state, so the next request simply starts fresh.
        // Entry shape: { runId, containerName, endpoint, lastRequest (ms),
        //   idleTimeout (secs), storageDir, trustedRoot, inFlight }.
        this.runs = new Map();
        // Per-actor locks so concurrent first-callers for the same
        // not-yet-warm actor serialize instead of racing to start two
        // containers.
        this.locks = new Map();
        this.watchdogTimer = null;
    }

    /**
     * The per-actor lock serializing standby start/reap/abort for `actorId`.
     * Creates it on first use. Exposed so `Service.abortRun` can serialize on
     * the SAME lock this class uses internally.
     */
    actorLock(actorId) {
        let lock = this.locks.get(actorId);
        if (!lock) {
            lock = new AsyncLock();
            this.locks.set(actorId, lock);
        }
        return lock;
    }

    /**
     * Resolve the idle timeout to enforce for a standby run.
     *
     * The `Settings`/env override always wins when set -- deliberately
     * bypassing even the platform-mirrored 5s floor, so tests can reap in a
     * fraction of a second. Otherwise the per-actor config applies, clamped
     * to the platform's minimum.
     */
    #idleTimeoutSecs(standbyCfg) {
        const settings = this.service.settings;
        if (settings.standbyIdleOverrideSecs !== null) {
            return Math.max(settings.standbyIdleOverrideSecs, 0);
        }
        const value = Number(standbyCfg.idleTimeoutSecs) || STANDBY_IDLE_TIMEOUT_DEFAULT_SECS;
        return Math.max(value, STANDBY_IDLE_TIMEOUT_MIN_SECS);
    }

    /**
     * Poll `endpoint` with the readiness-probe header until it answers 200,
     * or `settings.standbyReadyTimeoutSecs` elapses (returns false).
     */
    async #waitStandbyReady(endpoint) {
        const deadline = Date.now() + this.service.settings.standbyReadyTimeoutSecs * 1000;
        for (;;) {
            const remainingMs = deadline - Date.now();
            if (remainingMs <= 0) return false;
            try {
                // Bound each attempt by whatever's left of the overall
                // readiness budget (capped at 5s), so the configured value is
                // a true upper bound on the total wait even against a
                // container that accepts the TCP connection but hangs.
                const response = await fetch(`${endpoint}/`, {
                    headers: { 'x-apify-container-server-readiness-probe': '1' },
                    signal: AbortSignal.timeout(Math.min(5000, remainingMs)),
                });
                if (response.status === 200) return true;
                await response.body?.cancel?.();
            } catch {
                // not ready yet
            }
            await sleep(STANDBY_READY_POLL_SECS * 1000);
        }
    }

    /**
     * Return the actor's warm standby endpoint, lazily starting one.
     *
     * At most one warm run exists per actor at a time. Concurrent first
     * callers for the same not-yet-warm actor serialize on a per-actor lock:
     * the first starts the container and waits for readiness; the rest reuse
     * whatever it produced. Returns `null` if the actor has no successful
     * build to run. Throws `StandbyReadinessTimeout` if a newly-started
     * container never answers the readiness probe.
     */
    async ensureStandbyRun(actorId) {
        const svc = this.service;
        return this.actorLock(actorId).runExclusive(async () => {
            const entry = this.runs.get(actorId);
            if (entry) {
                // Confirm the tracked run is still actually alive server-side
                // (e.g. not aborted out-of-band) before reusing it.
                const run = svc.getRun(entry.runId);
                if (run && run.status === 'RUNNING') {
                    entry.lastRequest = Date.now();
                    return entry.endpoint;
                }
                this.runs.delete(actorId);
            }

            const actor = svc.db.getActor(actorId);
            if (!actor) return null;
            const owner = actor.username;
            const standbyCfg = normalizeStandbyConfig(actor.actorStandby);

            const buildTag = standbyCfg.build || 'latest';
            const tagged = svc.taggedBuilds(actorId);
            const buildInfo = tagged[buildTag];
            const build = buildInfo ? svc.getBuild(buildInfo.buildId) : svc.latestBuild(actorId);
            if (!build) return null;

            const runId = shortId();
            const kvStoreId = `kv_${runId}`;
            const datasetId = `ds_${runId}`;
            const requestQueueId = `rq_${runId}`;
            // Resolved ONCE and reused for both the persisted run options AND
            // the actual container's memory cap below, so the API can never
            // report a cap that isn't really enforced.
            const memLimitMb = Number(standbyCfg.memoryMbytes) || 1024;
            // Forced options mirror apify-core: standby config always takes
            // precedence over caller-provided run options, and the run has no
            // wall-clock timeout (the idle watchdog supersedes it).
            const forcedOptions = { build: buildTag, timeoutSecs: 0, memoryMbytes: memLimitMb };
            // NOTE (documented skip): `shouldPassActorInput` has nothing to
            // gate here. On the real platform it decides whether the caller's
            // HTTP request body is also exposed as the Actor's INPUT record;
            // this runtime's standby containers never receive per-start input
            // in the first place (there is no "start a standby run" API call,
            // only the forwarded HTTP requests), so INPUT is always empty.
            const runInput = {};

            svc.db.data.runs.push({
                id: runId,
                actorId,
                username: owner,
                buildId: build.id,
                buildNumber: build.buildNumber,
                status: 'RUNNING',
                exitCode: null,
                options: forcedOptions,
                runInput,
                kvStoreId,
                datasetId,
                requestQueueId,
                isStandby: true,
                log: '',
                startedAt: utcNow(),
                finishedAt: null,
            });
            for (const [id, type] of [
                [kvStoreId, STORAGE_KV],
                [datasetId, STORAGE_DS],
                [requestQueueId, STORAGE_RQ],
            ]) {
                svc.db.data.storages.push({ id, type, owner, createdAt: utcNow() });
            }
            svc.db.save();

            const { storageDir, trustedRoot } = await svc.prepareRunStorage(runId, runInput);
            const hostStorageDir = path.join(svc.settings.hostRunsDir, runId, 'storage');
            const containerToken = svc.containerTokenFor(owner);
            const environment = svc.buildEnvironment({
                owner,
                containerToken,
                actorId,
                runId,
                kvStoreId,
                datasetId,
                requestQueueId,
            });
            environment.ACTOR_STANDBY_PORT = String(ACTOR_STANDBY_PORT);
            // The platform-documented way for an Actor to tell standby from a
            // standard start is APIFY_META_ORIGIN == "STANDBY"; override the
            // env builder's "API" default for standby-origin runs only.
            environment.APIFY_META_ORIGIN = 'STANDBY';
            const containerName = svc.containerName(runId);

            let endpoint;
            try {
                endpoint = await svc.driver.start(
                    build.imageTag,
                    hostStorageDir,
                    environment,
                    containerName,
                    memLimitMb,
                );
            } catch (err) {
                svc.finishRun(runId, { exitCode: 1, log: `${logStamp()} STANDBY START ERROR: ${err?.message ?? err}\n` });
                // Distinct from `return null` ("no successful build"): the
                // build IS fine, launching its container failed for an
                // infrastructure reason. A distinct error lets the route
                // report a 5xx with the real cause instead of reusing the
                // same 404 both cases would otherwise collapse into.
                throw new StandbyStartError(actorId, String(err?.message ?? err));
            }

            const ready = await this.#waitStandbyReady(endpoint);
            if (!ready) {
                // Capture whatever the container printed before killing it --
                // useful to see WHY it never answered the readiness probe.
                // Routed through the shared teardown core (entry=null: no
                // standby entry was ever tracked for this attempt, so no
                // storage import).
                const containerLog = await this.#teardownContainer(containerName, null);
                svc.finishRun(runId, {
                    exitCode: 1,
                    log: containerLog + `${logStamp()} Standby container never answered the readiness probe.\n`,
                });
                throw new StandbyReadinessTimeout(actorId);
            }

            this.runs.set(actorId, {
                runId,
                containerName,
                endpoint,
                lastRequest: Date.now(),
                idleTimeout: this.#idleTimeoutSecs(standbyCfg),
                storageDir,
                trustedRoot,
                // Count of forwarded requests currently being served by this
                // container. A positive count means "busy right now", which
                // reapIdleStandbyRuns() treats as non-idle regardless of how
                // stale lastRequest looks -- this is what lets a single
                // long-lived/streamed response outlive idleTimeoutSecs
                // without being torn down mid-flight.
                inFlight: 0,
            });
            return endpoint;
        });
    }

    /**
     * Record that a forwarded request is actively being served for
     * `actorId`. Called by the standby route right after `ensureStandbyRun`
     * hands back an endpoint, for the entire duration of the forward --
     * including while a streamed response is still being read chunk by
     * chunk. Paired with `markStandbyRequestFinished`.
     *
     * A no-op if the actor has no tracked entry (e.g. a race with a
     * concurrent reap/abort) -- the forward itself still proceeds against
     * the endpoint the caller already has.
     */
    markStandbyRequestStarted(actorId) {
        const entry = this.runs.get(actorId);
        if (entry) entry.inFlight += 1;
    }

    /**
     * Counterpart to `markStandbyRequestStarted`. Decrements the in-flight
     * count and refreshes `lastRequest` from the moment the request actually
     * finished (not from when it started), so the idle countdown for the
     * NEXT idle period is measured from a truthful "last active" time.
     */
    markStandbyRequestFinished(actorId) {
        const entry = this.runs.get(actorId);
        if (entry) {
            entry.inFlight = Math.max(0, entry.inFlight - 1);
            entry.lastRequest = Date.now();
        }
    }

    /**
     * Current stdout/stderr of a warm standby run's container, or `null`.
     *
     * A standby run has no live log sink/buffer the way a blocking run does:
     * while it is RUNNING its log exists only inside the container (it is
     * persisted to `run.log` at teardown), so the log endpoints fetch it on
     * demand through the driver. Returns `null` for anything that is not a
     * currently-RUNNING standby run, so callers can fall back to the stored
     * log.
     */
    async liveContainerLog(run) {
        if (!run.isStandby || run.status !== 'RUNNING') return null;
        return this.service.driver.logs(this.service.containerName(run.id));
    }

    /**
     * Shared teardown core: best-effort capture container logs, reap
     * (kill+remove) the container, and -- only when `entry` is given --
     * best-effort import whatever the Actor wrote into the runtime's
     * storage.
     *
     * Used by both `reapIdleStandbyRuns` (idle timeout -- `entry` is always
     * the tracked entry being torn down) and `teardownAbortedRun` (explicit
     * abort -- `entry` is null whenever the aborted run is not, or is no
     * longer, the actor's currently tracked warm run). Callers are
     * responsible for finalizing the run row's own terminal status/log.
     * Returns the captured container log text (possibly empty).
     */
    async #teardownContainer(containerName, entry) {
        let containerLog = '';
        try {
            containerLog = await this.service.driver.logs(containerName);
        } catch {
            // best effort
        }
        try {
            await this.service.driver.reap(containerName);
        } catch {
            // best effort
        }
        if (entry) {
            const run = this.service.getRun(entry.runId);
            if (run) {
                try {
                    await this.service.storage.importRunStorage(
                        entry.storageDir,
                        run.kvStoreId,
                        run.datasetId,
                        run.requestQueueId,
                        entry.trustedRoot,
                    );
                } catch {
                    // best-effort, mirrors the normal run path
                }
            }
        }
        return containerLog;
    }

    /**
     * Single reap pass: tear down every warm standby run idle past its
     * timeout. Exposed as its own method (rather than only reachable through
     * the watchdog loop) so tests can drive one deterministic pass instead
     * of racing a background timer.
     *
     * Acquires the SAME per-actor lock `ensureStandbyRun()` takes before
     * popping/reaping an actor's warm entry, so a request arriving right at
     * the idle boundary always resolves cleanly (a cold start or a warm
     * reuse), never a forward into a container that is already being killed.
     */
    async reapIdleStandbyRuns() {
        for (const actorId of [...this.runs.keys()]) {
            await this.actorLock(actorId).runExclusive(async () => {
                const entry = this.runs.get(actorId);
                if (!entry) return; // already reaped/reused by a concurrent caller
                if (entry.inFlight > 0) {
                    // A forwarded request (possibly a long-lived/streamed
                    // one) is actively using this container right now --
                    // never reap out from under it, no matter how stale
                    // lastRequest looks.
                    return;
                }
                if (Date.now() - entry.lastRequest < entry.idleTimeout * 1000) {
                    return; // a concurrent request refreshed it after our snapshot
                }
                this.runs.delete(actorId);
                // Standby runs have no live log sink like the blocking run
                // path, so their container's stdout/stderr is otherwise never
                // captured -- fetch it now, before reap kills and removes the
                // container, so it lands in run.log.
                const containerLog = await this.#teardownContainer(entry.containerName, entry);
                this.service.finishRun(entry.runId, {
                    exitCode: 0,
                    log: containerLog + `${logStamp()} Standby Actor stopped after idle timeout.\n`,
                    status: TERMINAL_ABORTED,
                });
            });
        }
    }

    /**
     * Standby-specific teardown for an explicitly aborted run.
     *
     * Called by `Service.abortRun` once it has already committed the run
     * row's ABORTED status. Mirrors the natural-idle teardown (the same
     * logs -> reap -> storage-import core) so an explicit abort is not a
     * silent-data-loss path: killing a warm standby run (e.g. to push a new
     * build) is a routine developer action, and its dataset/KV/request-queue
     * output up to that point must survive it. Appends the captured
     * container log to the run directly (not via `finishRun`, which would
     * no-op: the row is already non-RUNNING by the time this runs).
     *
     * Handles `run` not being -- or no longer being -- the actor's CURRENTLY
     * tracked warm run (e.g. re-aborting an already idle-reaped run) by
     * skipping the storage import and the bookkeeping pop in that case; the
     * container is still reaped either way.
     */
    async teardownAbortedRun(run) {
        const entry = this.runs.get(run.actorId);
        const isCurrentEntry = entry?.runId === run.id;
        if (isCurrentEntry) this.runs.delete(run.actorId);
        const containerName = this.service.containerName(run.id);
        const containerLog = await this.#teardownContainer(containerName, isCurrentEntry ? entry : null);
        if (containerLog) {
            const row = this.service.db.getRun(run.id);
            if (row) {
                row.log = (row.log ?? '') + containerLog;
                this.service.db.save();
            }
        }
    }

    /** Start the background idle-reap loop exactly once (idempotent). */
    startStandbyWatchdog(intervalSecs = 0.5) {
        if (this.watchdogTimer !== null) return;
        this.watchdogTimer = setInterval(() => {
            // Via `this.service.reapIdleStandbyRuns()` (the Service-level
            // delegator) rather than this class's method directly, so a
            // caller that patches `service.reapIdleStandbyRuns` (e.g. tests
            // simulating a flaky pass) actually changes what the watchdog
            // invokes. One bad pass must never kill the loop.
            this.service.reapIdleStandbyRuns().catch((err) => {
                console.error('Standby idle-reap pass failed; will retry next interval.', err);
            });
        }, intervalSecs * 1000);
        this.watchdogTimer.unref?.();
    }

    stopStandbyWatchdog() {
        if (this.watchdogTimer !== null) {
            clearInterval(this.watchdogTimer);
            this.watchdogTimer = null;
        }
    }
}

function sleep(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

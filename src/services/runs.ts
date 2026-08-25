import { generateId } from '../storage/ids.js';
import type { ActorRecord, ActorVersionRecord, BuildRecord, JobStatus, RunRecord } from '../storage/entities.js';
import { getRegistries } from '../storage/registries.js';
import { createStorage } from './storages.js';
import { openKeyValueStore } from '../storage/open.js';
import type { Driver } from '../driver/types.js';
import { appendLog, flushLog, markLogTerminal } from './logs.js';
import { markEventsTerminal, publishAborting, publishSystemInfo } from './events-channel.js';
import { isTerminalJobStatus, transitionJobStatus } from './job-status.js';
import { DEFAULT_BUILD_TAG, findVersion } from './actors.js';
import { dedicatedCpusFor } from './resources.js';
import { CONTAINER_EVENTS_WS_BASE_URL } from '../config.js';

const DEFAULT_MEMORY_MBYTES = 1024;
const DEFAULT_TIMEOUT_SECS = 300;
/** No separate platform disk-default constant exists to match exactly (`apify-core` has no
 * `ACTOR_DEFAULT_DISK_MBYTES`-shaped constant alongside `ACTOR_DEFAULT_MEMORY_MBYTES`); this mirrors the
 * 2x ratio `apify-core`'s own OpenAPI examples use for the pair (`packages/consts/src/actors.ts`'s run
 * schema: `memoryMbytes: 1024` example paired with `diskMbytes: 2048`), also the exact ratio in
 * `apify-client`'s `RunOptions` pydantic model examples. */
const DISK_MBYTES_PER_MEMORY_MBYTE = 2;
/** `?gracefully=true`'s fixed wait between the `aborting` frame and the actual `driver.abortRun` call -
 * matches the real platform's own number (apify-sdk-python's `Actor.abort(..., gracefully=True)`
 * docstring: "send `aborting` and `persistState` events into the run and force-stop the run after 30
 * seconds"). A named constant, not inlined, so the one number the docs/tests/code all have to agree on
 * only has one place to look. */
const GRACEFUL_ABORT_WINDOW_MS = 30_000;

export async function listOwnedRuns(userId: string, actorId?: string): Promise<RunRecord[]> {
	const all = await getRegistries().runs.list();
	return all.filter((run) => run.userId === userId && (!actorId || run.actorId === actorId));
}

export async function getOwnedRun(userId: string, id: string): Promise<RunRecord | null> {
	const record = await getRegistries().runs.get(id);
	if (!record || record.userId !== userId) return null;
	return record;
}

/** Cross-user listing, for the console only (see `services/actors.ts: listAllActors`'s doc comment). */
export async function listAllRuns(): Promise<RunRecord[]> {
	return getRegistries().runs.list();
}

/** Cross-user lookup by id - for the console (see `listAllRuns`), and for `api/events-ws.ts`'s connection
 * handler, which has no authenticated caller at all to scope an owned-lookup against (the events
 * websocket's own scoping is the path's run id itself, not a user - see that module's doc comment). */
export async function getRunById(id: string): Promise<RunRecord | null> {
	return getRegistries().runs.get(id);
}

/** Mirrors `deleteActor` (`services/actors.ts`) - the route layer resolves+authorizes the record (via
 * `getOwnedRun`) and passes only its id down, same split as every other service-layer mutation. */
export async function deleteRun(id: string): Promise<void> {
	await getRegistries().runs.delete(id);
}

export interface StartRunOptions {
	input?: { body: Buffer; contentType: string };
	memoryMbytes?: number;
	timeoutSecs?: number;
	/** Build tag or build number this run should use (the real platform's `options.build`) - defaults to
	 * `DEFAULT_BUILD_TAG` (`'latest'`, `services/actors.ts`) when omitted; `api/routes/actors.ts`'s route
	 * imports that same constant as its local `DEFAULT_TAG` and always resolves and passes the actual tag
	 * it used, so this default only matters for direct service-layer callers, e.g. tests. */
	build?: string;
	proxyPassword?: string;
	apiBaseUrl: string;
	token: string;
}

/**
 * Version-level `envVars` (accepted and stored on `POST`/`PUT .../versions`, `actor-driver.md`) are
 * applied to the run's container environment, merged in *below* the platform-owned vars so a version
 * can never override the contract the runtime itself guarantees (e.g. a version that tries to set its
 * own `APIFY_TOKEN` loses to the real one).
 */
function buildEnv(
	run: RunRecord,
	actor: ActorRecord,
	version: ActorVersionRecord | undefined,
	options: StartRunOptions,
): Record<string, string> {
	const versionEnv: Record<string, string> = {};
	for (const entry of version?.envVars ?? []) {
		versionEnv[entry.name] = entry.value;
	}

	// Both names in each pair are byte-identical, deliberately: apify-sdk-js's `ENV_MAP` and pydantic's
	// `AliasChoices` resolve `ACTOR_*`-vs-`APIFY_*` in OPPOSITE precedence order, so letting the two ever
	// diverge would size the run differently depending on which SDK happens to read it.
	const eventsWebSocketUrl = `${CONTAINER_EVENTS_WS_BASE_URL}/actor-runtime/events/${run.id}`;
	const memoryMbytes = String(run.options.memoryMbytes);

	const env: Record<string, string> = {
		...versionEnv,
		APIFY_IS_AT_HOME: '1',
		APIFY_META_ORIGIN: 'API',
		APIFY_API_BASE_URL: options.apiBaseUrl,
		APIFY_TOKEN: options.token,
		APIFY_DEFAULT_KEY_VALUE_STORE_ID: run.defaultKeyValueStoreId,
		APIFY_DEFAULT_DATASET_ID: run.defaultDatasetId,
		APIFY_DEFAULT_REQUEST_QUEUE_ID: run.defaultRequestQueueId,
		APIFY_ACTOR_ID: actor.id,
		ACTOR_ID: actor.id,
		APIFY_ACTOR_RUN_ID: run.id,
		ACTOR_RUN_ID: run.id,
		// No token, no query string: this endpoint has no authentication at all (`api/events-ws.ts`) - the
		// run id in the path is the only per-run element, and also the only thing there is to scope on.
		ACTOR_EVENTS_WEBSOCKET_URL: eventsWebSocketUrl,
		APIFY_ACTOR_EVENTS_WS_URL: eventsWebSocketUrl,
		ACTOR_MEMORY_MBYTES: memoryMbytes,
		APIFY_MEMORY_MBYTES: memoryMbytes,
		// No `ACTOR_`-prefixed counterpart - apify-sdk-js's `ENV_MAP` has no dedicated-CPU key at all; this
		// exists solely so apify-sdk-python stops dividing its own CPU-overload ratio by an assumed `1`.
		APIFY_DEDICATED_CPUS: String(dedicatedCpusFor(run.options.memoryMbytes)),
	};
	if (options.proxyPassword) env.APIFY_PROXY_PASSWORD = options.proxyPassword;
	return env;
}

export async function startRun(
	driver: Driver,
	actor: ActorRecord,
	build: BuildRecord,
	options: StartRunOptions,
): Promise<RunRecord> {
	const { runs } = getRegistries();

	const [dataset, keyValueStore, requestQueue] = await Promise.all([
		createStorage(actor.userId, 'dataset'),
		createStorage(actor.userId, 'keyValueStore'),
		createStorage(actor.userId, 'requestQueue'),
	]);

	if (options.input) {
		const store = await openKeyValueStore(keyValueStore.id);
		await store.setValue('INPUT', options.input.body, { contentType: options.input.contentType });
	}

	const memoryMbytes = options.memoryMbytes ?? DEFAULT_MEMORY_MBYTES;
	const record: RunRecord = {
		id: generateId(),
		userId: actor.userId,
		actorId: actor.id,
		buildId: build.id,
		buildNumber: build.buildNumber,
		status: 'READY',
		startedAt: new Date().toISOString(),
		defaultDatasetId: dataset.id,
		defaultKeyValueStoreId: keyValueStore.id,
		defaultRequestQueueId: requestQueue.id,
		options: {
			build: options.build ?? DEFAULT_BUILD_TAG,
			memoryMbytes,
			timeoutSecs: options.timeoutSecs ?? DEFAULT_TIMEOUT_SECS,
			diskMbytes: memoryMbytes * DISK_MBYTES_PER_MEMORY_MBYTE,
		},
		meta: { origin: 'API' },
		// The real platform's run-creation default (`RUN_GENERAL_ACCESS.FOLLOW_USER_SETTING`,
		// `apify-core`'s `actor_jobs.server.ts`) - this runtime has no per-user "make runs public by
		// default" setting to follow, so every run gets this fixed default.
		generalAccess: 'FOLLOW_USER_SETTING',
	};
	await runs.set(record.id, record);

	void runInBackground(driver, actor, record, options).catch(async (error: unknown) => {
		// Every *expected* failure mode inside `runInBackground` is already caught internally and mapped
		// to a terminal status - this is only reached by a genuinely unexpected exception (e.g. a
		// registry/storage failure from the pre-start re-check or a version lookup). Without a
		// best-effort terminal write here the record would stay stuck non-terminal forever -
		// `waitForRunFinish` would block until its timeout and every future abort/status check would just
		// see a permanently "running" run.
		console.error(`run ${record.id}: unexpected error escaped runInBackground`, error);
		try {
			await transitionJobStatus(runs, record.id, 'FAILED', {
				finishedAt: new Date().toISOString(),
				statusMessage: `Unexpected internal error: ${error instanceof Error ? error.message : String(error)}`,
			});
		} catch (innerError) {
			console.error(`run ${record.id}: failed to mark FAILED after unexpected error`, innerError);
		}
	});

	return record;
}

/**
 * Exported only for direct testing of the guarded transitions/pre-start abort window (see
 * `test/integration/job-lifecycle.test.ts`) - not part of the service's public surface for callers
 * outside this module, which should only ever go through `startRun`.
 */
export async function runInBackground(
	driver: Driver,
	actor: ActorRecord,
	record: RunRecord,
	options: StartRunOptions,
): Promise<void> {
	const { runs, builds } = getRegistries();

	const afterStart = await transitionJobStatus(runs, record.id, 'RUNNING');
	if (!afterStart || afterStart.status !== 'RUNNING') {
		// An abort issued during the READY window already moved (or is moving) the record past RUNNING -
		// finalise it as ABORTED without ever creating a container. `driver.abortRun` is called
		// defensively even though no container can exist yet on this path (harmless no-op if so; a real
		// stop if some future change ever lets a container start before this check runs).
		// `afterStart.status` can legitimately be `ABORTED` here too, not just `ABORTING`: `job-status.ts`
		// allows `READY -> ABORTED` directly (used by `reconcileOrphanedJobs`), and `abortRun` can also
		// complete its whole `ABORTING -> ABORTED` two-write sequence before this function's own `RUNNING`
		// transition attempt above ever runs - there is no ordering guarantee between the two. In that
		// case the record is already terminal and there is genuinely nothing left to finalise, so the bare
		// `return` below is correct. If the record simply vanished, same thing.
		if (afterStart?.status === 'ABORTING') {
			await driver.abortRun(record.id).catch(() => undefined);
			await transitionJobStatus(runs, record.id, 'ABORTED', { finishedAt: new Date().toISOString() });
		}
		return;
	}

	const build = await builds.get(record.buildId);
	if (!driver.available || !build?.imageId) {
		const reason = !driver.available ? driver.unavailableReason : 'Build has no image to run';
		appendLog(record.id, `Cannot start run: ${reason}\n`);
		await flushLog(record.id);
		markLogTerminal(record.id);
		markEventsTerminal(record.id);
		await transitionJobStatus(runs, record.id, 'FAILED', {
			finishedAt: new Date().toISOString(),
			statusMessage: reason,
		});
		return;
	}

	const version = findVersion(actor, build.versionNumber);
	const env = buildEnv(record, actor, version, options);
	// Both-or-neither, enforced by `DevFolderMount`'s type (`driver/types.ts`) - a mount is only ever
	// added when the Actor actually has a non-empty registered dev folder AND this *run's own resolved
	// build* has a known, non-empty image working directory (`actor-driver.md`: "The mount is applied
	// only when both a registered dev folder and a known working directory exist"). Deliberately
	// `build.imageWorkingDirectory` here, never an Actor-level field: the working directory is
	// build-specific, not Actor-specific - `build` above is already the exact `BuildRecord` this run
	// resolved (by tag or number, `startRun`'s caller), so a multi-tag Actor's `latest` run always mounts
	// at `latest`'s own build's working directory, never at some other, more-recently-built tag's. An
	// Actor that was never registered (or was cleared), or whose resolved build has no known working
	// directory, gets `devMount: undefined`, which `docker-driver.ts`'s `startRun` treats identically to
	// "no `Mounts` key at all" - the regression guarantee that an unregistered/cleared Actor's run
	// container is unaffected.
	const devMount =
		actor.localDevFolder && build.imageWorkingDirectory
			? { localDevFolder: actor.localDevFolder, imageWorkingDirectory: build.imageWorkingDirectory }
			: undefined;

	// Re-check right before creating the container: an abort issued while the registry/version lookups
	// above were in flight may have already moved the record to ABORTING. Closing this window is the fix
	// for the "abort races the pre-start window" finding - without it, an abort landing here would still
	// let `driver.startRun` create and start a container nothing will ever stop.
	const preStart = await runs.get(record.id);
	if (!preStart || preStart.status !== 'RUNNING') {
		if (preStart?.status === 'ABORTING') {
			await driver.abortRun(record.id).catch(() => undefined);
			await transitionJobStatus(runs, record.id, 'ABORTED', { finishedAt: new Date().toISOString() });
		}
		return;
	}

	try {
		const outcome = await driver.startRun(
			{
				runId: record.id,
				imageId: build.imageId,
				env,
				memoryMbytes: record.options.memoryMbytes,
				timeoutSecs: record.options.timeoutSecs,
				devMount,
			},
			(chunk) => appendLog(record.id, chunk),
			(sample) => publishSystemInfo(record.id, sample, record.options),
		);
		const status: JobStatus = outcome.timedOut ? 'TIMED-OUT' : outcome.exitCode === 0 ? 'SUCCEEDED' : 'FAILED';
		// Flush before writing the terminal status, not after: `driver.startRun` resolving is the signal
		// that every `onLog` call for this run has already happened (the Docker driver waits for its log
		// capture stream to fully drain before resolving - see `docker-driver.ts`'s doc comment on
		// `startRun`), so this flush is guaranteed to persist the run's complete output. Doing this before
		// the status write (rather than in the `finally` below, after it) means a client that polls status,
		// observes it turn terminal, and immediately does a non-stream `GET /v2/logs/:id` can never observe
		// the persisted log lagging behind the status it just saw.
		await flushLog(record.id);
		// Guarded: `container.wait()` resolving is not proof the run wasn't aborted - `container.stop()`
		// (from an in-flight `abortRun`) and the container exiting on its own race off the same
		// underlying Docker event with no ordering guarantee. If `abortRun` already moved the record to
		// ABORTING/ABORTED, this write is refused rather than clobbering the abort - see `job-status.ts`.
		await transitionJobStatus(runs, record.id, status, {
			finishedAt: new Date().toISOString(),
			exitCode: outcome.exitCode,
		});
	} catch (error) {
		await flushLog(record.id);
		await transitionJobStatus(runs, record.id, 'FAILED', {
			finishedAt: new Date().toISOString(),
			statusMessage: (error as Error).message,
		});
	} finally {
		markLogTerminal(record.id);
		// Also what actually drives the events websocket's `1000` close (`api/events-ws.ts` polls this
		// exact flag, mirroring `api/routes/logs.ts`'s `?stream=true` handling of `isLogTerminal`).
		markEventsTerminal(record.id);
	}
}

/**
 * Stops the run for real (`driver.abortRun` -> `container.stop()`) and reports `ABORTED` back to the
 * caller. The record is moved to `ABORTING` *before* `driver.abortRun` is even called, which is what
 * makes the result race-proof against `runInBackground`'s own completion write: from that point on, an
 * `ABORTING` record only accepts `ABORTED` as its next status (`job-status.ts`), so whichever of the two
 * writes - this function's final `ABORTED`, or `runInBackground`'s `SUCCEEDED`/`FAILED`/`TIMED-OUT` -
 * reaches the record first, the other is refused rather than clobbering it.
 *
 * `gracefully`, when true, inserts the platform's own graceful-abort contract in between - but only when
 * a container is actually running (`run.status === 'RUNNING'` at the moment this was called): a
 * best-effort `publishAborting(run.id)`, then a fixed `GRACEFUL_ABORT_WINDOW_MS` wall-clock wait - before
 * the existing `driver.abortRun` call, itself untouched either way. A `READY`-state abort (no container
 * created yet) keeps today's immediate `ABORTING -> ABORTED` path regardless of `gracefully`: there is no
 * container for an `aborting` frame's SDK-side handler to react to, and no reason to hold the caller's
 * HTTP request open for 30 seconds against nothing running - a settled edge case for this design, not an
 * oversight (an already-terminal run is still handled by the `isTerminalJobStatus` check above, also
 * unaffected by `gracefully`).
 *
 * `wasRunning`/`alreadyAborting` are both captured from `transitionJobStatus`'s own `onBeforeTransition`
 * hook, INSIDE the same mutex-serialized read-modify-write that performs (or refuses) the `-> ABORTING`
 * write itself - not from a separate, preceding `runs.get(run.id)` read. A plain `get` taken before the
 * guarded write has no ordering relationship with a concurrent `runInBackground` call going through its
 * own `transitionJobStatus` (READY -> RUNNING): the two can interleave so the plain read observes a stale
 * `READY`/`RUNNING` status a moment before the real one lands, silently steering a `?gracefully=true`
 * request onto the wrong path (no `aborting` frame, no window - or the reverse). Reading `current.status`
 * from inside the mutator closure closes that window structurally: by the time this callback runs, the
 * per-id `KeyedMutex` (`storage/registry.ts`) has already serialized it against every other `update` on
 * this same id, so `current` here is the record exactly as it stood the instant before this write decides
 * anything - the freshest status this function could possibly observe. The caller's own `run` parameter
 * is never consulted for either decision, for the same reason.
 *
 * **Two concurrent `/abort` calls on the same run.** `ALLOWED_NEXT.ABORTING` (`job-status.ts`) has no
 * `ABORTING` entry, so a second call's own attempt to transition `ABORTING -> ABORTING` is always refused
 * and returns the record unchanged - `aborting.status === 'ABORTING'` is therefore true whether *this*
 * call just performed the READY/RUNNING -> ABORTING write, or the record was already `ABORTING` because a
 * different, concurrent call put it there moments earlier. Those two cases must be told apart before
 * deciding whether to start (or skip) the graceful window - `onBeforeTransition`'s pre-transition status is
 * exactly that signal (`alreadyAborting = current?.status === 'ABORTING'`), which a post-transition check
 * on `aborting.status` alone cannot provide.
 *
 * The chosen semantics, once told apart: a graceful window, having started, is only ever cut short by an
 * explicit non-graceful abort - never by a second graceful one.
 * - A second `?gracefully=true` call landing while a window (started by a *different* call) is still open
 *   is a no-op: it returns the record exactly as it stands (still `ABORTING`) without calling
 *   `driver.abortRun` and without starting a window of its own. The first caller's own window is the only
 *   one that will ever elapse, and its own eventual `driver.abortRun` + `-> ABORTED` write is the only one
 *   that happens - exactly the guarantee criterion #25 makes for "the" caller of a graceful abort, now made
 *   to hold for whichever caller actually started the window still in flight.
 * - A second `?gracefully=false` (or omitted) call is a deliberate escalation, not a bug: it proceeds
 *   straight to `driver.abortRun` and the terminal `-> ABORTED` write, immediately, exactly like the
 *   pre-graceful-window shape of this function always did for a plain double-abort (a redundant
 *   `driver.abortRun` call is a harmless no-op against an already-stopped/stopping container, matching
 *   `container.stop()`'s own idempotence). This is the outcome a caller who explicitly asked for a hard
 *   abort would expect - a graceful window is a courtesy to the Actor, not a hold the caller cannot escalate
 *   past. The first (graceful) caller's own window still elapses on its own schedule; its later
 *   `driver.abortRun` call is then just as harmless a no-op, and its final `transitionJobStatus(...,
 *   'ABORTED', ...)` call finds the record already terminal and is refused rather than erroring or
 *   double-writing (`transitionJobStatus`'s own terminal check) - the `ABORTING -> ABORTED` guard already
 *   made this safe before this fix; this fix only stops the *early* stop, not the guard that was already
 *   protecting the finalisation write.
 */
export async function abortRun(driver: Driver, run: RunRecord, gracefully = false): Promise<RunRecord | null> {
	if (isTerminalJobStatus(run.status)) return run;
	const { runs } = getRegistries();
	let wasRunning = false;
	let alreadyAborting = false;
	const aborting = await transitionJobStatus(runs, run.id, 'ABORTING', {}, (current) => {
		wasRunning = current?.status === 'RUNNING';
		alreadyAborting = current?.status === 'ABORTING';
	});
	if (!aborting || aborting.status !== 'ABORTING') return aborting;

	// A second `?gracefully=true` call joining a window someone else already started: no-op, join it -
	// never re-trigger the stop early (see the doc comment above).
	if (alreadyAborting && gracefully) return aborting;

	if (!alreadyAborting && gracefully && wasRunning) {
		// Best-effort, same no-subscriber tolerance `publishSystemInfo` already has (`events-channel.ts`):
		// a run with nobody connected still waits out the window and still gets stopped.
		publishAborting(run.id);
		await new Promise<void>((resolve) => setTimeout(resolve, GRACEFUL_ABORT_WINDOW_MS));
	}

	await driver.abortRun(run.id);
	return transitionJobStatus(runs, run.id, 'ABORTED', { finishedAt: new Date().toISOString() });
}

export async function waitForRunFinish(runId: string, seconds: number): Promise<RunRecord | null> {
	const deadline = Date.now() + seconds * 1000;
	for (;;) {
		const current = await getRegistries().runs.get(runId);
		if (!current || isTerminalJobStatus(current.status) || Date.now() >= deadline) return current;
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
}

/** Startup reconciliation: any run/build left non-terminal from a previous process is now orphaned.
 * Unlike the live abort path there is no in-flight background handler to race (the previous process is
 * gone), so this finalises straight to `ABORTED` in one write - `READY`/`RUNNING`/`ABORTING` all accept
 * it directly per `job-status.ts`'s transition table. */
export async function reconcileOrphanedJobs(driver: Driver): Promise<void> {
	const { runs, builds } = getRegistries();
	const [allRuns, allBuilds] = await Promise.all([runs.list(), builds.list()]);

	const orphanedRuns = allRuns.filter((r) => !isTerminalJobStatus(r.status));
	const orphanedBuilds = allBuilds.filter((b) => !isTerminalJobStatus(b.status));

	await driver.reconcileOrphans(orphanedRuns.map((r) => r.id));

	await Promise.all(
		orphanedRuns.map((r) =>
			transitionJobStatus(runs, r.id, 'ABORTED', {
				finishedAt: new Date().toISOString(),
				statusMessage: 'Orphaned by a runtime restart',
			}),
		),
	);
	await Promise.all(
		orphanedBuilds.map((b) =>
			transitionJobStatus(builds, b.id, 'ABORTED', {
				finishedAt: new Date().toISOString(),
				statusMessage: 'Orphaned by a runtime restart',
			}),
		),
	);
}

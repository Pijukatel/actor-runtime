import { generateId } from '../storage/ids.js';
import type { ActorRecord, ActorVersionRecord, BuildRecord, JobStatus, RunRecord } from '../storage/entities.js';
import { getRegistries } from '../storage/registries.js';
import { createStorage } from './storages.js';
import { openKeyValueStore } from '../storage/open.js';
import { DebugPortInUseError, type Driver } from '../driver/types.js';
import { appendLog, flushLog, markLogTerminal } from './logs.js';
import { markEventsTerminal, publishAborting, publishPersistState, publishSystemInfo } from './events-channel.js';
import { clearRunRestartState, consumeRunRestart } from './migrations.js';
import { isTerminalJobStatus, transitionJobStatus } from './job-status.js';
import { DEFAULT_BUILD_TAG, findVersion } from './actors.js';
import {
	describeDebugPortConflict,
	describeDebugRefusal,
	prependDebugEnvValue,
	resolveDebugPlan,
	type DebugPlan,
} from './debug-mode.js';
import { dedicatedCpusFor } from '../resources.js';
import { CONTAINER_EVENTS_WS_BASE_URL } from '../config.js';

const DEFAULT_MEMORY_MBYTES = 1024;
const DEFAULT_TIMEOUT_SECS = 300;
/** No separate platform disk-default constant exists to match exactly (`apify-core` has no
 * `ACTOR_DEFAULT_DISK_MBYTES`-shaped constant alongside `ACTOR_DEFAULT_MEMORY_MBYTES`); this mirrors the
 * 2x ratio `apify-core`'s own OpenAPI examples use for the pair (`packages/consts/src/actors.ts`'s run
 * schema: `memoryMbytes: 1024` example paired with `diskMbytes: 2048`), also the exact ratio in
 * `apify-client`'s `RunOptions` pydantic model examples. */
const DISK_MBYTES_PER_MEMORY_MBYTE = 2;
/** `?gracefully=true`'s wait between the `aborting` frame and the stop, matching the platform's 30s. */
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
	debugPlan: DebugPlan | undefined,
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

	// A debug plan's `NODE_OPTIONS`/`PYTHONPATH` must PREPEND to (never clobber) an Actor-version-level
	// `envVars` entry of the same name - the identical prepend-not-replace discipline `resolveDebugPlan`
	// already applies to the resolved build image's own baked-in env, just against a different "other
	// source" (`services/debug-mode.ts: prependDebugEnvValue`'s own doc comment). A plain `...debugPlan?.env`
	// spread here would silently clobber a version-level override of the same name instead.
	const debugEnv: Record<string, string> = {};
	if (debugPlan) {
		for (const [key, value] of Object.entries(debugPlan.env)) {
			debugEnv[key] = prependDebugEnvValue(key, value, versionEnv[key]);
		}
	}

	const env: Record<string, string> = {
		...versionEnv,
		// Below every platform-owned var (spread order matters here, even though nothing today actually
		// collides): a debug run's `NODE_OPTIONS`/`PYTHONPATH`/debug-port var must never be able to shadow
		// a real contract var (`services/debug-mode.ts: DebugPlan`'s own doc comment).
		...debugEnv,
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
		// No token: the endpoint is unauthenticated and the run id in the path is all there is to scope on.
		ACTOR_EVENTS_WEBSOCKET_URL: eventsWebSocketUrl,
		APIFY_ACTOR_EVENTS_WS_URL: eventsWebSocketUrl,
		ACTOR_MEMORY_MBYTES: memoryMbytes,
		APIFY_MEMORY_MBYTES: memoryMbytes,
		// No `ACTOR_`-prefixed counterpart exists; only the Python SDK reads this.
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
		// Same zeros the platform writes at run creation (see `RunRecord.stats`).
		stats: { migrationCount: 0, rebootCount: 0, restartCount: 0, resurrectCount: 0 },
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
 * The "fail the run before any container exists" sequence, shared by every pre-container failure path in
 * `runInBackground` below (driver-unavailable/no-image, and a refused debug plan): appends `logMessage`
 * to the run's log, flushes it, marks the log/events channels terminal, and transitions the record to
 * `FAILED` with `statusMessage`. The two callers deliberately pass different shapes for the two
 * parameters: the driver-unavailable/no-image path logs a `Cannot start run: `-prefixed line but stores
 * the bare reason as `statusMessage` - the same shape `services/builds.ts`'s own driver-unavailable path
 * stores for a build - while a refused debug plan's `statusMessage` already carries that same prefix
 * (`describeDebugRefusal`'s caller builds it in below) so the run's terminal status reads exactly like
 * the line that appeared in its log. Neither caller relies on this helper to add or infer a prefix.
 */
async function failBeforeContainer(
	runId: string,
	logMessage: string,
	statusMessage: string | undefined,
): Promise<void> {
	const { runs } = getRegistries();
	appendLog(runId, `${logMessage}\n`);
	await flushLog(runId);
	markLogTerminal(runId);
	markEventsTerminal(runId);
	await transitionJobStatus(runs, runId, 'FAILED', {
		finishedAt: new Date().toISOString(),
		statusMessage,
	});
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
		await failBeforeContainer(record.id, `Cannot start run: ${reason}`, reason);
		return;
	}

	// Debug-mode resolution - only when the Actor has the toggle on (`env`/`RunContext` below stay
	// byte-identical to today's for every Actor that has never touched the toggle, the regression
	// guarantee criterion 9/15 both name). A refusal fails the run through the exact "Cannot start run:
	// ..." path every other pre-container failure above uses, before any container is ever created
	// (`actor-driver.md`'s "Non-debuggable images fail the run, loudly" section).
	let debugPlan: DebugPlan | undefined;
	if (actor.localDebug) {
		const target = await driver.inspectDebugTarget(build.imageId);
		const result = resolveDebugPlan(actor.localDebug, target);
		if (result.kind === 'refused') {
			const message = `Cannot start run: ${describeDebugRefusal(actor.id, actor.localDebug.port, result)}`;
			await failBeforeContainer(record.id, message, message);
			return;
		}
		const plan = result.plan;
		debugPlan = plan;
		// Persisted on the run record itself (not derived later from the Actor's toggle, which could
		// change after this run started) - local-only, so the console run page can show an attach address
		// after the fact even for a run started by someone else's `apify call` (`actor-driver.md`'s "Debug
		// mode" section, "Finding it after the fact"). A direct registry write, mirroring how
		// `services/dev-folder.ts` bypasses `updateActor` - there is no job-status transition happening
		// here, just an informational field.
		await runs.update(record.id, (current) =>
			current ? { ...current, localDebug: { language: plan.language, port: plan.port } } : current,
		);
	}

	const version = findVersion(actor, build.versionNumber);
	const env = buildEnv(record, actor, version, options, debugPlan);
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
		// A migration/reboot stop restarts the same run instead of finishing it (`services/migrations.ts`).
		for (;;) {
			const outcome = await driver.startRun(
				{
					runId: record.id,
					imageId: build.imageId,
					env,
					memoryMbytes: record.options.memoryMbytes,
					// The timeout budget is per run, not per container - a restart gets only what is left.
					timeoutSecs: remainingTimeoutSecs(record),
					devMount,
					debug: debugPlan ? { language: debugPlan.language, port: debugPlan.port } : undefined,
				},
				(chunk) => appendLog(record.id, chunk),
				(sample) => publishSystemInfo(record.id, sample, record.options),
			);

			// An abort that raced the restart wins.
			const restart = consumeRunRestart(record.id);
			if (restart) {
				const current = await runs.get(record.id);
				if (current && current.status === 'RUNNING') {
					appendLog(
						record.id,
						restart === 'migration'
							? 'Migrating Actor run to a new container.\n'
							: 'Rebooting Actor run container.\n',
					);
					continue;
				}
			}

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
			return;
		}
	} catch (error) {
		await flushLog(record.id);
		// The driver classifies a debug port conflict as a typed `DebugPortInUseError` (just the port); this
		// is the one place that knows both the Actor id and its stored `language` preference, so it is the
		// one place that can word the remediation (`services/debug-mode.ts: describeDebugPortConflict`) -
		// a typed driver error so the service layer can compose the remedy, analogous to but not the same
		// split as `DriverTimedOutError` (its own caller in `services/builds.ts` only maps status and keeps
		// the driver's own message verbatim).
		const statusMessage =
			error instanceof DebugPortInUseError && actor.localDebug
				? describeDebugPortConflict(actor.id, actor.localDebug.language, error.port)
				: (error as Error).message;
		await transitionJobStatus(runs, record.id, 'FAILED', {
			finishedAt: new Date().toISOString(),
			statusMessage,
		});
	} finally {
		// A run that ends for real must not leave an armed migration-stop timer behind.
		clearRunRestartState(record.id);
		markLogTerminal(record.id);
		// Also what actually drives the events websocket's `1000` close (`api/events-ws.ts` polls this
		// exact flag, mirroring `api/routes/logs.ts`'s `?stream=true` handling of `isLogTerminal`).
		markEventsTerminal(record.id);
	}
}

/** Clamped to at least 1s so a run migrated at the edge of its budget still starts and times out. */
function remainingTimeoutSecs(record: RunRecord): number {
	const elapsedSecs = (Date.now() - Date.parse(record.startedAt)) / 1000;
	return Math.max(1, Math.ceil(record.options.timeoutSecs - elapsedSecs));
}

/**
 * Stops the run and reports `ABORTED`. The record moves to `ABORTING` before `driver.abortRun` is called,
 * which is what makes this race-proof against `runInBackground`'s own completion write: an `ABORTING`
 * record only accepts `ABORTED` next, so whichever write lands first, the other is refused.
 *
 * `gracefully` on a `RUNNING` run publishes the platform's `aborting` + `persistState` frame pair and
 * waits `GRACEFUL_ABORT_WINDOW_MS` before stopping; other states take the immediate path. A second
 * concurrent graceful abort joins the window rather than restarting it - see `requirements/api.md`.
 *
 * Both flags come from `onBeforeTransition`, read inside the same mutex-serialized write that performs
 * the transition: a preceding `get()` could observe a stale status, and only the hook can tell "this call
 * wrote ABORTING" apart from "it was already ABORTING".
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
		publishPersistState(run.id, false);
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

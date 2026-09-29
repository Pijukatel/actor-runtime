import { generateId } from '../storage/ids.js';
import { liveDevFolderWarningLines, unknownWorkingDirectoryLine } from './dev-folder.js';
import type { ActorRecord, ActorVersionRecord, BuildRecord, JobStatus, RunRecord } from '../storage/entities.js';
import { getRegistries } from '../storage/registries.js';
import { createStorage } from './storages.js';
import { openKeyValueStore } from '../storage/open.js';
import { DebugPortInUseError, type BrowserViewerHandle, type Driver } from '../driver/types.js';
import { appendLog, appendRuntimeLog, flushLog, markLogTerminal } from './logs.js';
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
import { browserViewLogLine, describeBrowserViewerStartFailure } from './browser-view.js';
import { dedicatedCpusFor, platformIncompatibleMemoryWarning } from '../resources.js';
import { CONTAINER_EVENTS_WS_BASE_URL } from '../config.js';
import { formatRuntimeLogLines } from '../runtime-log.js';
import { getRunTelemetry } from './events-channel.js';
import { resolveRunMemory } from './actor-memory.js';
import { initialChargedEventCounts, resolveRunPricingInfo } from './pricing.js';
import { consumeStandbyRunFinishing } from './standby-finish.js';
import {
	actorStartChargeMessage,
	registerDefaultDatasetForCharging,
	unregisterDefaultDatasetForCharging,
} from './charging.js';

const DEFAULT_MEMORY_MBYTES = 1024;
const DEFAULT_TIMEOUT_SECS = 300;
/** `@apify/consts`' `DEFAULT_CONTAINER_PORT`. */
const DEFAULT_CONTAINER_SERVER_PORT = 4321;
/** The public API docs don't state a separate disk default; this mirrors the 2x ratio the public
 * OpenAPI examples use for the pair (`memoryMbytes: 1024` paired with `diskMbytes: 2048`), also the
 * exact ratio in `apify-client`'s `RunOptions` pydantic model examples. */
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

/**
 * The `runs/last` pick: apify-core's `getUserActorLastRun`, the same filters under `sort: { startedAt: -1 }`.
 * `startedAt` is set at creation, `READY` runs included, so the most recently created run wins - and two
 * runs of the same millisecond tie, which neither sort resolves.
 */
export async function findLastOwnedRun(
	userId: string,
	actorId: string,
	filter: { status?: string; origin?: string } = {},
): Promise<RunRecord | null> {
	const runs = await listOwnedRuns(userId, actorId);
	let newest: RunRecord | null = null;
	for (const run of runs) {
		if (filter.status !== undefined && run.status !== filter.status) continue;
		if (filter.origin !== undefined && run.meta.origin !== filter.origin) continue;
		// `toISOString()` output orders the same lexically as in time.
		if (!newest || run.startedAt > newest.startedAt) newest = run;
	}
	return newest;
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
	/** `false` skips the registered dev folder for this run only (`?devFolder=false`). */
	devFolder?: boolean;
	/** Absent means no cap. */
	maxTotalChargeUsd?: number;
	/** `STANDBY` for a run the standby router starts; `API` otherwise. */
	origin?: 'API' | 'STANDBY';
	/** The Actor's standby URL, given to every run as `ACTOR_STANDBY_URL`, as on the platform. */
	standbyUrl?: string;
	proxyPassword?: string;
	apiBaseUrl: string;
	token: string;
}

function versionEnvOf(version: ActorVersionRecord | undefined): Record<string, string> {
	const versionEnv: Record<string, string> = {};
	for (const entry of version?.envVars ?? []) {
		versionEnv[entry.name] = entry.value;
	}
	return versionEnv;
}

/**
 * The port the Actor's HTTP server listens on: the platform reads a version-level
 * `ACTOR_WEB_SERVER_PORT`, then `ACTOR_STANDBY_PORT`, then defaults to 4321.
 */
export function containerServerPortFor(version: ActorVersionRecord | undefined): number {
	const versionEnv = versionEnvOf(version);
	for (const name of ['ACTOR_WEB_SERVER_PORT', 'ACTOR_STANDBY_PORT']) {
		const port = Number(versionEnv[name]);
		if (Number.isInteger(port) && port > 0 && port < 65536) return port;
	}
	return DEFAULT_CONTAINER_SERVER_PORT;
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
	const versionEnv = versionEnvOf(version);

	// Both names in each pair are byte-identical, deliberately: apify-sdk-js's `ENV_MAP` and pydantic's
	// `AliasChoices` resolve `ACTOR_*`-vs-`APIFY_*` in OPPOSITE precedence order, so letting the two ever
	// diverge would size the run differently depending on which SDK happens to read it.
	const eventsWebSocketUrl = `${CONTAINER_EVENTS_WS_BASE_URL}/actor-runtime/events/${run.id}`;
	const memoryMbytes = String(run.options.memoryMbytes);
	const containerServerPort = String(containerServerPortFor(version));

	// Prepend, never clobber, a version-level envVars entry of the same name.
	const debugEnv: Record<string, string> = {};
	if (debugPlan) {
		for (const [key, value] of Object.entries(debugPlan.env)) {
			debugEnv[key] = prependDebugEnvValue(key, value, versionEnv[key]);
		}
	}

	const env: Record<string, string> = {
		...versionEnv,
		// Below every platform-owned var so a debug run can never shadow one.
		...debugEnv,
		APIFY_IS_AT_HOME: '1',
		APIFY_META_ORIGIN: run.meta.origin,
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
		// Both, as on the platform: the JavaScript SDK reads the first, the Python SDK the second.
		ACTOR_STANDBY_PORT: containerServerPort,
		ACTOR_WEB_SERVER_PORT: containerServerPort,
	};
	if (options.standbyUrl) env.ACTOR_STANDBY_URL = options.standbyUrl;
	if (options.proxyPassword) env.APIFY_PROXY_PASSWORD = options.proxyPassword;
	// Deliberately not accompanied by `APIFY_ACTOR_PRICING_INFO`/`APIFY_CHARGED_ACTOR_EVENT_COUNTS`: with
	// both set the SDKs skip their fetch of the run object, and a container restarted by a migration would
	// then read charge counts frozen at run start.
	if (run.options.maxTotalChargeUsd !== undefined) {
		env.ACTOR_MAX_TOTAL_CHARGE_USD = String(run.options.maxTotalChargeUsd);
	}
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

	const buildTag = options.build ?? DEFAULT_BUILD_TAG;
	const timeoutSecs = options.timeoutSecs ?? DEFAULT_TIMEOUT_SECS;
	const { memoryMbytes, logLines: memoryLogLines } = await resolveRunMemory(build.memorySettings, {
		requestedMemoryMbytes: options.memoryMbytes,
		fallbackMemoryMbytes: DEFAULT_MEMORY_MBYTES,
		runOptions: {
			build: buildTag,
			timeoutSecs,
			diskMbytes: DEFAULT_MEMORY_MBYTES * DISK_MBYTES_PER_MEMORY_MBYTE,
			...(options.maxTotalChargeUsd !== undefined ? { maxTotalChargeUsd: options.maxTotalChargeUsd } : {}),
		},
		input: options.input,
	});
	// Resolved once: a later pricing change must not reprice a run that already exists.
	const pricingInfo = resolveRunPricingInfo(actor.pricingInfos);
	const chargedEventCounts = initialChargedEventCounts(pricingInfo, memoryMbytes);
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
			build: buildTag,
			memoryMbytes,
			timeoutSecs,
			diskMbytes: memoryMbytes * DISK_MBYTES_PER_MEMORY_MBYTE,
			...(options.maxTotalChargeUsd !== undefined ? { maxTotalChargeUsd: options.maxTotalChargeUsd } : {}),
		},
		meta: { origin: options.origin ?? 'API' },
		// Same zeros the platform writes at run creation (see `RunRecord.stats`).
		stats: {
			migrationCount: 0,
			rebootCount: 0,
			restartCount: 0,
			resurrectCount: 0,
			inputBodyLen: options.input?.body.length ?? 0,
		},
		...(pricingInfo ? { pricingInfo } : {}),
		...(chargedEventCounts ? { chargedEventCounts } : {}),
		// The real platform's run-creation default (`RUN_GENERAL_ACCESS.FOLLOW_USER_SETTING` from the
		// public `@apify/consts`) - this runtime has no per-user "make runs public by default" setting to
		// follow, so every run gets this fixed default.
		generalAccess: 'FOLLOW_USER_SETTING',
	};
	await runs.set(record.id, record);
	registerDefaultDatasetForCharging(record);

	// These lines are about what the caller asked for, so they are written before the run does anything.
	for (const line of memoryLogLines) appendRuntimeLog(record.id, line);
	const memoryWarning = platformIncompatibleMemoryWarning(memoryMbytes);
	if (memoryWarning) appendRuntimeLog(record.id, memoryWarning);
	const startCharge = actorStartChargeMessage(record);
	if (startCharge) appendRuntimeLog(record.id, startCharge);

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

/** Fails a run before any container exists: logs `logMessage`, flushes and terminates the log/events
 * channels, and transitions to `FAILED` with `statusMessage`. Adds no wording of its own - callers
 * pass each string already phrased as they want it to appear. */
async function failBeforeContainer(
	runId: string,
	logMessage: string,
	statusMessage: string | undefined,
): Promise<void> {
	const { runs } = getRegistries();
	appendRuntimeLog(runId, logMessage);
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
			cancelGracefulAbort(record.id);
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

	// Only when the Actor has the toggle on; a refusal fails the run before any container is created.
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
		// Persisted on the run record itself, not derived later from the Actor's toggle (which could
		// change after this run started), so the console can show the attach address after the fact.
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
	const devMountApplicable =
		actor.localDevFolder && build.imageWorkingDirectory
			? { localDevFolder: actor.localDevFolder, imageWorkingDirectory: build.imageWorkingDirectory }
			: undefined;
	const devMount = options.devFolder === false ? undefined : devMountApplicable;
	if (devMountApplicable && !devMount) {
		appendRuntimeLog(
			record.id,
			`Skipping the registered local dev folder ${devMountApplicable.localDevFolder} for this run ` +
				`(started with devFolder=false) - running from the built image alone.`,
		);
	}
	// Nothing to mount the registered folder over. Not reported for a run that opted out anyway.
	if (actor.localDevFolder && !build.imageWorkingDirectory && options.devFolder !== false) {
		appendRuntimeLog(record.id, unknownWorkingDirectoryLine(actor.localDevFolder));
	}
	const runtimeSection = devMount ? liveDevFolderWarningLines(devMount) : [];
	if (runtimeSection.length > 0) appendLog(record.id, formatRuntimeLogLines(runtimeSection));

	// The sidecar comes up before the Actor's container. Started before the pre-start abort re-check below,
	// so an abort landing during this (possibly slow) step is still caught by it.
	let browserViewer: BrowserViewerHandle | undefined;
	if (actor.localBrowserView) {
		const { interactive } = actor.localBrowserView;
		try {
			browserViewer = await driver.startBrowserViewer({ runId: record.id, interactive });
		} catch (error) {
			const message = `Cannot start run: ${describeBrowserViewerStartFailure(actor.id, error)}`;
			await failBeforeContainer(record.id, message, message);
			return;
		}
		const { vncHost, vncPort } = browserViewer;
		await runs.update(record.id, (current) =>
			current ? { ...current, localBrowserView: { interactive, vncHost, vncPort } } : current,
		);
		appendRuntimeLog(record.id, browserViewLogLine(record.id, interactive));
	}

	// Re-check right before creating the container: an abort issued while the registry/version lookups
	// above were in flight may have already moved the record to ABORTING. Closing this window is the fix
	// for the "abort races the pre-start window" finding - without it, an abort landing here would still
	// let `driver.startRun` create and start a container nothing will ever stop.
	const preStart = await runs.get(record.id);
	if (!preStart || preStart.status !== 'RUNNING') {
		if (browserViewer) await driver.stopBrowserViewer(record.id);
		if (preStart?.status === 'ABORTING') {
			// A window armed before the container existed has nothing to stop; this branch finalizes the run.
			cancelGracefulAbort(record.id);
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
					...(record.meta.origin === 'STANDBY'
						? { containerServerPort: containerServerPortFor(version) }
						: {}),
					devMount,
					debug: debugPlan ? { language: debugPlan.language, port: debugPlan.port } : undefined,
					// The sidecar outlives a migration/reboot restart; the new container mounts the same volume.
					x11SocketVolume: browserViewer?.x11SocketVolume,
				},
				(chunk) => appendLog(record.id, chunk),
				(sample) => publishSystemInfo(record.id, sample, record.options),
			);

			// An abort that raced the restart wins.
			const restart = consumeRunRestart(record.id);
			if (restart) {
				const current = await runs.get(record.id);
				if (current && current.status === 'RUNNING') {
					appendRuntimeLog(
						record.id,
						restart === 'migration'
							? 'Migrating Actor run to a new container.'
							: 'Rebooting Actor run container.',
					);
					continue;
				}
			}

			// A standby run the runtime wound down ends `SUCCEEDED` whatever its exit code, as on the platform.
			const status: JobStatus = consumeStandbyRunFinishing(record.id)
				? 'SUCCEEDED'
				: outcome.timedOut
					? 'TIMED-OUT'
					: outcome.exitCode === 0
						? 'SUCCEEDED'
						: 'FAILED';
			// Flush before writing the terminal status, not after: `driver.startRun` resolving is the signal
			// that every `onLog` call for this run has already happened (the Docker driver waits for its log
			// capture stream to fully drain before resolving - see `docker-driver.ts`'s doc comment on
			// `startRun`), so this flush is guaranteed to persist the run's complete output. Doing this before
			// the status write (rather than in the `finally` below, after it) means a client that polls status,
			// observes it turn terminal, and immediately does a non-stream `GET /v2/logs/:id` can never observe
			// the persisted log lagging behind the status it just saw.
			await flushLog(record.id);
			// Before the status write for the same reason as the flush: the sampled figures live only in
			// memory until this runs, and a client that sees the run turn terminal reads the record next.
			await persistRunTelemetry(record.id);
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
		// This is the one place that knows both the Actor id and its stored language preference, so it
		// composes the port-conflict remediation from the driver's typed error.
		const statusMessage =
			error instanceof DebugPortInUseError && actor.localDebug
				? describeDebugPortConflict(actor.id, actor.localDebug.language, error.port)
				: (error as Error).message;
		// Into the run's own log too: the engine refusing the container (a network it cannot set up, an
		// unusable mount) is what `apify call` streams, and the status message alone leaves it empty.
		appendRuntimeLog(record.id, `Cannot start run: ${statusMessage}`);
		await flushLog(record.id);
		await persistRunTelemetry(record.id);
		await transitionJobStatus(runs, record.id, 'FAILED', {
			finishedAt: new Date().toISOString(),
			statusMessage,
		});
	} finally {
		// The container is gone, so an open graceful-abort window has nothing left to wait out - the path an
		// Actor that honours the `aborting` frame takes. The log is already flushed by both the success
		// path above and the catch below, so a client seeing this terminal status can still read all of it.
		// The accumulators are in-memory, so a finished run keeps its figures only if they are written
		// here - before the transition below, and again for the paths above that end the run elsewhere.
		await persistRunTelemetry(record.id);
		if (cancelGracefulAbort(record.id)) {
			await transitionJobStatus(runs, record.id, 'ABORTED', { finishedAt: new Date().toISOString() });
		}
		unregisterDefaultDatasetForCharging(record);
		if (browserViewer) await driver.stopBrowserViewer(record.id);
		// A run that ends for real must not leave an armed migration-stop timer behind.
		clearRunRestartState(record.id);
		consumeStandbyRunFinishing(record.id);
		markLogTerminal(record.id);
		// Also what actually drives the events websocket's `1000` close (`api/events-ws.ts` polls this
		// exact flag, mirroring `api/routes/logs.ts`'s `?stream=true` handling of `isLogTerminal`).
		markEventsTerminal(record.id);
	}
}

/** A plain update, never a status transition: the run is already terminal when this runs. */
async function persistRunTelemetry(runId: string): Promise<void> {
	const telemetry = getRunTelemetry(runId);
	if (!telemetry) return;
	await getRegistries().runs.update(runId, (current) =>
		current ? { ...current, stats: { ...current.stats, ...telemetry } } : current,
	);
}

/** Clamped to at least 1s so a run migrated at the edge of its budget still starts and times out. A
 * run with no timeout (`0`) keeps having none. */
function remainingTimeoutSecs(record: RunRecord): number {
	if (record.options.timeoutSecs === 0) return 0;
	const elapsedSecs = (Date.now() - Date.parse(record.startedAt)) / 1000;
	return Math.max(1, Math.ceil(record.options.timeoutSecs - elapsedSecs));
}

/** Open graceful-abort windows, keyed by run id - same shape as `services/migrations.ts`'s
 * `pendingMigrationStops`, so a window can always be cancelled. */
const pendingGracefulAborts = new Map<string, ReturnType<typeof setTimeout>>();

/** Arms the window and returns; nothing awaits it, so no caller (and no HTTP response) is held for it. */
function armGracefulAbort(driver: Driver, runId: string): void {
	const timer = setTimeout(() => {
		pendingGracefulAborts.delete(runId);
		void finishGracefulAbort(driver, runId).catch((error: unknown) => {
			// Nothing is awaiting this, so an unlogged throw would leave the run stuck ABORTING, silently.
			console.error(`run ${runId}: graceful abort window failed to finish the run`, error);
		});
	}, GRACEFUL_ABORT_WINDOW_MS);
	pendingGracefulAborts.set(runId, timer);
}

async function finishGracefulAbort(driver: Driver, runId: string): Promise<void> {
	await driver.abortRun(runId);
	await transitionJobStatus(getRegistries().runs, runId, 'ABORTED', { finishedAt: new Date().toISOString() });
}

/** Ends an open window early, reporting whether there was one. The caller finalizes the run itself. */
function cancelGracefulAbort(runId: string): boolean {
	const timer = pendingGracefulAborts.get(runId);
	if (timer === undefined) return false;
	clearTimeout(timer);
	pendingGracefulAborts.delete(runId);
	return true;
}

/**
 * Stops the run and reports `ABORTED`. The record moves to `ABORTING` before `driver.abortRun` is called,
 * which is what makes this race-proof against `runInBackground`'s own completion write: an `ABORTING`
 * record only accepts `ABORTED` next, so whichever write lands first, the other is refused.
 *
 * `gracefully` on a `RUNNING` run publishes the platform's `aborting` + `persistState` frame pair and
 * returns the `ABORTING` record straight away, leaving `GRACEFUL_ABORT_WINDOW_MS` to run in the
 * background; other states take the immediate path. A second concurrent graceful abort joins the window,
 * a hard one cancels it - see the abort entry in `src/api/openapi/actor-runtime.json`'s
 * `x-actor-runtime-platform-notes`.
 *
 * Both flags come from `onBeforeTransition`, read inside the same mutex-serialized write that performs
 * the transition: a preceding `get()` could observe a stale status, and only the hook can tell "this call
 * wrote ABORTING" apart from "it was already ABORTING".
 */
export async function abortRun(
	driver: Driver,
	run: RunRecord,
	gracefully = false,
	statusMessage?: string,
): Promise<RunRecord | null> {
	if (isTerminalJobStatus(run.status)) return run;
	const { runs } = getRegistries();
	let wasRunning = false;
	let alreadyAborting = false;
	// Only a runtime-initiated abort (the cost cap) carries a reason; a caller's abort has none, as on
	// the platform.
	const patch: Partial<RunRecord> = statusMessage === undefined ? {} : { statusMessage };
	const aborting = await transitionJobStatus(runs, run.id, 'ABORTING', patch, (current) => {
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
		armGracefulAbort(driver, run.id);
		return aborting;
	}

	// The hard path, including an escalation past someone else's open window - whose stop would otherwise
	// land 30s from now on a container this call is about to kill.
	cancelGracefulAbort(run.id);
	await driver.abortRun(run.id);
	return transitionJobStatus(runs, run.id, 'ABORTED', { finishedAt: new Date().toISOString() });
}

/** Test-only: no window may outlive the test that armed it and fire against the next one's storage. */
export function resetGracefulAbortsForTests(): void {
	for (const timer of pendingGracefulAborts.values()) clearTimeout(timer);
	pendingGracefulAborts.clear();
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

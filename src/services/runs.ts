import { generateId } from '../storage/ids.js';
import { liveDevFolderDisabledLine, liveDevFolderWarningLines, unknownWorkingDirectoryLine } from './dev-folder.js';
import type { ActorRecord, ActorVersionRecord, BuildRecord, JobStatus, RunRecord } from '../storage/entities.js';
import { getRegistries } from '../storage/registries.js';
import { createStorage } from './storages.js';
import { openKeyValueStore } from '../storage/open.js';
import { DebugPortInUseError, type BrowserViewerHandle, type Driver } from '../driver/types.js';
import { REAL_APIFY_PROXY_WARNING } from './apify-proxy.js';
import { appendLog, appendRuntimeLog, flushLog, markLogTerminal, reopenLog } from './logs.js';
import {
	markEventsTerminal,
	publishAborting,
	publishPersistState,
	publishSystemInfo,
	reopenEvents,
} from './events-channel.js';
import { clearRunRestartState, consumeRunRestart } from './migrations.js';
import { isTerminalJobStatus, transitionJobStatus } from './job-status.js';
import { DEFAULT_BUILD_TAG, findVersion } from './actors.js';
import { defaultRunOptionsOf } from './default-run-options.js';
import { resolveTaggedBuild } from './builds.js';
import { decryptedEnvVars, ensureSecretKeys, inputSecretsEnv, sealInputSecrets } from './secrets.js';
import { createLogRedactor } from './log-redaction.js';
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
import { containerUrl } from './container-url.js';
import { formatRuntimeLogLines } from '../runtime-log.js';
import { getRunTelemetry } from './events-channel.js';
import { resolveRunMemory } from './actor-memory.js';
import { DEFAULT_STORAGE_ALIAS, runStorageIds } from './actor-storages.js';
import {
	ACTOR_START_EVENT_NAME,
	actorStartEventCount,
	initialChargedEventCounts,
	isPayPerEvent,
	resolveRunPricingInfo,
} from './pricing.js';
import { runDurationMillis } from './run-usage.js';
import { consumeStandbyRunFinishing } from './standby-finish.js';
import {
	actorStartChargeMessage,
	registerDefaultDatasetForCharging,
	unregisterDefaultDatasetForCharging,
} from './charging.js';

/** `@apify/consts`' `DEFAULT_CONTAINER_PORT`. */
const DEFAULT_CONTAINER_SERVER_PORT = 4321;
/** The public API docs don't state a separate disk default; this mirrors the 2x ratio the public
 * OpenAPI examples use for the pair (`memoryMbytes: 1024` paired with `diskMbytes: 2048`), also the
 * exact ratio in `apify-client`'s `RunOptions` pydantic model examples. */
const DISK_MBYTES_PER_MEMORY_MBYTE = 2;
/** `?gracefully=true`'s wait between the `aborting` frame and the stop, matching the platform's 30s. */
const GRACEFUL_ABORT_WINDOW_MS = 30_000;

/** The platform's `ACTOR_RESTART_ON_ERROR` (`@apify/consts`). */
const RESTART_ON_ERROR_MAX_RESTARTS = 3;
const RESTART_ON_ERROR_INTERVAL_MS = 60_000;

function memoryMbytesToDisk(memoryMbytes: number): number {
	return memoryMbytes * DISK_MBYTES_PER_MEMORY_MBYTE;
}

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
 * `PUT /v2/actor-runs/:runId`, as on the platform: replaces the message (an absent one clears it) and
 * accepts it whatever the run's status, finished runs included. A reason the runtime itself ended the run
 * with is kept: an Actor's wind-down (Crawlee's final "Finished!") would otherwise replace it.
 */
export async function setRunStatusMessage(
	id: string,
	statusMessage: string | undefined,
	isStatusMessageTerminal: boolean,
): Promise<RunRecord | null> {
	return getRegistries().runs.update(id, (current) => {
		if (!current || current.isStatusMessageFromRuntime) return current;
		const next: RunRecord = { ...current, statusMessage, isStatusMessageTerminal };
		if (statusMessage === undefined) delete next.statusMessage;
		if (!isStatusMessageTerminal) delete next.isStatusMessageTerminal;
		return next;
	});
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
	/** Each of these, when absent, falls back to the Actor's `defaultRunOptions`. */
	memoryMbytes?: number;
	timeoutSecs?: number;
	/** Build tag or build number this run should use (the real platform's `options.build`).
	 * `api/routes/actors.ts`'s route always resolves and passes the tag it used, so the fallback only
	 * matters for direct service-layer callers, e.g. tests. */
	build?: string;
	/** `false` skips the registered dev folder for this run only (`?devFolder=false`). */
	devFolder?: boolean;
	/** Absent means the Actor's default; no cap when that is absent too. */
	maxTotalChargeUsd?: number;
	/** Absent means the Actor's default. */
	restartOnError?: boolean;
	/** `STANDBY` for a run the standby router starts; `API` otherwise. */
	origin?: 'API' | 'STANDBY';
	/** The Actor's standby URL, given to every run as `ACTOR_STANDBY_URL`, as on the platform. */
	standbyUrl?: string;
	/** `''` sets `APIFY_PROXY_PASSWORD` explicitly empty (the Apify Proxy setting turned off). */
	proxyPassword?: string;
	apiBaseUrl: string;
	token: string;
}

function versionEnvOf(actor: ActorRecord, version: ActorVersionRecord | undefined): Record<string, string> {
	const versionEnv: Record<string, string> = {};
	for (const entry of decryptedEnvVars(actor, version?.envVars)) {
		versionEnv[entry.name] = entry.value;
	}
	return versionEnv;
}

/**
 * The port the Actor's HTTP server listens on: the platform reads a version-level
 * `ACTOR_WEB_SERVER_PORT`, then `ACTOR_STANDBY_PORT`, then defaults to 4321. A port set as a secret is
 * not read, so this never needs the Actor's private key.
 */
export function containerServerPortFor(version: ActorVersionRecord | undefined): number {
	const versionEnv = Object.fromEntries(
		(version?.envVars ?? []).filter((entry) => !entry.isSecret).map((entry) => [entry.name, entry.value]),
	);
	for (const name of ['ACTOR_WEB_SERVER_PORT', 'ACTOR_STANDBY_PORT']) {
		const port = Number(versionEnv[name]);
		if (Number.isInteger(port) && port > 0 && port < 65536) return port;
	}
	return DEFAULT_CONTAINER_SERVER_PORT;
}

/** Where the run's web server, if the Actor starts one, is reachable. */
export function webServerLogLine(runId: string, port: number): string {
	return (
		`Web server: a server the Actor starts on port ${port} (ACTOR_WEB_SERVER_PORT) is served at ` +
		`${containerUrl(runId)} (live view).`
	);
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
	const versionEnv = versionEnvOf(actor, version);

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
		...(actor.secretKeys ? inputSecretsEnv(actor.secretKeys) : {}),
		APIFY_DEFAULT_KEY_VALUE_STORE_ID: run.defaultKeyValueStoreId,
		APIFY_DEFAULT_DATASET_ID: run.defaultDatasetId,
		APIFY_DEFAULT_REQUEST_QUEUE_ID: run.defaultRequestQueueId,
		// How the SDKs find a storage by alias, e.g. `Actor.openDataset({ alias })`.
		ACTOR_STORAGES_JSON: JSON.stringify(runStorageIds(run)),
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
		APIFY_CONTAINER_PORT: containerServerPort,
		// The host-facing form: what an Actor prints for its developer to open (`actor-driver.md`).
		ACTOR_WEB_SERVER_URL: containerUrl(run.id),
		APIFY_CONTAINER_URL: containerUrl(run.id),
	};
	if (options.standbyUrl) env.ACTOR_STANDBY_URL = options.standbyUrl;
	if (options.proxyPassword !== undefined) env.APIFY_PROXY_PASSWORD = options.proxyPassword;
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

	const extraDatasetAliases = build.extraDatasetAliases ?? [];
	const schemaOf = (alias: string) => build.datasetSchemas?.[alias];
	const [dataset, keyValueStore, requestQueue, ...extraDatasets] = await Promise.all([
		createStorage(actor.userId, 'dataset', undefined, schemaOf(DEFAULT_STORAGE_ALIAS)),
		createStorage(actor.userId, 'keyValueStore'),
		createStorage(actor.userId, 'requestQueue'),
		...extraDatasetAliases.map((alias) => createStorage(actor.userId, 'dataset', undefined, schemaOf(alias))),
	]);

	const input = await sealInputSecrets(actor, build.inputSchema, options.input);
	if (input) {
		const store = await openKeyValueStore(keyValueStore.id);
		await store.setValue('INPUT', input.body, { contentType: input.contentType });
	}

	const defaults = defaultRunOptionsOf(actor);
	const buildTag = options.build ?? defaults.build;
	// `0` is a deliberate "no timeout" (as on the platform), distinct from an omitted option.
	const timeoutSecs = options.timeoutSecs ?? defaults.timeoutSecs;
	const maxTotalChargeUsd = options.maxTotalChargeUsd ?? defaults.maxTotalChargeUsd;
	const restartOnError = options.restartOnError ?? defaults.restartOnError;
	// As on the platform, `.actor/actor.json`'s `defaultMemoryMbytes` outranks the Actor's default memory.
	const { memoryMbytes, logLines: memoryLogLines } = await resolveRunMemory(build.memorySettings, {
		requestedMemoryMbytes: options.memoryMbytes,
		fallbackMemoryMbytes: defaults.memoryMbytes,
		runOptions: {
			build: buildTag,
			timeoutSecs,
			diskMbytes: memoryMbytesToDisk(defaults.memoryMbytes),
			...(maxTotalChargeUsd !== undefined ? { maxTotalChargeUsd } : {}),
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
		storageIds: {
			datasets: {
				[DEFAULT_STORAGE_ALIAS]: dataset.id,
				...Object.fromEntries(extraDatasetAliases.map((alias, index) => [alias, extraDatasets[index]!.id])),
			},
			keyValueStores: { [DEFAULT_STORAGE_ALIAS]: keyValueStore.id },
			requestQueues: { [DEFAULT_STORAGE_ALIAS]: requestQueue.id },
		},
		options: {
			build: buildTag,
			memoryMbytes,
			timeoutSecs,
			diskMbytes: memoryMbytesToDisk(memoryMbytes),
			...(maxTotalChargeUsd !== undefined ? { maxTotalChargeUsd } : {}),
			...(restartOnError !== undefined ? { restartOnError } : {}),
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
	if (options.proxyPassword) appendRuntimeLog(record.id, REAL_APIFY_PROXY_WARNING);
	appendRuntimeLog(
		record.id,
		webServerLogLine(record.id, containerServerPortFor(findVersion(actor, build.versionNumber))),
	);

	launchInBackground(driver, actor, record, options);
	return record;
}

/** Each run's live incarnation, so a resurrection waits for the previous one to wind down: its
 * cleanup runs after the terminal status is written, and must not close the channels the next one reopens. */
const incarnations = new Map<string, Promise<void>>();

/** Hands a `READY` record to `runInBackground` without awaiting it. */
function launchInBackground(driver: Driver, actor: ActorRecord, record: RunRecord, options: StartRunOptions): void {
	const { runs } = getRegistries();
	const settled = runInBackground(driver, actor, record, options).catch(async (error: unknown) => {
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
	incarnations.set(record.id, settled);
	void settled.then(() => {
		if (incarnations.get(record.id) === settled) incarnations.delete(record.id);
	});
}

export interface ResurrectRunOptions {
	/** Each absent one keeps the run's own value. */
	build?: string;
	memoryMbytes?: number;
	timeoutSecs?: number;
	maxTotalChargeUsd?: number;
	restartOnError?: boolean;
	devFolder?: boolean;
	standbyUrl?: string;
	proxyPassword?: string;
	apiBaseUrl: string;
	token: string;
}

/** The route maps each of these to its HTTP status and error type. */
export type ResurrectRunResult =
	| { kind: 'resurrected'; run: RunRecord }
	/** Not finished, or finished differently than the caller's copy says - a concurrent resurrection won. */
	| { kind: 'not-finished'; status: JobStatus }
	/** The run was deleted meanwhile. */
	| { kind: 'gone' }
	| { kind: 'no-such-build'; message: string }
	| { kind: 'cost-limit-decreased' };

/**
 * The platform's `POST /v2/actor-runs/:runId/resurrect`: the same run, with its id, input and default
 * storages, starts over from `READY` as if it had just been created. `startedAt` stays; the timeout
 * budget restarts in full. The run's pricing is the one it was created with - a later pricing change
 * does not reprice it, as `startRun` promises.
 */
export async function resurrectRun(
	driver: Driver,
	actor: ActorRecord,
	run: RunRecord,
	options: ResurrectRunOptions,
): Promise<ResurrectRunResult> {
	const { runs, builds } = getRegistries();
	if (!isTerminalJobStatus(run.status)) return { kind: 'not-finished', status: run.status };

	// The platform refuses to lower a cap the run already has; `0` lifts it instead.
	const currentCap = run.options.maxTotalChargeUsd;
	const requestedCap = options.maxTotalChargeUsd;
	if (requestedCap !== undefined && currentCap !== undefined && requestedCap !== 0 && requestedCap < currentCap) {
		return { kind: 'cost-limit-decreased' };
	}

	let build: BuildRecord | null;
	if (options.build !== undefined) {
		const lookup = await resolveTaggedBuild(actor, options.build);
		if (!lookup.found) {
			// Same two messages as `POST /actors/:actorId/runs` (`api/routes/actors.ts`).
			return {
				kind: 'no-such-build',
				message:
					lookup.reason === 'no-such-tag'
						? `Actor has no build tagged "${options.build}"`
						: 'Record was not found',
			};
		}
		build = lookup.build;
	} else {
		build = await builds.get(run.buildId);
		if (!build) return { kind: 'no-such-build', message: 'Actor build associated with the given run' };
	}

	const buildTag = options.build ?? run.options.build ?? DEFAULT_BUILD_TAG;
	const timeoutSecs = options.timeoutSecs ?? run.options.timeoutSecs;
	const maxTotalChargeUsd = requestedCap ?? currentCap;
	const restartOnError = options.restartOnError ?? run.options.restartOnError;
	// Always a requested figure, so only the build's bounds apply - never its default expression, which
	// the run's own memory already came from.
	const { memoryMbytes, logLines: memoryLogLines } = await resolveRunMemory(build.memorySettings, {
		requestedMemoryMbytes: options.memoryMbytes ?? run.options.memoryMbytes,
		fallbackMemoryMbytes: run.options.memoryMbytes,
		runOptions: {
			build: buildTag,
			timeoutSecs,
			diskMbytes: memoryMbytesToDisk(run.options.memoryMbytes),
			...(maxTotalChargeUsd !== undefined ? { maxTotalChargeUsd } : {}),
		},
		input: undefined,
	});
	// Charged again at every start, as on the platform.
	const startEventCount =
		isPayPerEvent(run.pricingInfo) && ACTOR_START_EVENT_NAME in run.pricingInfo.pricingPerEvent.actorChargeEvents
			? actorStartEventCount(memoryMbytes)
			: 0;

	await incarnations.get(run.id);

	const resurrectedAt = new Date().toISOString();
	const resolvedBuild = build;
	let raced: JobStatus | 'gone' | undefined;
	// Guarded on the status the caller saw, like the platform's conditional update: two concurrent
	// resurrections start one container, not two. Not `transitionJobStatus`, whose gate (rightly) lets
	// nothing out of a terminal status.
	const updated = await runs.update(run.id, (current) => {
		if (!current) {
			raced = 'gone';
			return null;
		}
		if (current.status !== run.status) {
			raced = current.status;
			return current;
		}
		const chargedEventCounts =
			startEventCount > 0
				? {
						...current.chargedEventCounts,
						[ACTOR_START_EVENT_NAME]:
							(current.chargedEventCounts?.[ACTOR_START_EVENT_NAME] ?? 0) + startEventCount,
					}
				: current.chargedEventCounts;
		return {
			...current,
			status: 'READY',
			finishedAt: undefined,
			exitCode: undefined,
			statusMessage: `The Actor has been resurrected from ${current.status} status.`,
			isStatusMessageTerminal: undefined,
			isStatusMessageFromRuntime: undefined,
			chargingStoppedAt: undefined,
			resurrectedAt,
			buildId: resolvedBuild.id,
			buildNumber: resolvedBuild.buildNumber,
			options: {
				...current.options,
				build: buildTag,
				memoryMbytes,
				timeoutSecs,
				diskMbytes: memoryMbytesToDisk(memoryMbytes),
				maxTotalChargeUsd,
				...(restartOnError !== undefined ? { restartOnError } : {}),
			},
			stats: {
				...current.stats,
				resurrectCount: (current.stats?.resurrectCount ?? 0) + 1,
				durationMillisBeforeResurrect: runDurationMillis(current, new Date(resurrectedAt)),
			},
			...(chargedEventCounts ? { chargedEventCounts } : {}),
			// Resolved afresh by `runInBackground` from the Actor's current toggles.
			localDebug: undefined,
			localBrowserView: undefined,
		};
	});
	if (raced === 'gone' || !updated) return { kind: 'gone' };
	if (raced !== undefined) return { kind: 'not-finished', status: raced };

	reopenLog(run.id);
	reopenEvents(run.id);
	registerDefaultDatasetForCharging(updated);

	appendRuntimeLog(run.id, `Resurrecting Actor run from ${run.status} status.`);
	for (const line of memoryLogLines) appendRuntimeLog(run.id, line);
	const memoryWarning = platformIncompatibleMemoryWarning(memoryMbytes);
	if (memoryWarning) appendRuntimeLog(run.id, memoryWarning);
	if (startEventCount > 0) {
		// Only this start's charge, not the run's cumulative count.
		const startCharge = actorStartChargeMessage({
			...updated,
			chargedEventCounts: { [ACTOR_START_EVENT_NAME]: startEventCount },
		});
		if (startCharge) appendRuntimeLog(run.id, startCharge);
	}
	if (options.proxyPassword) appendRuntimeLog(run.id, REAL_APIFY_PROXY_WARNING);
	appendRuntimeLog(run.id, webServerLogLine(run.id, containerServerPortFor(findVersion(actor, build.versionNumber))));

	launchInBackground(driver, actor, updated, { ...options, memoryMbytes, timeoutSecs, build: buildTag });
	return { kind: 'resurrected', run: updated };
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

	const keyedActor = await ensureSecretKeys(actor);
	const version = findVersion(keyedActor, build.versionNumber);
	const env = buildEnv(record, keyedActor, version, options, debugPlan);
	// As on the platform: the run's token and its secret env vars, never its secret input fields.
	const logRedactor = createLogRedactor([
		options.token,
		...decryptedEnvVars(keyedActor, version?.envVars)
			.filter((envVar) => envVar.isSecret)
			.map((envVar) => envVar.value),
	]);
	const flushRedactedLog = () => appendLog(record.id, logRedactor.flush());
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
	const localDevFolder = actor.localDevFolderEnabled ? actor.localDevFolder : undefined;
	const devMountApplicable =
		localDevFolder && build.imageWorkingDirectory
			? { localDevFolder, imageWorkingDirectory: build.imageWorkingDirectory }
			: undefined;
	const devMount = options.devFolder === false ? undefined : devMountApplicable;
	if (devMountApplicable && !devMount) {
		appendRuntimeLog(
			record.id,
			`Skipping the registered local dev folder ${devMountApplicable.localDevFolder} for this run ` +
				`(started with devFolder=false) - running from the built image alone.`,
		);
	}
	if (actor.localDevFolder && !actor.localDevFolderEnabled && options.devFolder !== false) {
		appendRuntimeLog(record.id, liveDevFolderDisabledLine(actor.id, actor.localDevFolder));
	}
	// Nothing to mount the registered folder over. Not reported for a run that opted out anyway.
	if (localDevFolder && !build.imageWorkingDirectory && options.devFolder !== false) {
		appendRuntimeLog(record.id, unknownWorkingDirectoryLine(localDevFolder));
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

	// Kept per incarnation: a resurrection starts with a clean restart-on-error history.
	const errorRestartTimes: number[] = [];
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
					containerServerPort: containerServerPortFor(version),
					// Only a standby run's server is worth changing the container's networking for.
					containerServerRequired: record.meta.origin === 'STANDBY',
					devMount,
					debug: debugPlan ? { language: debugPlan.language, port: debugPlan.port } : undefined,
					// The sidecar outlives a migration/reboot restart; the new container mounts the same volume.
					x11SocketVolume: browserViewer?.x11SocketVolume,
				},
				(chunk) => appendLog(record.id, logRedactor.redact(chunk)),
				(sample) => publishSystemInfo(record.id, sample, record.options),
			);
			flushRedactedLog();

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

			const standbyFinishing = consumeStandbyRunFinishing(record.id);
			if (
				!standbyFinishing &&
				!outcome.timedOut &&
				outcome.exitCode !== 0 &&
				(await restartAfterError(record, outcome.exitCode, errorRestartTimes))
			) {
				continue;
			}

			// A standby run the runtime wound down ends `SUCCEEDED` whatever its exit code, as on the platform.
			const status: JobStatus = standbyFinishing
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
		flushRedactedLog();
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

/**
 * Restart on error, as on the platform: a `restartOnError` run whose container exits non-zero starts
 * again as the same run, unless it already restarted `RESTART_ON_ERROR_MAX_RESTARTS` times within
 * `RESTART_ON_ERROR_INTERVAL_MS`. Decided inside one serialized write, so an abort that raced the exit
 * wins, and a resurrection's changed flag is honoured.
 */
async function restartAfterError(record: RunRecord, exitCode: number, restartTimes: number[]): Promise<boolean> {
	const now = Date.now();
	const recentRestarts = restartTimes.filter((time) => now - time < RESTART_ON_ERROR_INTERVAL_MS).length;
	let decision: 'restart' | 'limit-reached' | undefined;
	await getRegistries().runs.update(record.id, (current) => {
		if (!current || current.status !== 'RUNNING' || !current.options.restartOnError) return current;
		if (recentRestarts >= RESTART_ON_ERROR_MAX_RESTARTS) {
			decision = 'limit-reached';
			return current;
		}
		decision = 'restart';
		return { ...current, stats: { ...current.stats, restartCount: (current.stats?.restartCount ?? 0) + 1 } };
	});
	if (decision === 'limit-reached') {
		appendRuntimeLog(
			record.id,
			`The Actor run failed more than ${RESTART_ON_ERROR_MAX_RESTARTS} times within ` +
				`${RESTART_ON_ERROR_INTERVAL_MS / 1000} seconds, so it is not restarted again.`,
		);
	}
	if (decision !== 'restart') return false;
	restartTimes.push(now);
	appendRuntimeLog(record.id, `The Actor run exited with code ${exitCode}, restarting it (restart on error).`);
	return true;
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
 * run with no timeout (`0`, or anything else the driver arms no timer for) keeps having none. A
 * resurrection restarts the budget, as on the platform. */
function remainingTimeoutSecs(record: RunRecord): number {
	if (record.options.timeoutSecs <= 0) return 0;
	const elapsedSecs = (Date.now() - Date.parse(record.resurrectedAt ?? record.startedAt)) / 1000;
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
 * a hard one cancels it - see `requirements/api.md`.
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
	const patch: Partial<RunRecord> =
		statusMessage === undefined
			? {}
			: { statusMessage, isStatusMessageTerminal: true, isStatusMessageFromRuntime: true };
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

/**
 * The standby run pool (`actor-driver.md`'s "Actor Standby"): which run of a standby Actor, or of a task
 * of one, serves the next request, when another run is started, and when an idle one is wound down. Each
 * Actor and each task has a pool of its own. Single-tenant only - every run belongs to the owner, who is
 * the only caller the router lets through.
 *
 * In memory only: a runtime restart aborts every run anyway (`reconcileOrphanedJobs`).
 */
import http from 'node:http';

import type { ActorRecord, ActorStandbyRecord, BuildRecord, TaskRecord, UserRecord } from '../storage/entities.js';
import type { ContainerServerAddress, Driver } from '../driver/types.js';
import { getRegistries } from '../storage/registries.js';
import { CONTAINER_API_BASE_URL } from '../config.js';
import { appendRuntimeLog } from './logs.js';
import { publishAborting, publishPersistState } from './events-channel.js';
import { isTerminalJobStatus } from './job-status.js';
import { resolveTaggedBuild } from './builds.js';
import { resolveBuildInput } from './input-schema.js';
import { resolveProxyPassword } from './users.js';
import { containerServerPortFor, startRun } from './runs.js';
import { findVersion } from './actors.js';
import { markStandbyRunFinishing } from './standby-finish.js';
import { standbyUrl, taskStandbyConfig } from './standby-config.js';

/** The platform's readiness probe: a `GET /` carrying this header; any HTTP response means ready. */
export const READINESS_PROBE_HEADER = 'x-apify-container-server-readiness-probe';
const READINESS_POLL_MS = 500;
const READINESS_PROBE_TIMEOUT_MS = 2_000;
/** How long a request waits for a starting run's server before giving up on it. */
const DEFAULT_READY_TIMEOUT_MS = 180_000;
/** Between the `aborting` frame and the stop signal, then again before the kill - the platform's 15 s + 15 s. */
const FINISH_WARNING_MS = 15_000;
const FINISH_GRACE_SECS = 15;

/** A request that could not be given a run; the router answers with this status and message. */
export class StandbyUnavailableError extends Error {
	constructor(
		readonly status: number,
		readonly type: string,
		message: string,
	) {
		super(message);
	}
}

interface PooledRun {
	/** Resolves once the run record exists; the entry is in the pool before that, so concurrent
	 * requests count against it instead of each starting a run of their own. */
	readonly runId: Promise<string>;
	knownRunId?: string;
	readonly buildId: string;
	openRequests: number;
	/** The address last seen answering the readiness probe; a restarted container has a new one. */
	readyAddress?: string;
	idleTimer?: ReturnType<typeof setTimeout>;
	/** Retired from the pool: takes no new requests and is wound down once its last one completes. */
	retiring?: string;
}

/** What a standby address serves: an Actor, or a task of one, with the settings its runs use. */
export interface StandbyService {
	actor: ActorRecord;
	task?: TaskRecord;
	/** `undefined` while the Actor's Standby is off. */
	config: ActorStandbyRecord | undefined;
}

export function actorStandbyService(actor: ActorRecord): StandbyService {
	return { actor, config: actor.actorStandby?.isEnabled ? actor.actorStandby : undefined };
}

export function taskStandbyService(actor: ActorRecord, task: TaskRecord): StandbyService {
	return { actor, task, config: taskStandbyConfig(actor, task) };
}

/** The pool a service's runs live in. */
function poolKeyOf(service: StandbyService): string {
	return service.task ? `task:${service.task.id}` : service.actor.id;
}

export interface StandbyLease {
	runId: string;
	address: ContainerServerAddress;
	/** The request reached a container that refused it: re-probe before the next request uses it. */
	markUnreachable(): void;
	release(): void;
}

const pools = new Map<string, PooledRun[]>();
let readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS;
let finishWarningMs = FINISH_WARNING_MS;

function poolOf(key: string): PooledRun[] {
	let pool = pools.get(key);
	if (!pool) {
		pool = [];
		pools.set(key, pool);
	}
	return pool;
}

function removeFromPool(key: string, entry: PooledRun): void {
	const pool = pools.get(key);
	if (!pool) return;
	const index = pool.indexOf(entry);
	if (index !== -1) pool.splice(index, 1);
	if (entry.idleTimer) clearTimeout(entry.idleTimer);
	entry.idleTimer = undefined;
}

/** Drops runs that ended on their own (crashed, aborted, finished) since the pool last looked. */
async function pruneEndedRuns(key: string): Promise<void> {
	const { runs } = getRegistries();
	for (const entry of [...poolOf(key)]) {
		if (!entry.knownRunId) continue;
		const record = await runs.get(entry.knownRunId);
		if (!record || isTerminalJobStatus(record.status) || record.status === 'ABORTING') {
			removeFromPool(key, entry);
		}
	}
}

async function resolveStandbyBuild(actor: ActorRecord, config: ActorStandbyRecord): Promise<BuildRecord> {
	const lookup = await resolveTaggedBuild(actor, config.build);
	if (lookup.found) return lookup.build;
	throw new StandbyUnavailableError(
		404,
		'record-not-found',
		`Actor has no build tagged "${config.build}" for Actor Standby - push the Actor, or change actorStandby.build.`,
	);
}

/**
 * The run the platform's controller would start: standby build and memory, no timeout, input only on
 * request. A task's run takes the task's input and its other run options, as any run of the task does.
 */
async function startStandbyRun(
	driver: Driver,
	service: StandbyService,
	config: ActorStandbyRecord,
	build: BuildRecord,
	user: UserRecord,
) {
	const { actor, task } = service;
	let input: { body: Buffer; contentType: string } | undefined;
	if (config.shouldPassActorInput) {
		const taskInput = task?.input
			? { body: Buffer.from(JSON.stringify(task.input), 'utf8'), contentType: 'application/json' }
			: undefined;
		const processed = resolveBuildInput(build, taskInput);
		if (processed.kind !== 'ok') {
			throw new StandbyUnavailableError(400, processed.kind, processed.message);
		}
		input = processed.input;
	}
	const { maxTotalChargeUsd, restartOnError } = task?.options ?? {};
	return startRun(driver, actor, build, {
		origin: 'STANDBY',
		input,
		memoryMbytes: config.memoryMbytes,
		timeoutSecs: 0,
		build: config.build,
		...(maxTotalChargeUsd !== undefined ? { maxTotalChargeUsd } : {}),
		...(restartOnError !== undefined ? { restartOnError } : {}),
		...(task ? { actorTaskId: task.id } : {}),
		standbyUrl: standbyUrl(task ?? actor, user.username),
		proxyPassword: resolveProxyPassword(user),
		apiBaseUrl: CONTAINER_API_BASE_URL,
		token: user.token,
	});
}

function addRun(
	driver: Driver,
	service: StandbyService,
	config: ActorStandbyRecord,
	build: BuildRecord,
	user: UserRecord,
	onStarted: (entry: PooledRun, runId: string) => void,
): PooledRun {
	const key = poolKeyOf(service);
	const pool = poolOf(key);
	const started = startStandbyRun(driver, service, config, build, user).then((run) => run.id);
	const entry: PooledRun = { runId: started, buildId: build.id, openRequests: 0 };
	pool.push(entry);
	started.then(
		(runId) => {
			entry.knownRunId = runId;
			onStarted(entry, runId);
		},
		() => removeFromPool(key, entry),
	);
	return entry;
}

/**
 * Picks the least loaded run below `maxRequestsPerActorRun`, starting one when there is none, and
 * starts one more ahead of demand once every run is above `desiredRequestsPerActorRun`. Resolves once the
 * picked run's server answers; the caller must `release()` the lease when its request is done.
 */
export async function acquireStandbyRun(
	driver: Driver,
	service: StandbyService,
	user: UserRecord,
): Promise<StandbyLease> {
	const { actor, task, config } = service;
	if (!config) {
		throw new StandbyUnavailableError(400, 'standby-not-enabled', "This Actor doesn't have Standby mode enabled.");
	}
	const key = poolKeyOf(service);
	const build = await resolveStandbyBuild(actor, config);
	await pruneEndedRuns(key);

	// Synchronous from here to the reservation, so two concurrent requests can never both see an empty pool.
	const pool = poolOf(key);
	for (const entry of [...pool]) {
		if (entry.buildId !== build.id && !entry.retiring) {
			retire(driver, key, entry, `a newer build (${build.buildNumber}) now serves Actor Standby`);
		}
	}
	const onStarted = (entry: PooledRun, runId: string) => {
		appendRuntimeLog(
			runId,
			`Actor Standby: this run serves requests to ${standbyUrl(task ?? actor, user.username)}; waiting for ` +
				`the Actor's server on port ${containerServerPortFor(findVersion(actor, build.versionNumber))}.`,
		);
		if (entry.openRequests === 0) armIdleTimer(driver, key, entry, config);
	};
	const candidates = () => pool.filter((entry) => !entry.retiring);
	let picked: PooledRun | undefined;
	for (const entry of candidates()) {
		if (entry.openRequests >= config.maxRequestsPerActorRun) continue;
		if (!picked || entry.openRequests < picked.openRequests) picked = entry;
	}
	picked ??= addRun(driver, service, config, build, user, onStarted);
	picked.openRequests++;
	if (picked.idleTimer) clearTimeout(picked.idleTimer);
	picked.idleTimer = undefined;
	if (candidates().every((entry) => entry.openRequests > config.desiredRequestsPerActorRun)) {
		addRun(driver, service, config, build, user, onStarted);
	}

	const entry = picked;
	let released = false;
	const release = () => {
		if (released) return;
		released = true;
		entry.openRequests--;
		if (entry.openRequests > 0) return;
		if (entry.retiring) void finishRun(driver, entry, entry.retiring);
		else armIdleTimer(driver, key, entry, config);
	};

	try {
		const runId = await entry.runId.catch((error: unknown) => {
			if (error instanceof StandbyUnavailableError) throw error;
			throw new StandbyUnavailableError(
				503,
				'standby-run-failed',
				`Could not start a standby run of the Actor: ${error instanceof Error ? error.message : String(error)}`,
			);
		});
		const address = await waitForServer(driver, entry, runId);
		return {
			runId,
			address,
			markUnreachable: () => {
				entry.readyAddress = undefined;
			},
			release,
		};
	} catch (error) {
		release();
		throw error;
	}
}

async function waitForServer(driver: Driver, entry: PooledRun, runId: string): Promise<ContainerServerAddress> {
	const deadline = Date.now() + readyTimeoutMs;
	for (;;) {
		const record = await getRegistries().runs.get(runId);
		if (!record || isTerminalJobStatus(record.status) || record.status === 'ABORTING') {
			const status = record?.status ?? 'deleted';
			const reason = record?.statusMessage ? `: ${record.statusMessage}` : '';
			throw new StandbyUnavailableError(
				503,
				'standby-run-finished',
				`The Actor's standby run ${runId} finished (${status}${reason}) before serving the request; see its log.`,
			);
		}
		const address = await driver.containerServerAddress(runId);
		if (address) {
			const key = `${address.host}:${address.port}`;
			if (entry.readyAddress === key) return address;
			if (await answersReadinessProbe(address)) {
				if (entry.readyAddress === undefined) {
					appendRuntimeLog(runId, "Actor Standby: the Actor's server is ready.");
				}
				entry.readyAddress = key;
				return address;
			}
		}
		if (Date.now() >= deadline) {
			throw new StandbyUnavailableError(
				504,
				'standby-run-not-ready',
				`The Actor's standby run ${runId} did not start listening on its standby port (ACTOR_STANDBY_PORT) ` +
					`within ${Math.round(readyTimeoutMs / 1000)} s; see its log.`,
			);
		}
		await new Promise((resolve) => setTimeout(resolve, READINESS_POLL_MS));
	}
}

function answersReadinessProbe(address: ContainerServerAddress): Promise<boolean> {
	return new Promise((resolve) => {
		const request = http.get(
			{
				host: address.host,
				port: address.port,
				path: '/',
				headers: { [READINESS_PROBE_HEADER]: '1' },
				timeout: READINESS_PROBE_TIMEOUT_MS,
			},
			(response) => {
				response.resume();
				resolve(true);
			},
		);
		request.on('timeout', () => request.destroy());
		request.on('error', () => resolve(false));
	});
}

function armIdleTimer(driver: Driver, key: string, entry: PooledRun, config: ActorStandbyRecord): void {
	if (entry.idleTimer) clearTimeout(entry.idleTimer);
	entry.idleTimer = setTimeout(() => {
		entry.idleTimer = undefined;
		if (entry.openRequests > 0 || !pools.get(key)?.includes(entry)) return;
		removeFromPool(key, entry);
		void finishRun(driver, entry, 'Actor Standby server was idle for too long, finishing run.');
	}, config.idleTimeoutSecs * 1000);
}

function retire(driver: Driver, key: string, entry: PooledRun, reason: string): void {
	entry.retiring = `Actor Standby: ${reason}, finishing this run.`;
	if (entry.idleTimer) clearTimeout(entry.idleTimer);
	entry.idleTimer = undefined;
	removeFromPool(key, entry);
	if (entry.openRequests === 0) void finishRun(driver, entry, entry.retiring);
}

/**
 * The platform's graceful finish: the `aborting` + `persistState` frames, the stop signal 15 s later
 * and the kill 15 s after that. The run ends `SUCCEEDED` either way (`standby-finish.ts`).
 */
async function finishRun(driver: Driver, entry: PooledRun, message: string): Promise<void> {
	const runId = await entry.runId.catch(() => undefined);
	if (!runId) return;
	// A run still starting is waited for: stopping it before its container exists would stop nothing.
	let record = await getRegistries().runs.get(runId);
	while (record?.status === 'READY') {
		await new Promise((resolve) => setTimeout(resolve, READINESS_POLL_MS));
		record = await getRegistries().runs.get(runId);
	}
	if (!record || record.status !== 'RUNNING') return;
	markStandbyRunFinishing(runId);
	appendRuntimeLog(runId, message);
	publishAborting(runId);
	publishPersistState(runId, false);
	setTimeout(() => {
		void driver.abortRun(runId, { graceSecs: FINISH_GRACE_SECS }).catch((error: unknown) => {
			console.error(`run ${runId}: could not stop a finishing standby run`, error);
		});
	}, finishWarningMs);
}

/** For the console: the pool's live view of an Actor's or a task's standby runs. */
export function standbyPoolSnapshot(
	service: StandbyService,
): Array<{ runId?: string; openRequests: number; ready: boolean }> {
	return (pools.get(poolKeyOf(service)) ?? []).map((entry) => ({
		runId: entry.knownRunId,
		openRequests: entry.openRequests,
		ready: entry.readyAddress !== undefined,
	}));
}

/** Test-only. */
export function configureStandbyForTests(options: { readyTimeoutMs?: number; finishWarningMs?: number }): void {
	if (options.readyTimeoutMs !== undefined) readyTimeoutMs = options.readyTimeoutMs;
	if (options.finishWarningMs !== undefined) finishWarningMs = options.finishWarningMs;
}

/** Test-only: no timer may outlive the test that armed it. */
export function resetStandbyForTests(): void {
	for (const pool of pools.values()) {
		for (const entry of pool) if (entry.idleTimer) clearTimeout(entry.idleTimer);
	}
	pools.clear();
	readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS;
	finishWarningMs = FINISH_WARNING_MS;
}

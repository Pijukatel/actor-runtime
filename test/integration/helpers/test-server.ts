import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import { ApifyClient } from 'apify-client';

import { bootstrapStorage, resetStorageForTests, shutdownStorage } from '../../../src/storage/bootstrap.js';
import { openRegistries, resetRegistriesForTests } from '../../../src/storage/registries.js';
import { resetUsersForTests } from '../../../src/services/users.js';
import { resetApiFallbackStateForTests } from '../../../src/services/api-fallback.js';
import { createApiServer } from '../../../src/api/server.js';
import { attachEventsWebSocket } from '../../../src/api/events-ws.js';
import { resetLogsForTests, stopLogFlusher } from '../../../src/services/logs.js';
import { resetEventsChannelForTests } from '../../../src/services/events-channel.js';
import type { BuildContext, BuildOutcome, Driver, RunOutcome, RunResourceSample } from '../../../src/driver/types.js';

/** A driver that is always unavailable, so build/run creation fails fast and deterministically. */
export function unavailableDriver(): Driver {
	return {
		available: false,
		unavailableReason: 'Docker is not available in the test environment',
		async init() {},
		async startBuild() {
			throw new Error('unavailable');
		},
		async abortBuild() {},
		async startRun() {
			throw new Error('unavailable');
		},
		async abortRun() {},
		async reconcileOrphans() {},
		async probeDevFolder() {
			throw new Error('not used by this stub');
		},
		async ensureProbeImage() {
			throw new Error('not used by this stub');
		},
		async inspectDebugTarget() {
			throw new Error('not used by this stub');
		},
	};
}

/**
 * A driver whose `startRun` resolves immediately with a caller-supplied outcome - for asserting how
 * `runInBackground` maps a given `RunOutcome` (in particular `timedOut: true`) to a final status,
 * without needing a real container or any real elapsed time.
 */
export function fixedRunOutcomeDriver(outcome: RunOutcome): Driver {
	return {
		available: true,
		async init() {},
		async startBuild() {
			throw new Error('not used by this stub');
		},
		async abortBuild() {},
		async startRun() {
			return outcome;
		},
		async abortRun() {},
		async reconcileOrphans() {},
		async probeDevFolder() {
			throw new Error('not used by this stub');
		},
		async ensureProbeImage() {
			throw new Error('not used by this stub');
		},
		async inspectDebugTarget() {
			throw new Error('not used by this stub');
		},
	};
}

/** Same idea as `fixedRunOutcomeDriver`, but for builds; also records every `startBuild` ctx into
 * `startBuildContexts`. */
export function fixedBuildOutcomeDriver(
	outcome: BuildOutcome,
	error?: Error,
): Driver & { startBuildContexts: BuildContext[] } {
	const startBuildContexts: BuildContext[] = [];
	return {
		available: true,
		startBuildContexts,
		async init() {},
		async startBuild(ctx) {
			startBuildContexts.push(ctx);
			if (error) throw error;
			return outcome;
		},
		async abortBuild() {},
		async startRun() {
			throw new Error('not used by this stub');
		},
		async abortRun() {},
		async reconcileOrphans() {},
		async probeDevFolder() {
			throw new Error('not used by this stub');
		},
		async ensureProbeImage() {
			throw new Error('not used by this stub');
		},
		async inspectDebugTarget() {
			throw new Error('not used by this stub');
		},
	};
}

/**
 * A driver whose `startRun` does not settle until the test calls `resolveRun`/`rejectRun` - for testing
 * an abort that races an in-flight run. `started` resolves once `startRun` has actually been invoked
 * (i.e. `runInBackground` got past every guard and is genuinely "in the container"), so a test can
 * `await it` before calling `abortRun` instead of guessing at timing. `startRunCalls`/`abortRunCalls`
 * record every run id passed to each method, so a test can also assert a container was (or, for the
 * pre-start-window case, was *not*) ever started.
 */
export interface DeferredRunDriver extends Driver {
	started: Promise<void>;
	startRunCalls: string[];
	abortRunCalls: string[];
	resolveRun(outcome: RunOutcome): void;
	rejectRun(error: Error): void;
}

export function deferredRunDriver(): DeferredRunDriver {
	let resolveRun!: (outcome: RunOutcome) => void;
	let rejectRun!: (error: Error) => void;
	const runOutcome = new Promise<RunOutcome>((resolve, reject) => {
		resolveRun = resolve;
		rejectRun = reject;
	});
	let signalStarted!: () => void;
	const started = new Promise<void>((resolve) => {
		signalStarted = resolve;
	});
	const startRunCalls: string[] = [];
	const abortRunCalls: string[] = [];

	return {
		available: true,
		startRunCalls,
		abortRunCalls,
		started,
		resolveRun: (outcome) => resolveRun(outcome),
		rejectRun: (error) => rejectRun(error),
		async init() {},
		async startBuild() {
			throw new Error('not used by this stub');
		},
		async abortBuild() {},
		async startRun(ctx) {
			startRunCalls.push(ctx.runId);
			signalStarted();
			return runOutcome;
		},
		async abortRun(runId) {
			abortRunCalls.push(runId);
		},
		async reconcileOrphans() {},
		async probeDevFolder() {
			throw new Error('not used by this stub');
		},
		async ensureProbeImage() {
			throw new Error('not used by this stub');
		},
		async inspectDebugTarget() {
			throw new Error('not used by this stub');
		},
	};
}

/** Same idea as `deferredRunDriver`, but for builds. */
export interface DeferredBuildDriver extends Driver {
	started: Promise<void>;
	startBuildCalls: string[];
	abortBuildCalls: string[];
	resolveBuild(outcome: BuildOutcome): void;
	rejectBuild(error: Error): void;
}

export function deferredBuildDriver(): DeferredBuildDriver {
	let resolveBuild!: (outcome: BuildOutcome) => void;
	let rejectBuild!: (error: Error) => void;
	const buildOutcome = new Promise<BuildOutcome>((resolve, reject) => {
		resolveBuild = resolve;
		rejectBuild = reject;
	});
	let signalStarted!: () => void;
	const started = new Promise<void>((resolve) => {
		signalStarted = resolve;
	});
	const startBuildCalls: string[] = [];
	const abortBuildCalls: string[] = [];

	return {
		available: true,
		startBuildCalls,
		abortBuildCalls,
		started,
		resolveBuild: (outcome) => resolveBuild(outcome),
		rejectBuild: (error) => rejectBuild(error),
		async init() {},
		async startBuild(ctx) {
			startBuildCalls.push(ctx.buildId);
			signalStarted();
			return buildOutcome;
		},
		async abortBuild(buildId) {
			abortBuildCalls.push(buildId);
		},
		async startRun() {
			throw new Error('not used by this stub');
		},
		async abortRun() {},
		async reconcileOrphans() {},
		async probeDevFolder() {
			throw new Error('not used by this stub');
		},
		async ensureProbeImage() {
			throw new Error('not used by this stub');
		},
		async inspectDebugTarget() {
			throw new Error('not used by this stub');
		},
	};
}

/**
 * Same idea as `deferredRunDriver`, but tracking an arbitrary number of runs *concurrently* rather than
 * exactly one - needed for the events-websocket integration tests, which need two independently
 * controllable runs open at once (`deferredRunDriver`'s single `started`/`resolveRun` pair cannot express
 * that). Also captures each run's own `onSample` callback (`Driver.startRun`'s optional third parameter)
 * so a test can simulate the driver's per-second sampler ticking - `emitSample` - without a real Docker
 * daemon or a real 1000ms wait.
 */
export interface MultiRunDriver extends Driver {
	abortRunCalls: string[];
	/** Resolves once `startRun` has actually been called for `runId` - mirrors `deferredRunDriver`'s
	 * `started`, per-run. */
	waitForStart(runId: string): Promise<void>;
	resolveRun(runId: string, outcome: RunOutcome): void;
	rejectRun(runId: string, error: Error): void;
	/** Invokes `runId`'s own captured `onSample` callback, if `startRun` was ever called with one -
	 * simulates one sampler tick. A no-op (never throws) if `startRun` hasn't been called for `runId` yet,
	 * or was called without an `onSample` at all. */
	emitSample(runId: string, sample: RunResourceSample): void;
}

interface MultiRunState {
	startedResolve: () => void;
	started: Promise<void>;
	outcomeResolve: (outcome: RunOutcome) => void;
	outcomeReject: (error: Error) => void;
	outcomePromise: Promise<RunOutcome>;
	onSample?: (sample: RunResourceSample) => void;
}

export function multiRunDriver(): MultiRunDriver {
	const states = new Map<string, MultiRunState>();
	const abortRunCalls: string[] = [];

	function getOrCreateState(runId: string): MultiRunState {
		let state = states.get(runId);
		if (!state) {
			let startedResolve!: () => void;
			const started = new Promise<void>((resolve) => {
				startedResolve = resolve;
			});
			let outcomeResolve!: (outcome: RunOutcome) => void;
			let outcomeReject!: (error: Error) => void;
			const outcomePromise = new Promise<RunOutcome>((resolve, reject) => {
				outcomeResolve = resolve;
				outcomeReject = reject;
			});
			state = { startedResolve, started, outcomeResolve, outcomeReject, outcomePromise };
			states.set(runId, state);
		}
		return state;
	}

	return {
		available: true,
		abortRunCalls,
		async init() {},
		async startBuild() {
			throw new Error('not used by this stub');
		},
		async abortBuild() {},
		async startRun(ctx, _onLog, onSample) {
			const state = getOrCreateState(ctx.runId);
			state.onSample = onSample;
			state.startedResolve();
			return state.outcomePromise;
		},
		async abortRun(runId) {
			abortRunCalls.push(runId);
		},
		async reconcileOrphans() {},
		async probeDevFolder() {
			throw new Error('not used by this stub');
		},
		async ensureProbeImage() {
			throw new Error('not used by this stub');
		},
		async inspectDebugTarget() {
			throw new Error('not used by this stub');
		},
		async waitForStart(runId) {
			return getOrCreateState(runId).started;
		},
		resolveRun(runId, outcome) {
			getOrCreateState(runId).outcomeResolve(outcome);
		},
		rejectRun(runId, error) {
			getOrCreateState(runId).outcomeReject(error);
		},
		emitSample(runId, sample) {
			getOrCreateState(runId).onSample?.(sample);
		},
	};
}

export interface TestServerHandle {
	client: ApifyClient;
	baseUrl: string;
	/** `baseUrl`, `ws://`-scheméd - the same host:port, since the events websocket upgrades on this same
	 * server (`api/events-ws.ts`), never a second one. Build a run's own events URL by appending
	 * `/actor-runtime/events/:runId`, exactly like `services/runs.ts: buildEnv` does against the real
	 * `CONTAINER_EVENTS_WS_BASE_URL`. */
	wsBaseUrl: string;
	token: string;
	dataDir: string;
	driver: Driver;
	close(): Promise<void>;
}

/** Default token `startTestServer()` builds its `client` with. No user is created eagerly any more (no
 * startup-created default user) - the underlying user is minted ad-hoc on whichever request happens to
 * be the first to actually use `client`/`token` (`services/users.ts: getOrCreateUserForToken()`), same
 * as against the real runtime. Tests that need a *second*, distinct user pass their own `token` to
 * `startTestServer` (or make requests with another `ApifyClient`/token against the same `baseUrl`). */
const DEFAULT_TEST_TOKEN = 'test-default-token';

export async function startTestServer(
	driver: Driver = unavailableDriver(),
	token: string = DEFAULT_TEST_TOKEN,
): Promise<TestServerHandle> {
	const dataDir = await mkdtemp(join(tmpdir(), 'actor-runtime-test-'));
	bootstrapStorage(dataDir);
	await openRegistries();

	const app = createApiServer({ driver });
	const server: Server = await new Promise((resolve) => {
		const s = app.listen(0, () => resolve(s));
	});
	const { port } = server.address() as AddressInfo;
	const baseUrl = `http://127.0.0.1:${port}`;
	const wsBaseUrl = `ws://127.0.0.1:${port}`;
	// Same server, same upgrade path as production (`index.ts`) - a real `ws` client against this handle
	// exercises the actual `api/events-ws.ts` code, not a stand-in.
	const eventsWebSocketServer = attachEventsWebSocket(server);

	// maxRetries: 0 - real apify-client retries 5xx (so a deliberate 501 from the request-deletion
	// endpoints would otherwise burn ~8 exponential-backoff retries per test); production behaviour is
	// unaffected, this only speeds up the test suite.
	const client = new ApifyClient({ baseUrl, token, maxRetries: 0 });

	return {
		client,
		baseUrl,
		wsBaseUrl,
		token,
		dataDir,
		driver,
		async close() {
			// MUST run before `server.close()` below, not after - see `EventsWebSocketServer.close()`'s
			// own doc comment (`api/events-ws.ts`) for why `closeAllConnections()` cannot do this itself;
			// same ordering requirement `shutdown.ts`'s `gracefulShutdown` follows in production.
			eventsWebSocketServer.close();
			await new Promise<void>((resolve) => {
				server.close(() => resolve());
				server.closeAllConnections();
			});
			stopLogFlusher();
			resetLogsForTests();
			resetEventsChannelForTests();
			await shutdownStorage();
			resetStorageForTests();
			resetRegistriesForTests();
			resetUsersForTests();
			resetApiFallbackStateForTests();
			// A background write (late log flush, run-record update) can land while the tree is
			// being removed, recreating entries under an already-emptied directory — seen in CI as
			// ENOTEMPTY. fs.rm retries exactly that class of error when maxRetries is set.
			await rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
		},
	};
}

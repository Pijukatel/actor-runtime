import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import { ApifyClient } from 'apify-client';

import { bootstrapStorage, resetStorageForTests, shutdownStorage } from '../../../src/storage/bootstrap.js';
import { openRegistries, resetRegistriesForTests } from '../../../src/storage/registries.js';
import { bootstrapDefaultUser, resetDefaultUserCacheForTests } from '../../../src/services/users.js';
import { createApiServer } from '../../../src/api/server.js';
import { resetLogsForTests, stopLogFlusher } from '../../../src/services/logs.js';
import type { BuildOutcome, Driver, RunOutcome } from '../../../src/driver/types.js';

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
	};
}

/** Same idea as `fixedRunOutcomeDriver`, but for builds: `startBuild` either resolves with `outcome` or
 * rejects with `error`, whichever the caller supplies (`error` wins if both are given, so a
 * `DriverTimedOutError` can be asserted straight through to a `TIMED-OUT` status). */
export function fixedBuildOutcomeDriver(outcome: BuildOutcome, error?: Error): Driver {
	return {
		available: true,
		async init() {},
		async startBuild() {
			if (error) throw error;
			return outcome;
		},
		async abortBuild() {},
		async startRun() {
			throw new Error('not used by this stub');
		},
		async abortRun() {},
		async reconcileOrphans() {},
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
	};
}

export interface TestServerHandle {
	client: ApifyClient;
	baseUrl: string;
	token: string;
	dataDir: string;
	driver: Driver;
	close(): Promise<void>;
}

export async function startTestServer(driver: Driver = unavailableDriver()): Promise<TestServerHandle> {
	const dataDir = await mkdtemp(join(tmpdir(), 'actor-runtime-test-'));
	bootstrapStorage(dataDir);
	await openRegistries();
	const user = await bootstrapDefaultUser();

	const app = createApiServer({ driver });
	const server: Server = await new Promise((resolve) => {
		const s = app.listen(0, () => resolve(s));
	});
	const { port } = server.address() as AddressInfo;
	const baseUrl = `http://127.0.0.1:${port}`;

	// maxRetries: 0 - real apify-client retries 5xx (so a deliberate 501 from the request-deletion
	// endpoints would otherwise burn ~8 exponential-backoff retries per test); production behaviour is
	// unaffected, this only speeds up the test suite.
	const client = new ApifyClient({ baseUrl, token: user.token, maxRetries: 0 });

	return {
		client,
		baseUrl,
		token: user.token,
		dataDir,
		driver,
		async close() {
			await new Promise<void>((resolve) => server.close(() => resolve()));
			stopLogFlusher();
			resetLogsForTests();
			await shutdownStorage();
			resetStorageForTests();
			resetRegistriesForTests();
			resetDefaultUserCacheForTests();
			await rm(dataDir, { recursive: true, force: true });
		},
	};
}

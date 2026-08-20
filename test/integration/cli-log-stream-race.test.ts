/**
 * Regression test for the CI e2e failure on commit b00a23a: `npx apify-cli apify call --json` exited 13
 * with empty stdout and Node's "Detected unsettled top-level await" warning pointing at apify-cli's
 * `outputJobLog` (`src/lib/utils.ts`). That function's promise is resolved *only* by the log stream's
 * `'end'` event (no `'error'` handler, and `apify call` never passes a `timeoutMillis`), so anything that
 * lets the server's `?stream=true` response end without ever delivering a clean stream 'end' to the
 * client hangs the CLI forever.
 *
 * This drives the *real* `apify-client` (`node_modules/apify-client`, the same package apify-cli embeds)
 * against the real HTTP server (`startTestServer`), replicating two things `outputJobLog` actually does
 * that no existing `logs.test.ts` case does:
 *
 *  1. The exact promise-settlement pattern: `stream.on('data', ...)`, `stream.once('end', resolve)`, no
 *     `'error'` listener, no timeout - so if the stream ever ends via `'error'`/`'close'` instead of
 *     `'end'`, this reproduces the hang instead of masking it.
 *  2. The exact request sequence `apify call` makes on *one* `ApifyClient` instance (keep-alive `httpAgent`,
 *     `src/http_client.ts`): `actor(id).start(input, { waitForFinish: 2 })` immediately followed by
 *     `log(id).stream()` - i.e. the log stream request can land on a socket the server *just* finished a
 *     different (held-open, `waitForFinish`) response on, not a fresh connection.
 *
 * Sweeps the offset between "the run turns terminal" and "the log stream request lands" across the exact
 * boundary `waitForFinish: 2` produces (run finishes just before/at/after the 2s mark - matching a fast
 * Actor run like `maxPages: 1`, which is exactly the case that failed in CI), rather than asserting only
 * one hand-picked timing.
 */
import { setTimeout as delay } from 'node:timers/promises';

import { afterEach, describe, expect, it } from 'vitest';
import { ApifyClient } from 'apify-client';

import { startTestServer, type TestServerHandle } from './helpers/test-server.js';
import { getRegistries } from '../../src/storage/registries.js';
import { generateId } from '../../src/storage/ids.js';
import { recordTaggedBuild, updateActor } from '../../src/services/actors.js';
import { appendLog } from '../../src/services/logs.js';
import { runInBackground } from '../../src/services/runs.js';
import type { ActorRecord, BuildRecord, RunRecord } from '../../src/storage/entities.js';
import type { Driver, RunOutcome } from '../../src/driver/types.js';

async function seedActor(server: TestServerHandle, name: string): Promise<ActorRecord> {
	const created = await server.client.actors().create({ name });
	return (await getRegistries().actors.get(created.id))!;
}

async function seedSucceededBuild(actor: ActorRecord): Promise<BuildRecord> {
	const build: BuildRecord = {
		id: generateId(),
		userId: actor.userId,
		actorId: actor.id,
		versionNumber: '0.0',
		buildNumber: '0.0.1',
		tag: 'latest',
		status: 'SUCCEEDED',
		startedAt: new Date().toISOString(),
		finishedAt: new Date().toISOString(),
		imageId: 'fake-image:latest',
	};
	await getRegistries().builds.set(build.id, build);
	return build;
}

/**
 * A driver whose `startRun` resolves exactly `resolveAfterMs` after being called, having called `onLog`
 * once immediately (mirrors the run's early output) and once more (the trailing "Crawl finished."-style
 * line) right before resolving - the exact `onLog`-then-resolve ordering `docker-driver.ts` guarantees
 * for the real driver (log drain completes, *then* `startRun` resolves).
 */
function timedDriver(resolveAfterMs: number): Driver {
	return {
		available: true,
		async init() {},
		async startBuild() {
			throw new Error('not used by this stub');
		},
		async abortBuild() {},
		async startRun(ctx, onLog) {
			onLog('line 1\n');
			await delay(resolveAfterMs);
			onLog('Crawl finished.\n');
			const outcome: RunOutcome = { exitCode: 0, timedOut: false };
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
	};
}

function bareRunRecord(actor: ActorRecord, build: BuildRecord): RunRecord {
	return {
		id: generateId(),
		userId: actor.userId,
		actorId: actor.id,
		buildId: build.id,
		buildNumber: build.buildNumber,
		status: 'READY',
		startedAt: new Date().toISOString(),
		defaultDatasetId: 'd',
		defaultKeyValueStoreId: 'k',
		defaultRequestQueueId: 'r',
		options: { memoryMbytes: 1024, timeoutSecs: 300 },
		meta: { origin: 'API' },
	};
}

/** Replicates `apify-cli`'s `outputJobLog` (`src/lib/utils.ts:579-639`) *exactly*: resolves only on the
 * stream's `'end'` event, no `'error'` listener, no timeout. If this ever fails to settle, that is
 * precisely the CLI hang from the CI failure, not a proxy for it. */
function outputJobLogLike(stream: NodeJS.ReadableStream): Promise<'finished'> {
	return new Promise<'finished'>((resolve) => {
		stream.on('data', () => undefined);
		stream.once('end', () => resolve('finished'));
	});
}

describe('CLI log-stream race: apify-cli outputJobLog must always settle (regression for CI exit 13)', () => {
	let server: TestServerHandle;

	afterEach(async () => {
		// Guard, not just cleanup: every `it` above now closes its own server(s) via try/finally as it
		// goes, so this only catches a server that somehow never got closed (e.g. an exception before the
		// first `startTestServer()` call of a test ever assigns `server`). Without the guard, a still-
		// unassigned `server` here would throw and mask whatever the test itself failed with.
		if (server) await server.close();
	});

	it('a run that turns terminal at/around a waitForFinish=2 boundary never leaves the log stream promise unsettled', async () => {
		// One offset per attempt, straddling the exact 2000ms `waitForFinish` boundary `apify call` uses -
		// this is the tight window a fast (e.g. `maxPages: 1`) run can land in.
		const offsetsMs = [1700, 1900, 1950, 2000, 2020, 2050, 2100, 2200, 2500];
		const failures: string[] = [];

		for (const offsetMs of offsetsMs) {
			server = await startTestServer(timedDriver(offsetMs));
			try {
				const actor = await seedActor(server, `race-actor-${offsetMs}`);
				const build = await seedSucceededBuild(actor);
				await updateActor(actor.id, (current) =>
					recordTaggedBuild(current, 'latest', build.id, build.buildNumber),
				);

				// One ApifyClient instance for both calls, exactly like `runActorOrTaskOnCloud` - shares the
				// keep-alive `httpAgent`, so the log-stream request can reuse the socket the `start` call (held
				// open by `waitForFinish`) just released.
				const client = new ApifyClient({ baseUrl: server.baseUrl, token: server.token, maxRetries: 0 });

				const run = await client.actor(actor.id).start(undefined, { waitForFinish: 2 });

				let outcome: string;
				if (run.status !== 'RUNNING') {
					// Already terminal by the time `start` returned - `outputJobLog`'s non-stream branch, always safe.
					const log = await client.log(run.id).get();
					outcome = typeof log === 'string' ? 'finished' : 'no-logs';
				} else {
					const stream = await client.log(run.id).stream();
					if (!stream) {
						outcome = 'no-logs';
					} else {
						const settleOrTimeout = Promise.race([
							outputJobLogLike(stream),
							delay(5000).then(() => 'TIMED_OUT_UNSETTLED' as const),
						]);
						outcome = await settleOrTimeout;
					}
				}

				if (outcome === 'TIMED_OUT_UNSETTLED') {
					failures.push(`offset=${offsetMs}ms: outputJobLog-equivalent promise never settled within 5s`);
				}
			} finally {
				await server.close();
			}
		}

		expect(failures).toEqual([]);
	}, 120_000);

	it('the log stream settles promptly when opened exactly as the record turns terminal via the real HTTP driver path (tight loop, no stub timing assumptions)', async () => {
		// Drives `runInBackground` directly (as job-lifecycle.test.ts does) so the terminal transition's
		// timing relative to the log-stream request is controlled precisely, sweeping the offset between
		// "stream request issued" and "run finalized" across zero, so the exact instant of the transition
		// is exercised, not just comfortably-before/after it.
		const offsetsMs = [-20, -5, 0, 5, 20, 50];
		const failures: string[] = [];

		for (const offsetMs of offsetsMs) {
			server = await startTestServer();
			try {
				const actor = await seedActor(server, `tight-race-actor-${offsetMs}`);
				const build = await seedSucceededBuild(actor);
				const record = bareRunRecord(actor, build);
				await getRegistries().runs.set(record.id, record);

				// `resolveDriverRun` is assigned synchronously inside `startRun`, strictly before
				// `signalStarted()` is called - so awaiting `started` below guarantees the assignment has
				// already happened, regardless of how long `runInBackground`'s own setup (registry/version
				// lookups, the RUNNING transition) takes to actually reach `driver.startRun` on a loaded CI
				// runner. Without this, the `setTimeout` below races that setup: if `runInBackground` hasn't
				// called `startRun` yet by the time the timer fires, `resolveDriverRun` is still unassigned
				// and invoking it throws `TypeError: resolveDriverRun is not a function` from inside the
				// timer callback - exactly the CI failure this guards against.
				let resolveDriverRun!: (outcome: RunOutcome) => void;
				let signalStarted!: () => void;
				const started = new Promise<void>((resolve) => {
					signalStarted = resolve;
				});
				const driver: Driver = {
					available: true,
					async init() {},
					async startBuild() {
						throw new Error('n/a');
					},
					async abortBuild() {},
					async startRun(ctx, onLog) {
						onLog('line 1\n');
						const outcome = new Promise<RunOutcome>((resolve) => {
							resolveDriverRun = (result) => {
								onLog('Crawl finished.\n');
								resolve(result);
							};
						});
						signalStarted();
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
				};

				const bg = runInBackground(driver, actor, record, {
					apiBaseUrl: server.baseUrl,
					token: server.token,
				});

				// Wait for `resolveDriverRun` to actually be assigned before doing anything that might
				// schedule a call to it, then let the first appendLog land before opening the stream.
				await started;
				await delay(10);

				const openStream = async (): Promise<NodeJS.ReadableStream | undefined> =>
					server.client.log(record.id).stream();

				let stream: NodeJS.ReadableStream | undefined;
				let driverTimer: NodeJS.Timeout | undefined;
				try {
					if (offsetMs <= 0) {
						// Open the stream first, then finalize the run `-offsetMs` ms later.
						stream = await openStream();
						driverTimer = setTimeout(() => resolveDriverRun({ exitCode: 0, timedOut: false }), -offsetMs);
					} else {
						// Finalize first, then open the stream `offsetMs` ms later (job may already be terminal).
						resolveDriverRun({ exitCode: 0, timedOut: false });
						await delay(offsetMs);
						stream = await openStream();
					}

					if (!stream) {
						failures.push(`offset=${offsetMs}ms: log().stream() returned undefined`);
					} else {
						const settleOrTimeout = Promise.race([
							outputJobLogLike(stream),
							delay(5000).then(() => 'TIMED_OUT_UNSETTLED' as const),
						]);
						const outcome = await settleOrTimeout;
						if (outcome === 'TIMED_OUT_UNSETTLED') {
							failures.push(
								`offset=${offsetMs}ms: outputJobLog-equivalent promise never settled within 5s`,
							);
						}
					}
				} finally {
					clearTimeout(driverTimer);
				}

				await bg;
			} finally {
				await server.close();
			}
		}

		expect(failures).toEqual([]);
	}, 120_000);

	it('appendLog after the stream has already ended (subscriber unsubscribed) never throws / never reopens the promise', async () => {
		server = await startTestServer();
		const actor = await seedActor(server, 'late-append-actor');
		const build = await seedSucceededBuild(actor);
		const record = bareRunRecord(actor, build);
		record.status = 'RUNNING';
		await getRegistries().runs.set(record.id, record);

		appendLog(record.id, 'line 1\n');
		const stream = await server.client.log(record.id).stream();
		expect(stream).toBeDefined();

		const settled = outputJobLogLike(stream!);

		const { markLogTerminal } = await import('../../src/services/logs.js');
		setTimeout(() => {
			appendLog(record.id, 'line 2\n');
			markLogTerminal(record.id);
		}, 50);

		const outcome = await Promise.race([settled, delay(5000).then(() => 'TIMED_OUT_UNSETTLED' as const)]);
		expect(outcome).toBe('finished');

		// A late appendLog for the same id, after the stream already ended, must not throw synchronously
		// (it would be an uncaught exception inside whatever calls it in production).
		expect(() => appendLog(record.id, 'late line, after end\n')).not.toThrow();
	});

	it("stress: many trials with randomized tight timing, the periodic flusher running, and unrelated concurrent traffic never leave the stream unsettled (regression for a low-probability race, cf. iter-12's 0.23%-under-flusher finding)", async () => {
		const { startLogFlusher, stopLogFlusher } = await import('../../src/services/logs.js');
		const TRIALS = 60;
		const failures: string[] = [];

		for (let trial = 0; trial < TRIALS; trial++) {
			server = await startTestServer();
			try {
				startLogFlusher();
				const actor = await seedActor(server, `stress-actor-${trial}`);
				const build = await seedSucceededBuild(actor);
				const record = bareRunRecord(actor, build);
				await getRegistries().runs.set(record.id, record);

				let resolveDriverRun!: (outcome: RunOutcome) => void;
				let signalStarted!: () => void;
				const started = new Promise<void>((resolve) => {
					signalStarted = resolve;
				});
				const driver: Driver = {
					available: true,
					async init() {},
					async startBuild() {
						throw new Error('n/a');
					},
					async abortBuild() {},
					async startRun(ctx, onLog) {
						onLog('line 1\n');
						const outcome = new Promise<RunOutcome>((resolve) => {
							resolveDriverRun = (result) => {
								onLog('Crawl finished.\n');
								resolve(result);
							};
						});
						signalStarted();
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
				};

				const bg = runInBackground(driver, actor, record, {
					apiBaseUrl: server.baseUrl,
					token: server.token,
				});
				await started;

				// Unrelated concurrent traffic on the same server, mirroring real load (other API calls
				// happening while a log stream is open) instead of testing the stream in total isolation.
				const noise = (async () => {
					for (let i = 0; i < 5; i++) {
						await server.client
							.actors()
							.list()
							.catch(() => undefined);
						await delay(Math.random() * 5);
					}
				})();

				// Jitter around the transition instant itself - the tightest part of the window, on both sides.
				const jitterMs = Math.round((Math.random() - 0.5) * 40); // [-20, 20]

				let stream: NodeJS.ReadableStream | undefined;
				let driverTimer: NodeJS.Timeout | undefined;
				try {
					if (jitterMs <= 0) {
						stream = await server.client.log(record.id).stream();
						driverTimer = setTimeout(() => resolveDriverRun({ exitCode: 0, timedOut: false }), -jitterMs);
					} else {
						resolveDriverRun({ exitCode: 0, timedOut: false });
						await delay(jitterMs);
						stream = await server.client.log(record.id).stream();
					}

					if (!stream) {
						failures.push(`trial=${trial} jitter=${jitterMs}ms: log().stream() returned undefined`);
					} else {
						const outcome = await Promise.race([
							outputJobLogLike(stream),
							delay(4000).then(() => 'TIMED_OUT_UNSETTLED' as const),
						]);
						if (outcome === 'TIMED_OUT_UNSETTLED') {
							failures.push(
								`trial=${trial} jitter=${jitterMs}ms: outputJobLog-equivalent promise never settled within 4s`,
							);
						}
					}
				} finally {
					clearTimeout(driverTimer);
				}

				await bg;
				await noise;
			} finally {
				stopLogFlusher();
				await server.close();
			}
		}

		expect(failures).toEqual([]);
	}, 180_000);
});

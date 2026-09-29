/**
 * `?gracefully=` abort contract (the abort entry in `src/api/openapi/actor-runtime.json`'s
 * `x-actor-runtime-platform-notes`,
 * `GRACEFUL_ABORT_WINDOW_MS = 30000`): the `aborting` frame published before the fixed wait,
 * `driver.abortRun` withheld until the window elapses, the omitted/`false` path staying byte-identical to
 * an immediate abort, best-effort behavior with nobody connected, the READY-state and already-terminal
 * short-circuits, and two concurrent abort calls racing the same window (a second graceful call joins
 * rather than restarting it; a second hard call escalates past it). The second `describe` below exercises
 * the same contract over a real HTTP round trip (`apify-client`), not just direct `abortRun` calls.
 *
 * Split out of `job-lifecycle.test.ts` (which had grown past 1000 lines once these two `describe` blocks
 * were added, making both suites harder to navigate) - every test below is unchanged from that file,
 * byte-for-byte; only the imports and the small set of shared setup helpers the split needs were copied over.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	deferredRunDriver,
	fixedRunOutcomeDriver,
	startTestServer,
	type TestServerHandle,
} from './helpers/test-server.js';
import { getRegistries } from '../../src/storage/registries.js';
import { generateId } from '../../src/storage/ids.js';
import { recordTaggedBuild, updateActor } from '../../src/services/actors.js';
import { abortRun, runInBackground } from '../../src/services/runs.js';
import { subscribeEvents } from '../../src/services/events-channel.js';
import { realDelay } from './helpers/fake-timers.js';
import type { Driver } from '../../src/driver/types.js';
import type { ActorRecord, BuildRecord, JobStatus, RunRecord } from '../../src/storage/entities.js';

/** Creates an Actor via the real client (so it has a genuine owner) and returns the underlying
 * `ActorRecord` for direct service-layer calls. */
async function seedActor(server: TestServerHandle, name: string): Promise<ActorRecord> {
	const created = await server.client.actors().create({ name });
	return (await getRegistries().actors.get(created.id))!;
}

/** A SUCCEEDED build with a fake image, seeded directly (bypassing the driver) - mirrors the pattern
 * already used by `actors-builds-runs.test.ts`. */
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

/** Fails the test immediately (rather than hanging) if the driver is ever asked to start a run/build -
 * used to assert the pre-start abort window really does prevent a container/build from ever starting. */
function neverStartDriver(): Driver & { abortRunCalls: string[]; abortBuildCalls: string[] } {
	const abortRunCalls: string[] = [];
	const abortBuildCalls: string[] = [];
	return {
		available: true,
		abortRunCalls,
		abortBuildCalls,
		async init() {},
		async startBuild() {
			throw new Error('startBuild must never be called once the record is already ABORTING');
		},
		async abortBuild(buildId) {
			abortBuildCalls.push(buildId);
		},
		async startRun() {
			throw new Error('startRun must never be called once the record is already ABORTING');
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
		async startBrowserViewer() {
			throw new Error('not used by this stub');
		},
		async stopBrowserViewer() {},
		async containerServerAddress() {
			return undefined;
		},
		async inspectDebugTarget() {
			throw new Error('not used by this stub');
		},
	};
}

/**
 * Real-time polling (never gated by a fake `setTimeout`) for a run's status as observed over a real HTTP
 * `GET`, via `apify-client`. Used where the awaited status is one the background graceful-abort window
 * writes, which no HTTP response of the caller's own is tied to any more.
 */
async function pollForRunStatus(
	server: TestServerHandle,
	runId: string,
	status: JobStatus,
	timeoutMs = 3000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const current = await server.client.run(runId).get();
		if (current?.status === status) return;
		if (Date.now() > deadline) {
			throw new Error(
				`timed out waiting for run ${runId} to reach status ${status} (last seen: ${current?.status})`,
			);
		}
		await realDelay(10);
	}
}

/** Polls the run record in real time until it reaches `status`: advancing the fake clock past the window
 * only proves its timer fired, not that the real fs-storage write it kicks off has landed. */
async function waitForRecordStatus(runId: string, status: JobStatus, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const current = await getRegistries().runs.get(runId);
		if (current?.status === status) return;
		if (Date.now() > deadline) {
			throw new Error(
				`timed out waiting for run ${runId} to reach status ${status} (last seen: ${current?.status})`,
			);
		}
		await realDelay(5);
	}
}

describe('graceful abort (?gracefully=) contract', () => {
	let server: TestServerHandle;

	afterEach(async () => {
		await server.close();
	});

	describe("graceful abort (?gracefully= contract per the abort entry in src/api/openapi/actor-runtime.json's x-actor-runtime-platform-notes, GRACEFUL_ABORT_WINDOW_MS = 30000)", () => {
		afterEach(() => {
			vi.useRealTimers();
		});

		it('gracefully omitted is byte-identical to today: driver.abortRun is called immediately, no aborting frame, no wait', async () => {
			const driver = deferredRunDriver();
			server = await startTestServer(driver);
			const actor = await seedActor(server, 'graceful-omitted-actor');
			const build = await seedSucceededBuild(actor);
			const record = bareRunRecord(actor, build);
			await getRegistries().runs.set(record.id, record);

			const frames: string[] = [];
			const unsubscribe = subscribeEvents(record.id, (frame) => frames.push(frame));

			const bg = runInBackground(driver, actor, record, { apiBaseUrl: server.baseUrl, token: server.token });
			await driver.started;

			const aborted = await abortRun(driver, record); // gracefully omitted entirely
			expect(aborted?.status).toBe('ABORTED');
			expect(driver.abortRunCalls).toEqual([record.id]);
			expect(frames).toEqual([]);

			driver.resolveRun({ exitCode: 137, timedOut: false });
			await bg;
			unsubscribe();
		});

		it('gracefully: false is explicitly the same as omitted', async () => {
			const driver = deferredRunDriver();
			server = await startTestServer(driver);
			const actor = await seedActor(server, 'graceful-false-actor');
			const build = await seedSucceededBuild(actor);
			const record = bareRunRecord(actor, build);
			await getRegistries().runs.set(record.id, record);

			const bg = runInBackground(driver, actor, record, { apiBaseUrl: server.baseUrl, token: server.token });
			await driver.started;

			const aborted = await abortRun(driver, record, false);
			expect(aborted?.status).toBe('ABORTED');
			expect(driver.abortRunCalls).toEqual([record.id]);

			driver.resolveRun({ exitCode: 137, timedOut: false });
			await bg;
		});

		it('gracefully: true publishes exactly {"name":"aborting","data":{}} before driver.abortRun, returns the ABORTING record immediately rather than holding the caller for the window, and only calls driver.abortRun once the full 30000ms window has elapsed', async () => {
			const driver = deferredRunDriver();
			server = await startTestServer(driver);
			const actor = await seedActor(server, 'graceful-true-actor');
			const build = await seedSucceededBuild(actor);
			const record = bareRunRecord(actor, build);
			await getRegistries().runs.set(record.id, record);

			const frames: string[] = [];
			const unsubscribe = subscribeEvents(record.id, (frame) => frames.push(frame));

			const bg = runInBackground(driver, actor, record, { apiBaseUrl: server.baseUrl, token: server.token });
			await driver.started;

			// Faked only from here on, and only `setTimeout`/`clearTimeout` - `abortRun`'s 30s wait is the
			// only thing this test needs virtual control over. Deliberately NOT `Date` and NOT
			// `setImmediate`: the registry writes below go through `@crawlee/fs-storage`'s real
			// (native-addon-backed) storage layer, which this sandbox found does not tolerate a frozen
			// `Date.now()` - a write can silently read back stale under a fully-fake clock. Leaving `Date`
			// and `setImmediate` real costs nothing here: nothing in this test asserts on wall-clock time
			// itself, only on `setTimeout`'s own virtual schedule.
			vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

			// The specification's abort platform note: the call answers as soon as the record is ABORTING and
			// never blocks its caller (and so never holds an HTTP response open) for the 30s.
			const armed = await abortRun(driver, record, true);
			expect(armed?.status).toBe('ABORTING');

			const midWindow = await getRegistries().runs.get(record.id);
			expect(midWindow?.status).toBe('ABORTING');
			// The platform's graceful-abort frame pair, in this order, before the wait.
			expect(frames).toEqual([
				JSON.stringify({ name: 'aborting', data: {} }),
				JSON.stringify({ name: 'persistState', data: { isMigrating: false } }),
			]);
			expect(driver.abortRunCalls).toEqual([]);

			// Just under the window: still not called.
			await vi.advanceTimersByTimeAsync(29_999);
			expect(driver.abortRunCalls).toEqual([]);

			// At the window: now called, and the background window writes the terminal status.
			await vi.advanceTimersByTimeAsync(1);
			expect(driver.abortRunCalls).toEqual([record.id]);
			await waitForRecordStatus(record.id, 'ABORTED');

			driver.resolveRun({ exitCode: 137, timedOut: false });
			await bg;
			unsubscribe();
		});

		it("ends the window early when the Actor's own container exits inside it: the run is finalized ABORTED there and then, never left ABORTING for the remaining seconds", async () => {
			const driver = deferredRunDriver();
			server = await startTestServer(driver);
			const actor = await seedActor(server, 'graceful-early-exit-actor');
			const build = await seedSucceededBuild(actor);
			const record = bareRunRecord(actor, build);
			await getRegistries().runs.set(record.id, record);

			const bg = runInBackground(driver, actor, record, { apiBaseUrl: server.baseUrl, token: server.token });
			await driver.started;

			vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

			const armed = await abortRun(driver, record, true);
			expect(armed?.status).toBe('ABORTING');

			// The Actor honours the `aborting` frame and exits one second in.
			await vi.advanceTimersByTimeAsync(1_000);
			driver.resolveRun({ exitCode: 137, timedOut: false });
			await bg;

			expect((await getRegistries().runs.get(record.id))?.status).toBe('ABORTED');

			// And the cancelled window never fires afterwards.
			await vi.advanceTimersByTimeAsync(30_000);
			expect(driver.abortRunCalls).toEqual([]);
			expect((await getRegistries().runs.get(record.id))?.status).toBe('ABORTED');
		});

		it('gracefully: true with nobody connected to the events socket is still best-effort - the abort request itself still succeeds and the container is still stopped after the window elapses', async () => {
			const driver = deferredRunDriver();
			server = await startTestServer(driver);
			const actor = await seedActor(server, 'graceful-no-subscriber-actor');
			const build = await seedSucceededBuild(actor);
			const record = bareRunRecord(actor, build);
			await getRegistries().runs.set(record.id, record);
			// Deliberately no `subscribeEvents(record.id, ...)` call at all - nobody is connected.

			const bg = runInBackground(driver, actor, record, { apiBaseUrl: server.baseUrl, token: server.token });
			await driver.started;

			vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
			const armed = await abortRun(driver, record, true);
			expect(armed?.status).toBe('ABORTING');
			await vi.advanceTimersByTimeAsync(30_000);

			await waitForRecordStatus(record.id, 'ABORTED');
			expect(driver.abortRunCalls).toEqual([record.id]);

			driver.resolveRun({ exitCode: 137, timedOut: false });
			await bg;
		});

		it('gracefully: true against a READY-state abort (no container yet) keeps the immediate ABORTING -> ABORTED path - no 30s wait, no aborting frame', async () => {
			const driver = neverStartDriver();
			server = await startTestServer(driver);
			const actor = await seedActor(server, 'graceful-ready-state-actor');
			const build = await seedSucceededBuild(actor);
			const record = bareRunRecord(actor, build); // status READY, no container ever created
			await getRegistries().runs.set(record.id, record);

			const frames: string[] = [];
			const unsubscribe = subscribeEvents(record.id, (frame) => frames.push(frame));

			const aborted = await abortRun(driver, record, true);

			expect(aborted?.status).toBe('ABORTED');
			expect(driver.abortRunCalls).toEqual([record.id]);
			expect(frames).toEqual([]); // no container running - no aborting frame, no wait

			unsubscribe();
		});

		it('gracefully: true is a no-op on an already-terminal run, same as gracefully omitted', async () => {
			server = await startTestServer(fixedRunOutcomeDriver({ exitCode: 0, timedOut: false }));
			const actor = await seedActor(server, 'graceful-terminal-actor');
			const build = await seedSucceededBuild(actor);
			const record = bareRunRecord(actor, build);
			const terminalRecord: RunRecord = { ...record, status: 'SUCCEEDED', finishedAt: new Date().toISOString() };
			await getRegistries().runs.set(record.id, terminalRecord);

			const aborted = await abortRun(server.driver, terminalRecord, true);
			expect(aborted?.status).toBe('SUCCEEDED');
		});

		it('a second ?gracefully=true call arriving while a first graceful window is still open does not defeat it: it no-ops (joins, no early stop), and the window still ends in exactly one driver.abortRun call', async () => {
			const driver = deferredRunDriver();
			server = await startTestServer(driver);
			const actor = await seedActor(server, 'graceful-double-graceful-actor');
			const build = await seedSucceededBuild(actor);
			const record = bareRunRecord(actor, build);
			await getRegistries().runs.set(record.id, record);

			const bg = runInBackground(driver, actor, record, { apiBaseUrl: server.baseUrl, token: server.token });
			await driver.started;

			vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

			const firstResult = await abortRun(driver, record, true);
			expect(firstResult?.status).toBe('ABORTING');
			const midWindow = await getRegistries().runs.get(record.id);
			expect(midWindow?.status).toBe('ABORTING');
			expect(driver.abortRunCalls).toEqual([]);

			// The second call re-fetches the record first, exactly as the real HTTP route does via
			// `getOwnedRun`: `abortRun` checks `isTerminalJobStatus(run.status)` on its `run` parameter
			// before ever touching the registry, so passing the first call's now-stale local object here
			// (instead of a freshly re-fetched one) would let this call observe a different status than a
			// genuinely concurrent second request actually would.
			const secondResult = await abortRun(driver, midWindow!, true);

			// The no-op join: the second call must not itself have started a window or called
			// driver.abortRun - it returns the record exactly as it stood (still ABORTING), immediately,
			// without waiting.
			expect(secondResult?.status).toBe('ABORTING');
			expect(driver.abortRunCalls).toEqual([]);

			// Just under the first call's own window: still not called - the second call did not shorten it.
			await vi.advanceTimersByTimeAsync(29_999);
			expect(driver.abortRunCalls).toEqual([]);

			// At the window: exactly one driver.abortRun call - the first caller's own, and only one.
			await vi.advanceTimersByTimeAsync(1);
			expect(driver.abortRunCalls).toEqual([record.id]);

			await waitForRecordStatus(record.id, 'ABORTED');

			driver.resolveRun({ exitCode: 137, timedOut: false });
			await bg;
		});

		it('a second, hard (?gracefully=false) call arriving while a graceful window is still open is a deliberate escalation: it cancels that window and stops the container immediately, and no stop lands 30s later against a container it already killed', async () => {
			const driver = deferredRunDriver();
			server = await startTestServer(driver);
			const actor = await seedActor(server, 'graceful-then-hard-actor');
			const build = await seedSucceededBuild(actor);
			const record = bareRunRecord(actor, build);
			await getRegistries().runs.set(record.id, record);

			const bg = runInBackground(driver, actor, record, { apiBaseUrl: server.baseUrl, token: server.token });
			await driver.started;

			vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

			const firstResult = await abortRun(driver, record, true);
			expect(firstResult?.status).toBe('ABORTING');
			const midWindow = await getRegistries().runs.get(record.id);
			expect(midWindow?.status).toBe('ABORTING');
			expect(driver.abortRunCalls).toEqual([]);

			// The escalation: a plain (hard) abort call, re-fetching the record first like the real HTTP
			// route does, stops the container right away - it does not wait out someone else's window.
			const secondResult = await abortRun(driver, midWindow!, false);
			expect(secondResult?.status).toBe('ABORTED');
			expect(driver.abortRunCalls).toEqual([record.id]);

			const afterEscalation = await getRegistries().runs.get(record.id);
			expect(afterEscalation?.status).toBe('ABORTED');

			// The cancelled window never fires against a container this call already killed.
			await vi.advanceTimersByTimeAsync(30_000);
			expect(driver.abortRunCalls).toEqual([record.id]);

			const final = await getRegistries().runs.get(record.id);
			expect(final?.status).toBe('ABORTED');

			driver.resolveRun({ exitCode: 137, timedOut: false });
			await bg;
		});
	});

	describe('?gracefully= exercised over a real HTTP round trip, not just direct service-layer calls', () => {
		afterEach(() => {
			vi.useRealTimers();
		});

		it("POST .../abort?gracefully=true (via apify-client, the actors-builds-runs.test.ts .abort() pattern) gets the full graceful contract: the HTTP response returns the run as ABORTING right away rather than being held for 30s, the aborting frame is emitted on the run's own events channel, and the container is stopped when the window elapses", async () => {
			const driver = deferredRunDriver();
			server = await startTestServer(driver);
			const actor = await seedActor(server, 'graceful-http-actor');
			const build = await seedSucceededBuild(actor);
			await updateActor(actor.id, (current) => recordTaggedBuild(current, 'latest', build.id, build.buildNumber));

			// A genuine run started through the real client - not a hand-seeded record - so the run id below
			// is one the HTTP abort route's own ownership check (`getOwnedRun`) actually resolves, exactly as
			// a real caller's request would.
			const started = await server.client.actor(actor.id).start({});
			await driver.started;
			expect(driver.startRunCalls).toEqual([started.id]);

			const frames: string[] = [];
			const unsubscribe = subscribeEvents(started.id, (frame) => frames.push(frame));

			vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

			// The real HTTP round trip: `apify-client`'s `RunClient.abort({gracefully:true})` issues
			// `POST /v2/actor-runs/:runId/abort?gracefully=true`, exercising `api/routes/runs.ts`'s own
			// `queryBoolean` parsing and its call into `abortRun` - never `abortRun` called directly, unlike
			// every other graceful-abort test in the "graceful abort" section above.
			// The response itself carries the run in ABORTING and arrives without waiting out the window.
			const armed = await server.client.run(started.id).abort({ gracefully: true });
			expect(armed.status).toBe('ABORTING');
			expect(frames).toEqual([
				JSON.stringify({ name: 'aborting', data: {} }),
				JSON.stringify({ name: 'persistState', data: { isMigrating: false } }),
			]);
			expect(driver.abortRunCalls).toEqual([]);

			// Just under the window: the response having already returned did not shorten the Actor's 30s.
			await vi.advanceTimersByTimeAsync(29_999);
			expect(driver.abortRunCalls).toEqual([]);

			// At the window: the container is stopped and the run reaches its terminal status.
			await vi.advanceTimersByTimeAsync(1);
			expect(driver.abortRunCalls).toEqual([started.id]);
			await pollForRunStatus(server, started.id, 'ABORTED');

			driver.resolveRun({ exitCode: 137, timedOut: false });
			unsubscribe();
		});

		it('POST .../abort with no gracefully parameter, over the same real HTTP round trip, still returns immediately with no wait (matches the specification\'s "omitted, or false" graceful-abort behavior end to end, not just at the service layer)', async () => {
			const driver = deferredRunDriver();
			server = await startTestServer(driver);
			const actor = await seedActor(server, 'immediate-http-actor');
			const build = await seedSucceededBuild(actor);
			await updateActor(actor.id, (current) => recordTaggedBuild(current, 'latest', build.id, build.buildNumber));

			const started = await server.client.actor(actor.id).start({});
			await driver.started;

			const frames: string[] = [];
			const unsubscribe = subscribeEvents(started.id, (frame) => frames.push(frame));

			const aborted = await server.client.run(started.id).abort();
			expect(aborted.status).toBe('ABORTED');
			expect(driver.abortRunCalls).toEqual([started.id]);
			expect(frames).toEqual([]);

			driver.resolveRun({ exitCode: 137, timedOut: false });
			unsubscribe();
		});
	});
});

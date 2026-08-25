/**
 * `GET /actor-runtime/events/:runId` - the events websocket (`api/events-ws.ts`), end to end against a
 * real `ws` client and a real server (`startTestServer`'s `wsBaseUrl`, `api/events-ws.ts` attached the
 * same way `index.ts` attaches it in production). Covers the events-endpoint contract documented in
 * `requirements/api.md`: `systemInfo` frame delivery, strict per-run isolation (no global/broadcast
 * channel), the `1008`/`1000` close-code lifecycle, and the `?gracefully=` `aborting` contract riding the
 * same socket.
 */
import { request } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { Socket } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

import {
	multiRunDriver,
	startTestServer,
	unavailableDriver,
	type MultiRunDriver,
	type TestServerHandle,
} from './helpers/test-server.js';
import { realDelay, waitForPendingTimer } from './helpers/fake-timers.js';
import { abortRun } from '../../src/services/runs.js';
import { getRegistries } from '../../src/storage/registries.js';
import { getSubscriberCount } from '../../src/services/events-channel.js';
import { generateId } from '../../src/storage/ids.js';
import { recordTaggedBuild, updateActor } from '../../src/services/actors.js';
import type { ActorRecord, BuildRecord, RunRecord } from '../../src/storage/entities.js';
import type { RunResourceSample } from '../../src/driver/types.js';

async function seedActor(server: TestServerHandle, name: string): Promise<ActorRecord> {
	const created = await server.client.actors().create({ name });
	return (await getRegistries().actors.get(created.id))!;
}

/** A SUCCEEDED build with a fake image, seeded directly (bypassing the driver, which `multiRunDriver`
 * cannot build with) - mirrors `job-lifecycle.test.ts`'s identical helper. */
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

/** Creates an Actor with a taggedBuild ready to run, and starts a run against it (not waiting for
 * finish) - the run stays `RUNNING`, its container controllable via the returned `driver`, until the
 * test calls `driver.resolveRun`/`abortRun`. */
async function seedRunnableRun(server: TestServerHandle, driver: MultiRunDriver, name: string): Promise<RunRecord> {
	const actor = await seedActor(server, name);
	const build = await seedSucceededBuild(actor);
	await updateActor(actor.id, (current) => recordTaggedBuild(current, 'latest', build.id, build.buildNumber));
	const started = await server.client.actor(actor.id).start({});
	await driver.waitForStart(started.id);
	return (await getRegistries().runs.get(started.id))!;
}

function sample(overrides: Partial<RunResourceSample> = {}): RunResourceSample {
	return {
		cpuPercentOfOneCore: 20,
		memoryBytes: 402_653_184,
		memoryLimitBytes: 1024 * 1024 * 1024,
		at: new Date(),
		...overrides,
	};
}

interface EventsSocket {
	ws: WebSocket;
	messages: Array<{ name: string; data: unknown }>;
	closed: Promise<{ code: number; reason: string }>;
}

function connectEventsSocket(server: TestServerHandle, runId: string): EventsSocket {
	const ws = new WebSocket(`${server.wsBaseUrl}/actor-runtime/events/${runId}`);
	const messages: Array<{ name: string; data: unknown }> = [];
	ws.on('message', (data) => {
		messages.push(JSON.parse(data.toString('utf8')));
	});
	const closed = new Promise<{ code: number; reason: string }>((resolve) => {
		ws.on('close', (code, reasonBuffer) => resolve({ code, reason: reasonBuffer.toString('utf8') }));
	});
	return { ws, messages, closed };
}

function waitForOpen(ws: WebSocket): Promise<void> {
	return new Promise((resolve, reject) => {
		ws.once('open', () => resolve());
		ws.once('error', reject);
	});
}

/**
 * The client's `open` event fires as soon as the HTTP upgrade handshake completes - `api/events-ws.ts`'s
 * own `handleConnection` is still an async function running *after* that (it resolves the run, then
 * subscribes), so a sample/frame published immediately after `waitForOpen` can race ahead of the actual
 * `subscribe()` call and be silently dropped (broadcast to zero subscribers, never replayed). Polling
 * `getSubscriberCount` - real-exported for exactly this kind of test synchronization (`events-channel.ts`'s
 * own doc comment) - waits out that gap deterministically before a test emits anything.
 */
async function waitForSubscribed(runId: string): Promise<void> {
	await waitFor(() => getSubscriberCount(runId) > 0);
}

/**
 * Real-time polling for an async condition driven by a real websocket message arriving over a real
 * loopback socket - genuine network I/O, never delivered in the same synchronous tick as the server-side
 * `publish*`/`ws.send()` call that triggered it. Deliberately polls via `realDelay` (`setInterval`, never
 * `setTimeout`): several of this file's tests fake `setTimeout` (to control `GRACEFUL_ABORT_WINDOW_MS`)
 * while a frame is still in flight over the real socket, and a `setTimeout`-based poll would hang forever
 * waiting on a fake timer nothing ever advances.
 */
async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error('waitFor: condition never became true in time');
		await realDelay(10);
	}
}

/**
 * Completes a real HTTP upgrade handshake for `runId` and hands back the raw underlying `net.Socket` -
 * bypassing the `ws` client library entirely, which (being a correct implementation) could never be made
 * to emit an actually-malformed frame. Used to reproduce an unhandled `'error'` event on an
 * already-accepted socket: a real upgrade, then raw invalid bytes written directly onto the wire.
 */
function rawUpgrade(server: TestServerHandle, runId: string): Promise<Socket> {
	return new Promise((resolve, reject) => {
		const req = request(`${server.baseUrl}/actor-runtime/events/${runId}`, {
			headers: {
				Connection: 'Upgrade',
				Upgrade: 'websocket',
				'Sec-WebSocket-Version': '13',
				'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
			},
		});
		req.on('upgrade', (_res, socket) => resolve(socket));
		req.on('error', reject);
		req.end();
	});
}

const SYSTEM_INFO_FIELDS = [
	'memAvgBytes',
	'memCurrentBytes',
	'memMaxBytes',
	'cpuAvgUsage',
	'cpuMaxUsage',
	'cpuCurrentUsage',
	'isCpuOverloaded',
	'createdAt',
];

describe('events websocket (GET /actor-runtime/events/:runId)', () => {
	let server: TestServerHandle;

	afterEach(async () => {
		vi.useRealTimers();
		await server.close();
	});

	it("accepts a connection with no auth at all and delivers the systemInfo frame the driver's onSample callback produced, with all eight fields present", async () => {
		const driver = multiRunDriver();
		server = await startTestServer(driver);
		const run = await seedRunnableRun(server, driver, 'ws-basic-actor');

		const socket = connectEventsSocket(server, run.id);
		await waitForOpen(socket.ws);
		await waitForSubscribed(run.id);

		driver.emitSample(run.id, sample());
		await waitFor(() => socket.messages.length > 0);

		expect(socket.messages).toHaveLength(1);
		expect(socket.messages[0]?.name).toBe('systemInfo');
		expect(Object.keys(socket.messages[0]!.data as Record<string, unknown>).sort()).toEqual(
			[...SYSTEM_INFO_FIELDS].sort(),
		);

		socket.ws.close();
		driver.resolveRun(run.id, { exitCode: 0, timedOut: false });
	});

	it("two concurrently running Actors: a client connected to run A never receives run B's systemInfo frames, and vice versa (no global/broadcast channel)", async () => {
		const driver = multiRunDriver();
		server = await startTestServer(driver);
		const runA = await seedRunnableRun(server, driver, 'ws-iso-actor-a');
		const runB = await seedRunnableRun(server, driver, 'ws-iso-actor-b');

		const socketA = connectEventsSocket(server, runA.id);
		const socketB = connectEventsSocket(server, runB.id);
		await Promise.all([waitForOpen(socketA.ws), waitForOpen(socketB.ws)]);
		await Promise.all([waitForSubscribed(runA.id), waitForSubscribed(runB.id)]);

		// Distinguishable per-run values, so a leaked cross-run frame would be caught, not just miscounted.
		driver.emitSample(runA.id, sample({ memoryBytes: 111_111_111 }));
		driver.emitSample(runB.id, sample({ memoryBytes: 222_222_222 }));

		await waitFor(() => socketA.messages.length > 0 && socketB.messages.length > 0);
		// Give any (incorrect) cross-delivery a moment to arrive before asserting counts.
		await new Promise((resolve) => setTimeout(resolve, 50));

		expect(socketA.messages).toHaveLength(1);
		expect((socketA.messages[0]!.data as Record<string, unknown>).memCurrentBytes).toBe(111_111_111);
		expect(socketB.messages).toHaveLength(1);
		expect((socketB.messages[0]!.data as Record<string, unknown>).memCurrentBytes).toBe(222_222_222);

		socketA.ws.close();
		socketB.ws.close();
		driver.resolveRun(runA.id, { exitCode: 0, timedOut: false });
		driver.resolveRun(runB.id, { exitCode: 0, timedOut: false });
	});

	it("a graceful abort on one of two concurrent runs delivers the aborting frame only on that run's own socket, never the other's", async () => {
		const driver = multiRunDriver();
		server = await startTestServer(driver);
		const runToAbort = await seedRunnableRun(server, driver, 'ws-abort-iso-actor-a');
		const unrelatedRun = await seedRunnableRun(server, driver, 'ws-abort-iso-actor-b');

		const abortedSocket = connectEventsSocket(server, runToAbort.id);
		const unrelatedSocket = connectEventsSocket(server, unrelatedRun.id);
		await Promise.all([waitForOpen(abortedSocket.ws), waitForOpen(unrelatedSocket.ws)]);
		await Promise.all([waitForSubscribed(runToAbort.id), waitForSubscribed(unrelatedRun.id)]);

		// Calls the service layer directly (mirrors `job-lifecycle.test.ts`'s own graceful-abort tests)
		// rather than a real HTTP round trip - the route itself is a thin `queryBoolean` pass-through
		// (`api/routes/runs.ts`) already covered elsewhere; this test's own job is the events-channel
		// fan-out and per-run isolation, which `abortRun` already exercises for real.
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		const abortPromise = abortRun(driver, runToAbort, true);

		await waitForPendingTimer();
		await waitFor(() => abortedSocket.messages.some((m) => m.name === 'aborting'));

		expect(abortedSocket.messages).toContainEqual({ name: 'aborting', data: {} });
		expect(unrelatedSocket.messages.some((m) => m.name === 'aborting')).toBe(false);
		// Never persistState, on either socket, under any circumstance.
		expect(abortedSocket.messages.some((m) => m.name === 'persistState')).toBe(false);
		expect(unrelatedSocket.messages.some((m) => m.name === 'persistState')).toBe(false);

		await vi.advanceTimersByTimeAsync(30_000);
		await abortPromise;
		vi.useRealTimers();

		abortedSocket.ws.close();
		unrelatedSocket.ws.close();
		// Lets both runs' own dangling `runInBackground` background tasks settle (the terminal-status guard
		// makes this a safe no-op for the already-`ABORTED` one) - tidiness, not required for the assertions
		// above, which the persisted-record fallback in `api/events-ws.ts`'s poll already satisfies.
		driver.resolveRun(runToAbort.id, { exitCode: 137, timedOut: false });
		driver.resolveRun(unrelatedRun.id, { exitCode: 0, timedOut: false });
	});

	it('completes the upgrade and then closes with 1008 and a non-empty reason for an unknown run id (never a non-101 HTTP status)', async () => {
		server = await startTestServer(unavailableDriver());
		const socket = connectEventsSocket(server, 'no-such-run-id-at-all');

		await waitForOpen(socket.ws); // the upgrade itself succeeds
		const closeEvent = await socket.closed;

		expect(closeEvent.code).toBe(1008);
		expect(closeEvent.reason.length).toBeGreaterThan(0);
	});

	it('completes the upgrade and then closes with 1008 for a run already in a terminal state', async () => {
		server = await startTestServer(unavailableDriver());
		const terminalRun: RunRecord = {
			id: generateId(),
			userId: 'some-user',
			actorId: 'some-actor',
			buildId: 'some-build',
			buildNumber: '0.0.1',
			status: 'SUCCEEDED',
			startedAt: new Date().toISOString(),
			finishedAt: new Date().toISOString(),
			exitCode: 0,
			defaultDatasetId: 'd',
			defaultKeyValueStoreId: 'k',
			defaultRequestQueueId: 'r',
			options: { memoryMbytes: 1024, timeoutSecs: 300 },
			meta: { origin: 'API' },
		};
		await getRegistries().runs.set(terminalRun.id, terminalRun);

		const socket = connectEventsSocket(server, terminalRun.id);
		await waitForOpen(socket.ws);
		const closeEvent = await socket.closed;

		expect(closeEvent.code).toBe(1008);
		expect(closeEvent.reason.length).toBeGreaterThan(0);
	});

	it('closes with 1000 once a live run reaches a normal end - not 1008, not left hanging', async () => {
		const driver = multiRunDriver();
		server = await startTestServer(driver);
		const run = await seedRunnableRun(server, driver, 'ws-normal-end-actor');

		const socket = connectEventsSocket(server, run.id);
		await waitForOpen(socket.ws);

		driver.resolveRun(run.id, { exitCode: 0, timedOut: false });
		const closeEvent = await socket.closed;

		expect(closeEvent.code).toBe(1000);
	});

	it('closes with 1000 once a graceful abort completes (the container stops, the record reaches ABORTED) - not 1008', async () => {
		const driver = multiRunDriver();
		server = await startTestServer(driver);
		const run = await seedRunnableRun(server, driver, 'ws-graceful-end-actor');

		const socket = connectEventsSocket(server, run.id);
		await waitForOpen(socket.ws);
		await waitForSubscribed(run.id);

		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		const abortPromise = abortRun(driver, run, true);

		await waitForPendingTimer();
		await vi.advanceTimersByTimeAsync(30_000);
		await abortPromise;
		vi.useRealTimers();

		const closeEvent = await socket.closed;
		expect(closeEvent.code).toBe(1000);
		// The graceful abort's own frame arrived, persistState never did.
		expect(socket.messages).toContainEqual({ name: 'aborting', data: {} });
		expect(socket.messages.some((m) => m.name === 'persistState')).toBe(false);
	});

	it("never drops a healthy, still-running run's connection for any reason short of the run ending or being rejected", async () => {
		const driver = multiRunDriver();
		server = await startTestServer(driver);
		const run = await seedRunnableRun(server, driver, 'ws-no-server-drop-actor');

		const socket = connectEventsSocket(server, run.id);
		await waitForOpen(socket.ws);
		await waitForSubscribed(run.id);

		let closed = false;
		void socket.closed.then(() => {
			closed = true;
		});

		// Several systemInfo ticks over real time, well within the run's lifetime - no close should occur.
		for (let i = 0; i < 3; i++) {
			driver.emitSample(run.id, sample());
			await new Promise((resolve) => setTimeout(resolve, 50));
		}

		expect(closed).toBe(false);
		expect(socket.ws.readyState).toBe(WebSocket.OPEN);
		expect(socket.messages.length).toBe(3);
		expect(socket.messages.every((m) => m.name === 'systemInfo')).toBe(true);

		socket.ws.close();
		driver.resolveRun(run.id, { exitCode: 0, timedOut: false });
	});

	it('a reconnect after a run has already ended (via normal completion) hits the terminal-run check and gets 1008', async () => {
		const driver = multiRunDriver();
		server = await startTestServer(driver);
		const run = await seedRunnableRun(server, driver, 'ws-reconnect-after-end-actor');

		const firstSocket = connectEventsSocket(server, run.id);
		await waitForOpen(firstSocket.ws);
		driver.resolveRun(run.id, { exitCode: 0, timedOut: false });
		expect((await firstSocket.closed).code).toBe(1000);

		const reconnectSocket = connectEventsSocket(server, run.id);
		await waitForOpen(reconnectSocket.ws);
		const closeEvent = await reconnectSocket.closed;
		expect(closeEvent.code).toBe(1008);
	});

	it('an unhandled protocol-level error on a connected socket (a malformed frame) never crashes the process - it is contained to that one connection (regression: blocker - unhandled `error` event)', async () => {
		const driver = multiRunDriver();
		server = await startTestServer(driver);
		const run = await seedRunnableRun(server, driver, 'ws-malformed-frame-actor');

		const socket = await rawUpgrade(server, run.id);

		// If `handleConnection` ever again omits an `'error'` listener on the accepted `WebSocket`, `ws`
		// throws this synchronously out of its own internal socket-data handler - with nothing up that
		// call stack to catch it, Node turns it into a process-wide `'uncaughtException'`, which (with no
		// listener of our own) would otherwise crash this entire test worker, not just fail an assertion.
		// Registering a listener here doesn't just observe that outcome; per Node's own documented
		// semantics, adding an `'uncaughtException'` listener is what prevents the default crash-and-exit,
		// which is exactly why this test is able to make a red/green assertion here at all instead of
		// taking the whole process down with it pre-fix.
		const uncaughtErrors: unknown[] = [];
		const onUncaught = (error: unknown): void => {
			uncaughtErrors.push(error);
		};
		process.on('uncaughtException', onUncaught);
		try {
			// Ten invalid frame bytes (RSV2/RSV3 set) - the shape of malformed frame the installed `ws`
			// package rejects with a synchronous `'error'` emission, per `handleConnection`'s own doc
			// comment (`api/events-ws.ts`).
			socket.write(Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]));

			// Give the server a real moment to actually process the bad frame (and, pre-fix, crash).
			await new Promise((resolve) => setTimeout(resolve, 200));

			expect(uncaughtErrors).toEqual([]);
		} finally {
			process.removeListener('uncaughtException', onUncaught);
		}

		// Not just "didn't throw synchronously" - the server is still alive and still serving every other
		// run: a fresh connection to an unrelated, healthy run still gets its frames normally.
		const otherRun = await seedRunnableRun(server, driver, 'ws-malformed-frame-survivor-actor');
		const otherSocket = connectEventsSocket(server, otherRun.id);
		await waitForOpen(otherSocket.ws);
		await waitForSubscribed(otherRun.id);
		driver.emitSample(otherRun.id, sample());
		await waitFor(() => otherSocket.messages.length > 0);
		expect(otherSocket.messages[0]?.name).toBe('systemInfo');

		socket.destroy();
		otherSocket.ws.close();
		driver.resolveRun(run.id, { exitCode: 0, timedOut: false });
		driver.resolveRun(otherRun.id, { exitCode: 0, timedOut: false });
	});
});

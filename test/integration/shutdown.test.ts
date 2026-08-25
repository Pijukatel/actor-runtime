import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

import { bootstrapStorage, getRuntimeStorage, resetStorageForTests } from '../../src/storage/bootstrap.js';
import { openRegistries, resetRegistriesForTests } from '../../src/storage/registries.js';
import { getOrCreateUserForToken, resetUsersForTests } from '../../src/services/users.js';
import { createApiServer } from '../../src/api/server.js';
import { attachEventsWebSocket, type EventsWebSocketServer } from '../../src/api/events-ws.js';
import { createConsoleServer } from '../../src/console/server.js';
import { resetLogsForTests, stopLogFlusher } from '../../src/services/logs.js';
import { resetEventsChannelForTests } from '../../src/services/events-channel.js';
import { gracefulShutdown } from '../../src/shutdown.js';
import { unavailableDriver } from './helpers/test-server.js';

/**
 * Regression coverage for the graceful-shutdown deadlock: before the fix, closing the API server would
 * never resolve while a `?stream=true` log response stayed open (`apify push`/`apify call`'s common
 * case), so `shutdownStorage()` - and its `teardown()` flush of every open request queue - never ran.
 * The second `it` below covers the exact same bug class recurring for the events websocket
 * (`api/events-ws.ts`) - see its own doc comment for the full evidence that `closeAllConnections()` does
 * not reach an already-upgraded socket the way it reaches an ordinary open HTTP response.
 */
describe('gracefulShutdown', () => {
	let dataDir: string | undefined;
	let apiServer: Server | undefined;
	let consoleServer: Server | undefined;
	let eventsWebSocketServer: EventsWebSocketServer | undefined;

	afterEach(async () => {
		eventsWebSocketServer?.close();
		stopLogFlusher();
		resetLogsForTests();
		resetEventsChannelForTests();
		resetRegistriesForTests();
		resetUsersForTests();
		resetStorageForTests();
		if (dataDir) await rm(dataDir, { recursive: true, force: true });
		dataDir = undefined;
		apiServer = undefined;
		consoleServer = undefined;
		eventsWebSocketServer = undefined;
	});

	it('resolves promptly and tears down storage even while a ?stream=true log response is held open', async () => {
		dataDir = await mkdtemp(join(tmpdir(), 'actor-runtime-shutdown-'));
		bootstrapStorage(dataDir);
		await openRegistries();
		const user = await getOrCreateUserForToken('shutdown-test-token');

		const apiApp = createApiServer({ driver: unavailableDriver() });
		const consoleApp = createConsoleServer({ driver: unavailableDriver() });
		apiServer = await new Promise<Server>((resolve) => {
			const s = apiApp.listen(0, () => resolve(s));
		});
		consoleServer = await new Promise<Server>((resolve) => {
			const s = consoleApp.listen(0, () => resolve(s));
		});
		const { port } = apiServer.address() as AddressInfo;

		// Seed a non-terminal run directly, so the log endpoint's ownership check passes and there is
		// something for the stream to hold open against.
		const { getRegistries } = await import('../../src/storage/registries.js');
		const runId = 'shutdownStreamRun12';
		await getRegistries().runs.set(runId, {
			id: runId,
			userId: user.id,
			actorId: 'x',
			buildId: 'y',
			buildNumber: '0.0.1',
			status: 'RUNNING',
			startedAt: new Date().toISOString(),
			defaultDatasetId: 'd',
			defaultKeyValueStoreId: 'k',
			defaultRequestQueueId: 'r',
			options: { memoryMbytes: 1024, timeoutSecs: 300 },
			meta: { origin: 'API' },
		});

		const controller = new AbortController();
		const res = await fetch(`http://127.0.0.1:${port}/v2/logs/${runId}?stream=true`, {
			headers: { Authorization: `Bearer ${user.token}` },
			signal: controller.signal,
		});
		expect(res.status).toBe(200);
		const reader = res.body!.getReader();
		// Start consuming, so the connection is genuinely established and held open. `closeServer`'s
		// `closeAllConnections()` forcibly destroys this socket, which rejects this read - caught here
		// rather than left as an unhandled rejection surfacing later, asynchronously, in whatever test
		// happens to be running at the time.
		void reader.read().catch(() => undefined);

		const teardownSpy = vi.spyOn(getRuntimeStorage().storageBackend, 'teardown');

		const timedOut = Symbol('timeout');
		const result = await Promise.race([
			gracefulShutdown({ apiServer, consoleServer }).then(() => 'shut down' as const),
			new Promise((resolve) => setTimeout(() => resolve(timedOut), 3000)),
		]);

		expect(result).toBe('shut down');
		expect(teardownSpy).toHaveBeenCalledTimes(1);

		controller.abort();
		await reader.cancel().catch(() => undefined);
	});

	it('resolves promptly even while a live events-websocket client is connected to a RUNNING run (blocker: graceful shutdown must not hang on an upgraded socket)', async () => {
		dataDir = await mkdtemp(join(tmpdir(), 'actor-runtime-shutdown-ws-'));
		bootstrapStorage(dataDir);
		await openRegistries();

		const apiApp = createApiServer({ driver: unavailableDriver() });
		const consoleApp = createConsoleServer({ driver: unavailableDriver() });
		apiServer = await new Promise<Server>((resolve) => {
			const s = apiApp.listen(0, () => resolve(s));
		});
		consoleServer = await new Promise<Server>((resolve) => {
			const s = consoleApp.listen(0, () => resolve(s));
		});
		// Attached the same way `index.ts` attaches it in production - on the same `http.Server`
		// `apiApp.listen()` returned, never a second port.
		eventsWebSocketServer = attachEventsWebSocket(apiServer);
		const { port } = apiServer.address() as AddressInfo;

		// Seed a non-terminal run directly, so the events socket's upgrade resolves to a live subscription
		// (not an immediate 1008) and stays open exactly as an Actor container's own SDK connection would
		// for the whole life of a real run.
		const { getRegistries } = await import('../../src/storage/registries.js');
		const runId = 'shutdownEventsWsRun12';
		await getRegistries().runs.set(runId, {
			id: runId,
			userId: 'irrelevant-for-this-endpoint',
			actorId: 'x',
			buildId: 'y',
			buildNumber: '0.0.1',
			status: 'RUNNING',
			startedAt: new Date().toISOString(),
			defaultDatasetId: 'd',
			defaultKeyValueStoreId: 'k',
			defaultRequestQueueId: 'r',
			options: { memoryMbytes: 1024, timeoutSecs: 300 },
			meta: { origin: 'API' },
		});

		const ws = new WebSocket(`ws://127.0.0.1:${port}/actor-runtime/events/${runId}`);
		await new Promise<void>((resolve, reject) => {
			ws.once('open', () => resolve());
			ws.once('error', reject);
		});
		// Deliberately never closed by this test before `gracefulShutdown` runs - simulating exactly the
		// scenario the design's own risk note calls the ordinary case, not an edge case: a live run with a
		// still-connected SDK socket at the moment `SIGTERM`/`SIGINT` arrives.

		const timedOut = Symbol('timeout');
		const result = await Promise.race([
			gracefulShutdown({ apiServer, consoleServer, eventsWebSocketServer }).then(() => 'shut down' as const),
			new Promise((resolve) => setTimeout(() => resolve(timedOut), 3000)),
		]);

		expect(result).toBe('shut down');

		ws.terminate();
	});
});

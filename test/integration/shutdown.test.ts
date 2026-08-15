import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { bootstrapStorage, getRuntimeStorage, resetStorageForTests } from '../../src/storage/bootstrap.js';
import { openRegistries, resetRegistriesForTests } from '../../src/storage/registries.js';
import { bootstrapDefaultUser, resetDefaultUserCacheForTests } from '../../src/services/users.js';
import { createApiServer } from '../../src/api/server.js';
import { createConsoleServer } from '../../src/console/server.js';
import { resetLogsForTests, stopLogFlusher } from '../../src/services/logs.js';
import { gracefulShutdown } from '../../src/shutdown.js';
import { unavailableDriver } from './helpers/test-server.js';

/**
 * Regression coverage for the graceful-shutdown deadlock: before the fix, closing the API server would
 * never resolve while a `?stream=true` log response stayed open (`apify push`/`apify call`'s common
 * case), so `shutdownStorage()` - and its `teardown()` flush of every open request queue - never ran.
 */
describe('gracefulShutdown', () => {
	let dataDir: string | undefined;
	let apiServer: Server | undefined;
	let consoleServer: Server | undefined;

	afterEach(async () => {
		stopLogFlusher();
		resetLogsForTests();
		resetRegistriesForTests();
		resetDefaultUserCacheForTests();
		resetStorageForTests();
		if (dataDir) await rm(dataDir, { recursive: true, force: true });
		dataDir = undefined;
		apiServer = undefined;
		consoleServer = undefined;
	});

	it('resolves promptly and tears down storage even while a ?stream=true log response is held open', async () => {
		dataDir = await mkdtemp(join(tmpdir(), 'actor-runtime-shutdown-'));
		bootstrapStorage(dataDir);
		await openRegistries();
		const user = await bootstrapDefaultUser();

		const apiApp = createApiServer({ driver: unavailableDriver() });
		const consoleApp = createConsoleServer();
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
});

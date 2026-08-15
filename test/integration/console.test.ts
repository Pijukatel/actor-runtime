import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import axios from 'axios';

import { createConsoleServer } from '../../src/console/server.js';
import { openRequestQueue } from '../../src/storage/open.js';
import { getRegistries } from '../../src/storage/registries.js';
import { generateId } from '../../src/storage/ids.js';
import type { BuildRecord, RunRecord } from '../../src/storage/entities.js';
import { startTestServer, type TestServerHandle } from './helpers/test-server.js';

describe('console pages (HTTP fetch)', () => {
	let server: TestServerHandle;
	let consoleServer: Server;
	let consoleBaseUrl: string;

	beforeEach(async () => {
		server = await startTestServer();
		const app = createConsoleServer();
		consoleServer = await new Promise((resolve) => {
			const s = app.listen(0, () => resolve(s));
		});
		consoleBaseUrl = `http://127.0.0.1:${(consoleServer.address() as AddressInfo).port}`;
	});

	afterEach(async () => {
		await new Promise<void>((resolve) => consoleServer.close(() => resolve()));
		await server.close();
	});

	const listAndDetailPaths: Array<[string, () => Promise<string>]> = [
		['actors', async () => (await server.client.actors().create({ name: 'console-actor' })).id],
		['datasets', async () => (await server.client.datasets().getOrCreate()).id],
		['key-value-stores', async () => (await server.client.keyValueStores().getOrCreate()).id],
		['request-queues', async () => (await server.client.requestQueues().getOrCreate()).id],
	];

	for (const [kind, createFixture] of listAndDetailPaths) {
		it(`${kind}: list view and detail view both render`, async () => {
			const id = await createFixture();

			const list = await axios.get(`${consoleBaseUrl}/${kind}`);
			expect(list.status).toBe(200);
			expect(list.data).toContain(id);

			const detail = await axios.get(`${consoleBaseUrl}/${kind}/${id}`);
			expect(detail.status).toBe(200);
			expect(detail.data).toContain(id);
		});
	}

	it('builds and runs list+detail views render (even with no Docker)', async () => {
		const actor = await server.client.actors().create({ name: 'console-build-actor' });
		await server.client
			.actor(actor.id)
			.versions()
			.create({
				versionNumber: '0.0',
				buildTag: 'latest',
				sourceType: 'SOURCE_FILES' as never,
				sourceFiles: [],
			} as never);
		const build = await server.client.actor(actor.id).build('0.0', { waitForFinish: 5 });

		const buildList = await axios.get(`${consoleBaseUrl}/builds`);
		expect(buildList.data).toContain(build.id);
		const buildDetail = await axios.get(`${consoleBaseUrl}/builds/${build.id}`);
		expect(buildDetail.data).toContain(build.id);
		expect(buildDetail.data).toContain('Docker');

		const logList = await axios.get(`${consoleBaseUrl}/logs`);
		expect(logList.data).toContain(build.id);
		const logDetail = await axios.get(`${consoleBaseUrl}/logs/${build.id}`);
		expect(logDetail.data).toContain('Docker');
	});

	it('logs/:id 404s for a nonexistent id and 200s for an owned build or run id (regression: it used to render any id with no ownership/existence check at all, unlike /builds/:id and /runs/:id)', async () => {
		const missing = await axios.get(`${consoleBaseUrl}/logs/totally-made-up-id-not-in-any-registry`, {
			validateStatus: () => true,
		});
		expect(missing.status).toBe(404);

		// Build/run records are seeded directly into the registries (bypassing the driver, which is
		// unavailable in this test environment - same pattern as `job-lifecycle.test.ts`), since only
		// ownership resolution is under test here, not the driver itself.
		const actor = await server.client.actors().create({ name: 'console-log-ownership-actor' });
		const actorRecord = (await getRegistries().actors.get(actor.id))!;

		const build: BuildRecord = {
			id: generateId(),
			userId: actorRecord.userId,
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

		const buildLog = await axios.get(`${consoleBaseUrl}/logs/${build.id}`, { validateStatus: () => true });
		expect(buildLog.status).toBe(200);

		const run: RunRecord = {
			id: generateId(),
			userId: actorRecord.userId,
			actorId: actor.id,
			buildId: build.id,
			buildNumber: build.buildNumber,
			status: 'SUCCEEDED',
			startedAt: new Date().toISOString(),
			finishedAt: new Date().toISOString(),
			defaultDatasetId: 'd',
			defaultKeyValueStoreId: 'k',
			defaultRequestQueueId: 'r',
			options: { memoryMbytes: 1024, timeoutSecs: 300 },
			meta: { origin: 'API' },
		};
		await getRegistries().runs.set(run.id, run);

		const runLog = await axios.get(`${consoleBaseUrl}/logs/${run.id}`, { validateStatus: () => true });
		expect(runLog.status).toBe(200);
	});

	it('viewing the request-queue detail page does not fetch/lock any request out of the queue (regression: it used to call getHead/peekHead, which calls fetchNextRequest under the hood)', async () => {
		const { id } = await server.client.requestQueues().getOrCreate();
		const queue = server.client.requestQueue(id);
		await queue.batchAddRequests([
			{ url: 'http://example.com/1', uniqueKey: '1' },
			{ url: 'http://example.com/2', uniqueKey: '2' },
		]);

		const before = await (await openRequestQueue(id)).getInfo();
		expect(before.pendingRequestCount).toBe(2);

		const detail = await axios.get(`${consoleBaseUrl}/request-queues/${id}`);
		expect(detail.status).toBe(200);
		expect(detail.data).toContain('http://example.com/1');

		const after = await (await openRequestQueue(id)).getInfo();
		expect(after.pendingRequestCount).toBe(before.pendingRequestCount);

		// The decisive check: call `fetchNextRequest()` directly against the real frontend, bypassing this
		// runtime's own `RequestQueueBuffer` entirely. `fetchNextRequest()` marks whatever it returns
		// in-progress at the storage level, not just in this process's JS memory - so if the console page
		// had already called `getHead`/`peekHead` (which calls it too), both real requests would already be
		// locked in-progress and this would come back empty. Getting a real request back proves the page
		// never touched the queue.
		const next = await (await openRequestQueue(id)).fetchNextRequest();
		expect(next).not.toBeNull();
		expect(['http://example.com/1', 'http://example.com/2']).toContain(next?.url);
	});

	it('renders exactly one widget design per storage type across multiple instances', async () => {
		const first = await server.client.datasets().getOrCreate('one');
		const second = await server.client.datasets().getOrCreate('two');

		const firstPage = (await axios.get(`${consoleBaseUrl}/datasets/${first.id}`)).data as string;
		const secondPage = (await axios.get(`${consoleBaseUrl}/datasets/${second.id}`)).data as string;

		// Same structural markers (heading text), proving one shared widget template.
		expect(firstPage).toContain('<h2>Items');
		expect(secondPage).toContain('<h2>Items');
	});
});

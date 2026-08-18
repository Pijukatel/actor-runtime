import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import axios from 'axios';
import { ApifyClient } from 'apify-client';

import { createConsoleServer } from '../../src/console/server.js';
import { openRequestQueue } from '../../src/storage/open.js';
import { getRegistries } from '../../src/storage/registries.js';
import { generateId } from '../../src/storage/ids.js';
import type { BuildRecord, RunRecord } from '../../src/storage/entities.js';
import { startTestServer, type TestServerHandle } from './helpers/test-server.js';
import { appendLog } from '../../src/services/logs.js';
import { recordTaggedBuild, updateActor } from '../../src/services/actors.js';

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

	it('run views render the default storage ids as links to the storage detail views (regression: they used to be plain text)', async () => {
		const actor = await server.client.actors().create({ name: 'console-storage-links-actor' });
		const actorRecord = (await getRegistries().actors.get(actor.id))!;

		const dataset = await server.client.datasets().getOrCreate();
		const store = await server.client.keyValueStores().getOrCreate();
		const queue = await server.client.requestQueues().getOrCreate();

		const run: RunRecord = {
			id: generateId(),
			userId: actorRecord.userId,
			actorId: actor.id,
			buildId: generateId(),
			buildNumber: '0.0.1',
			status: 'SUCCEEDED',
			startedAt: new Date().toISOString(),
			finishedAt: new Date().toISOString(),
			defaultDatasetId: dataset.id,
			defaultKeyValueStoreId: store.id,
			defaultRequestQueueId: queue.id,
			options: { memoryMbytes: 1024, timeoutSecs: 300 },
			meta: { origin: 'API' },
		};
		await getRegistries().runs.set(run.id, run);

		const detail = (await axios.get(`${consoleBaseUrl}/runs/${run.id}`)).data as string;
		expect(detail).toContain(`<a href="/datasets/${dataset.id}">${dataset.id}</a>`);
		expect(detail).toContain(`<a href="/key-value-stores/${store.id}">${store.id}</a>`);
		expect(detail).toContain(`<a href="/request-queues/${queue.id}">${queue.id}</a>`);

		// The runs list's defaultDatasetId column links too, and each linked page actually resolves.
		const list = (await axios.get(`${consoleBaseUrl}/runs`)).data as string;
		expect(list).toContain(`<a href="/datasets/${dataset.id}">${dataset.id}</a>`);
		for (const href of [
			`/datasets/${dataset.id}`,
			`/key-value-stores/${store.id}`,
			`/request-queues/${queue.id}`,
		]) {
			const target = await axios.get(`${consoleBaseUrl}${href}`);
			expect(target.status).toBe(200);
		}
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

	it('logs/:id renders ANSI SGR sequences as colored HTML spans, with no raw escape byte in the response (regression: console used to dump raw ANSI, e.g. "[32mINFO[39m", into the page)', async () => {
		const actor = await server.client.actors().create({ name: 'console-ansi-log-actor' });
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

		const rawAnsiLine = '\x1b[32mINFO\x1b[39m \x1b[33m CheerioCrawler:\x1b[39m All requests have been processed.';
		appendLog(build.id, rawAnsiLine);

		const logPage = await axios.get(`${consoleBaseUrl}/logs/${build.id}`);
		expect(logPage.status).toBe(200);
		expect(logPage.data).not.toContain('\x1b');
		expect(logPage.data).toContain('<span style="color:#2e7d32">INFO</span>');
		expect(logPage.data).toContain('<span style="color:#b8860b"> CheerioCrawler:</span>');

		// Same conversion path is shared by the build detail page's own log section.
		const buildDetail = await axios.get(`${consoleBaseUrl}/builds/${build.id}`);
		expect(buildDetail.data).not.toContain('\x1b');
		expect(buildDetail.data).toContain('<span style="color:#2e7d32">INFO</span>');
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

	// --- Compatibility redirects (console.md): stock apify-cli prints links using the real Apify
	// Console's URL shapes, since it only knows one Console. These regression-test that every shape it
	// can print against `APIFY_CONSOLE_URL` (verified against apify-cli v1.8.0's source: `run-result.ts`,
	// `agent-output.ts`, `commands/runs/info.ts`, `commands/builds/info.ts`) redirects here instead of 404ing.

	it("redirects the real Console run URL shape to this console's own run page (representative end-to-end: also verifies the destination detail page renders)", async () => {
		const actor = await server.client.actors().create({ name: 'redirect-run-actor' });
		const actorRecord = (await getRegistries().actors.get(actor.id))!;

		// Seed a "successful" build directly, bypassing the driver (same pattern as
		// `actors-builds-runs.test.ts`), so starting a run doesn't require a real Docker build here.
		const fakeBuildId = generateId();
		const { builds } = getRegistries();
		await builds.set(fakeBuildId, {
			id: fakeBuildId,
			userId: actorRecord.userId,
			actorId: actor.id,
			versionNumber: '0.0',
			buildNumber: '0.0.1',
			tag: 'latest',
			status: 'SUCCEEDED',
			startedAt: new Date().toISOString(),
			finishedAt: new Date().toISOString(),
			imageId: 'fake-image:latest',
		});
		await updateActor(actor.id, (current) => recordTaggedBuild(current, 'latest', fakeBuildId, '0.0.1'));

		const run = await server.client.actor(actor.id).start({});
		const cliShapeUrl = `${consoleBaseUrl}/actors/${actor.id}/runs/${run.id}`;

		const redirect = await axios.get(cliShapeUrl, { maxRedirects: 0, validateStatus: () => true });
		expect(redirect.status).toBe(302);
		expect(redirect.headers.location).toBe(`/runs/${run.id}`);

		// Following it (axios follows redirects by default) lands on the real run detail page.
		const followed = await axios.get(cliShapeUrl);
		expect(followed.status).toBe(200);
		expect(followed.data).toContain(run.id);
	});

	it("redirects the real Console build URL shape (actorId + buildNumber) to this console's own build page (by resolving buildNumber to the build's internal id)", async () => {
		const actor = await server.client.actors().create({ name: 'redirect-build-actor' });
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

		const redirect = await axios.get(`${consoleBaseUrl}/actors/${actor.id}/builds/${build.buildNumber}`, {
			maxRedirects: 0,
			validateStatus: () => true,
		});
		expect(redirect.status).toBe(302);
		expect(redirect.headers.location).toBe(`/builds/${build.id}`);
	});

	it('404s (not a redirect) for a build URL naming a buildNumber that does not exist under that actor', async () => {
		const actor = await server.client.actors().create({ name: 'redirect-build-404-actor' });
		const res = await axios.get(`${consoleBaseUrl}/actors/${actor.id}/builds/0.0.1`, {
			validateStatus: () => true,
		});
		expect(res.status).toBe(404);
	});

	it('shows the owner userId on every list page and every detail view (console.md: "Frontend shows for each object the owner (userId)")', async () => {
		const actor = await server.client.actors().create({ name: 'owner-display-actor' });
		const dataset = await server.client.datasets().getOrCreate('owner-display-dataset');
		const me = await server.client.user('me').get();

		const actorsList = await axios.get(`${consoleBaseUrl}/actors`);
		expect(actorsList.data).toContain('userId');
		expect(actorsList.data).toContain(me.id);

		const actorDetail = await axios.get(`${consoleBaseUrl}/actors/${actor.id}`);
		expect(actorDetail.data).toContain(me.id);

		const datasetsList = await axios.get(`${consoleBaseUrl}/datasets`);
		expect(datasetsList.data).toContain('userId');

		const datasetDetail = await axios.get(`${consoleBaseUrl}/datasets/${dataset.id}`);
		expect(datasetDetail.data).toContain(me.id);
	});

	it('lists objects across ALL users, not just one (view-only local dev console, no login of its own)', async () => {
		const otherClient = new ApifyClient({
			baseUrl: server.baseUrl,
			token: 'console-other-user-token',
			maxRetries: 0,
		});

		const actorMine = await server.client.actors().create({ name: 'console-cross-user-mine' });
		const actorOther = await otherClient.actors().create({ name: 'console-cross-user-other' });
		const meId = (await server.client.user('me').get()).id;
		const otherId = (await otherClient.user('me').get()).id;
		expect(meId).not.toBe(otherId);

		const actorsList = await axios.get(`${consoleBaseUrl}/actors`);
		expect(actorsList.data).toContain(actorMine.id);
		expect(actorsList.data).toContain(actorOther.id);
		expect(actorsList.data).toContain(meId);
		expect(actorsList.data).toContain(otherId);

		// The other user's actor detail page renders too - the console has no per-user scoping of its own.
		const otherDetail = await axios.get(`${consoleBaseUrl}/actors/${actorOther.id}`);
		expect(otherDetail.status).toBe(200);
		expect(otherDetail.data).toContain(otherId);

		const datasetMine = await server.client.datasets().getOrCreate('console-cross-user-dataset-mine');
		const datasetOther = await otherClient.datasets().getOrCreate('console-cross-user-dataset-other');
		const datasetsList = await axios.get(`${consoleBaseUrl}/datasets`);
		expect(datasetsList.data).toContain(datasetMine.id);
		expect(datasetsList.data).toContain(datasetOther.id);
	});

	it("redirects the real Console storage URL shapes (/storage/<type>/:id) to this console's own flat pages", async () => {
		const dataset = await server.client.datasets().getOrCreate();
		const kvStore = await server.client.keyValueStores().getOrCreate();
		const queue = await server.client.requestQueues().getOrCreate();

		const cases: Array<[string, string]> = [
			[`/storage/datasets/${dataset.id}`, `/datasets/${dataset.id}`],
			[`/storage/key-value-stores/${kvStore.id}`, `/key-value-stores/${kvStore.id}`],
			[`/storage/request-queues/${queue.id}`, `/request-queues/${queue.id}`],
		];

		for (const [from, to] of cases) {
			const redirect = await axios.get(`${consoleBaseUrl}${from}`, {
				maxRedirects: 0,
				validateStatus: () => true,
			});
			expect(redirect.status).toBe(302);
			expect(redirect.headers.location).toBe(to);
		}
	});
});

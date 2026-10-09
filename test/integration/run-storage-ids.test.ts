/**
 * `.actor/actor.json`'s `storages.datasets`: every run gets one dataset per declared alias, reported as
 * `storageIds` on the run and as `ACTOR_STORAGES_JSON` in its container (`storage.md`).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { capturingDriver, startTestServer, type TestServerHandle } from './helpers/test-server.js';

describe('extra named default storages (storageIds)', () => {
	let server: TestServerHandle;
	let getCapturedEnv: () => Record<string, string> | undefined;

	beforeEach(async () => {
		const capturing = capturingDriver();
		getCapturedEnv = () => capturing.captured.runEnv;
		server = await startTestServer(capturing.driver);
	});

	afterEach(async () => {
		await server.close();
	});

	async function buildAndRun(name: string, storages?: unknown) {
		const actor = await server.client.actors().create({ name });
		await server.client
			.actor(actor.id)
			.versions()
			.create({
				versionNumber: '0.0',
				buildTag: 'latest',
				sourceType: 'SOURCE_FILES' as never,
				sourceFiles: [
					{ name: 'main.js', format: 'TEXT', content: 'console.log(1)' },
					{
						name: '.actor/actor.json',
						format: 'TEXT',
						content: JSON.stringify({ actorSpecification: 1, name, version: '0.0', storages }),
					},
				],
			} as never);
		const build = await server.client.actor(actor.id).build('0.0', { waitForFinish: 5 });
		expect(build.status).toBe('SUCCEEDED');
		return server.client.actor(actor.id).start({}, { waitForFinish: 5 });
	}

	it('creates a dataset per declared alias and exposes them on the run and in the container', async () => {
		const run = await buildAndRun('multi-dataset-actor', {
			datasets: {
				default: { actorSpecification: 1, fields: {} },
				categories: { actorSpecification: 1, fields: {} },
			},
		});

		const storageIds = (run as unknown as { storageIds: Record<string, Record<string, string>> }).storageIds;
		expect(storageIds.datasets.default).toBe(run.defaultDatasetId);
		expect(storageIds.keyValueStores).toEqual({ default: run.defaultKeyValueStoreId });
		expect(storageIds.requestQueues).toEqual({ default: run.defaultRequestQueueId });
		const categoriesId = storageIds.datasets.categories;
		expect(categoriesId).toBeTruthy();
		expect(categoriesId).not.toBe(run.defaultDatasetId);

		await server.client.dataset(categoriesId!).pushItems({ categoryId: 'c1' });
		const { items } = await server.client.dataset(categoriesId!).listItems();
		expect(items).toEqual([{ categoryId: 'c1' }]);

		expect(JSON.parse(getCapturedEnv()!.ACTOR_STORAGES_JSON!)).toEqual(storageIds);
	});

	it('reports only the default storages for an Actor that declares no extra datasets', async () => {
		const run = await buildAndRun('single-dataset-actor');
		const expected = {
			datasets: { default: run.defaultDatasetId },
			keyValueStores: { default: run.defaultKeyValueStoreId },
			requestQueues: { default: run.defaultRequestQueueId },
		};
		expect((run as unknown as { storageIds: unknown }).storageIds).toEqual(expected);
		expect(JSON.parse(getCapturedEnv()!.ACTOR_STORAGES_JSON!)).toEqual(expected);
	});
});

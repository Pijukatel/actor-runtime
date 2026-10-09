/**
 * Dataset schema validation (`storage.md`'s "Dataset schema validation") over the real HTTP server and a
 * real `apify-client`. The build is a real one over pushed source files with the driver stubbed out at
 * `docker build`, so the schema really is resolved from `.actor/actor.json`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { fixedBuildOutcomeDriver, startTestServer, type TestServerHandle } from './helpers/test-server.js';
import { getRegistries } from '../../src/storage/registries.js';
import { runBuildInBackground } from '../../src/services/builds.js';
import type { SourceFile } from '../../src/storage/entities.js';

const SCHEMA = {
	actorSpecification: 1,
	fields: {
		type: 'object',
		properties: { title: { type: 'string' } },
		required: ['title'],
	},
};

describe('dataset schema validation (via real apify-client)', () => {
	let server: TestServerHandle;

	beforeEach(async () => {
		server = await startTestServer();
	});

	afterEach(async () => {
		await server.close();
	});

	it('rejects a whole batch with any invalid item, in the platform error shape, and stores none of it', async () => {
		const res = await fetch(`${server.baseUrl}/v2/datasets?token=${server.token}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ schema: SCHEMA }),
		});
		expect(res.status).toBe(201);
		const { data: created } = (await res.json()) as { data: { id: string; schema: unknown } };
		expect(created.schema).toEqual(SCHEMA);
		const dataset = server.client.dataset(created.id);

		const rejected = await fetch(`${server.baseUrl}/v2/datasets/${created.id}/items?token=${server.token}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify([{ title: 'a' }, { title: 1 }]),
		});
		expect(rejected.status).toBe(400);
		const body = (await rejected.json()) as {
			error: { type: string; message: string; data: { invalidItems: { itemPosition: number }[] } };
		};
		expect(body.error.type).toBe('schema-validation-error');
		expect(body.error.message).toBe('Schema validation failed');
		expect(body.error.data.invalidItems.map((item) => item.itemPosition)).toEqual([1]);
		expect((await dataset.listItems()).items).toEqual([]);

		await expect(dataset.pushItems({ nope: true })).rejects.toMatchObject({
			statusCode: 400,
			type: 'schema-validation-error',
		});
		await dataset.pushItems([{ title: 'a' }, { title: 'b' }]);
		expect((await dataset.listItems()).items).toEqual([{ title: 'a' }, { title: 'b' }]);
	});

	it('leaves a dataset without a schema unvalidated', async () => {
		const { id } = await server.client.datasets().getOrCreate();
		await server.client.dataset(id).pushItems([{ anything: 1 }]);
		expect((await server.client.dataset(id).get()) as unknown).not.toHaveProperty('schema');
	});

	it("gives a run's default dataset the schema of the build's .actor/actor.json", async () => {
		const actor = await server.client.actors().create({ name: 'schema-actor' });
		const { actors, builds } = getRegistries();

		const build = async (buildId: string, sourceFiles: SourceFile[]): Promise<void> => {
			await builds.set(buildId, {
				id: buildId,
				userId: actor.userId,
				actorId: actor.id,
				versionNumber: '0.0',
				buildNumber: '0.0.1',
				tag: 'latest',
				status: 'READY',
				startedAt: new Date().toISOString(),
			});
			await runBuildInBackground(
				fixedBuildOutcomeDriver({ imageId: 'built-image:latest' }),
				(await actors.get(actor.id))!,
				{ versionNumber: '0.0', buildTag: 'latest', sourceType: 'SOURCE_FILES', sourceFiles },
				(await builds.get(buildId))!,
				{ tag: 'latest', useCache: true },
			);
		};
		const actorJson = (dataset: unknown): SourceFile => ({
			name: '.actor/actor.json',
			format: 'TEXT',
			content: JSON.stringify({
				actorSpecification: 1,
				name: 'schema-actor',
				version: '0.0',
				storages: { dataset },
			}),
		});

		const goodBuildId = 'goodBuildId12345g';
		await build(goodBuildId, [
			actorJson('./dataset_schema.json'),
			{ name: '.actor/dataset_schema.json', format: 'TEXT', content: JSON.stringify(SCHEMA) },
		]);
		expect((await builds.get(goodBuildId))?.status).toBe('SUCCEEDED');
		expect(await server.client.log(goodBuildId).get()).toContain('Using the dataset schema from');

		const run = await server.client.actor(actor.id).start();
		const dataset = server.client.dataset(run.defaultDatasetId);
		expect(((await dataset.get()) as unknown as { schema: unknown }).schema).toEqual(SCHEMA);
		await expect(server.client.run(run.id).dataset().pushItems({})).rejects.toMatchObject({
			type: 'schema-validation-error',
		});

		const brokenBuildId = 'brokenBuildId123b';
		await build(brokenBuildId, [actorJson('./missing.json')]);
		const broken = await server.client.build(brokenBuildId).get();
		expect(broken?.status).toBe('FAILED');
		expect(broken?.statusMessage).toContain('does not exist');
	});
});

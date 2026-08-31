import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { startTestServer, type TestServerHandle } from './helpers/test-server.js';
import { getRegistries } from '../../src/storage/registries.js';
import { recordTaggedBuild, updateActor } from '../../src/services/actors.js';

/** Seeds an Actor with a fake successful build and starts a run, without needing Docker. */
async function seedRun(server: TestServerHandle) {
	const actor = await server.client.actors().create({ name: 'alias-actor' });
	const { builds } = getRegistries();
	const buildId = 'aliasFakeBuildId1';
	await builds.set(buildId, {
		id: buildId,
		userId: actor.userId,
		actorId: actor.id,
		versionNumber: '0.0',
		buildNumber: '0.0.1',
		tag: 'latest',
		status: 'SUCCEEDED',
		startedAt: new Date().toISOString(),
		imageId: 'fake-image:latest',
	});
	await updateActor(actor.id, (current) => recordTaggedBuild(current, 'latest', buildId, '0.0.1'));
	return server.client.actor(actor.id).start({});
}

describe('actor-runs/:runId default-storage aliases', () => {
	let server: TestServerHandle;

	beforeEach(async () => {
		server = await startTestServer();
	});

	afterEach(async () => {
		await server.close();
	});

	it('dataset alias reaches the run default dataset', async () => {
		const run = await seedRun(server);
		const runClient = server.client.run(run.id);

		await runClient.dataset().pushItems({ ok: true });
		const info = await runClient.dataset().get();
		expect(info?.id).toBe(run.defaultDatasetId);
		expect(info?.itemCount).toBe(1);

		const directInfo = await server.client.dataset(run.defaultDatasetId).get();
		expect(directInfo?.itemCount).toBe(1);
	});

	it('key-value-store alias reaches the run default store', async () => {
		const run = await seedRun(server);
		const runClient = server.client.run(run.id);

		await runClient.keyValueStore().setRecord({ key: 'OUTPUT', value: { done: true } });
		const record = await server.client.keyValueStore(run.defaultKeyValueStoreId).getRecord('OUTPUT');
		expect(record?.value).toEqual({ done: true });
	});

	it('request-queue alias reaches the run default queue', async () => {
		const run = await seedRun(server);
		const runClient = server.client.run(run.id);

		await runClient.requestQueue().addRequest({ url: 'http://example.com', uniqueKey: 'x' });
		const info = await server.client.requestQueue(run.defaultRequestQueueId).get();
		expect(info?.totalRequestCount).toBe(1);
	});

	it('head/lock and unlock aliases respond 2xx with non-locking semantics', async () => {
		const run = await seedRun(server);
		const runClient = server.client.run(run.id);
		await runClient.requestQueue().addRequest({ url: 'http://example.com/1', uniqueKey: '1' });

		const locked = await runClient.requestQueue().listAndLockHead({ lockSecs: 60, limit: 10 });
		expect(locked.items).toHaveLength(1);

		const unlock = await runClient.requestQueue().unlockRequests();
		expect(unlock.unlockedCount).toBe(1);
	});
});

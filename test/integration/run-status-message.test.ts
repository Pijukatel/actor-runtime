/**
 * Actor-set run status messages (`api.md`'s "Run status messages"): `PUT /v2/actor-runs/:runId` through a
 * real `apify-client`, the way the SDKs' `Actor.setStatusMessage()` reaches it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import axios from 'axios';

import { startTestServer, type TestServerHandle } from './helpers/test-server.js';
import { createStorage } from '../../src/services/storages.js';
import { getRegistries } from '../../src/storage/registries.js';
import { generateId } from '../../src/storage/ids.js';
import type { JobStatus, RunRecord } from '../../src/storage/entities.js';

describe('run status messages', () => {
	let server: TestServerHandle;

	beforeEach(async () => {
		server = await startTestServer();
	});

	afterEach(async () => {
		await server.close();
	});

	async function seedRun(status: JobStatus = 'RUNNING'): Promise<RunRecord> {
		const actor = await server.client.actors().create({ name: `status-message-${generateId()}` });
		const [dataset, keyValueStore, requestQueue] = await Promise.all([
			createStorage(actor.userId, 'dataset'),
			createStorage(actor.userId, 'keyValueStore'),
			createStorage(actor.userId, 'requestQueue'),
		]);
		const run: RunRecord = {
			id: generateId(),
			userId: actor.userId,
			actorId: actor.id,
			buildId: generateId(),
			buildNumber: '0.0.1',
			status,
			startedAt: new Date().toISOString(),
			defaultDatasetId: dataset.id,
			defaultKeyValueStoreId: keyValueStore.id,
			defaultRequestQueueId: requestQueue.id,
			options: { memoryMbytes: 1024, timeoutSecs: 300 },
			meta: { origin: 'API' },
		};
		await getRegistries().runs.set(run.id, run);
		return run;
	}

	function put(runId: string, body: unknown) {
		return axios.put(`${server.baseUrl}/v2/actor-runs/${runId}`, body, {
			headers: { Authorization: `Bearer ${server.token}` },
			validateStatus: () => true,
		});
	}

	it('sets the message and its terminal flag, visible on the run object', async () => {
		const run = await seedRun();
		const updated = await server.client.run(run.id).update({ statusMessage: 'Crawled 3 of 10 pages' });
		expect(updated.statusMessage).toBe('Crawled 3 of 10 pages');
		expect(updated.isStatusMessageTerminal).toBeUndefined();

		await server.client.run(run.id).update({ statusMessage: 'Done', isStatusMessageTerminal: true });
		const fetched = await server.client.run(run.id).get();
		expect(fetched?.statusMessage).toBe('Done');
		expect(fetched?.isStatusMessageTerminal).toBe(true);
	});

	it('replaces both fields on every call, clearing what is not sent', async () => {
		const run = await seedRun();
		await put(run.id, { statusMessage: 'Done', isStatusMessageTerminal: true });
		const response = await put(run.id, {});
		expect(response.status).toBe(200);
		expect(response.data.data.statusMessage).toBeUndefined();
		expect(response.data.data.isStatusMessageTerminal).toBeUndefined();
	});

	it('truncates a message over 500 characters', async () => {
		const run = await seedRun();
		const response = await put(run.id, { statusMessage: 'x'.repeat(600) });
		expect(response.status).toBe(200);
		expect(response.data.data.statusMessage).toHaveLength(500);
		expect(response.data.data.statusMessage.endsWith('...')).toBe(true);
	});

	it('rejects a terminal flag without a message, and wrongly typed fields', async () => {
		const run = await seedRun();
		const noMessage = await put(run.id, { isStatusMessageTerminal: true });
		expect(noMessage.status).toBe(400);
		expect(noMessage.data.error.type).toBe('cannot-set-is-status-message-terminal');

		expect((await put(run.id, { statusMessage: 42 })).status).toBe(400);
		expect((await put(run.id, { statusMessage: 'ok', isStatusMessageTerminal: 'yes' })).status).toBe(400);
	});

	it("keeps the runtime's own reason for ending the run", async () => {
		const run = await seedRun('ABORTING');
		await getRegistries().runs.update(run.id, (current) =>
			current
				? {
						...current,
						statusMessage: 'Cap reached',
						isStatusMessageTerminal: true,
						isStatusMessageFromRuntime: true,
					}
				: current,
		);
		const response = await put(run.id, { statusMessage: 'Finished!', isStatusMessageTerminal: true });
		expect(response.status).toBe(200);
		expect(response.data.data.statusMessage).toBe('Cap reached');
	});

	it('accepts an update on a finished run, and 404s an unknown one', async () => {
		const run = await seedRun('SUCCEEDED');
		const response = await put(run.id, { statusMessage: 'Finished', isStatusMessageTerminal: true });
		expect(response.status).toBe(200);
		expect(response.data.data.status).toBe('SUCCEEDED');
		expect(response.data.data.statusMessage).toBe('Finished');

		const unknown = await put(generateId(), { statusMessage: 'x' });
		expect(unknown.status).toBe(404);
		expect(unknown.data.error.type).toBe('record-not-found');
	});
});

/** Covers `run-sync` and `run-sync-get-dataset-items` (`api.md`'s "Synchronous runs"). */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import axios from 'axios';

import { capturingDriver, startTestServer, type TestServerHandle } from './helpers/test-server.js';
import { setRunSyncWaitSecsForTests } from '../../src/api/routes/run-sync.js';
import { openDataset, openKeyValueStore } from '../../src/storage/open.js';
import type { Driver, RunContext, RunOutcome } from '../../src/driver/types.js';

type RunBehaviour = (ctx: RunContext) => Promise<RunOutcome>;

/** Builds succeed at once; each run does whatever the test sets as `behaviour`, writing to its default
 * storages the way an Actor would. */
function scriptedDriver(): { driver: Driver; setBehaviour(behaviour: RunBehaviour): void } {
	let behaviour: RunBehaviour = async () => ({ exitCode: 0 });
	const driver: Driver = {
		...capturingDriver().driver,
		async startRun(ctx) {
			return behaviour(ctx);
		},
	};
	return { driver, setBehaviour: (next) => (behaviour = next) };
}

describe('synchronous runs', () => {
	let server: TestServerHandle;
	let scripted: ReturnType<typeof scriptedDriver>;
	let actorId: string;

	beforeEach(async () => {
		scripted = scriptedDriver();
		server = await startTestServer(scripted.driver);
		const actor = await server.client.actors().create({ name: 'sync-actor' });
		actorId = actor.id;
		await server.client
			.actor(actorId)
			.versions()
			.create({ versionNumber: '0.0', buildTag: 'latest', sourceType: 'SOURCE_FILES' as never, sourceFiles: [] });
		const build = await server.client.actor(actorId).build('0.0', { waitForFinish: 5 });
		expect(build.status).toBe('SUCCEEDED');
	});

	afterEach(async () => {
		setRunSyncWaitSecsForTests(undefined);
		await server.close();
	});

	function call(method: 'get' | 'post', path: string, body?: unknown) {
		return axios.request({
			method,
			url: `${server.baseUrl}/v2/actors/${actorId}/${path}`,
			data: body,
			headers: { Authorization: `Bearer ${server.token}`, 'Content-Type': 'application/json' },
			validateStatus: () => true,
			transformResponse: (raw) => raw,
		});
	}

	it('run-sync answers 201 with the OUTPUT record and its content type, the run having seen the input', async () => {
		scripted.setBehaviour(async (ctx) => {
			const store = await openKeyValueStore(ctx.env.APIFY_DEFAULT_KEY_VALUE_STORE_ID!);
			const input = await store.getValue<{ name: string }>('INPUT');
			await store.setValue('OUTPUT', JSON.stringify({ hello: input?.name }), {
				contentType: 'application/json',
			});
			await store.setValue('OTHER', 'plain text', { contentType: 'text/plain' });
			return { exitCode: 0 };
		});

		for (const method of ['get', 'post'] as const) {
			const output = await call(method, 'run-sync', method === 'post' ? { name: 'world' } : undefined);
			expect(output.status).toBe(201);
			expect(output.headers['content-type']).toContain('application/json');
			expect(JSON.parse(output.data)).toEqual(method === 'post' ? { hello: 'world' } : {});
		}

		const other = await call('post', 'run-sync?outputRecordKey=OTHER');
		expect(other.status).toBe(201);
		expect(other.headers['content-type']).toContain('text/plain');
		expect(other.data).toBe('plain text');
	});

	it('run-sync answers an empty 201 when the run wrote no output record', async () => {
		const response = await call('post', 'run-sync');
		expect(response.status).toBe(201);
		expect(response.data).toBe('');
	});

	it('run-sync-get-dataset-items answers 201 with the default dataset items, honouring the items parameters', async () => {
		scripted.setBehaviour(async (ctx) => {
			const dataset = await openDataset(ctx.env.APIFY_DEFAULT_DATASET_ID!);
			await dataset.pushData([
				{ n: 1, a: 'x' },
				{ n: 2, a: 'y' },
				{ n: 3, a: 'z' },
			]);
			return { exitCode: 0 };
		});

		for (const method of ['get', 'post'] as const) {
			const all = await call(method, 'run-sync-get-dataset-items');
			expect(all.status).toBe(201);
			expect(JSON.parse(all.data)).toEqual([
				{ n: 1, a: 'x' },
				{ n: 2, a: 'y' },
				{ n: 3, a: 'z' },
			]);
			expect(all.headers['x-apify-pagination-total']).toBe('3');
		}

		const page = await call('post', 'run-sync-get-dataset-items?offset=1&limit=1&fields=n');
		expect(page.status).toBe(201);
		expect(JSON.parse(page.data)).toEqual([{ n: 2 }]);
	});

	it('a run that does not succeed is 400 run-failed', async () => {
		scripted.setBehaviour(async () => ({ exitCode: 1 }));
		for (const path of ['run-sync', 'run-sync-get-dataset-items']) {
			const response = await call('post', path);
			expect(response.status).toBe(400);
			const { error } = JSON.parse(response.data);
			expect(error.type).toBe('run-failed');
			expect(error.message).toMatch(/^Actor run did not succeed \(run ID: \w+, status: FAILED\)\.$/);
		}
	});

	it('a run still going when the wait ends is 408 run-timeout-exceeded and keeps running', async () => {
		setRunSyncWaitSecsForTests(0.3);
		let finish!: () => void;
		scripted.setBehaviour(() => new Promise<RunOutcome>((resolve) => (finish = () => resolve({ exitCode: 0 }))));

		const response = await call('post', 'run-sync');
		expect(response.status).toBe(408);
		const { error } = JSON.parse(response.data);
		expect(error).toEqual({
			type: 'run-timeout-exceeded',
			message: 'Actor run exceeded the timeout of 0.3 seconds for this API endpoint',
		});

		const [run] = (await server.client.actor(actorId).runs().list()).items;
		expect(run!.status).toBe('RUNNING');
		finish();
		const finished = await server.client.run(run!.id).waitForFinish({ waitSecs: 5 });
		expect(finished!.status).toBe('SUCCEEDED');
	});

	it('an unknown Actor is 404 record-not-found and starts nothing', async () => {
		const response = await axios.post(`${server.baseUrl}/v2/actors/nope/run-sync`, undefined, {
			headers: { Authorization: `Bearer ${server.token}` },
			validateStatus: () => true,
		});
		expect(response.status).toBe(404);
		expect(response.data.error.type).toBe('record-not-found');
	});
});

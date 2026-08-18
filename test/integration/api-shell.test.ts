import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import axios from 'axios';

import { startTestServer, type TestServerHandle } from './helpers/test-server.js';
import { getRegistries } from '../../src/storage/registries.js';

describe('API shell: envelope, 501/404, internal-object isolation, ownership scoping', () => {
	let server: TestServerHandle;

	beforeEach(async () => {
		server = await startTestServer();
	});

	afterEach(async () => {
		await server.close();
	});

	function get(path: string) {
		return axios.get(`${server.baseUrl}${path}`, {
			headers: { Authorization: `Bearer ${server.token}` },
			validateStatus: () => true,
		});
	}

	it('wraps every JSON response in {"data": ...}', async () => {
		const res = await get('/v2/users/me');
		expect(res.status).toBe(200);
		expect(res.data).toHaveProperty('data');
		expect(res.data.data).toHaveProperty('username');
	});

	it('a real-but-unimplemented spec path answers 501', async () => {
		const res = await get('/v2/schedules');
		expect(res.status).toBe(501);
	});

	it('a path absent from the spec entirely answers 404', async () => {
		const res = await get('/v2/this-path-does-not-exist-anywhere');
		expect(res.status).toBe(404);
	});

	it('a 404 for an unknown resource id uses the record-not-found error type', async () => {
		const res = await get('/v2/datasets/doesNotExist12345');
		expect(res.status).toBe(404);
		expect(res.data.error.type).toBe('record-not-found');
	});

	it('rejects requests with no auth token', async () => {
		const res = await axios.get(`${server.baseUrl}/v2/users/me`, { validateStatus: () => true });
		expect(res.status).toBe(401);
	});

	it('internal registries are not reachable through the public storage endpoints', async () => {
		// __STORAGES__ etc. are internal KeyValueStore frontends opened by name; confirm none of their
		// names resolve as a public dataset/key-value-store/request-queue id.
		const internalNames = [
			'__STORAGES__',
			'__USERS__',
			'__ACTORS__',
			'__RUNS__',
			'__BUILDS__',
			'__LOGS__',
			'__FILES__',
		];
		for (const name of internalNames) {
			const kv = await get(`/v2/key-value-stores/${name}`);
			expect(kv.status).toBe(404);
			const ds = await get(`/v2/datasets/${name}`);
			expect(ds.status).toBe(404);
		}

		// And they never show up in a listing either.
		const { items } = (await get('/v2/key-value-stores')).data.data as { items: Array<{ id: string }> };
		for (const item of items) {
			expect(internalNames).not.toContain(item.id);
		}
	});

	it("list endpoints only ever return resources owned by the calling token's user", async () => {
		await server.client.actors().create({ name: 'owned-actor' });
		await server.client.datasets().getOrCreate('owned-dataset');

		const { id: userId } = (await getRegistries().users.list())[0]!;

		const actorsRes = await get('/v2/actors');
		for (const actor of actorsRes.data.data.items) {
			expect(actor.userId).toBe(userId);
		}

		const datasetsRes = await get('/v2/datasets');
		for (const dataset of datasetsRes.data.data.items) {
			expect(dataset.userId).toBe(userId);
		}
	});
});

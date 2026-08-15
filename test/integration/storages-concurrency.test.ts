import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { startTestServer, type TestServerHandle } from './helpers/test-server.js';
import { createStorage, listOwnedStorages } from '../../src/services/storages.js';

/**
 * Regression coverage for the `createStorage`-by-name TOCTOU race: two concurrent
 * `getOrCreate(name)` calls for the same `(userId, type, name)` must mint exactly one record, never
 * two. `datasets.test.ts` / `key-value-stores.test.ts` / `request-queues.test.ts` each already assert
 * idempotency for two *sequential* calls; this file is the concurrent case, once at the service level
 * (bypassing HTTP, the same code path all three storage routes call) and once over real HTTP.
 */
describe('createStorage getOrCreate-by-name concurrency', () => {
	let server: TestServerHandle;

	beforeEach(async () => {
		server = await startTestServer();
	});

	afterEach(async () => {
		await server.close();
	});

	it('service level: two concurrent createStorage calls with the same name mint exactly one record', async () => {
		const user = await server.client.user('me').get();
		const userId = user!.id;

		const [a, b] = await Promise.all([
			createStorage(userId, 'dataset', 'same-name-concurrent'),
			createStorage(userId, 'dataset', 'same-name-concurrent'),
		]);

		expect(a.id).toBe(b.id);

		const all = await listOwnedStorages(userId, 'dataset');
		expect(all.filter((s) => s.name === 'same-name-concurrent')).toHaveLength(1);
	});

	it('HTTP level: two concurrent getOrCreate calls with the same name (real apify-client) yield one dataset', async () => {
		const [a, b] = await Promise.all([
			server.client.datasets().getOrCreate('same-name-http-concurrent'),
			server.client.datasets().getOrCreate('same-name-http-concurrent'),
		]);

		expect(a.id).toBe(b.id);

		const { items } = await server.client.datasets().list();
		expect(items.filter((d) => d.name === 'same-name-http-concurrent')).toHaveLength(1);
	});
});

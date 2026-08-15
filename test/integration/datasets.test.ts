import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { startTestServer, type TestServerHandle } from './helpers/test-server.js';

describe('datasets API (via real apify-client)', () => {
	let server: TestServerHandle;

	beforeEach(async () => {
		server = await startTestServer();
	});

	afterEach(async () => {
		await server.close();
	});

	it('creates, lists, and gets a dataset', async () => {
		const created = await server.client.datasets().getOrCreate('my-dataset');
		expect(created.id).toHaveLength(17);
		expect(created.itemCount).toBe(0);

		const { items: list } = await server.client.datasets().list();
		expect(list).toHaveLength(1);
		expect(list[0]!.id).toBe(created.id);

		const fetched = await server.client.dataset(created.id).get();
		expect(fetched?.id).toBe(created.id);
	});

	it('pushes and paginates items', async () => {
		const { id } = await server.client.datasets().getOrCreate();
		const dataset = server.client.dataset(id);

		await dataset.pushItems([{ n: 1 }, { n: 2 }, { n: 3 }]);

		const info = await dataset.get();
		expect(info?.itemCount).toBe(3);

		const page1 = await dataset.listItems({ limit: 2, offset: 0 });
		expect(page1.items).toEqual([{ n: 1 }, { n: 2 }]);
		expect(page1.total).toBe(3);

		const page2 = await dataset.listItems({ limit: 2, offset: 2 });
		expect(page2.items).toEqual([{ n: 3 }]);
	});

	it('applies fields/omit/clean projections over a page', async () => {
		const { id } = await server.client.datasets().getOrCreate();
		const dataset = server.client.dataset(id);
		await dataset.pushItems([{ a: 1, b: 2, '#hidden': 'x', empty: '' }]);

		const fieldsOnly = await dataset.listItems({ fields: ['a'] });
		expect(fieldsOnly.items).toEqual([{ a: 1 }]);

		const cleaned = await dataset.listItems({ clean: true });
		expect(cleaned.items).toEqual([{ a: 1, b: 2 }]);
	});

	it('supports desc ordering', async () => {
		const { id } = await server.client.datasets().getOrCreate();
		const dataset = server.client.dataset(id);
		await dataset.pushItems([{ n: 1 }, { n: 2 }, { n: 3 }]);

		const desc = await dataset.listItems({ desc: true });
		expect(desc.items).toEqual([{ n: 3 }, { n: 2 }, { n: 1 }]);
	});

	it('renames and deletes a dataset', async () => {
		const { id } = await server.client.datasets().getOrCreate();
		const dataset = server.client.dataset(id);

		const renamed = await dataset.update({ name: 'renamed' });
		expect(renamed.name).toBe('renamed');

		await dataset.delete();
		expect(await dataset.get()).toBeUndefined();
	});

	it('404s (record-not-found) for an unknown dataset id, so the client returns undefined', async () => {
		const result = await server.client.dataset('nonexistent1234567').get();
		expect(result).toBeUndefined();
	});

	it('DELETE on an unknown dataset id 404s with record-not-found (not a bare 204)', async () => {
		// apify-client-js's own `.delete()` swallows a `record-not-found` 404 to stay idempotent from
		// the caller's perspective, so hit the HTTP endpoint directly to observe the real status/envelope
		// - matches the fixed `DELETE /actor-builds/:buildId` / `DELETE /actor-runs/:runId` contract and
		// api.md's documented response envelopes.
		const res = await fetch(`${server.baseUrl}/v2/datasets/nonexistent1234567`, {
			method: 'DELETE',
			headers: { Authorization: `Bearer ${server.token}` },
		});
		expect(res.status).toBe(404);
		const body = (await res.json()) as { error: { type: string } };
		expect(body.error.type).toBe('record-not-found');
	});

	it('getOrCreate is idempotent by name - two calls with the same name yield the same dataset', async () => {
		const first = await server.client.datasets().getOrCreate('same-name');
		const second = await server.client.datasets().getOrCreate('same-name');
		expect(second.id).toBe(first.id);

		const { items: list } = await server.client.datasets().list();
		expect(list).toHaveLength(1);
	});
});

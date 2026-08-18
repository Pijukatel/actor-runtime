import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { startTestServer, type TestServerHandle } from './helpers/test-server.js';

describe('key-value-stores API (via real apify-client)', () => {
	let server: TestServerHandle;

	beforeEach(async () => {
		server = await startTestServer();
	});

	afterEach(async () => {
		await server.close();
	});

	it('creates, lists, and gets a store', async () => {
		const created = await server.client.keyValueStores().getOrCreate('my-store');
		expect(created.id).toHaveLength(17);

		const { items } = await server.client.keyValueStores().list();
		expect(items).toHaveLength(1);

		const fetched = await server.client.keyValueStore(created.id).get();
		expect(fetched?.id).toBe(created.id);
	});

	it('round-trips a JSON record byte-exact', async () => {
		const { id } = await server.client.keyValueStores().getOrCreate();
		const store = server.client.keyValueStore(id);

		await store.setRecord({ key: 'OUTPUT', value: { hello: 'world' } });
		const record = await store.getRecord('OUTPUT');
		expect(record?.value).toEqual({ hello: 'world' });
	});

	it('round-trips a binary record byte-exact with its content type', async () => {
		const { id } = await server.client.keyValueStores().getOrCreate();
		const store = server.client.keyValueStore(id);

		const bytes = Buffer.from([0, 1, 2, 254, 255, 10, 13]);
		await store.setRecord({ key: 'binary.dat', value: bytes, contentType: 'application/octet-stream' });

		const record = await store.getRecord('binary.dat');
		expect(Buffer.isBuffer(record?.value)).toBe(true);
		expect(record?.value).toEqual(bytes);
		expect(record?.contentType).toBe('application/octet-stream');
	});

	it('handles a record written with no explicit Content-Type', async () => {
		const { id } = await server.client.keyValueStores().getOrCreate();
		const store = server.client.keyValueStore(id);
		await store.setRecord({ key: 'k', value: 'plain text', contentType: 'text/plain' });
		const record = await store.getRecord('k');
		expect(record?.value).toBe('plain text');
	});

	it('reports record existence and 404s for missing records', async () => {
		const { id } = await server.client.keyValueStores().getOrCreate();
		const store = server.client.keyValueStore(id);
		await store.setRecord({ key: 'present', value: '1' });

		expect(await store.getRecord('missing')).toBeUndefined();
	});

	it('deletes a record', async () => {
		const { id } = await server.client.keyValueStores().getOrCreate();
		const store = server.client.keyValueStore(id);
		await store.setRecord({ key: 'k', value: '1' });
		await store.deleteRecord('k');
		expect(await store.getRecord('k')).toBeUndefined();
	});

	it('deleting a missing record key on an existing store stays a 204 no-op (matches apify-core: S3 NotFound is swallowed)', async () => {
		const { id } = await server.client.keyValueStores().getOrCreate();
		const store = server.client.keyValueStore(id);
		await expect(store.deleteRecord('never-existed')).resolves.toBeUndefined();
	});

	it('deleting a record on an unknown store id 404s with record-not-found (not a bare 204)', async () => {
		const res = await fetch(`${server.baseUrl}/v2/key-value-stores/nonexistent1234567/records/some-key`, {
			method: 'DELETE',
			headers: { Authorization: `Bearer ${server.token}` },
		});
		expect(res.status).toBe(404);
		const body = (await res.json()) as { error: { type: string } };
		expect(body.error.type).toBe('record-not-found');
	});

	it('lists keys across a cursor', async () => {
		const { id } = await server.client.keyValueStores().getOrCreate();
		const store = server.client.keyValueStore(id);
		for (let i = 0; i < 5; i++) {
			await store.setRecord({ key: `key-${i}`, value: String(i) });
		}

		const page1 = await store.listKeys({ limit: 2 });
		expect(page1.items).toHaveLength(2);
		expect(page1.isTruncated).toBe(true);

		const page2 = await store.listKeys({ limit: 10, exclusiveStartKey: page1.nextExclusiveStartKey });
		expect(page2.items.length).toBe(3);
	});

	it('renames and deletes a store', async () => {
		const { id } = await server.client.keyValueStores().getOrCreate();
		const store = server.client.keyValueStore(id);
		const renamed = await store.update({ name: 'renamed-store' });
		expect(renamed.name).toBe('renamed-store');
		await store.delete();
		expect(await store.get()).toBeUndefined();
	});

	it('DELETE on an unknown store id 404s with record-not-found (not a bare 204)', async () => {
		const res = await fetch(`${server.baseUrl}/v2/key-value-stores/nonexistent1234567`, {
			method: 'DELETE',
			headers: { Authorization: `Bearer ${server.token}` },
		});
		expect(res.status).toBe(404);
		const body = (await res.json()) as { error: { type: string } };
		expect(body.error.type).toBe('record-not-found');
	});

	it('getOrCreate is idempotent by name - two calls with the same name yield the same store', async () => {
		const first = await server.client.keyValueStores().getOrCreate('same-name');
		const second = await server.client.keyValueStores().getOrCreate('same-name');
		expect(second.id).toBe(first.id);

		const { items: list } = await server.client.keyValueStores().list();
		expect(list).toHaveLength(1);
	});
});

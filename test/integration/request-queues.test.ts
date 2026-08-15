import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { startTestServer, type TestServerHandle } from './helpers/test-server.js';

describe('request-queues API (via real apify-client, both client dialects)', () => {
	let server: TestServerHandle;

	beforeEach(async () => {
		server = await startTestServer();
	});

	afterEach(async () => {
		await server.close();
	});

	it('creates, lists, and gets a queue with real counts', async () => {
		const created = await server.client.requestQueues().getOrCreate('my-queue');
		expect(created.id).toHaveLength(17);
		expect(created.totalRequestCount).toBe(0);

		const { items } = await server.client.requestQueues().list();
		expect(items).toHaveLength(1);
	});

	it('getOrCreate is idempotent by name - two calls with the same name yield the same queue', async () => {
		const first = await server.client.requestQueues().getOrCreate('same-name');
		const second = await server.client.requestQueues().getOrCreate('same-name');
		expect(second.id).toBe(first.id);

		const { items: list } = await server.client.requestQueues().list();
		expect(list).toHaveLength(1);
	});

	it('single addRequest, then fetches it back via GET /requests/:id', async () => {
		const { id } = await server.client.requestQueues().getOrCreate();
		const queue = server.client.requestQueue(id);

		const added = await queue.addRequest({ url: 'http://example.com/a', uniqueKey: 'a' });
		expect(added.wasAlreadyPresent).toBe(false);
		expect(added.wasAlreadyHandled).toBe(false);

		const fetched = await queue.getRequest(added.requestId);
		expect(fetched?.url).toBe('http://example.com/a');
		expect(fetched?.uniqueKey).toBe('a');
	});

	it('POST .../requests never leaks Crawlee-internal operation-info fields (forefront, uniqueKey) into the response body, on either arm', async () => {
		const { id } = await server.client.requestQueues().getOrCreate();

		const freshRes = await fetch(`${server.baseUrl}/v2/request-queues/${id}/requests`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${server.token}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ url: 'http://example.com/fresh', uniqueKey: 'fresh' }),
		});
		const freshBody = ((await freshRes.json()) as { data: Record<string, unknown> }).data;
		expect(Object.keys(freshBody).sort()).toEqual(['requestId', 'wasAlreadyHandled', 'wasAlreadyPresent']);

		// Re-adding the same uniqueKey exercises the `wasAlreadyPresent: true` arm.
		const dupeRes = await fetch(`${server.baseUrl}/v2/request-queues/${id}/requests`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${server.token}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ url: 'http://example.com/fresh', uniqueKey: 'fresh' }),
		});
		const dupeBody = ((await dupeRes.json()) as { data: Record<string, unknown> }).data;
		expect(Object.keys(dupeBody).sort()).toEqual(['requestId', 'wasAlreadyHandled', 'wasAlreadyPresent']);
		expect(dupeBody.wasAlreadyPresent).toBe(true);
	});

	it('the Crawlee v3 dialect: batchAddRequests -> listAndLockHead -> prolongRequestLock -> updateRequest(handledAt) -> listHead', async () => {
		const { id } = await server.client.requestQueues().getOrCreate();
		const queue = server.client.requestQueue(id);

		const batch = await queue.batchAddRequests([
			{ url: 'http://example.com/1', uniqueKey: '1' },
			{ url: 'http://example.com/2', uniqueKey: '2' },
		]);
		expect(batch.processedRequests).toHaveLength(2);
		expect(batch.unprocessedRequests).toHaveLength(0);

		const locked = await queue.listAndLockHead({ lockSecs: 60, limit: 10 });
		expect(locked.items).toHaveLength(2);
		expect(locked.queueHasLockedRequests).toBe(true);

		const first = locked.items[0]!;
		await queue.prolongRequestLock(first.id, { lockSecs: 120 });

		await queue.updateRequest({
			id: first.id,
			uniqueKey: first.uniqueKey,
			url: first.url,
			handledAt: new Date().toISOString(),
		});

		const head = await queue.listHead({ limit: 10 });
		// The second (still-locked) request is not offered again by a non-consuming peek since it was
		// already staged/handed-out; head reflects only what's currently staged.
		expect(head.items.every((i) => i.uniqueKey !== first.uniqueKey)).toBe(true);

		const info = await queue.get();
		expect(info?.handledRequestCount).toBe(1);
		expect(info?.pendingRequestCount).toBe(1);
	});

	it('the Python-SDK dialect: batch_add_requests -> list_head -> get_request -> update_request (reclaim, no lock)', async () => {
		const { id } = await server.client.requestQueues().getOrCreate();
		const queue = server.client.requestQueue(id);

		await queue.batchAddRequests([{ url: 'http://example.com/py', uniqueKey: 'py' }]);

		const head = await queue.listHead({ limit: 10 });
		expect(head.items).toHaveLength(1);
		const item = head.items[0]!;

		const fetched = await queue.getRequest(item.id);
		expect(fetched).toBeDefined();

		// Reclaim without ever locking (Python SDK's single client never locks).
		const updated = await queue.updateRequest({
			id: item.id,
			uniqueKey: item.uniqueKey,
			url: item.url,
			retryCount: 1,
		});
		expect(updated.requestId).toBe(item.id);
	});

	it('corrects wasAlreadyHandled on a batch re-add of an already-handled uniqueKey', async () => {
		const { id } = await server.client.requestQueues().getOrCreate();
		const queue = server.client.requestQueue(id);

		const added = await queue.addRequest({ url: 'http://example.com/x', uniqueKey: 'x' });
		const locked = await queue.listAndLockHead({ lockSecs: 60, limit: 1 });
		await queue.updateRequest({
			id: locked.items[0]!.id,
			uniqueKey: 'x',
			url: 'http://example.com/x',
			handledAt: new Date().toISOString(),
		});

		const rebatch = await queue.batchAddRequests([{ url: 'http://example.com/x', uniqueKey: 'x' }]);
		expect(rebatch.processedRequests).toHaveLength(1);
		expect(rebatch.processedRequests[0]!.wasAlreadyPresent).toBe(true);
		expect(rebatch.processedRequests[0]!.wasAlreadyHandled).toBe(true);
		expect(added.requestId).toBe(rebatch.processedRequests[0]!.requestId);
	});

	it('marking handled a request the client never fetched triggers the bounded drain, not a 404', async () => {
		const { id } = await server.client.requestQueues().getOrCreate();
		const queue = server.client.requestQueue(id);

		await queue.batchAddRequests([
			{ url: 'http://example.com/a', uniqueKey: 'a' },
			{ url: 'http://example.com/b', uniqueKey: 'b' },
			{ url: 'http://example.com/target', uniqueKey: 'target' },
		]);

		// Compute the id the same way the server does, without ever calling head/lock first.
		const added = await queue.addRequest({ url: 'http://example.com/target', uniqueKey: 'target' });

		const result = await queue.updateRequest({
			id: added.requestId,
			uniqueKey: 'target',
			url: 'http://example.com/target',
			handledAt: new Date().toISOString(),
		});
		expect(result.requestId).toBe(added.requestId);

		const info = await queue.get();
		expect(info?.handledRequestCount).toBe(1);
	});

	it('reclaiming an already-handled request does not throw and reports wasAlreadyHandled: true (frontend returns null)', async () => {
		const { id } = await server.client.requestQueues().getOrCreate();
		const queue = server.client.requestQueue(id);

		const added = await queue.addRequest({ url: 'http://example.com/h', uniqueKey: 'h' });
		await queue.updateRequest({
			id: added.requestId,
			uniqueKey: 'h',
			url: 'http://example.com/h',
			handledAt: new Date().toISOString(),
		});

		// Reclaim (no handledAt) of the now-handled request must not 500, and - mirroring markHandled's
		// own fallback for the same situation - must report `wasAlreadyHandled: true`, not `false`.
		const reclaimed = await queue.updateRequest({
			id: added.requestId,
			uniqueKey: 'h',
			url: 'http://example.com/h',
		});
		expect(reclaimed).toBeDefined();
		expect(reclaimed.wasAlreadyHandled).toBe(true);
	});

	it('deduplicates a duplicate uniqueKey within one batch', async () => {
		const { id } = await server.client.requestQueues().getOrCreate();
		const queue = server.client.requestQueue(id);

		// The `RequestQueue` frontend itself collapses duplicate uniqueKeys within one `addRequests`
		// call before it ever reaches the backend (`adapter.test.ts:83-97`), so only one request is
		// processed even though two were submitted - this is Crawlee's behaviour, not ours.
		const batch = await queue.batchAddRequests([
			{ url: 'http://example.com/dup', uniqueKey: 'dup' },
			{ url: 'http://example.com/dup', uniqueKey: 'dup' },
		]);
		expect(batch.processedRequests.length).toBeGreaterThanOrEqual(1);
		const info = await queue.get();
		expect(info?.totalRequestCount).toBe(1);
	});

	it('accepts a request added with handledAt already set', async () => {
		const { id } = await server.client.requestQueues().getOrCreate();
		const queue = server.client.requestQueue(id);

		await queue.addRequest({
			url: 'http://example.com/pre',
			uniqueKey: 'pre',
			handledAt: new Date().toISOString(),
		});
		const info = await queue.get();
		expect(info?.handledRequestCount).toBe(1);
	});

	it('never hands out the same request twice within a process under concurrent head/lock calls', async () => {
		const { id } = await server.client.requestQueues().getOrCreate();
		const queue = server.client.requestQueue(id);
		await queue.batchAddRequests(
			Array.from({ length: 10 }, (_, i) => ({ url: `http://example.com/${i}`, uniqueKey: `${i}` })),
		);

		const [a, b, c] = await Promise.all([
			queue.listAndLockHead({ lockSecs: 60, limit: 4 }),
			queue.listAndLockHead({ lockSecs: 60, limit: 4 }),
			queue.listAndLockHead({ lockSecs: 60, limit: 4 }),
		]);
		const allIds = [...a.items, ...b.items, ...c.items].map((i) => i.id);
		expect(new Set(allIds).size).toBe(allIds.length);
	});

	it('requests/unlock releases everything handed out', async () => {
		const { id } = await server.client.requestQueues().getOrCreate();
		const queue = server.client.requestQueue(id);
		await queue.batchAddRequests([
			{ url: 'http://example.com/1', uniqueKey: '1' },
			{ url: 'http://example.com/2', uniqueKey: '2' },
		]);
		await queue.listAndLockHead({ lockSecs: 60, limit: 10 });

		const result = await queue.unlockRequests();
		expect(result.unlockedCount).toBe(2);

		const head = await queue.listHead({ limit: 10 });
		expect(head.items).toHaveLength(2);
	});

	it('deleteRequestLock releases a single handed-out request', async () => {
		const { id } = await server.client.requestQueues().getOrCreate();
		const queue = server.client.requestQueue(id);
		await queue.addRequest({ url: 'http://example.com/1', uniqueKey: '1' });
		const locked = await queue.listAndLockHead({ lockSecs: 60, limit: 1 });

		await queue.deleteRequestLock(locked.items[0]!.id);
		const head = await queue.listHead({ limit: 10 });
		expect(head.items).toHaveLength(1);
	});

	it('GET /requests lists requests this process has seen, best-effort', async () => {
		const { id } = await server.client.requestQueues().getOrCreate();
		const queue = server.client.requestQueue(id);
		await queue.batchAddRequests([
			{ url: 'http://example.com/1', uniqueKey: '1' },
			{ url: 'http://example.com/2', uniqueKey: '2' },
		]);

		const listed = await queue.listRequests();
		expect(listed.items).toHaveLength(2);
	});

	it('request deletion endpoints return 501 through the real error envelope, not a bare {data: null}', async () => {
		const { id } = await server.client.requestQueues().getOrCreate();
		const queue = server.client.requestQueue(id);
		await queue.addRequest({ url: 'http://example.com/1', uniqueKey: '1' });

		// apify-client-js's `ApifyApiError` reads `type`/`message` off `responseData.error` - a bare
		// `{data: null}` 501 body would leave `type` undefined and `message` a generic "Unexpected
		// error: null" instead of the real `not-implemented` envelope every other 501/404 uses.
		await expect(queue.deleteRequest('nonexistent12345')).rejects.toMatchObject({
			statusCode: 501,
			type: 'not-implemented',
		});
		await expect(queue.batchDeleteRequests([{ uniqueKey: '1' }])).rejects.toMatchObject({
			statusCode: 501,
			type: 'not-implemented',
		});
	});

	it('404s (record-not-found) for an unknown queue id', async () => {
		expect(await server.client.requestQueue('nonexistent1234567').get()).toBeUndefined();
	});

	it('drops a queue and later requests for it 404', async () => {
		const { id } = await server.client.requestQueues().getOrCreate();
		await server.client.requestQueue(id).delete();
		expect(await server.client.requestQueue(id).get()).toBeUndefined();
	});

	it('DELETE on an unknown queue id 404s with record-not-found (not a bare 204)', async () => {
		// apify-client-js's own `.delete()` swallows a `record-not-found` 404 to stay idempotent from
		// the caller's perspective, so hit the HTTP endpoint directly to observe the real status/envelope.
		const res = await fetch(`${server.baseUrl}/v2/request-queues/nonexistent1234567`, {
			method: 'DELETE',
			headers: { Authorization: `Bearer ${server.token}` },
		});
		expect(res.status).toBe(404);
		const body = (await res.json()) as { error: { type: string } };
		expect(body.error.type).toBe('record-not-found');
	});
});

import { describe, expect, it } from 'vitest';
import { getRequestId, Request as CrawleeRequest, type RequestQueue } from '@crawlee/core';

import { RequestQueueBuffer } from '../../src/storage/request-queue/buffer.js';

/** A stub `RequestQueue`-shaped object: only `fetchNextRequest()` is used by the buffer itself. */
function stubQueue(urls: string[]): RequestQueue {
	const items = urls.map((url) => new CrawleeRequest({ url }));
	return {
		async fetchNextRequest() {
			return items.shift() ?? null;
		},
	} as unknown as RequestQueue;
}

describe('RequestQueueBuffer', () => {
	it('stage -> hand out -> handled releases the request from both staged and handed-out bookkeeping', async () => {
		const buffer = new RequestQueueBuffer(stubQueue(['http://a.com', 'http://b.com']));

		const staged = await buffer.peekHead(10);
		expect(staged).toHaveLength(2);

		const locked = await buffer.lockHead(1, 60);
		expect(locked).toHaveLength(1);
		expect(buffer.hasHandedOutRequests()).toBe(true);

		const requestId = getRequestId(locked[0]!.uniqueKey);
		expect(buffer.getLiveHandle(requestId)).toBeDefined();

		// Simulate a successful markRequestAsHandled by the caller, then the buffer's own release.
		buffer.releaseFromBuffers(requestId);
		expect(buffer.getLiveHandle(requestId)).toBeUndefined();
		expect(buffer.hasHandedOutRequests()).toBe(false);
	});

	it('stage -> hand out -> reclaim makes the request handed-out-free again', async () => {
		const buffer = new RequestQueueBuffer(stubQueue(['http://a.com']));
		const [locked] = await buffer.lockHead(1, 30);
		const requestId = getRequestId(locked!.uniqueKey);

		buffer.releaseFromBuffers(requestId);

		expect(buffer.hasHandedOutRequests()).toBe(false);
		expect(buffer.getLiveHandle(requestId)).toBeUndefined();
	});

	it('unlock-all releases every handed-out request at once', async () => {
		const buffer = new RequestQueueBuffer(stubQueue(['http://a.com', 'http://b.com', 'http://c.com']));
		await buffer.lockHead(3, 60);
		expect(buffer.hasHandedOutRequests()).toBe(true);

		const released = buffer.takeAllHandedOut();
		expect(released).toHaveLength(3);
		expect(buffer.hasHandedOutRequests()).toBe(false);
	});

	it('bounded drain finds a request further back in the queue than what is currently staged', async () => {
		const buffer = new RequestQueueBuffer(stubQueue(['http://a.com', 'http://b.com', 'http://target.com']));
		// Nothing staged yet.
		const targetId = getRequestId(new CrawleeRequest({ url: 'http://target.com' }).uniqueKey);

		const found = await buffer.drainUntilFound(targetId);
		expect(found?.url).toBe('http://target.com');
		// Draining staged the two requests it passed over along the way.
		expect(buffer.getLiveHandle(getRequestId(new CrawleeRequest({ url: 'http://a.com' }).uniqueKey))).toBeDefined();
	});

	it('drain gives up and returns undefined once the queue is exhausted', async () => {
		const buffer = new RequestQueueBuffer(stubQueue(['http://a.com']));
		const found = await buffer.drainUntilFound('nonexistent-request-id');
		expect(found).toBeUndefined();
	});

	it('peekHead does not remove requests from the buffer (non-consuming)', async () => {
		const buffer = new RequestQueueBuffer(stubQueue(['http://a.com', 'http://b.com']));
		const first = await buffer.peekHead(10);
		const second = await buffer.peekHead(10);
		expect(first).toHaveLength(2);
		expect(second).toHaveLength(2);
	});

	it('lockHead only ever hands out a request once within a process (no double hand-out)', async () => {
		const buffer = new RequestQueueBuffer(stubQueue(['http://a.com', 'http://b.com']));
		const first = await buffer.lockHead(1, 60);
		const second = await buffer.lockHead(1, 60);
		expect(first[0]?.url).not.toBe(second[0]?.url);
	});

	it('caps the buffer so it never grows unbounded', async () => {
		const urls = Array.from({ length: 1500 }, (_, i) => `http://example.com/${i}`);
		const buffer = new RequestQueueBuffer(stubQueue(urls));
		const staged = await buffer.peekHead(2000);
		expect(staged.length).toBeLessThanOrEqual(1000);
	});
});

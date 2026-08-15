import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Request as CrawleeRequest } from '@crawlee/core';

import { bootstrapStorage, resetStorageForTests, shutdownStorage } from '../../src/storage/bootstrap.js';
import {
	closeRequestQueueBuffer,
	getRequestQueueBuffer,
	releaseAllBuffersForShutdown,
} from '../../src/storage/request-queue/registry.js';
import * as openModule from '../../src/storage/open.js';
import { generateId } from '../../src/storage/ids.js';

/**
 * Regression coverage for the `getRequestQueueBuffer` TOCTOU: two concurrent first-touch calls for the
 * same queue id must resolve to the exact same `RequestQueueBuffer` instance, never two, so nothing
 * staged into one of them is ever stranded (see `registry.ts`'s doc comment).
 */
describe('getRequestQueueBuffer concurrency', () => {
	let dataDir: string;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), 'actor-runtime-rq-registry-'));
		bootstrapStorage(dataDir);
	});

	afterEach(async () => {
		await shutdownStorage();
		resetStorageForTests();
		await rm(dataDir, { recursive: true, force: true });
	});

	it('two concurrent first-touch calls for the same id return the exact same buffer instance', async () => {
		const queueId = generateId();

		const [a, b] = await Promise.all([getRequestQueueBuffer(queueId), getRequestQueueBuffer(queueId)]);

		expect(a).toBe(b);
	});

	it('three-way concurrent first touch also converges on one instance', async () => {
		const queueId = generateId();

		const [a, b, c] = await Promise.all([
			getRequestQueueBuffer(queueId),
			getRequestQueueBuffer(queueId),
			getRequestQueueBuffer(queueId),
		]);

		expect(a).toBe(b);
		expect(b).toBe(c);
	});

	it('no request is stranded: everything staged through a concurrent first touch is reachable afterwards and reclaimable on shutdown', async () => {
		const queueId = generateId();

		const [a, b] = await Promise.all([getRequestQueueBuffer(queueId), getRequestQueueBuffer(queueId)]);

		// Add through `a` and stage (peek) through `b` - with the fix these are the same object, so this
		// also proves nothing was staged into a buffer that a later `getRequestQueueBuffer(queueId)` call
		// could no longer reach.
		await a.queue.addRequests([
			new CrawleeRequest({ url: 'http://e.com/1', uniqueKey: '1' }),
			new CrawleeRequest({ url: 'http://e.com/2', uniqueKey: '2' }),
		]);
		await b.peekHead(10);

		const liveBuffer = await getRequestQueueBuffer(queueId);
		expect(liveBuffer).toBe(a);
		expect(liveBuffer.allOutstanding()).toHaveLength(2);

		await releaseAllBuffersForShutdown();

		// After the shutdown-reclaim, both requests are back on the queue proper, fetchable again -
		// nothing was left stranded as "in progress" forever in an orphaned buffer.
		closeRequestQueueBuffer(queueId);
		const reopened = await getRequestQueueBuffer(queueId);
		const first = await reopened.queue.fetchNextRequest();
		const second = await reopened.queue.fetchNextRequest();
		expect([first?.url, second?.url].sort()).toEqual(['http://e.com/1', 'http://e.com/2']);
	});

	it('a failed open does not poison the cache: the same id gets a fresh attempt on retry instead of an eternally-rejecting promise', async () => {
		const queueId = generateId();
		const boom = new Error('simulated openRequestQueue failure');
		// Rejects asynchronously (not a synchronous throw) so `openRequestQueue(id).then(...)` in
		// `registry.ts` actually produces a rejected *promise* that gets memoised into `buffers` before
		// settling - exercising the `pending.catch(() => buffers.delete(id))` cleanup arm this test
		// targets, rather than a throw that never reaches the map at all.
		const openSpy = vi.spyOn(openModule, 'openRequestQueue').mockImplementationOnce(async () => {
			throw boom;
		});

		await expect(getRequestQueueBuffer(queueId)).rejects.toThrow(boom);

		// The rejected promise must have been dropped from the memo (`registry.ts`'s
		// `pending.catch(() => buffers.delete(id))`) - otherwise every future call for this id would
		// keep resolving to the same eternally-rejecting promise instead of trying again.
		const buffer = await getRequestQueueBuffer(queueId);
		expect(buffer).toBeDefined();
		expect(openSpy).toHaveBeenCalledTimes(2);

		openSpy.mockRestore();
	});
});

import { openRequestQueue } from '../open.js';
import { RequestQueueBuffer } from './buffer.js';

/**
 * Memoised by *promise*, not by resolved value - two concurrent first-touch calls for the same `id`
 * must observe the in-flight `openRequestQueue`+construct as a single critical section, otherwise both
 * pass the "not found" check before either has stored a buffer, each builds its own
 * `RequestQueueBuffer` wrapping the same underlying `RequestQueue`, and whichever `set` runs last wins -
 * silently orphaning the other buffer's staged/handed-out requests (they stay marked in-progress in
 * Crawlee forever, since `releaseAllBuffersForShutdown` can only iterate buffers still reachable from
 * this map). Storing the pending promise closes that window: the second concurrent caller gets back the
 * exact same promise (and, once it resolves, the exact same buffer instance) as the first.
 */
const buffers = new Map<string, Promise<RequestQueueBuffer>>();

export async function getRequestQueueBuffer(id: string): Promise<RequestQueueBuffer> {
	let pending = buffers.get(id);
	if (!pending) {
		pending = openRequestQueue(id).then((queue) => new RequestQueueBuffer(queue));
		// A failed open must not poison every future call for this id - drop the memoised rejection so
		// the next caller gets a fresh attempt instead of an eternally-rejecting promise.
		pending.catch(() => buffers.delete(id));
		buffers.set(id, pending);
	}
	return pending;
}

/** Called when a request queue is dropped, so a future id (never reused in practice) starts clean. */
export function closeRequestQueueBuffer(id: string): void {
	buffers.delete(id);
}

/**
 * Graceful shutdown: reclaim everything staged-or-handed-out in every open buffer, so nothing is
 * stranded in progress, before `shutdownStorage()` calls `teardown()`.
 */
export async function releaseAllBuffersForShutdown(): Promise<void> {
	for (const pending of buffers.values()) {
		const buffer = await pending.catch(() => undefined);
		if (!buffer) continue;
		for (const request of buffer.allOutstanding()) {
			await buffer.queue.reclaimRequest(request).catch(() => undefined);
		}
	}
}

/**
 * The per-queue head buffer: a small FIFO of requests pulled out of the `RequestQueue` frontend with
 * `fetchNextRequest()` (which marks them in-progress), held in one of two states - *staged* (fetched
 * so the runtime can answer a non-consuming `GET /head` peek, not yet handed to any HTTP caller) or
 * *handed out* (returned from `POST /head/lock`, not offered again until marked handled, reclaimed,
 * or unlocked).
 *
 * Also keeps the id index: `requestId -> uniqueKey` for every request this process has ever seen
 * (added, staged, or handed out), because `getRequestId` is one-way and there is no reverse lookup on
 * the frontend. This index is a lookup aid only - ordering, dedup, in-progress/handled state and all
 * counts stay in Crawlee's `RequestQueue`, single-sourced. It is deliberately not persisted (see
 * `storage.md`'s "Known differences" section): a restart already orphans every run.
 */
import { getRequestId, type Request as CrawleeRequest, type RequestQueue } from '@crawlee/core';

/** Buffer + index cap: staged + handed-out + indexed-only entries never grow past this. */
const BUFFER_CAP = 1000;
/** How many `fetchNextRequest()` calls the bounded drain is willing to make looking for one id. */
const DRAIN_CAP = 1000;

export interface HeadItem {
	request: CrawleeRequest;
	lockExpiresAt?: number;
}

export class RequestQueueBuffer {
	private readonly staged: CrawleeRequest[] = [];
	private readonly handedOut = new Map<string, { request: CrawleeRequest; lockExpiresAt: number }>();
	/** requestId -> uniqueKey, for every request ever seen. Never removed (POC-scale, process-lifetime). */
	private readonly uniqueKeyIndex = new Map<string, string>();
	/** requestId insertion order, for `GET /requests`. */
	private readonly insertionOrder: string[] = [];

	constructor(readonly queue: RequestQueue) {}

	private remember(requestId: string, uniqueKey: string): void {
		if (!this.uniqueKeyIndex.has(requestId)) {
			this.uniqueKeyIndex.set(requestId, uniqueKey);
			this.insertionOrder.push(requestId);
		}
	}

	/** Called when a request is added via `addRequest`/`addRequests`, before it is ever staged. */
	rememberAdded(uniqueKey: string): void {
		this.remember(getRequestId(uniqueKey), uniqueKey);
	}

	uniqueKeyFor(requestId: string): string | undefined {
		return this.uniqueKeyIndex.get(requestId);
	}

	listSeenRequestIds(): readonly string[] {
		return this.insertionOrder;
	}

	private bufferSize(): number {
		return this.staged.length + this.handedOut.size;
	}

	private async topUp(limit: number): Promise<void> {
		while (this.staged.length < limit && this.bufferSize() < BUFFER_CAP) {
			const next = await this.queue.fetchNextRequest();
			if (!next) break;
			this.remember(getRequestId(next.uniqueKey), next.uniqueKey);
			this.staged.push(next);
		}
	}

	/** Non-consuming peek: top up staged up to `limit`, return staged items without removing them. */
	async peekHead(limit: number): Promise<CrawleeRequest[]> {
		await this.topUp(limit);
		return this.staged.slice(0, limit);
	}

	/** Top up, then move up to `limit` staged items to handed-out, FIFO. */
	async lockHead(limit: number, lockSecs: number): Promise<CrawleeRequest[]> {
		await this.topUp(limit);
		const taken = this.staged.splice(0, limit);
		const lockExpiresAt = Date.now() + lockSecs * 1000;
		for (const request of taken) {
			this.handedOut.set(getRequestId(request.uniqueKey), { request, lockExpiresAt });
		}
		return taken;
	}

	lockExpiresAtFor(requestId: string): number | undefined {
		return this.handedOut.get(requestId)?.lockExpiresAt;
	}

	hasHandedOutRequests(): boolean {
		return this.handedOut.size > 0;
	}

	/** A live handle we can pass to `markRequestAsHandled`/`reclaimRequest` (needs the native `id`). */
	private findLiveHandle(requestId: string): CrawleeRequest | undefined {
		return (
			this.handedOut.get(requestId)?.request ??
			this.staged.find((request) => getRequestId(request.uniqueKey) === requestId)
		);
	}

	/** `GET /requests/:id` - no drain; unknown-to-this-buffer id resolves via `uniqueKeyIndex` only. */
	getLiveHandle(requestId: string): CrawleeRequest | undefined {
		return this.findLiveHandle(requestId);
	}

	/**
	 * `PUT /requests/:id` fallback for a request this runtime never staged: pull requests off the
	 * queue (bounded), staging each one, until the target surfaces or the drain cap is hit.
	 */
	async drainUntilFound(requestId: string): Promise<CrawleeRequest | undefined> {
		const known = this.findLiveHandle(requestId);
		if (known) return known;

		for (let i = 0; i < DRAIN_CAP && this.bufferSize() < BUFFER_CAP; i++) {
			const next = await this.queue.fetchNextRequest();
			if (!next) break;
			const foundId = getRequestId(next.uniqueKey);
			this.remember(foundId, next.uniqueKey);
			this.staged.push(next);
			if (foundId === requestId) return next;
		}
		return undefined;
	}

	/** Drop bookkeeping for a request that has just been handled or reclaimed. */
	releaseFromBuffers(requestId: string): void {
		this.handedOut.delete(requestId);
		const idx = this.staged.findIndex((request) => getRequestId(request.uniqueKey) === requestId);
		if (idx !== -1) this.staged.splice(idx, 1);
	}

	/** `POST /requests/unlock`: reclaim every handed-out request; returns how many were released. */
	takeAllHandedOut(): CrawleeRequest[] {
		const released = Array.from(this.handedOut.values()).map((h) => h.request);
		this.handedOut.clear();
		return released;
	}

	/** Everything currently staged or handed out, for graceful-shutdown reclaim. */
	allOutstanding(): CrawleeRequest[] {
		return [...this.staged, ...Array.from(this.handedOut.values()).map((h) => h.request)];
	}
}

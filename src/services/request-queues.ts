/**
 * Ownership-agnostic request-queue operations, over the `RequestQueue` frontend and its head buffer.
 * Ownership/name/scoping is the caller's job (the API route layer), same split as `storages.ts`.
 */
import { getRequestId, Request as CrawleeRequest } from '@crawlee/core';

import { getRequestQueueBuffer } from '../storage/request-queue/registry.js';

export interface RequestInput {
	url: string;
	uniqueKey?: string;
	method?: string;
	payload?: string;
	userData?: Record<string, unknown>;
	headers?: Record<string, string>;
	retryCount?: number;
	errorMessages?: string[];
	handledAt?: string;
	noRetry?: boolean;
}

export interface RequestListItem {
	id: string;
	retryCount: number;
	uniqueKey: string;
	url: string;
	method: string;
	lockExpiresAt?: string;
}

export interface RequestFullSchema extends RequestListItem {
	payload?: string;
	errorMessages?: string[];
	headers?: Record<string, string>;
	userData?: Record<string, unknown>;
	handledAt?: string;
	noRetry?: boolean;
	loadedUrl?: string;
}

function toCrawleeRequest(input: RequestInput): CrawleeRequest {
	const request = new CrawleeRequest({
		url: input.url,
		uniqueKey: input.uniqueKey ?? input.url,
		method: input.method as CrawleeRequest['method'],
		payload: input.payload,
		userData: input.userData,
		headers: input.headers,
	});
	mergeUpdates(request, input);
	return request;
}

function toListItem(requestId: string, request: CrawleeRequest, lockExpiresAt?: number): RequestListItem {
	return {
		id: requestId,
		retryCount: request.retryCount,
		uniqueKey: request.uniqueKey,
		url: request.url,
		method: request.method,
		lockExpiresAt: lockExpiresAt ? new Date(lockExpiresAt).toISOString() : undefined,
	};
}

function toFullSchema(requestId: string, request: CrawleeRequest): RequestFullSchema {
	return {
		...toListItem(requestId, request),
		payload: request.payload,
		errorMessages: request.errorMessages,
		headers: request.headers,
		userData: request.userData,
		handledAt: request.handledAt,
		noRetry: request.noRetry,
		loadedUrl: request.loadedUrl,
	};
}

function mergeUpdates(request: CrawleeRequest, updates: Partial<RequestInput>): void {
	if (updates.retryCount !== undefined) request.retryCount = updates.retryCount;
	if (updates.errorMessages !== undefined) request.errorMessages = updates.errorMessages;
	if (updates.userData !== undefined) request.userData = updates.userData;
	if (updates.headers !== undefined) request.headers = updates.headers;
	if (updates.handledAt !== undefined) request.handledAt = updates.handledAt;
	if (updates.noRetry !== undefined) request.noRetry = updates.noRetry;
}

export interface ProcessedRequestDto {
	uniqueKey: string;
	requestId: string;
	wasAlreadyPresent: boolean;
	wasAlreadyHandled: boolean;
}

export interface UnprocessedRequestDto {
	uniqueKey: string;
	url: string;
	method?: string;
}

/**
 * `POST .../requests/batch` - corrects `wasAlreadyHandled` for `wasAlreadyPresent` entries, because
 * the frontend's LRU dedup cache short-circuits `addRequests` for a cached `uniqueKey` and answers
 * `wasAlreadyHandled: false` regardless of true state (`request_queue.ts:526-543,756-763`).
 */
export async function addRequestsBatch(
	queueId: string,
	requests: RequestInput[],
	forefront: boolean,
): Promise<{ processedRequests: ProcessedRequestDto[]; unprocessedRequests: UnprocessedRequestDto[] }> {
	const buffer = await getRequestQueueBuffer(queueId);
	const crawleeRequests = requests.map(toCrawleeRequest);
	const result = await buffer.queue.addRequests(crawleeRequests, { forefront });

	const processedRequests = await Promise.all(
		result.processedRequests.map(async (processed) => {
			buffer.rememberAdded(processed.uniqueKey);
			if (!processed.wasAlreadyPresent) return processed;
			const live = await buffer.queue.getRequest(processed.uniqueKey);
			return { ...processed, wasAlreadyHandled: live?.handledAt != null };
		}),
	);

	return { processedRequests, unprocessedRequests: result.unprocessedRequests };
}

export interface AddRequestResult {
	requestId: string;
	wasAlreadyPresent: boolean;
	wasAlreadyHandled: boolean;
}

export async function addRequest(
	queueId: string,
	requestInput: RequestInput,
	forefront: boolean,
): Promise<AddRequestResult> {
	const buffer = await getRequestQueueBuffer(queueId);
	const request = toCrawleeRequest(requestInput);
	const info = await buffer.queue.addRequest(request, { forefront });
	buffer.rememberAdded(request.uniqueKey);

	// Built explicitly on both arms (rather than spreading Crawlee's `info`) so the response always
	// matches the declared `AddRequestResult` shape - `info` also carries `forefront`/`uniqueKey`
	// (Crawlee's internal `RequestQueueOperationInfo`), which would otherwise leak into the HTTP body.
	const wasAlreadyHandled = info.wasAlreadyPresent
		? (await buffer.queue.getRequest(request.uniqueKey))?.handledAt != null
		: false;
	return { requestId: info.requestId, wasAlreadyPresent: info.wasAlreadyPresent, wasAlreadyHandled };
}

export interface HeadResult {
	limit: number;
	queueModifiedAt: string;
	hadMultipleClients: boolean;
	items: RequestListItem[];
}

export async function getHead(queueId: string, limit: number): Promise<HeadResult> {
	const buffer = await getRequestQueueBuffer(queueId);
	const items = await buffer.peekHead(limit);
	const info = await buffer.queue.getInfo();
	return {
		limit,
		queueModifiedAt: info.modifiedAt.toISOString(),
		hadMultipleClients: false,
		items: items.map((request) => toListItem(getRequestId(request.uniqueKey), request)),
	};
}

export interface LockHeadResult extends HeadResult {
	lockSecs: number;
	queueHasLockedRequests: boolean;
	clientKey: string;
}

export async function lockHead(queueId: string, limit: number, lockSecs: number): Promise<LockHeadResult> {
	const buffer = await getRequestQueueBuffer(queueId);
	const items = await buffer.lockHead(limit, lockSecs);
	const info = await buffer.queue.getInfo();
	return {
		limit,
		queueModifiedAt: info.modifiedAt.toISOString(),
		hadMultipleClients: false,
		lockSecs,
		queueHasLockedRequests: buffer.hasHandedOutRequests(),
		clientKey: 'local',
		items: items.map((request) => {
			const requestId = getRequestId(request.uniqueKey);
			return toListItem(requestId, request, buffer.lockExpiresAtFor(requestId));
		}),
	};
}

export async function getRequestById(queueId: string, requestId: string): Promise<RequestFullSchema | undefined> {
	const buffer = await getRequestQueueBuffer(queueId);
	const uniqueKey = buffer.uniqueKeyFor(requestId);
	if (!uniqueKey) return undefined;
	const live = await buffer.queue.getRequest(uniqueKey);
	if (!live) return undefined;
	return toFullSchema(requestId, live);
}

/** Resolve a live, native handle for `requestId`, draining the queue (bounded) if we never staged it. */
async function resolveHandleForUpdate(
	buffer: Awaited<ReturnType<typeof getRequestQueueBuffer>>,
	requestId: string,
): Promise<CrawleeRequest | undefined> {
	const known = buffer.getLiveHandle(requestId);
	if (known) return known;

	const drained = await buffer.drainUntilFound(requestId);
	if (drained) return drained;

	// Last resort: known to the index (e.g. added but never fetched) but not currently in progress -
	// fetch its latest state anyway so a mark-handled/reclaim call at least has accurate fields, even
	// though the backend call below is expected to report "not in progress" (see caller).
	const uniqueKey = buffer.uniqueKeyFor(requestId);
	if (!uniqueKey) return undefined;
	const live = await buffer.queue.getRequest(uniqueKey);
	return live ?? undefined;
}

export async function markHandled(
	queueId: string,
	requestId: string,
	updates: Partial<RequestInput>,
): Promise<AddRequestResult | undefined> {
	const buffer = await getRequestQueueBuffer(queueId);
	const handle = await resolveHandleForUpdate(buffer, requestId);
	if (!handle) return undefined;

	mergeUpdates(handle, updates);
	const result = await buffer.queue.markRequestAsHandled(handle);
	buffer.releaseFromBuffers(requestId);

	// `markRequestAsHandled` returns `null` when the request isn't in progress (most likely: already
	// handled elsewhere). Answer gracefully rather than 500 - this is a documented simplification.
	return result ?? { requestId, wasAlreadyPresent: true, wasAlreadyHandled: true };
}

export async function reclaim(
	queueId: string,
	requestId: string,
	updates: Partial<RequestInput>,
	forefront: boolean,
): Promise<AddRequestResult | undefined> {
	const buffer = await getRequestQueueBuffer(queueId);
	const handle = await resolveHandleForUpdate(buffer, requestId);
	if (!handle) return undefined;

	mergeUpdates(handle, updates);
	const result = await buffer.queue.reclaimRequest(handle, { forefront });
	buffer.releaseFromBuffers(requestId);

	// `reclaimRequest` returns `null` when the request isn't in progress - by the same reasoning as
	// `markHandled`'s fallback above, the only way that happens here (single in-process consumer,
	// `getLiveHandle`/`drainUntilFound` already tried) is that the request is already handled.
	return result ?? { requestId, wasAlreadyPresent: true, wasAlreadyHandled: true };
}

export function prolongLock(lockSecs: number): { lockExpiresAt: string } {
	return { lockExpiresAt: new Date(Date.now() + lockSecs * 1000).toISOString() };
}

/** `DELETE .../requests/:id/lock` - idempotent: a no-op if the request isn't currently handed out. */
export async function releaseLock(queueId: string, requestId: string, forefront: boolean): Promise<void> {
	const buffer = await getRequestQueueBuffer(queueId);
	const handle = buffer.getLiveHandle(requestId);
	if (!handle) return;
	await buffer.queue.reclaimRequest(handle, { forefront }).catch(() => undefined);
	buffer.releaseFromBuffers(requestId);
}

export async function unlockAll(queueId: string): Promise<{ unlockedCount: number }> {
	const buffer = await getRequestQueueBuffer(queueId);
	const released = buffer.takeAllHandedOut();
	await Promise.all(released.map((request) => buffer.queue.reclaimRequest(request).catch(() => undefined)));
	return { unlockedCount: released.length };
}

export interface ListRequestsResult {
	limit: number;
	exclusiveStartId?: string;
	cursor?: string;
	nextCursor?: string;
	items: RequestFullSchema[];
}

export async function listRequests(
	queueId: string,
	options: { limit?: number; exclusiveStartId?: string; cursor?: string },
): Promise<ListRequestsResult> {
	const buffer = await getRequestQueueBuffer(queueId);
	const limit = options.limit ?? 1000;
	const start = options.cursor ?? options.exclusiveStartId;

	const allIds = buffer.listSeenRequestIds();
	let startIndex = 0;
	if (start) {
		const idx = allIds.indexOf(start);
		startIndex = idx === -1 ? allIds.length : idx + 1;
	}

	const pageIds = allIds.slice(startIndex, startIndex + limit);
	const items: RequestFullSchema[] = [];
	for (const requestId of pageIds) {
		const uniqueKey = buffer.uniqueKeyFor(requestId);
		if (!uniqueKey) continue;
		const live = await buffer.queue.getRequest(uniqueKey);
		if (live) items.push(toFullSchema(requestId, live));
	}

	const isTruncated = startIndex + pageIds.length < allIds.length;
	return {
		limit,
		exclusiveStartId: options.exclusiveStartId,
		cursor: options.cursor,
		nextCursor: isTruncated ? pageIds[pageIds.length - 1] : undefined,
		items,
	};
}

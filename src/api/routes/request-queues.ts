import type { Request, Router } from 'express';

import { requireUser } from '../auth.js';

import { paginate, sendData, sendError, sortByTimestamp } from '../envelope.js';
import { recordNotFound } from '../errors.js';
import { h, jsonBody, optionalJsonBody, paginationParams, queryBoolean, queryNumber, queryString } from '../handler.js';
import { openRequestQueue } from '../../storage/open.js';
import {
	createStorage,
	getOwnedStorage,
	listOwnedStorages,
	renameStorage,
	dropStorage,
} from '../../services/storages.js';
import { requestQueueDto } from '../dto/storages.js';
import type { StorageRecord } from '../../storage/entities.js';
import * as rq from '../../services/request-queues.js';
import type { RequestInput } from '../../services/request-queues.js';

type ResolveQueue = (req: Request) => Promise<StorageRecord | null>;

const DEFAULT_HEAD_LIMIT = 100;
const DEFAULT_LOCK_SECS = 60;

/**
 * The full request-queue operation surface, parameterised over how the queue's storage record is
 * resolved - directly by `:queueId`, or via a run's `defaultRequestQueueId` for the
 * `actor-runs/:runId/request-queue/*` aliases. Both mount points get byte-identical behaviour.
 */
export function mountRequestQueueOperations(router: Router, basePath: string, resolveQueue: ResolveQueue): void {
	async function requireQueue(req: Request): Promise<StorageRecord> {
		const record = await resolveQueue(req);
		if (!record) throw recordNotFound();
		return record;
	}

	router.post(
		`${basePath}/requests/batch`,
		h(async (req, res) => {
			const record = await requireQueue(req);
			const body = jsonBody<RequestInput[]>(req);
			const forefront = queryBoolean(req, 'forefront') ?? false;
			const result = await rq.addRequestsBatch(record.id, body, forefront);
			sendData(res, result, 201);
		}),
	);

	router.delete(`${basePath}/requests/batch`, (req, res) => {
		sendError(res, 501, 'not-implemented', 'Batch request deletion is not implemented by this runtime');
	});

	router.post(
		`${basePath}/requests`,
		h(async (req, res) => {
			const record = await requireQueue(req);
			const body = jsonBody<RequestInput>(req);
			const forefront = queryBoolean(req, 'forefront') ?? false;
			const result = await rq.addRequest(record.id, body, forefront);
			sendData(res, result, 201);
		}),
	);

	router.get(
		`${basePath}/requests`,
		h(async (req, res) => {
			const record = await requireQueue(req);
			const result = await rq.listRequests(record.id, {
				limit: queryNumber(req, 'limit'),
				exclusiveStartId: queryString(req, 'exclusiveStartId'),
				cursor: queryString(req, 'cursor'),
			});
			sendData(res, result);
		}),
	);

	router.get(
		`${basePath}/requests/:requestId`,
		h(async (req, res) => {
			const record = await requireQueue(req);
			const result = await rq.getRequestById(record.id, req.params.requestId as string);
			if (!result) throw recordNotFound();
			sendData(res, result);
		}),
	);

	router.put(
		`${basePath}/requests/:requestId`,
		h(async (req, res) => {
			const record = await requireQueue(req);
			const body = jsonBody<RequestInput>(req);
			const forefront = queryBoolean(req, 'forefront') ?? false;
			const requestId = req.params.requestId as string;

			const result = body.handledAt
				? await rq.markHandled(record.id, requestId, body)
				: await rq.reclaim(record.id, requestId, body, forefront);

			if (!result) throw recordNotFound();
			sendData(res, result);
		}),
	);

	router.delete(`${basePath}/requests/:requestId`, (req, res) => {
		sendError(res, 501, 'not-implemented', 'Single request deletion is not implemented by this runtime');
	});

	router.put(
		`${basePath}/requests/:requestId/lock`,
		h(async (req, res) => {
			await requireQueue(req);
			const lockSecs = queryNumber(req, 'lockSecs') ?? DEFAULT_LOCK_SECS;
			sendData(res, rq.prolongLock(lockSecs));
		}),
	);

	router.delete(
		`${basePath}/requests/:requestId/lock`,
		h(async (req, res) => {
			const record = await requireQueue(req);
			const forefront = queryBoolean(req, 'forefront') ?? false;
			await rq.releaseLock(record.id, req.params.requestId as string, forefront);
			res.status(204).end();
		}),
	);

	router.get(
		`${basePath}/head`,
		h(async (req, res) => {
			const record = await requireQueue(req);
			const limit = queryNumber(req, 'limit') ?? DEFAULT_HEAD_LIMIT;
			sendData(res, await rq.getHead(record.id, limit));
		}),
	);

	router.post(
		`${basePath}/head/lock`,
		h(async (req, res) => {
			const record = await requireQueue(req);
			const limit = queryNumber(req, 'limit') ?? DEFAULT_HEAD_LIMIT;
			const lockSecs = queryNumber(req, 'lockSecs') ?? DEFAULT_LOCK_SECS;
			sendData(res, await rq.lockHead(record.id, limit, lockSecs));
		}),
	);

	router.post(
		`${basePath}/requests/unlock`,
		h(async (req, res) => {
			const record = await requireQueue(req);
			sendData(res, await rq.unlockAll(record.id));
		}),
	);
}

export function mountRequestQueues(router: Router): void {
	router.get(
		'/request-queues',
		h(async (req, res) => {
			const records = await listOwnedStorages(requireUser(req).id, 'requestQueue');
			const sorted = sortByTimestamp(records, (record) => record.createdAt);
			const envelope = paginate(sorted, paginationParams(req));
			const items = await Promise.all(
				envelope.items.map(async (record) => {
					const queue = await openRequestQueue(record.id);
					return requestQueueDto(record, await queue.getInfo());
				}),
			);
			sendData(res, { ...envelope, items });
		}),
	);

	router.post(
		'/request-queues',
		h(async (req, res) => {
			const body = optionalJsonBody<{ name?: string }>(req);
			const name = queryString(req, 'name') ?? body?.name;
			const record = await createStorage(requireUser(req).id, 'requestQueue', name);
			const queue = await openRequestQueue(record.id);
			sendData(res, requestQueueDto(record, await queue.getInfo()), 201);
		}),
	);

	router.get(
		'/request-queues/:queueId',
		h(async (req, res) => {
			const record = await getOwnedStorage(requireUser(req).id, req.params.queueId as string, 'requestQueue');
			if (!record) throw recordNotFound();
			const queue = await openRequestQueue(record.id);
			sendData(res, requestQueueDto(record, await queue.getInfo()));
		}),
	);

	router.put(
		'/request-queues/:queueId',
		h(async (req, res) => {
			const record = await getOwnedStorage(requireUser(req).id, req.params.queueId as string, 'requestQueue');
			if (!record) throw recordNotFound();
			const body = jsonBody<{ name?: string }>(req);
			const updated = body.name ? await renameStorage(record.id, body.name) : record;
			const queue = await openRequestQueue(record.id);
			sendData(res, requestQueueDto(updated ?? record, await queue.getInfo()));
		}),
	);

	router.delete(
		'/request-queues/:queueId',
		h(async (req, res) => {
			const record = await getOwnedStorage(requireUser(req).id, req.params.queueId as string, 'requestQueue');
			// Matches the real platform and this API's own documented contract - see the identical note
			// on `DELETE /datasets/:datasetId`.
			if (!record) throw recordNotFound();
			await dropStorage(record);
			res.status(204).end();
		}),
	);

	mountRequestQueueOperations(router, '/request-queues/:queueId', async (req) =>
		getOwnedStorage(requireUser(req).id, req.params.queueId as string, 'requestQueue'),
	);
}

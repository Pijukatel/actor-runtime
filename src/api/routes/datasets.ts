import type { Request, Response, Router } from 'express';

import { requireUser } from '../auth.js';

import { paginate, sendData, sortByTimestamp } from '../envelope.js';
import { recordNotFound } from '../errors.js';
import { resolveStorageParam } from '../resolve-reference.js';
import {
	h,
	jsonBody,
	optionalJsonBody,
	paginationParams,
	queryBoolean,
	queryList,
	queryNumber,
	queryString,
} from '../handler.js';
import { openDataset } from '../../storage/open.js';
import { createStorage, listOwnedStorages, renameStorage, dropStorage, touchStorage } from '../../services/storages.js';
import { applyDatasetProjection, type DatasetItem } from '../../services/dataset-projection.js';
import { datasetDto } from '../dto/storages.js';
import type { StorageRecord } from '../../storage/entities.js';
import { recordDefaultDatasetItems } from '../../services/charging.js';
import type { ApiServerDeps } from '../server.js';

type ResolveDataset = (req: Request) => Promise<StorageRecord | null>;

/** Answers with a page of the dataset's items, honouring the items endpoint's query parameters. */
export async function sendDatasetItems(
	req: Request,
	res: Response,
	record: StorageRecord,
	status: number,
): Promise<void> {
	await touchStorage(record.id);
	const dataset = await openDataset(record.id);

	const offset = queryNumber(req, 'offset') ?? 0;
	const limit = queryNumber(req, 'limit');
	const desc = queryBoolean(req, 'desc') ?? false;

	const page = await dataset.getData({ offset, limit, desc });
	const items = applyDatasetProjection(page.items as DatasetItem[], {
		fields: queryList(req, 'fields'),
		omit: queryList(req, 'omit'),
		unwind: queryList(req, 'unwind')?.[0],
		clean: queryBoolean(req, 'clean'),
		skipHidden: queryBoolean(req, 'skipHidden'),
		skipEmpty: queryBoolean(req, 'skipEmpty'),
	});

	// Unlike every other list endpoint, the real Apify API returns dataset items as a bare JSON
	// array with pagination metadata in `x-apify-pagination-*` headers, not a `{data:{...}}`
	// envelope - confirmed against apify-client-js's `_createPaginationList` (`dataset.ts`),
	// which reads `response.data` directly as the items array and every count from headers.
	res.set({
		'x-apify-pagination-total': String(page.total),
		'x-apify-pagination-offset': String(page.offset),
		'x-apify-pagination-count': String(items.length),
		'x-apify-pagination-limit': String(page.limit ?? items.length),
		'x-apify-pagination-desc': String(desc),
	});
	res.status(status).json(items);
}

/**
 * The dataset operation surface, parameterised over how the dataset's storage record is resolved -
 * directly by `:datasetId`, or via a run's `defaultDatasetId` for the `actor-runs/:runId/dataset/*`
 * aliases. Both mount points get byte-identical behaviour.
 */
export function mountDatasetOperations(
	router: Router,
	basePath: string,
	resolveDataset: ResolveDataset,
	deps: ApiServerDeps,
): void {
	async function requireDataset(req: Request): Promise<StorageRecord> {
		const record = await resolveDataset(req);
		if (!record) throw recordNotFound();
		return record;
	}

	router.get(
		basePath,
		h(async (req, res) => {
			const record = await requireDataset(req);
			const dataset = await openDataset(record.id);
			sendData(res, datasetDto(record, await dataset.getInfo()));
		}),
	);

	router.post(
		`${basePath}/items`,
		h(async (req, res) => {
			const record = await requireDataset(req);
			const body = jsonBody<DatasetItem | DatasetItem[]>(req);
			const dataset = await openDataset(record.id);
			await dataset.pushData(body);
			// The platform's synthetic per-item pay-per-event charge (`services/charging.ts`) - a no-op for
			// every dataset that is not a pay-per-event run's default dataset.
			await recordDefaultDatasetItems(deps.driver, record.id, Array.isArray(body) ? body.length : 1);
			sendData(res, null, 201);
		}),
	);

	router.get(
		`${basePath}/items`,
		h(async (req, res) => {
			const record = await requireDataset(req);
			await sendDatasetItems(req, res, record, 200);
		}),
	);

	router.get(
		`${basePath}/statistics`,
		h(async (req, res) => {
			await requireDataset(req);
			sendData(res, { readCount: 0, writeCount: 0 });
		}),
	);
}

export function mountDatasets(router: Router, deps: ApiServerDeps): void {
	router.get(
		'/datasets',
		h(async (req, res) => {
			const records = await listOwnedStorages(requireUser(req).id, 'dataset', {
				includeUnnamed: queryBoolean(req, 'unnamed') ?? false,
			});
			const sorted = sortByTimestamp(records, (record) => record.createdAt);
			const envelope = paginate(sorted, paginationParams(req));
			const items = await Promise.all(
				envelope.items.map(async (record) => {
					const dataset = await openDataset(record.id);
					return datasetDto(record, await dataset.getInfo());
				}),
			);
			sendData(res, { ...envelope, items });
		}),
	);

	router.post(
		'/datasets',
		h(async (req, res) => {
			const body = optionalJsonBody<{ name?: string }>(req);
			const name = queryString(req, 'name') ?? body?.name;
			const record = await createStorage(requireUser(req).id, 'dataset', name);
			const dataset = await openDataset(record.id);
			sendData(res, datasetDto(record, await dataset.getInfo()), 201);
		}),
	);

	router.put(
		'/datasets/:datasetId',
		h(async (req, res) => {
			const record = await resolveStorageParam(req, 'datasetId', 'dataset');
			if (!record) throw recordNotFound();
			const body = jsonBody<{ name?: string }>(req);
			const updated = body.name ? await renameStorage(record.id, body.name) : record;
			const dataset = await openDataset(record.id);
			sendData(res, datasetDto(updated ?? record, await dataset.getInfo()));
		}),
	);

	router.delete(
		'/datasets/:datasetId',
		h(async (req, res) => {
			const record = await resolveStorageParam(req, 'datasetId', 'dataset');
			// Matches the real platform and this API's own documented contract (api.md's response
			// envelopes section): a missing id 404s with `record-not-found`, the same as every other
			// resource's DELETE - the public API answers `record-not-found` for a missing storage id on
			// every storage type before ever reaching a delete.
			if (!record) throw recordNotFound();
			await dropStorage(record);
			res.status(204).end();
		}),
	);

	mountDatasetOperations(
		router,
		'/datasets/:datasetId',
		async (req) => resolveStorageParam(req, 'datasetId', 'dataset'),
		deps,
	);
}

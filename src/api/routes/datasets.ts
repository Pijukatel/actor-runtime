import type { Request, Router } from 'express';

import { requireUser } from '../auth.js';

import { paginate, sendData, sortByTimestamp } from '../envelope.js';
import { recordNotFound } from '../errors.js';
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
import {
	createStorage,
	getOwnedStorage,
	listOwnedStorages,
	renameStorage,
	dropStorage,
	touchStorage,
} from '../../services/storages.js';
import { applyDatasetProjection, type DatasetItem } from '../../services/dataset-projection.js';
import { datasetDto } from '../dto/storages.js';
import type { StorageRecord } from '../../storage/entities.js';

type ResolveDataset = (req: Request) => Promise<StorageRecord | null>;

/**
 * The dataset operation surface, parameterised over how the dataset's storage record is resolved -
 * directly by `:datasetId`, or via a run's `defaultDatasetId` for the `actor-runs/:runId/dataset/*`
 * aliases. Both mount points get byte-identical behaviour.
 */
export function mountDatasetOperations(router: Router, basePath: string, resolveDataset: ResolveDataset): void {
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
			sendData(res, null, 201);
		}),
	);

	router.get(
		`${basePath}/items`,
		h(async (req, res) => {
			const record = await requireDataset(req);
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
			res.status(200).json(items);
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

export function mountDatasets(router: Router): void {
	router.get(
		'/datasets',
		h(async (req, res) => {
			const records = await listOwnedStorages(requireUser(req).id, 'dataset');
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
			const record = await getOwnedStorage(requireUser(req).id, req.params.datasetId as string, 'dataset');
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
			const record = await getOwnedStorage(requireUser(req).id, req.params.datasetId as string, 'dataset');
			// Matches the real platform and this API's own documented contract (api.md's response
			// envelopes section): a missing id 404s with `record-not-found`, the same as every other
			// resource's DELETE - apify-core's `getDatasetById`/`ensureQueueExists`/`ensureStoreExists`
			// all throw `record-not-found` for a missing storage id before ever reaching a delete.
			if (!record) throw recordNotFound();
			await dropStorage(record);
			res.status(204).end();
		}),
	);

	mountDatasetOperations(router, '/datasets/:datasetId', async (req) =>
		getOwnedStorage(requireUser(req).id, req.params.datasetId as string, 'dataset'),
	);
}

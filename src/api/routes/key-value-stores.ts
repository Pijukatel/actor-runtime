import type { Request, Router } from 'express';

import { requireUser } from '../auth.js';

import { paginate, sendData, sortByTimestamp } from '../envelope.js';
import { recordNotFound } from '../errors.js';
import { h, optionalJsonBody, paginationParams, queryNumber, queryString, toNodeBuffer } from '../handler.js';
import { openKeyValueStore } from '../../storage/open.js';
import {
	createStorage,
	getOwnedStorage,
	listOwnedStorages,
	renameStorage,
	dropStorage,
	touchStorage,
} from '../../services/storages.js';
import { keyValueStoreDto } from '../dto/storages.js';
import { pageKeys } from '../../services/kv-key-listing.js';
import type { StorageRecord } from '../../storage/entities.js';

type ResolveStore = (req: Request) => Promise<StorageRecord | null>;

/**
 * The key-value-store operation surface, parameterised over how the store's storage record is
 * resolved - directly by `:storeId`, or via a run's `defaultKeyValueStoreId` for the
 * `actor-runs/:runId/key-value-store/*` aliases.
 */
export function mountKeyValueStoreOperations(router: Router, basePath: string, resolveStore: ResolveStore): void {
	async function requireStore(req: Request): Promise<StorageRecord> {
		const record = await resolveStore(req);
		if (!record) throw recordNotFound();
		return record;
	}

	router.get(
		basePath,
		h(async (req, res) => {
			const record = await requireStore(req);
			await touchStorage(record.id);
			sendData(res, keyValueStoreDto(record));
		}),
	);

	router.get(
		`${basePath}/keys`,
		h(async (req, res) => {
			const record = await requireStore(req);
			const store = await openKeyValueStore(record.id);

			const allKeys: { key: string; size: number }[] = [];
			await store.forEachKey(
				async (key, _index, info) => {
					allKeys.push({ key, size: info.size });
				},
				{ prefix: queryString(req, 'prefix') },
			);

			const page = pageKeys(allKeys, {
				exclusiveStartKey: queryString(req, 'exclusiveStartKey'),
				limit: queryNumber(req, 'limit'),
			});
			sendData(res, page);
		}),
	);

	router.head(
		`${basePath}/records/:recordKey`,
		h(async (req, res) => {
			const record = await resolveStore(req);
			if (!record) {
				res.status(404).end();
				return;
			}
			const store = await openKeyValueStore(record.id);
			const exists = await store.recordExists(req.params.recordKey as string);
			res.status(exists ? 200 : 404).end();
		}),
	);

	router.get(
		`${basePath}/records/:recordKey`,
		h(async (req, res) => {
			const record = await requireStore(req);
			const store = await openKeyValueStore(record.id);
			const raw = await store.getRecord(req.params.recordKey as string);
			if (!raw) throw recordNotFound();
			await touchStorage(record.id);
			res.status(200)
				.set('Content-Type', raw.contentType ?? 'application/octet-stream')
				.send(toNodeBuffer(raw.value));
		}),
	);

	router.put(
		`${basePath}/records/:recordKey`,
		h(async (req, res) => {
			const record = await requireStore(req);
			const store = await openKeyValueStore(record.id);
			const contentType = req.header('content-type') ?? 'application/octet-stream';
			const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
			await store.setValue(req.params.recordKey as string, body, { contentType });
			await touchStorage(record.id);
			res.status(201).end();
		}),
	);

	router.delete(
		`${basePath}/records/:recordKey`,
		h(async (req, res) => {
			// A missing *store* 404s (matches apify-core's `getStoreById`, which throws before
			// `deleteRecord` is ever reached) - but a missing *record key* inside an existing store stays
			// a 204 no-op below, matching apify-core's S3 delete swallowing a `NotFound` for the key.
			const record = await requireStore(req);
			const store = await openKeyValueStore(record.id);
			await store.setValue(req.params.recordKey as string, null);
			res.status(204).end();
		}),
	);
}

export function mountKeyValueStores(router: Router): void {
	router.get(
		'/key-value-stores',
		h(async (req, res) => {
			const records = await listOwnedStorages(requireUser(req).id, 'keyValueStore');
			const sorted = sortByTimestamp(records, (record) => record.createdAt);
			const envelope = paginate(sorted, paginationParams(req));
			sendData(res, { ...envelope, items: envelope.items.map((record) => keyValueStoreDto(record)) });
		}),
	);

	router.post(
		'/key-value-stores',
		h(async (req, res) => {
			const body = optionalJsonBody<{ name?: string }>(req);
			const name = queryString(req, 'name') ?? body?.name;
			const record = await createStorage(requireUser(req).id, 'keyValueStore', name);
			sendData(res, keyValueStoreDto(record), 201);
		}),
	);

	router.put(
		'/key-value-stores/:storeId',
		h(async (req, res) => {
			const record = await getOwnedStorage(requireUser(req).id, req.params.storeId as string, 'keyValueStore');
			if (!record) throw recordNotFound();
			const body = optionalJsonBody<{ name?: string }>(req);
			const updated = body?.name ? await renameStorage(record.id, body.name) : record;
			sendData(res, keyValueStoreDto(updated ?? record));
		}),
	);

	router.delete(
		'/key-value-stores/:storeId',
		h(async (req, res) => {
			const record = await getOwnedStorage(requireUser(req).id, req.params.storeId as string, 'keyValueStore');
			// Matches the real platform and this API's own documented contract - see the identical note
			// on `DELETE /datasets/:datasetId`.
			if (!record) throw recordNotFound();
			await dropStorage(record);
			res.status(204).end();
		}),
	);

	mountKeyValueStoreOperations(router, '/key-value-stores/:storeId', async (req) =>
		getOwnedStorage(requireUser(req).id, req.params.storeId as string, 'keyValueStore'),
	);
}

/**
 * Ownership-filtered domain layer over the three user-facing storage types, shared by the API and the
 * console. All data access goes through the `Dataset` / `KeyValueStore` / `RequestQueue` frontends
 * (via `storage/open.ts`); `__STORAGES__` is the only place ownership, display name and timestamps
 * live, because `KeyValueStore` has no `getInfo()` of its own.
 */
import { generateId } from '../storage/ids.js';
import type { DatasetSchema, StorageRecord, StorageType, UserRecord } from '../storage/entities.js';
import { getRegistries } from '../storage/registries.js';
import { openDataset, openKeyValueStore, openRequestQueue } from '../storage/open.js';
import { closeRequestQueueBuffer } from '../storage/request-queue/registry.js';
import { KeyedMutex } from '../storage/mutex.js';
import { isCallerOwner, normalizeName, type ResolvableReference } from './resource-reference.js';

/**
 * Without this, two concurrent `getOrCreate(name)` calls can both pass the "not found" check and mint
 * two records. Keyed by the lower-cased name, so `Foo` and `foo` are one critical section; unnamed
 * creates look nothing up and skip it.
 */
const createByNameMutex = new KeyedMutex();

/**
 * Idempotent by `name`: apify-client-js's `getOrCreate(name)` does no dedup of its own
 * (`resource_collection_client.ts:41-49`), so the server must. An existing storage comes back
 * unchanged, matched case-insensitively and keeping its original casing - its `schema` too, as on the
 * platform.
 */
export async function createStorage(
	userId: string,
	type: StorageType,
	name?: string,
	schema?: DatasetSchema,
): Promise<StorageRecord> {
	if (name) {
		return createByNameMutex.run(`${userId}:${type}:${normalizeName(name)}`, () =>
			createStorageRecord(userId, type, name, schema),
		);
	}
	return createStorageRecord(userId, type, undefined, schema);
}

async function createStorageRecord(
	userId: string,
	type: StorageType,
	name: string | undefined,
	schema: DatasetSchema | undefined,
): Promise<StorageRecord> {
	if (name) {
		const existing = await findOwnedStorageByName(userId, type, name);
		if (existing) return existing;
	}

	const id = generateId();
	const now = new Date().toISOString();

	// Opening as a side effect materialises the Crawlee storage on disk immediately, named by id.
	if (type === 'dataset') await openDataset(id);
	else if (type === 'keyValueStore') await openKeyValueStore(id);
	else await openRequestQueue(id);

	const record: StorageRecord = {
		id,
		type,
		userId,
		name,
		createdAt: now,
		modifiedAt: now,
		accessedAt: now,
		...(type === 'dataset' && schema ? { schema } : {}),
	};
	await getRegistries().storages.set(id, record);
	return record;
}

export async function getOwnedStorage(userId: string, id: string, type: StorageType): Promise<StorageRecord | null> {
	const record = await getRegistries().storages.get(id);
	if (!record || record.userId !== userId || record.type !== type) return null;
	return record;
}

/** Named storages only unless `includeUnnamed`, as the platform's list endpoints (`?unnamed=`) do. */
export async function listOwnedStorages(
	userId: string,
	type: StorageType,
	{ includeUnnamed }: { includeUnnamed: boolean },
): Promise<StorageRecord[]> {
	const all = await getRegistries().storages.list();
	return all.filter((s) => s.userId === userId && s.type === type && (includeUnnamed || s.name !== undefined));
}

/** Cross-user listing, for the console only (see `services/actors.ts: listAllActors`'s doc comment). */
export async function listAllStorages(type: StorageType): Promise<StorageRecord[]> {
	const all = await getRegistries().storages.list();
	return all.filter((s) => s.type === type);
}

/** Cross-user lookup by id, for the console only (see `listAllStorages`). */
export async function getStorageById(id: string, type: StorageType): Promise<StorageRecord | null> {
	const record = await getRegistries().storages.get(id);
	if (!record || record.type !== type) return null;
	return record;
}

/** Case-insensitive, like the platform (`normalizeName`). */
export async function findOwnedStorageByName(
	userId: string,
	type: StorageType,
	name: string,
): Promise<StorageRecord | null> {
	const wanted = normalizeName(name);
	const owned = await listOwnedStorages(userId, type, { includeUnnamed: false });
	return owned.find((s) => s.name !== undefined && normalizeName(s.name) === wanted) ?? null;
}

/** Unlike an Actor, a bare segment is only ever an id here - so is it on the platform. */
export async function resolveOwnedStorage(
	user: UserRecord,
	reference: ResolvableReference,
	type: StorageType,
): Promise<StorageRecord | null> {
	if (reference.kind === 'id') return getOwnedStorage(user.id, reference.id, type);
	if (!isCallerOwner(user, reference.owner)) return null;
	return findOwnedStorageByName(user.id, type, reference.name);
}

export async function touchStorage(id: string): Promise<void> {
	await getRegistries().storages.update(id, (current) => {
		if (!current) return null;
		return { ...current, accessedAt: new Date().toISOString() };
	});
}

export async function renameStorage(id: string, name: string): Promise<StorageRecord | null> {
	return getRegistries().storages.update(id, (current) => {
		if (!current) return null;
		return { ...current, name, modifiedAt: new Date().toISOString() };
	});
}

export async function dropStorage(record: StorageRecord): Promise<void> {
	if (record.type === 'dataset') {
		const dataset = await openDataset(record.id);
		await dataset.drop();
	} else if (record.type === 'keyValueStore') {
		const store = await openKeyValueStore(record.id);
		await store.drop();
	} else {
		closeRequestQueueBuffer(record.id);
		const queue = await openRequestQueue(record.id);
		await queue.drop();
	}
	await getRegistries().storages.delete(record.id);
}

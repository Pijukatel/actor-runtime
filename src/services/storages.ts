/**
 * Ownership-filtered domain layer over the three user-facing storage types, shared by the API and the
 * console. All data access goes through the `Dataset` / `KeyValueStore` / `RequestQueue` frontends
 * (via `storage/open.ts`); `__STORAGES__` is the only place ownership, display name and timestamps
 * live, because `KeyValueStore` has no `getInfo()` of its own.
 */
import { generateId } from '../storage/ids.js';
import type { StorageRecord, StorageType } from '../storage/entities.js';
import { getRegistries } from '../storage/registries.js';
import { openDataset, openKeyValueStore, openRequestQueue } from '../storage/open.js';
import { closeRequestQueueBuffer } from '../storage/request-queue/registry.js';
import { KeyedMutex } from '../storage/mutex.js';

/**
 * Serialises the lookup-then-create critical section in `createStorage` per `user:type:name`, so two
 * concurrent `getOrCreate(name)` calls can never both pass the "not found" check before either has
 * written its record. Unnamed creates never look anything up (a fresh id can never collide), so they
 * skip the mutex entirely.
 */
const createByNameMutex = new KeyedMutex();

/**
 * Idempotent by `name`, matching apify-client-js's `getOrCreate(name)` contract: a bare
 * `POST .../datasets?name=X` relies on the *server* deduplicating by name (the client itself does no
 * dedup - `resource_collection_client.ts:41-49`). When `name` is given and a storage of this type with
 * that name already exists for the user, that existing record is returned unchanged rather than
 * minting a new storage. The lookup-plus-create is serialised per `user:type:name` (see
 * `createByNameMutex`) so two concurrent calls with the same name can never both mint a record.
 */
export async function createStorage(userId: string, type: StorageType, name?: string): Promise<StorageRecord> {
	if (name) {
		return createByNameMutex.run(`${userId}:${type}:${name}`, () => createStorageRecord(userId, type, name));
	}
	return createStorageRecord(userId, type, undefined);
}

async function createStorageRecord(
	userId: string,
	type: StorageType,
	name: string | undefined,
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

	const record: StorageRecord = { id, type, userId, name, createdAt: now, modifiedAt: now, accessedAt: now };
	await getRegistries().storages.set(id, record);
	return record;
}

export async function getOwnedStorage(userId: string, id: string, type: StorageType): Promise<StorageRecord | null> {
	const record = await getRegistries().storages.get(id);
	if (!record || record.userId !== userId || record.type !== type) return null;
	return record;
}

export async function listOwnedStorages(userId: string, type: StorageType): Promise<StorageRecord[]> {
	const all = await getRegistries().storages.list();
	return all.filter((s) => s.userId === userId && s.type === type);
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

export async function findOwnedStorageByName(
	userId: string,
	type: StorageType,
	name: string,
): Promise<StorageRecord | null> {
	const owned = await listOwnedStorages(userId, type);
	return owned.find((s) => s.name === name) ?? null;
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

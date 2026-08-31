/**
 * The seven internal `__*__` registries from `storage.md`, opened once at startup. They are ordinary
 * `KeyValueStore` frontends opened by name, in the same physical space as user storages, and are never
 * routable from the public API - the API only ever resolves ids it first finds in one of these.
 */
import { Registry } from './registry.js';
import { openKeyValueStore } from './open.js';
import type { ActorRecord, BuildRecord, RunRecord, StorageRecord, UserRecord } from './entities.js';

export interface Registries {
	storages: Registry<StorageRecord>;
	users: Registry<UserRecord>;
	actors: Registry<ActorRecord>;
	runs: Registry<RunRecord>;
	builds: Registry<BuildRecord>;
	/** Plain-text log bodies, keyed by build/run id. Not JSON - see `LogStore`. */
	logs: Awaited<ReturnType<typeof openKeyValueStore>>;
	files: Awaited<ReturnType<typeof openKeyValueStore>>;
}

let current: Registries | undefined;

export async function openRegistries(): Promise<Registries> {
	if (current) return current;
	current = {
		storages: await Registry.open<StorageRecord>('__STORAGES__'),
		users: await Registry.open<UserRecord>('__USERS__'),
		actors: await Registry.open<ActorRecord>('__ACTORS__'),
		runs: await Registry.open<RunRecord>('__RUNS__'),
		builds: await Registry.open<BuildRecord>('__BUILDS__'),
		logs: await openKeyValueStore('__LOGS__'),
		files: await openKeyValueStore('__FILES__'),
	};
	return current;
}

export function getRegistries(): Registries {
	if (!current) {
		throw new Error('openRegistries() has not been called yet.');
	}
	return current;
}

/**
 * Test-only: pairs with `resetStorageForTests()` - without this, `openRegistries()`'s memoisation
 * would keep handing back the *previous* test's `Registry` wrappers (and therefore its bootstrap user
 * and all its data) to every subsequent `startTestServer()` call in the same test file, since this
 * module's cache is otherwise never cleared. Never call this from runtime code.
 */
export function resetRegistriesForTests(): void {
	current = undefined;
}

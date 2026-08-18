/**
 * The service-locator bootstrap. This is the ONLY module in the codebase allowed to import
 * `FileSystemStorageBackend`, touch `Configuration`, or call `serviceLocator` setters - every other
 * module reaches storage exclusively through the `Dataset` / `KeyValueStore` / `RequestQueue`
 * frontends re-exported from here (see `storage/registries.ts`, `storage/open.ts`).
 *
 * Order matters and is fixed by the design:
 *   1. `Configuration` with `purgeOnStart: false` (anti-purge switch) - set first.
 *   2. `FileSystemStorageBackend` with `requestQueueAccess: 'single'`.
 *   3. An explicit `LocalEventManager`, never `.init()`-ed (no persistState/systemInfo intervals).
 *
 * `purgeOnStart: false` guarantees `purgeDefaultStorages()` (called internally by every
 * `Dataset.open` / `KeyValueStore.open` / `RequestQueue.open`, with `onlyPurgeOnce: true`) never
 * actually invokes `storageBackend.purge()`, because the gate is
 * `configuration.purgeOnStart && !alreadyPurged`. Constructor options win over
 * `CRAWLEE_PURGE_ON_START` env var resolution, so nothing in the container's environment can
 * re-enable purging.
 *
 * `storageBackend.teardown()` is the only backend-level call anywhere in this codebase, and it is
 * confined to `shutdown()` below.
 */
import { Configuration, LocalEventManager, serviceLocator } from '@crawlee/core';
import { FileSystemStorageBackend } from '@crawlee/fs-storage';

export interface RuntimeStorage {
	configuration: Configuration;
	storageBackend: FileSystemStorageBackend;
	dataDir: string;
}

let current: RuntimeStorage | undefined;

/**
 * Configure the service locator. Must be called exactly once, before any `Dataset` / `KeyValueStore`
 * / `RequestQueue` is opened.
 */
export function bootstrapStorage(dataDir: string): RuntimeStorage {
	if (current) {
		throw new Error('bootstrapStorage() was already called - the service locator is a process-wide singleton.');
	}

	const configuration = new Configuration({
		purgeOnStart: false,
		persistStorage: true,
		storageDir: dataDir,
	});
	serviceLocator.setConfiguration(configuration);

	const storageBackend = new FileSystemStorageBackend({
		localDataDirectory: dataDir,
		requestQueueAccess: 'single',
	});
	serviceLocator.setStorageBackend(storageBackend);

	// Never call .init(): that would start persistState/systemInfo intervals we have no use for and
	// don't want to have to shut down cleanly.
	serviceLocator.setEventManager(LocalEventManager.fromConfiguration(configuration));

	current = { configuration, storageBackend, dataDir };
	return current;
}

export function getRuntimeStorage(): RuntimeStorage {
	if (!current) {
		throw new Error('bootstrapStorage() has not been called yet.');
	}
	return current;
}

/** Flushes every open request queue's native state. Call once, at graceful shutdown. */
export async function shutdownStorage(): Promise<void> {
	if (!current) return;
	await current.storageBackend.teardown();
}

/**
 * Test-only: simulate a process restart within the same test process by resetting the service
 * locator singleton (which also clears the static storage-instance cache) so `bootstrapStorage()` can
 * be called again against the same (or a different) data directory. Never call this from runtime code.
 */
export function resetStorageForTests(): void {
	serviceLocator.reset();
	current = undefined;
}

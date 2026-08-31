/**
 * Frontend open-helpers. Every call site in the codebase (other than `bootstrap.ts` itself) reaches
 * storage through these - never through `FileSystemStorageBackend` directly - and always opens by
 * `name` (never bare id-string lookup) so `resolveStorageIdentifier`'s string-vs-id ambiguity never
 * arises, and always passes the explicit `{ configuration, storageBackend }` pair so behaviour never
 * depends on ambient service-locator state.
 */
import { Dataset, KeyValueStore, RequestQueue } from '@crawlee/core';

import { getRuntimeStorage } from './bootstrap.js';

function openOptions() {
	const { configuration, storageBackend } = getRuntimeStorage();
	return { configuration, storageBackend };
}

/** Open a user-facing or internal dataset, named by its Apify-style id (or a `__REGISTRY__` name). */
export function openDataset(name: string) {
	return Dataset.open({ name }, openOptions());
}

export function openKeyValueStore(name: string) {
	return KeyValueStore.open({ name }, openOptions());
}

export function openRequestQueue(name: string) {
	return RequestQueue.open({ name }, openOptions());
}

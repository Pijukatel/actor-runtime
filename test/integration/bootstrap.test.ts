import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
	bootstrapStorage,
	getRuntimeStorage,
	resetStorageForTests,
	shutdownStorage,
} from '../../src/storage/bootstrap.js';
import { openKeyValueStore, openDataset } from '../../src/storage/open.js';

describe('storage bootstrap - anti-purge guarantee', () => {
	let dataDir: string;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), 'actor-runtime-bootstrap-'));
		delete process.env.CRAWLEE_PURGE_ON_START;
	});

	afterEach(async () => {
		resetStorageForTests();
		delete process.env.CRAWLEE_PURGE_ON_START;
		await rm(dataDir, { recursive: true, force: true });
	});

	it('never calls backend.purge(), and named + default storages survive a restart', async () => {
		bootstrapStorage(dataDir);
		const { storageBackend } = getRuntimeStorage();
		const purgeSpy = vi.spyOn(storageBackend, 'purge');

		const named = await openKeyValueStore('a-named-storage');
		await named.setValue('hello', 'world');

		const defaultDataset = await openDataset('__default_probe__');
		await defaultDataset.pushData({ n: 1 });

		expect(purgeSpy).not.toHaveBeenCalled();

		await shutdownStorage();
		resetStorageForTests();

		// Simulate a process restart against the same data directory.
		bootstrapStorage(dataDir);
		const restarted = getRuntimeStorage();
		const purgeSpyAfterRestart = vi.spyOn(restarted.storageBackend, 'purge');

		const reopenedNamed = await openKeyValueStore('a-named-storage');
		expect(await reopenedNamed.getValue('hello')).toBe('world');

		const reopenedDataset = await openDataset('__default_probe__');
		const { items } = await reopenedDataset.getData();
		expect(items).toEqual([{ n: 1 }]);

		expect(purgeSpyAfterRestart).not.toHaveBeenCalled();
	});

	it('constructor purgeOnStart:false wins over CRAWLEE_PURGE_ON_START=1 in the environment', async () => {
		process.env.CRAWLEE_PURGE_ON_START = '1';
		bootstrapStorage(dataDir);
		const { configuration, storageBackend } = getRuntimeStorage();

		expect(configuration.purgeOnStart).toBe(false);

		const purgeSpy = vi.spyOn(storageBackend, 'purge');
		const store = await openKeyValueStore('survives-env-var');
		await store.setValue('k', 'v');
		expect(purgeSpy).not.toHaveBeenCalled();
	});

	it('sets up the service locator in the documented order without throwing ServiceConflictError', async () => {
		expect(() => bootstrapStorage(dataDir)).not.toThrow();
	});

	it('throws if bootstrapped twice without a reset', () => {
		bootstrapStorage(dataDir);
		expect(() => bootstrapStorage(dataDir)).toThrow();
	});
});

/**
 * Generic per-record registry over an internal `KeyValueStore` (one of `__STORAGES__` / `__USERS__` /
 * `__ACTORS__` / `__RUNS__` / `__BUILDS__` / `__LOGS__` / `__FILES__`). Never routable from the public
 * API - the API only resolves ids found in the matching registry, so these stores are unreachable by
 * construction (they are never opened by an id an external caller could guess into a public route).
 */
import type { KeyValueStore } from '@crawlee/core';

import { openKeyValueStore } from './open.js';
import { KeyedMutex } from './mutex.js';

export class Registry<T> {
	private constructor(
		private readonly store: KeyValueStore,
		private readonly mutex: KeyedMutex,
	) {}

	static async open<T>(name: string): Promise<Registry<T>> {
		const store = await openKeyValueStore(name);
		return new Registry<T>(store, new KeyedMutex());
	}

	async get(id: string): Promise<T | null> {
		return this.store.getValue<T>(id);
	}

	async set(id: string, value: T): Promise<void> {
		await this.mutex.run(id, () => this.store.setValue(id, value));
	}

	/** Read-modify-write, serialised per id. Returning `null` from `mutator` deletes the record. */
	async update(id: string, mutator: (current: T | null) => T | null): Promise<T | null> {
		return this.mutex.run(id, async () => {
			const current = await this.store.getValue<T>(id);
			const next = mutator(current);
			await this.store.setValue(id, next);
			return next;
		});
	}

	async delete(id: string): Promise<void> {
		await this.mutex.run(id, () => this.store.setValue(id, null));
	}

	/** All non-deleted records, in no particular order. Fine at POC scale (<100 records per type). */
	async list(): Promise<T[]> {
		const ids: string[] = [];
		await this.store.forEachKey(async (key) => {
			ids.push(key);
		});
		const values = await Promise.all(ids.map((id) => this.store.getValue<T>(id)));
		return values.filter((value) => value !== null);
	}
}

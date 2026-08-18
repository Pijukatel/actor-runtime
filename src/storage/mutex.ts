/**
 * A tiny per-key async mutex. Express serves requests concurrently, and the `KeyValueStore` frontend
 * offers no read-modify-write atomicity, so every registry mutation is serialised behind this per
 * record - the only place two handlers can collide on one record.
 */
export class KeyedMutex {
	private readonly tails = new Map<string, Promise<unknown>>();

	async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
		const previous = this.tails.get(key) ?? Promise.resolve();
		const settled = previous.then(fn, fn);
		// Chain future calls behind this one regardless of whether it throws; swallow the rejection
		// only for chaining purposes, the real result/rejection is still returned to our own caller.
		const tombstone = settled.catch(() => undefined);
		this.tails.set(key, tombstone);
		try {
			return await settled;
		} finally {
			if (this.tails.get(key) === tombstone) {
				this.tails.delete(key);
			}
		}
	}
}

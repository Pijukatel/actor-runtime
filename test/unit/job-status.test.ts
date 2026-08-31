import { describe, expect, it } from 'vitest';

import { isTerminalJobStatus, transitionJobStatus, type StatusRegistry } from '../../src/services/job-status.js';
import { KeyedMutex } from '../../src/storage/mutex.js';
import type { JobStatus } from '../../src/storage/entities.js';

interface FakeJob {
	id: string;
	status: JobStatus;
	finishedAt?: string;
}

/** A minimal in-memory stand-in for `Registry<T>` - `Registry` has a private constructor/mutex, so it
 * cannot be satisfied structurally by a plain test double; `transitionJobStatus` is typed against the
 * narrower `StatusRegistry<T>` interface for exactly this reason. */
function fakeRegistry(initial: Record<string, FakeJob>): StatusRegistry<FakeJob> {
	const store = new Map(Object.entries(initial));
	return {
		async get(id) {
			return store.get(id) ?? null;
		},
		async update(id, mutator) {
			const next = mutator(store.get(id) ?? null);
			if (next === null) store.delete(id);
			else store.set(id, next);
			return next;
		},
	};
}

describe('isTerminalJobStatus', () => {
	it('SUCCEEDED, FAILED, ABORTED and TIMED-OUT are terminal', () => {
		expect(isTerminalJobStatus('SUCCEEDED')).toBe(true);
		expect(isTerminalJobStatus('FAILED')).toBe(true);
		expect(isTerminalJobStatus('ABORTED')).toBe(true);
		expect(isTerminalJobStatus('TIMED-OUT')).toBe(true);
	});

	it('READY, RUNNING and ABORTING are not terminal', () => {
		expect(isTerminalJobStatus('READY')).toBe(false);
		expect(isTerminalJobStatus('RUNNING')).toBe(false);
		expect(isTerminalJobStatus('ABORTING')).toBe(false);
	});
});

describe('transitionJobStatus', () => {
	it('allows READY -> RUNNING', async () => {
		const registry = fakeRegistry({ a: { id: 'a', status: 'READY' } });
		const result = await transitionJobStatus(registry, 'a', 'RUNNING');
		expect(result?.status).toBe('RUNNING');
	});

	it.each(['SUCCEEDED', 'FAILED', 'TIMED-OUT', 'ABORTING', 'ABORTED'] as const)(
		'allows RUNNING -> %s',
		async (next) => {
			const registry = fakeRegistry({ a: { id: 'a', status: 'RUNNING' } });
			const result = await transitionJobStatus(registry, 'a', next);
			expect(result?.status).toBe(next);
		},
	);

	it('allows ABORTING -> ABORTED', async () => {
		const registry = fakeRegistry({ a: { id: 'a', status: 'ABORTING' } });
		const result = await transitionJobStatus(registry, 'a', 'ABORTED');
		expect(result?.status).toBe('ABORTED');
	});

	it('rejects ABORTING -> FAILED (the exact race the review flagged): the record is left unchanged', async () => {
		const registry = fakeRegistry({ a: { id: 'a', status: 'ABORTING' } });
		const result = await transitionJobStatus(registry, 'a', 'FAILED', { finishedAt: 'x' });
		expect(result?.status).toBe('ABORTING');
		expect(result?.finishedAt).toBeUndefined();
	});

	it('rejects ABORTING -> SUCCEEDED the same way', async () => {
		const registry = fakeRegistry({ a: { id: 'a', status: 'ABORTING' } });
		const result = await transitionJobStatus(registry, 'a', 'SUCCEEDED');
		expect(result?.status).toBe('ABORTING');
	});

	it.each(['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT'] as const)(
		'never overwrites a terminal %s status, whatever the requested next status',
		async (terminal) => {
			for (const next of [
				'READY',
				'RUNNING',
				'ABORTING',
				'ABORTED',
				'SUCCEEDED',
				'FAILED',
				'TIMED-OUT',
			] as const) {
				const registry = fakeRegistry({ a: { id: 'a', status: terminal, finishedAt: 'original' } });
				const result = await transitionJobStatus(registry, 'a', next, { finishedAt: 'overwritten' });
				expect(result?.status).toBe(terminal);
				expect(result?.finishedAt).toBe('original');
			}
		},
	);

	it('rejects READY -> SUCCEEDED/FAILED/TIMED-OUT directly (must go through RUNNING)', async () => {
		for (const next of ['SUCCEEDED', 'FAILED', 'TIMED-OUT'] as const) {
			const registry = fakeRegistry({ a: { id: 'a', status: 'READY' } });
			const result = await transitionJobStatus(registry, 'a', next);
			expect(result?.status).toBe('READY');
		}
	});

	it('allows READY -> ABORTING and READY -> ABORTED (the pre-start abort window)', async () => {
		const toAborting = fakeRegistry({ a: { id: 'a', status: 'READY' } });
		expect((await transitionJobStatus(toAborting, 'a', 'ABORTING'))?.status).toBe('ABORTING');

		const toAborted = fakeRegistry({ a: { id: 'a', status: 'READY' } });
		expect((await transitionJobStatus(toAborted, 'a', 'ABORTED'))?.status).toBe('ABORTED');
	});

	it('returns null and does nothing for a record that does not exist', async () => {
		const registry = fakeRegistry({});
		const result = await transitionJobStatus(registry, 'missing', 'RUNNING');
		expect(result).toBeNull();
	});

	it('merges the patch only when the transition is accepted', async () => {
		const registry = fakeRegistry({ a: { id: 'a', status: 'RUNNING' } });
		const result = await transitionJobStatus(registry, 'a', 'SUCCEEDED', { finishedAt: 'now' });
		expect(result).toEqual({ id: 'a', status: 'SUCCEEDED', finishedAt: 'now' });
	});

	it('a patch containing `status` is always overridden by the `next` argument', async () => {
		const registry = fakeRegistry({ a: { id: 'a', status: 'RUNNING' } });
		const result = await transitionJobStatus(registry, 'a', 'FAILED', { status: 'SUCCEEDED' } as never);
		expect(result?.status).toBe('FAILED');
	});

	it('invokes onBeforeTransition with the current record, before the accept/refuse decision is made, without affecting the result', async () => {
		const registry = fakeRegistry({ a: { id: 'a', status: 'RUNNING' } });
		const seen: Array<FakeJob | null> = [];
		const result = await transitionJobStatus(registry, 'a', 'SUCCEEDED', {}, (current) => {
			seen.push(current);
		});
		expect(seen).toEqual([{ id: 'a', status: 'RUNNING' }]);
		expect(result?.status).toBe('SUCCEEDED');
	});

	it('invokes onBeforeTransition even when the transition itself is refused (record left unchanged), still with the current record', async () => {
		const registry = fakeRegistry({ a: { id: 'a', status: 'ABORTING' } });
		const seen: Array<FakeJob | null> = [];
		const result = await transitionJobStatus(registry, 'a', 'FAILED', {}, (current) => {
			seen.push(current);
		});
		expect(seen).toEqual([{ id: 'a', status: 'ABORTING' }]);
		expect(result?.status).toBe('ABORTING'); // unchanged - ABORTING -> FAILED is not allowed
	});

	it('invokes onBeforeTransition with null for a record that does not exist', async () => {
		const registry = fakeRegistry({});
		const seen: Array<FakeJob | null> = [];
		await transitionJobStatus(registry, 'missing', 'RUNNING', {}, (current) => {
			seen.push(current);
		});
		expect(seen).toEqual([null]);
	});

	/**
	 * Regression for `abortRun`'s `wasRunning` TOCTOU (a race between a plain, mutex-bypassing registry
	 * read and a concurrent mutex-serialized write): built on top of the REAL `KeyedMutex` (already
	 * independently proven FIFO/no-overlap in `mutex.test.ts`), rather
	 * than `fakeRegistry` above (whose `update` is synchronous and so never actually races anything). This
	 * `StatusRegistry` deliberately holds its FIRST `update` call's read+write open behind a gate - mirroring
	 * `runInBackground`'s own real, slow `@crawlee/fs-storage` I/O not yet having settled - while a SECOND,
	 * concurrently-issued `transitionJobStatus` call (mirroring `abortRun`) is already queued behind it on
	 * the same mutex key. `onBeforeTransition` must observe whatever the first call ultimately wrote, never
	 * the value the record held before that write - which is exactly what a separate, unguarded
	 * `registry.get(id)` taken at the same wall-clock moment (the pre-fix shape of `abortRun`) would have
	 * returned instead: the stale, pre-transition status.
	 */
	it("onBeforeTransition observes the record's true current status under a real concurrent mutex-serialized write, never a stale pre-write snapshot (regression: a plain, mutex-bypassing read taken before the guarded write would return abortRun's wasRunning/alreadyAborting flags stale)", async () => {
		const mutex = new KeyedMutex();
		const store = new Map<string, FakeJob>([['a', { id: 'a', status: 'READY' }]]);
		let callCount = 0;
		let releaseFirstWrite!: () => void;
		const firstWriteGate = new Promise<void>((resolve) => {
			releaseFirstWrite = resolve;
		});

		const registry: StatusRegistry<FakeJob> = {
			async get(id) {
				return store.get(id) ?? null;
			},
			async update(id, mutator) {
				return mutex.run(id, async () => {
					callCount += 1;
					// Only the FIRST call (simulating `runInBackground`'s own READY -> RUNNING write) pauses
					// here, before actually reading/writing - a second, concurrently-issued call (simulating
					// `abortRun`) still has to wait its turn on this same mutex key regardless, so it can only
					// ever observe what THIS call ends up writing, never anything from before it.
					if (callCount === 1) await firstWriteGate;
					const current = store.get(id) ?? null;
					const next = mutator(current);
					if (next === null) store.delete(id);
					else store.set(id, next);
					return next;
				});
			},
		};

		// Issued first, but deliberately held open by the gate above.
		const runningPromise = transitionJobStatus(registry, 'a', 'RUNNING');

		// Issued while the first transition is still in flight - the concurrent-abort-during-a-still-settling
		// write interleaving this test exists to cover.
		let observedBeforeAborting: JobStatus | null | undefined;
		const abortingPromise = transitionJobStatus(registry, 'a', 'ABORTING', {}, (current) => {
			observedBeforeAborting = current?.status ?? null;
		});

		// Only now does the first transition's own read+write actually happen.
		releaseFirstWrite();

		const running = await runningPromise;
		const aborting = await abortingPromise;

		expect(running?.status).toBe('RUNNING');
		// The crux of the fix: RUNNING, never the pre-transition READY a separate, unguarded `get()` taken
		// at the moment `abortRun` was called would have returned instead.
		expect(observedBeforeAborting).toBe('RUNNING');
		expect(aborting?.status).toBe('ABORTING');
	});
});

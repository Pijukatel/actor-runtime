import { describe, expect, it } from 'vitest';

import { isTerminalJobStatus, transitionJobStatus, type StatusRegistry } from '../../src/services/job-status.js';
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
});

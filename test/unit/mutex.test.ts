import { describe, expect, it } from 'vitest';

import { KeyedMutex } from '../../src/storage/mutex.js';

/** Deterministic ordering helper: resolves after a macrotask tick, so `run()` calls that appear to
 * race really do overlap in time rather than resolving synchronously in call order. */
function tick(ms = 0): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('KeyedMutex', () => {
	it('serialises interleaved async writers to the same key: no overlap, FIFO order', async () => {
		const mutex = new KeyedMutex();
		const log: string[] = [];
		let inFlight = 0;
		let maxConcurrent = 0;

		async function writer(label: string, delayMs: number): Promise<void> {
			await mutex.run('record-1', async () => {
				inFlight += 1;
				maxConcurrent = Math.max(maxConcurrent, inFlight);
				log.push(`${label}-start`);
				await tick(delayMs);
				log.push(`${label}-end`);
				inFlight -= 1;
			});
		}

		// Kick off three writers "simultaneously" (same microtask), with the first taking the longest,
		// so a broken mutex would let B and C's work interleave with A's.
		await Promise.all([writer('A', 20), writer('B', 5), writer('C', 5)]);

		expect(maxConcurrent).toBe(1);
		// Never overlapping means every "-start" is immediately followed by its own "-end".
		expect(log).toEqual(['A-start', 'A-end', 'B-start', 'B-end', 'C-start', 'C-end']);
	});

	it('keeps serialising later callers even after an earlier one throws', async () => {
		const mutex = new KeyedMutex();
		const order: string[] = [];

		const first = mutex
			.run('record-1', async () => {
				order.push('first');
				throw new Error('boom');
			})
			.catch((error: unknown) => error);

		const second = mutex.run('record-1', async () => {
			order.push('second');
			return 'ok';
		});

		await expect(first).resolves.toBeInstanceOf(Error);
		await expect(second).resolves.toBe('ok');
		expect(order).toEqual(['first', 'second']);
	});

	it('does not serialise writers on different keys', async () => {
		const mutex = new KeyedMutex();
		let inFlightTotal = 0;
		let maxConcurrent = 0;

		async function writer(key: string): Promise<void> {
			await mutex.run(key, async () => {
				inFlightTotal += 1;
				maxConcurrent = Math.max(maxConcurrent, inFlightTotal);
				await tick(20);
				inFlightTotal -= 1;
			});
		}

		await Promise.all([writer('record-1'), writer('record-2'), writer('record-3')]);

		expect(maxConcurrent).toBe(3);
	});
});

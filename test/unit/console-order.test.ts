import { describe, expect, it } from 'vitest';

import { newestFirst } from '../../src/console/order.js';

describe('newestFirst', () => {
	it('sorts descending by startedAt, without mutating the input', () => {
		const input = [
			{ id: 'a', startedAt: '2024-01-01T00:00:00.000Z' },
			{ id: 'b', startedAt: '2024-01-03T00:00:00.000Z' },
			{ id: 'c', startedAt: '2024-01-02T00:00:00.000Z' },
		];
		const sorted = newestFirst(input);
		expect(sorted.map((item) => item.id)).toEqual(['b', 'c', 'a']);
		expect(input.map((item) => item.id)).toEqual(['a', 'b', 'c']); // original order untouched
	});

	it('breaks a startedAt tie by id ascending, even when the input hands the higher id in first (regression: a plain stable sort with no explicit tiebreak would just preserve this input order instead)', () => {
		const tie = '2024-01-01T00:00:00.000Z';
		const input = [
			{ id: 'z-tied', startedAt: tie },
			{ id: 'a-tied', startedAt: tie },
		];
		const sorted = newestFirst(input);
		expect(sorted.map((item) => item.id)).toEqual(['a-tied', 'z-tied']);
	});

	it('applies the id tiebreak only among equal startedAt values, not globally', () => {
		const tie = '2024-01-01T00:00:00.000Z';
		const input = [
			{ id: 'z-tied', startedAt: tie },
			{ id: 'newer', startedAt: '2024-06-01T00:00:00.000Z' },
			{ id: 'a-tied', startedAt: tie },
		];
		const sorted = newestFirst(input);
		expect(sorted.map((item) => item.id)).toEqual(['newer', 'a-tied', 'z-tied']);
	});
});

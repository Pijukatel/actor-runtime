import { describe, expect, it } from 'vitest';

import { paginate, sortByTimestamp } from '../../src/api/envelope.js';

describe('paginate', () => {
	it('defaults to the full set, ascending, offset 0, no desc', () => {
		const result = paginate(['a', 'b', 'c'], {});
		expect(result).toEqual({ total: 3, count: 3, offset: 0, limit: 3, desc: false, items: ['a', 'b', 'c'] });
	});

	it('applies limit and offset as a slice of the natural order', () => {
		const result = paginate(['a', 'b', 'c', 'd', 'e'], { offset: 1, limit: 2 });
		expect(result).toEqual({ total: 5, count: 2, offset: 1, limit: 2, desc: false, items: ['b', 'c'] });
	});

	it('desc reverses the natural order before slicing', () => {
		const result = paginate(['a', 'b', 'c', 'd'], { desc: true });
		expect(result.items).toEqual(['d', 'c', 'b', 'a']);
		expect(result.desc).toBe(true);
	});

	it('desc + offset + limit together (the exact combination the review flagged as ignored end to end)', () => {
		const result = paginate(['a', 'b', 'c', 'd', 'e'], { desc: true, offset: 1, limit: 2 });
		// Natural order reversed is [e, d, c, b, a]; offset 1, limit 2 -> [d, c].
		expect(result.items).toEqual(['d', 'c']);
		expect(result).toMatchObject({ total: 5, count: 2, offset: 1, limit: 2, desc: true });
	});

	it('count reflects the post-slice length, total the pre-slice length', () => {
		const result = paginate(['a', 'b'], { offset: 0, limit: 100 });
		expect(result.total).toBe(2);
		expect(result.count).toBe(2);
		expect(result.limit).toBe(100);
	});

	it('offset past the end yields an empty page without throwing', () => {
		const result = paginate(['a', 'b'], { offset: 10 });
		expect(result.items).toEqual([]);
		expect(result.count).toBe(0);
		expect(result.total).toBe(2);
	});
});

describe('sortByTimestamp', () => {
	it('sorts ascending by the given ISO-8601 timestamp field, stably, without mutating the input', () => {
		const input = [
			{ id: 'b', createdAt: '2024-01-02T00:00:00.000Z' },
			{ id: 'a', createdAt: '2024-01-01T00:00:00.000Z' },
			{ id: 'c', createdAt: '2024-01-03T00:00:00.000Z' },
		];
		const sorted = sortByTimestamp(input, (item) => item.createdAt);
		expect(sorted.map((item) => item.id)).toEqual(['a', 'b', 'c']);
		expect(input.map((item) => item.id)).toEqual(['b', 'a', 'c']); // original order untouched
	});
});

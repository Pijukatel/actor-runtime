import { describe, expect, it } from 'vitest';
import { pageKeys } from '../../src/services/kv-key-listing.js';

describe('pageKeys', () => {
	const keys = [
		{ key: 'c', size: 3 },
		{ key: 'a', size: 1 },
		{ key: 'b', size: 2 },
	];

	it('sorts lexicographically', () => {
		const page = pageKeys(keys);
		expect(page.items.map((i) => i.key)).toEqual(['a', 'b', 'c']);
	});

	it('applies limit and reports truncation', () => {
		const page = pageKeys(keys, { limit: 2 });
		expect(page.items.map((i) => i.key)).toEqual(['a', 'b']);
		expect(page.isTruncated).toBe(true);
		expect(page.nextExclusiveStartKey).toBe('b');
	});

	it('applies exclusiveStartKey after sorting', () => {
		const page = pageKeys(keys, { exclusiveStartKey: 'a' });
		expect(page.items.map((i) => i.key)).toEqual(['b', 'c']);
		expect(page.isTruncated).toBe(false);
		expect(page.nextExclusiveStartKey).toBeUndefined();
	});

	it('an exclusiveStartKey past the end yields an empty, non-truncated page', () => {
		const page = pageKeys(keys, { exclusiveStartKey: 'z' });
		expect(page.items).toEqual([]);
		expect(page.isTruncated).toBe(false);
	});

	it('defaults to a limit of 1000', () => {
		const page = pageKeys(keys);
		expect(page.limit).toBe(1000);
	});
});

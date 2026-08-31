import { describe, expect, it } from 'vitest';
import { applyDatasetProjection } from '../../src/services/dataset-projection.js';

describe('applyDatasetProjection', () => {
	const items = [
		{ a: 1, b: 2, '#hidden': 'x', empty: '', arr: [] },
		{ a: 3, b: 4, '#hidden': 'y', empty: 'nonempty', arr: [1, 2] },
	];

	it('passes items through unchanged with no options', () => {
		expect(applyDatasetProjection(items, {})).toEqual(items);
	});

	it('applies fields to keep only named keys, in requested order', () => {
		const result = applyDatasetProjection(items, { fields: ['b', 'a'] });
		expect(result).toEqual([
			{ b: 2, a: 1 },
			{ b: 4, a: 3 },
		]);
	});

	it('applies omit to drop named keys', () => {
		const result = applyDatasetProjection(items, { omit: ['#hidden', 'arr'] });
		expect(result[0]).toEqual({ a: 1, b: 2, empty: '' });
	});

	it('applies skipHidden to drop keys starting with #', () => {
		const result = applyDatasetProjection(items, { skipHidden: true });
		expect(result[0]).not.toHaveProperty('#hidden');
		expect(result[0]).toHaveProperty('a');
	});

	it('applies skipEmpty to drop empty-valued keys', () => {
		const result = applyDatasetProjection(items, { skipEmpty: true });
		expect(result[0]).not.toHaveProperty('empty');
		expect(result[0]).not.toHaveProperty('arr');
		expect(result[1]).toHaveProperty('empty', 'nonempty');
		expect(result[1]).toHaveProperty('arr', [1, 2]);
	});

	it('clean implies both skipHidden and skipEmpty', () => {
		const result = applyDatasetProjection(items, { clean: true });
		expect(result[0]).toEqual({ a: 1, b: 2 });
	});

	it('applies unwind to expand an array field into one item per element', () => {
		const result = applyDatasetProjection([{ id: 1, tags: ['x', 'y'] }], { unwind: 'tags' });
		expect(result).toEqual([
			{ id: 1, tags: 'x' },
			{ id: 1, tags: 'y' },
		]);
	});

	it('unwind leaves items with an empty array field alone', () => {
		const result = applyDatasetProjection([{ id: 1, tags: [] }], { unwind: 'tags' });
		expect(result).toEqual([{ id: 1, tags: [] }]);
	});

	it('unwind leaves an item alone when the field is a non-array value (string)', () => {
		const result = applyDatasetProjection([{ id: 1, tags: 'not-an-array' }], { unwind: 'tags' });
		expect(result).toEqual([{ id: 1, tags: 'not-an-array' }]);
	});

	it('unwind leaves an item alone when the field is a non-array value (number)', () => {
		const result = applyDatasetProjection([{ id: 1, tags: 42 }], { unwind: 'tags' });
		expect(result).toEqual([{ id: 1, tags: 42 }]);
	});

	it('unwind leaves an item alone when the field is missing entirely', () => {
		const result = applyDatasetProjection([{ id: 1 }], { unwind: 'tags' });
		expect(result).toEqual([{ id: 1 }]);
	});
});

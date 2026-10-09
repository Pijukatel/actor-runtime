import { describe, expect, it } from 'vitest';

import {
	findInvalidDatasetItems,
	resolveDatasetSchema,
	type DatasetSchemaResolution,
} from '../../src/services/dataset-schema.js';
import type { SourceFile } from '../../src/storage/entities.js';

const SCHEMA = {
	actorSpecification: 1,
	fields: {
		type: 'object',
		properties: { title: { type: 'string' }, price: { type: 'number' } },
		required: ['title'],
	},
};

function json(name: string, value: unknown): SourceFile {
	return { name, format: 'TEXT', content: JSON.stringify(value) };
}

function actorJson(storages: unknown): SourceFile {
	return json('.actor/actor.json', { actorSpecification: 1, name: 'a', version: '0.0', storages });
}

function expectResolved(resolution: DatasetSchemaResolution) {
	if (resolution.outcome !== 'resolved') throw new Error(`expected a resolved schema, got ${resolution.message}`);
	return resolution;
}

function expectFailure(resolution: DatasetSchemaResolution) {
	if (resolution.outcome !== 'failure') throw new Error('expected a failure');
	return resolution;
}

describe('resolveDatasetSchema', () => {
	it('declares no schema without .actor/actor.json or its "storages.dataset"', () => {
		expect(expectResolved(resolveDatasetSchema([])).schema).toBeUndefined();
		expect(expectResolved(resolveDatasetSchema([actorJson({})])).schema).toBeUndefined();
	});

	it('takes an inline schema object', () => {
		const resolution = expectResolved(resolveDatasetSchema([actorJson({ dataset: SCHEMA })]));
		expect(resolution.schema).toEqual(SCHEMA);
		expect(resolution.logLines.join('')).toContain('"storages.dataset" field');
	});

	it('reads a schema file relative to .actor/', () => {
		const resolution = expectResolved(
			resolveDatasetSchema([
				actorJson({ dataset: './dataset_schema.json' }),
				json('.actor/dataset_schema.json', SCHEMA),
			]),
		);
		expect(resolution.schema).toEqual(SCHEMA);
		expect(resolution.logLines.join('')).toContain('.actor/dataset_schema.json');
	});

	it('takes the default alias of "storages.datasets"', () => {
		const resolution = expectResolved(
			resolveDatasetSchema([actorJson({ datasets: { default: SCHEMA, other: { actorSpecification: 1 } } })]),
		);
		expect(resolution.schema).toEqual(SCHEMA);
	});

	it('fails on a missing, escaping, unparseable or invalid schema file', () => {
		expect(expectFailure(resolveDatasetSchema([actorJson({ dataset: './missing.json' })])).message).toBe(
			'Schema property "storages.dataset": File ".actor/missing.json" does not exist!',
		);
		expect(expectFailure(resolveDatasetSchema([actorJson({ dataset: '../../x.json' })])).message).toContain(
			'outside the Actor root',
		);
		expect(
			expectFailure(
				resolveDatasetSchema([
					actorJson({ dataset: './d.json' }),
					{ name: '.actor/d.json', format: 'TEXT', content: '{' },
				]),
			).message,
		).toContain('Could not parse the dataset schema');
		expect(
			expectFailure(
				resolveDatasetSchema([
					actorJson({ dataset: './d.json' }),
					json('.actor/d.json', { actorSpecification: 2 }),
				]),
			).message,
		).toContain('is not valid');
	});

	it('warns when "fields" cannot be compiled', () => {
		const resolution = expectResolved(
			resolveDatasetSchema([
				actorJson({ dataset: './d.json' }),
				json('.actor/d.json', { actorSpecification: 1, fields: { $ref: '#/nowhere' } }),
			]),
		);
		expect(resolution.logLines.join('')).toContain('will not be validated');
	});
});

describe('findInvalidDatasetItems', () => {
	it('reports every rejected item with its position and all of its errors', () => {
		const invalid = findInvalidDatasetItems(SCHEMA, [
			{ title: 'ok' },
			{ price: 'free' },
			{ title: 'ok', price: 1 },
		]);
		expect(invalid).toHaveLength(1);
		expect(invalid[0]!.itemPosition).toBe(1);
		expect(invalid[0]!.validationErrors.map((error) => (error as { keyword: string }).keyword).sort()).toEqual([
			'required',
			'type',
		]);
	});

	it('accepts anything without a schema, "fields", or a compilable "fields"', () => {
		expect(findInvalidDatasetItems(undefined, [{}])).toEqual([]);
		expect(findInvalidDatasetItems({ actorSpecification: 1 }, [{}])).toEqual([]);
		expect(findInvalidDatasetItems({ fields: { $ref: '#/nowhere' } }, [{}])).toEqual([]);
	});
});

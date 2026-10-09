/**
 * Dataset schemas (`storage.md`'s "Dataset schema validation"): resolved from `.actor/actor.json`'s
 * `storages.dataset` at build time, and enforced on every item pushed to a dataset that carries one.
 *
 * Item validation uses the platform API's own AJV configuration, and answers with its exact error shape,
 * so a developer sees locally the rejection the platform would send.
 */
import JSON5 from 'json5';
import ajvPackage from 'ajv';
import { getDatasetSchemaValidator } from '@apify/json_schemas';

import type { DatasetSchema, SourceFile } from '../storage/entities.js';
import {
	escapesActorRootMessage,
	indexSourceFiles,
	parseActorJson,
	resolveActorJsonPathField,
	sourceFileToText,
} from './actor-source-files.js';

// AJV ships as CommonJS, so under this package's ESM resolution its class arrives as the module's
// `default`.
const Ajv = ajvPackage.default;
type ItemValidator = ReturnType<InstanceType<typeof Ajv>['compile']>;

export type DatasetSchemaResolution =
	| { outcome: 'resolved'; schema: DatasetSchema | undefined; logLines: string[] }
	| { outcome: 'failure'; message: string };

/** `null` for a valid dataset schema, the defect otherwise. */
export function describeDatasetSchemaDefect(schema: unknown): string | null {
	if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
		return 'Dataset schema must be an object.';
	}
	const validate = getDatasetSchemaValidator();
	if (validate(schema)) return null;
	return JSON.stringify(validate.errors, null, 4);
}

/** The schema field the platform creates a run's default dataset from: `storages.datasets.default` (or,
 * for the schemas that predate that requirement, the first alias), else `storages.dataset`. */
function defaultDatasetField(specification: unknown): { field: unknown; fieldName: string } | undefined {
	if (specification === null || typeof specification !== 'object') return undefined;
	const storages = (specification as Record<string, unknown>).storages;
	if (storages === null || typeof storages !== 'object') return undefined;
	const { dataset, datasets } = storages as Record<string, unknown>;
	if (datasets !== null && typeof datasets === 'object' && !Array.isArray(datasets)) {
		const aliases = datasets as Record<string, unknown>;
		const alias = 'default' in aliases ? 'default' : Object.keys(aliases)[0];
		if (alias !== undefined) return { field: aliases[alias], fieldName: `storages.datasets.${alias}` };
	}
	if (dataset !== undefined) return { field: dataset, fieldName: 'storages.dataset' };
	return undefined;
}

function accept(schema: unknown, source: string): DatasetSchemaResolution {
	const defect = describeDatasetSchemaDefect(schema);
	if (defect) return { outcome: 'failure', message: `Dataset schema from ${source} is not valid: ${defect}` };
	const logLines = [`Using the dataset schema from ${source}.\n`];
	const { fields } = schema as DatasetSchema;
	// The platform stores such a schema and quietly skips item validation; saying so here is the only
	// place the developer would learn why their items are never rejected.
	if (fields !== undefined && compileItemValidator(fields) === null) {
		logLines.push(
			`Warning: the "fields" of the dataset schema from ${source} cannot be compiled, so dataset items will not be validated.\n`,
		);
	}
	return { outcome: 'resolved', schema: schema as DatasetSchema, logLines };
}

export function resolveDatasetSchema(sourceFiles: SourceFile[], actorPath = ''): DatasetSchemaResolution {
	const actorJson = parseActorJson(sourceFiles, actorPath);
	if (actorJson.outcome === 'unparseable') return { outcome: 'failure', message: actorJson.message };
	if (actorJson.outcome === 'absent') return { outcome: 'resolved', schema: undefined, logLines: [] };

	const located = defaultDatasetField(actorJson.specification);
	if (!located) return { outcome: 'resolved', schema: undefined, logLines: [] };
	const { field, fieldName } = located;

	if (typeof field !== 'string') return accept(field, `the "${fieldName}" field in .actor/actor.json`);

	// Exact case and no fallback, as for the input schema.
	const resolved = resolveActorJsonPathField(indexSourceFiles(sourceFiles), field, actorPath, true);
	if (resolved.outcome === 'escapes-actor-root') {
		return { outcome: 'failure', message: escapesActorRootMessage(field, 'Dataset schema') };
	}
	if (resolved.outcome === 'not-found') {
		return {
			outcome: 'failure',
			message: `Schema property "${fieldName}": File "${resolved.shownPath}" does not exist!`,
		};
	}
	let parsed: unknown;
	try {
		parsed = JSON5.parse(sourceFileToText(resolved.file.file));
	} catch (error) {
		return {
			outcome: 'failure',
			message: `Could not parse the dataset schema "${resolved.file.normalizedName}": ${(error as Error).message}`,
		};
	}
	return accept(parsed, `"${resolved.file.normalizedName}" (the "${fieldName}" field in .actor/actor.json)`);
}

/** `null` when `fields` does not compile - the platform then stores items unvalidated. */
function compileItemValidator(fields: Record<string, unknown>): ItemValidator | null {
	try {
		// A fresh instance per compilation: AJV never evicts its internal compiled-schema map.
		return new Ajv({ strict: false, unicodeRegExp: false, allErrors: true }).compile(fields);
	} catch {
		return null;
	}
}

/** Keyed by the serialized `fields`: every storage-record read is a fresh object, and datasets of one
 * Actor share a schema. Bounded, since nothing else ever evicts. */
const validatorCache = new Map<string, ItemValidator | null>();
const VALIDATOR_CACHE_LIMIT = 100;

function itemValidatorFor(schema: DatasetSchema): ItemValidator | null {
	if (schema.fields === undefined) return null;
	const key = JSON.stringify(schema.fields);
	let validator = validatorCache.get(key);
	if (validator === undefined) {
		validator = compileItemValidator(schema.fields);
		if (validatorCache.size >= VALIDATOR_CACHE_LIMIT) validatorCache.clear();
		validatorCache.set(key, validator);
	}
	return validator;
}

export interface InvalidDatasetItem {
	itemPosition: number;
	validationErrors: unknown[];
}

/** Every item that `schema` rejects, with its position in `items`; empty when all pass or there is
 * nothing to validate against. */
export function findInvalidDatasetItems(schema: DatasetSchema | undefined, items: unknown[]): InvalidDatasetItem[] {
	const validator = schema ? itemValidatorFor(schema) : null;
	if (!validator) return [];
	const invalidItems: InvalidDatasetItem[] = [];
	items.forEach((item, itemPosition) => {
		if (!validator(item)) invalidItems.push({ itemPosition, validationErrors: validator.errors ?? [] });
	});
	return invalidItems;
}

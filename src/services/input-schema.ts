/**
 * Input validation and defaults at run start; `services/input-schema-location.ts` is the build-time
 * half that finds the schema in the pushed source.
 *
 * Validation goes through the platform's own `@apify/input_schema`, driven by the same AJV
 * configuration the platform's API uses, so a developer reads locally the very message the real API
 * would answer with rather than an approximation of it.
 */
import ajvPackage from 'ajv';
import { validateInputUsingValidator } from '@apify/input_schema';

import type { BuildRecord, InputSchema } from '../storage/entities.js';

// AJV ships as CommonJS, so under this package's ESM resolution its class arrives as the module's
// `default`.
const Ajv = ajvPackage.default;
type InputValidator = ReturnType<InstanceType<typeof Ajv>['compile']>;

/** Stored verbatim as the run's `INPUT` record. */
export interface ActorInput {
	body: Buffer;
	contentType: string;
}

/** `kind` is the API error type the route answers with; `message` is the real Apify API's own wording
 * for the same defect (`@apify-packages/errors`'s `actor.inputNotJson` and its neighbours). */
export type InputProcessingResult =
	| { kind: 'ok'; input: ActorInput }
	| { kind: 'invalid-input'; message: string }
	| { kind: 'invalid-input-schema'; message: string };

/**
 * The input a run against `build` should actually start with: the caller's bytes untouched when the
 * build declares no input schema, and the validated input with that schema's defaults applied when it
 * does.
 */
export function resolveBuildInput(build: BuildRecord, input: ActorInput | undefined): InputProcessingResult {
	if (!build.inputSchema) return { kind: 'ok', input: input as ActorInput };
	return processActorInput(input, build.inputSchema);
}

/**
 * Mirrors the platform's `processInputUsingSchema`: with a schema present, an absent input is an empty
 * object the defaults are applied to, not "no input".
 */
export function processActorInput(input: ActorInput | undefined, schema: InputSchema): InputProcessingResult {
	let parsedInput: Record<string, unknown> = {};
	if (input) {
		if (!isJsonContentType(input.contentType)) {
			return { kind: 'invalid-input', message: 'Actor input must have content type "application/json".' };
		}
		let body: unknown;
		try {
			body = JSON.parse(input.body.toString('utf8'));
		} catch (error) {
			return { kind: 'invalid-input', message: `Cannot parse input JSON body: ${(error as Error).message}` };
		}
		// A literal `null` body is the platform's "no input" too, not a type error.
		if (body !== null) {
			if (!isPlainObject(body)) {
				const actualType = Array.isArray(body) ? 'array' : typeof body;
				return {
					kind: 'invalid-input',
					message: `The input JSON must be object, got "${actualType}" instead.`,
				};
			}
			parsedInput = body;
		}
	}

	let validator;
	try {
		validator = compileInputSchemaValidator(schema);
	} catch (error) {
		// Reachable only for a schema recorded before builds validated them, or one that meta-validates
		// yet still will not compile.
		return { kind: 'invalid-input-schema', message: `Input schema is not valid: ${(error as Error).message}` };
	}

	// `parsedInput` was parsed here and is referenced nowhere else, so the merge may own it.
	const withDefaults = assignDefaults(parsedInput, schema);

	// No `proxy` options: this runtime emulates no proxy groups (`unsupported.md`), so any
	// `apifyProxyGroups` selection is accepted, while the rest of a proxy field is still checked.
	const validationErrors = validateInputUsingValidator(validator, schema, withDefaults, {});
	if (validationErrors.length > 0) {
		// Joined, as the platform answers an API-origin run.
		const message = validationErrors.map(({ message: text }) => text).join(', ');
		return { kind: 'invalid-input', message: `Input is not valid: ${message}` };
	}

	return {
		kind: 'ok',
		input: { body: Buffer.from(JSON.stringify(withDefaults), 'utf8'), contentType: DEFAULT_INPUT_CONTENT_TYPE },
	};
}

const DEFAULT_INPUT_CONTENT_TYPE = 'application/json';

/** Parameters such as `; charset=utf-8` are ignored. */
export function isJsonContentType(contentType: string): boolean {
	return contentType.split(';')[0]?.trim().toLowerCase() === DEFAULT_INPUT_CONTENT_TYPE;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A port of the platform's `mergeDefaultsFromInputSchema`. `values` is filled in place and returned:
 * every caller parsed it itself, and cloning it doubles the peak heap of a large input.
 */
export function assignDefaults(values: Record<string, unknown>, schema: InputSchema): Record<string, unknown> {
	const properties = isPlainObject(schema.properties) ? schema.properties : {};
	const defaults: Record<string, unknown> = {};
	for (const [key, fieldSchema] of Object.entries(properties)) {
		defaults[key] = extractDefaults(fieldSchema);
	}

	// `extractDefaults` returns references into the stored schema, so the values assigned into the
	// input must be copies - otherwise a later mutation of either would reach the other.
	assignRecursively(values, structuredClone(defaults), schema);
	return values;
}

/** The input a new task starts with, as on the platform: each field's `prefill`, or its `default` for a
 * hidden field. */
export function inputSchemaPrefill(schema: InputSchema): Record<string, unknown> {
	const properties = isPlainObject(schema.properties) ? schema.properties : {};
	const prefill: Record<string, unknown> = {};
	for (const [key, fieldSchema] of Object.entries(properties)) {
		if (!isPlainObject(fieldSchema)) continue;
		const value = fieldSchema.editor === 'hidden' ? fieldSchema.default : fieldSchema.prefill;
		if (value !== undefined) prefill[key] = structuredClone(value);
	}
	return prefill;
}

/** A field's own `default` wins, key by key, over the defaults of its nested fields. */
function extractDefaults(fieldSchema: unknown): unknown {
	if (!isPlainObject(fieldSchema)) return undefined;

	const rootValue = fieldSchema.default;
	const properties = isPlainObject(fieldSchema.properties) ? fieldSchema.properties : undefined;
	if (properties) {
		const nested: Record<string, unknown> = {};
		for (const [key, subSchema] of Object.entries(properties)) {
			nested[key] = extractDefaults(subSchema);
		}
		if (isPlainObject(rootValue)) return deepMerge(nested, rootValue);
		if (Object.values(nested).some((value) => value !== undefined)) return nested;
	}
	return rootValue;
}

/** `fillDefinedValues` is set for array items alone, where the platform fills an item's fields even
 * though the item itself is present. */
function assignRecursively(
	target: Record<string, unknown>,
	defaults: Record<string, unknown>,
	schema: InputSchema | undefined,
	fillDefinedValues = false,
): void {
	const schemaProperties = isPlainObject(schema?.properties) ? schema.properties : {};
	const keys = new Set([...Object.keys(defaults), ...Object.keys(schemaProperties)]);

	for (const key of keys) {
		const defaultValue = defaults[key];
		const currentValue = target[key];
		const fieldSchema = schemaProperties[key];

		if (currentValue === undefined) {
			if (defaultValue !== undefined) target[key] = defaultValue;
			continue;
		}

		if (isPlainObject(currentValue)) {
			// A present nested object keeps exactly the keys it came with, so outside an array item
			// there is nothing to fill and no defaults to extract.
			const nestedDefaults = fillDefinedValues
				? isPlainObject(defaultValue)
					? defaultValue
					: ((extractDefaults(fieldSchema) as Record<string, unknown> | undefined) ?? {})
				: {};
			assignRecursively(currentValue, nestedDefaults, fieldSchema as InputSchema | undefined);
			continue;
		}

		if (Array.isArray(currentValue)) {
			const itemSchema = isPlainObject(fieldSchema) ? fieldSchema.items : undefined;
			const itemDefaults = extractDefaults(itemSchema);
			if (!isPlainObject(itemDefaults)) continue;
			for (const item of currentValue) {
				if (!isPlainObject(item)) continue;
				assignRecursively(item, itemDefaults, itemSchema as InputSchema | undefined, true);
			}
		}
	}
}

/** The one `lodash.merge` behaviour `extractDefaults` needs, without the dependency. */
function deepMerge(base: Record<string, unknown>, overrides: Record<string, unknown>): Record<string, unknown> {
	const merged: Record<string, unknown> = { ...base };
	for (const [key, value] of Object.entries(overrides)) {
		const existing = merged[key];
		merged[key] = isPlainObject(existing) && isPlainObject(value) ? deepMerge(existing, value) : value;
	}
	return merged;
}

/**
 * Compiled validators, keyed by the schema's serialization: a run start would otherwise spend ~6ms
 * recompiling a schema it has already seen. Bounded and evicted first-inserted-first, so a long-lived
 * runtime does not keep an entry per schema it has ever seen.
 */
const validatorCache = new Map<string, InputValidator>();
const VALIDATOR_CACHE_MAX_ENTRIES = 100;

function compileInputSchemaValidator(schema: InputSchema): InputValidator {
	const cacheKey = JSON.stringify(schema);
	const cached = validatorCache.get(cacheKey);
	if (cached) return cached;

	const validator = new Ajv({ strict: false, unicodeRegExp: false }).compile(prepareSchemaForValidation(schema));

	if (validatorCache.size >= VALIDATOR_CACHE_MAX_ENTRIES) {
		const oldest = validatorCache.keys().next();
		if (!oldest.done) validatorCache.delete(oldest.value);
	}
	validatorCache.set(cacheKey, validator);
	return validator;
}

/**
 * Ported from the platform's `getAjvValidator`. `$schema` is dropped because AJV would otherwise try
 * to fetch the Apify meta-schema it names and fail to compile the schema at all.
 */
function prepareSchemaForValidation(schema: InputSchema): Record<string, unknown> {
	const copy = structuredClone(schema) as Record<string, unknown>;
	const required: string[] = [];
	const originalRequired = Array.isArray(schema.required) ? schema.required : [];
	const properties = isPlainObject(copy.properties) ? copy.properties : {};

	for (const [key, fieldSchema] of Object.entries(properties)) {
		if (!originalRequired.includes(key)) continue;
		if (isPlainObject(fieldSchema) && fieldSchema.default !== undefined) continue;
		required.push(key);
		if (isPlainObject(fieldSchema) && fieldSchema.type === 'array') {
			const minItems = typeof fieldSchema.minItems === 'number' ? fieldSchema.minItems : 0;
			fieldSchema.minItems = Math.max(1, minItems);
		}
	}

	copy.required = required;
	delete copy.$schema;
	return copy;
}

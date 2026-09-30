/**
 * Which input schema a build carries, resolved from the version's pushed `sourceFiles`
 * (`actor-driver.md`'s "Input schema, validation and defaults").
 *
 * The candidate order is `apify-cli`'s own `readInputSchema`, so a developer's local
 * `apify validate-schema` and this build agree on which file is the Actor's schema. Case-insensitive
 * matching is why the CLI's four candidates collapse to the two here.
 */
import JSON5 from 'json5';
import ajv2019Package from 'ajv/dist/2019.js';
import { validateInputSchema } from '@apify/input_schema';

import type { InputSchema, SourceFile } from '../storage/entities.js';
import {
	ACTOR_DIR,
	actorFilePath,
	escapesActorRootMessage,
	findCaseInsensitive,
	indexSourceFiles,
	parseActorJson,
	resolveActorJsonPathField,
	sourceFileToText,
	type IndexedFile,
} from './actor-source-files.js';

// AJV ships as CommonJS, so under this package's ESM resolution its class arrives as the module's
// `default`. `2019` is the build with draft-2019-09 support, which the Apify input-schema meta-schema
// requires and the plain build lacks.
const Ajv2019 = ajv2019Package.default;

/** Checked case-insensitively, so the `INPUT_SCHEMA.json` spelling matches these too. */
const DEFAULT_SCHEMA_CANDIDATES = [`${ACTOR_DIR}/input_schema.json`, 'input_schema.json'] as const;

/** Why resolution failed. Each one fails the build: an Actor whose declared input contract cannot be
 * read must not be built with that contract silently dropped. */
export type InputSchemaResolutionFailureReason =
	| 'escapes-actor-root'
	| 'missing-input-schema'
	| 'invalid-input-field'
	| 'unparseable-actor-json'
	| 'unparseable-input-schema'
	| 'invalid-input-schema';

/** `none` means the Actor declares no input schema, which is not an error. */
export type InputSchemaResolution =
	| { outcome: 'resolved'; schema: InputSchema; source: string; logLines: string[] }
	| { outcome: 'none'; logLines: string[] }
	| { outcome: 'failure'; reason: InputSchemaResolutionFailureReason; message: string };

/**
 * `null` for a valid input schema, the defect otherwise. Runs at build time, so a broken schema is
 * reported where the developer is already looking rather than silently at every later run.
 */
export function describeInputSchemaDefect(schema: unknown): string | null {
	if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
		return 'Input schema must be an object.';
	}
	try {
		// A fresh instance per call: AJV never evicts its internal compiled-schema map, and this runs
		// once per build, not per request.
		const ajv = new Ajv2019({ strict: false, unicodeRegExp: false });
		// `validateInputSchema` normalizes in place, so it must not get the stored schema itself.
		validateInputSchema(ajv, structuredClone(schema) as Record<string, unknown>);
		return null;
	} catch (error) {
		return (error as Error).message;
	}
}

/** One place, so an inline `input` object and a schema file are held to the same standard. */
function acceptSchema(schema: unknown, source: string, logLines: string[]): InputSchemaResolution {
	const defect = describeInputSchemaDefect(schema);
	if (defect) {
		return {
			outcome: 'failure',
			reason: 'invalid-input-schema',
			message: `Input schema from ${source} is not valid: ${defect}`,
		};
	}
	return {
		outcome: 'resolved',
		schema: schema as InputSchema,
		source,
		logLines: [...logLines, `Using the input schema from ${source}.\n`],
	};
}

function acceptSchemaFile(match: IndexedFile, source: string, logLines: string[]): InputSchemaResolution {
	let parsed: unknown;
	try {
		parsed = JSON5.parse(sourceFileToText(match.file));
	} catch (error) {
		return {
			outcome: 'failure',
			reason: 'unparseable-input-schema',
			message: `Could not parse the input schema "${match.normalizedName}": ${(error as Error).message}`,
		};
	}
	return acceptSchema(parsed, source, logLines);
}

/** `actorPath`: see `actor-source-files.ts`. The default locations are relative to the Actor's folder. */
export function resolveInputSchemaLocation(sourceFiles: SourceFile[], actorPath = ''): InputSchemaResolution {
	const indexed = indexSourceFiles(sourceFiles);
	const logLines: string[] = [];

	const actorJson = parseActorJson(sourceFiles, actorPath);
	if (actorJson.outcome === 'unparseable') {
		return { outcome: 'failure', reason: 'unparseable-actor-json', message: actorJson.message };
	}
	const specification = actorJson.outcome === 'parsed' ? actorJson.specification : undefined;

	if (specification !== null && typeof specification === 'object' && 'input' in specification) {
		const field: unknown = specification.input;

		// An inline schema, the other shape the Actor specification allows for this field.
		if (field !== null && typeof field === 'object' && !Array.isArray(field)) {
			return acceptSchema(field, 'the "input" field in .actor/actor.json', logLines);
		}

		if (typeof field !== 'string') {
			return {
				outcome: 'failure',
				reason: 'invalid-input-field',
				message: '.actor/actor.json has invalid format: "input" must be a string or an object.',
			};
		}

		// Exact case, and no fallback when it is missing: the platform reads it as a path, and fails the build.
		const resolved = resolveActorJsonPathField(indexed, field, actorPath, true);
		if (resolved.outcome === 'escapes-actor-root') {
			return {
				outcome: 'failure',
				reason: 'escapes-actor-root',
				message: escapesActorRootMessage(field, 'Input schema'),
			};
		}
		if (resolved.outcome === 'match') {
			const source = `"${resolved.file.normalizedName}" (the "input" field in .actor/actor.json)`;
			return acceptSchemaFile(resolved.file, source, logLines);
		}
		// An empty field names no file, and the platform goes on to the default locations.
		if (field !== '') {
			return {
				outcome: 'failure',
				reason: 'missing-input-schema',
				message: `Schema property "input": File "${resolved.shownPath}" does not exist!`,
			};
		}
	}

	for (const candidate of DEFAULT_SCHEMA_CANDIDATES) {
		const match = findCaseInsensitive(indexed, actorFilePath(actorPath, candidate));
		if (match) return acceptSchemaFile(match, `"${match.normalizedName}"`, logLines);
	}

	return { outcome: 'none', logLines };
}

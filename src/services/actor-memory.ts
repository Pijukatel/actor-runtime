/**
 * The memory fields of `.actor/actor.json` - `defaultMemoryMbytes`, `minMemoryMbytes`, `maxMemoryMbytes` -
 * read at build time and applied at run start, in the platform's order: the caller's `memory`, else the
 * Actor's default expression, then clamped to the Actor's bounds.
 */
import { calculateRunDynamicMemory, type ActorRunOptions } from '@apify/actor-memory-expression';

import type { ActorMemorySettings, SourceFile } from '../storage/entities.js';
import { parseActorJson } from './actor-source-files.js';

/** The bounds `@apify/json_schemas`' `actor.schema.json` puts on each numeric memory field. */
const MIN_MEMORY_MBYTES = 128;
const MAX_MEMORY_MBYTES = 32_768;

export type ActorMemoryResolution =
	{ outcome: 'resolved'; settings: ActorMemorySettings | undefined } | { outcome: 'failure'; message: string };

function isMemoryMbytes(value: unknown): value is number {
	return Number.isInteger(value) && (value as number) >= MIN_MEMORY_MBYTES && (value as number) <= MAX_MEMORY_MBYTES;
}

function invalidField(field: string, expected: string): ActorMemoryResolution {
	return { outcome: 'failure', message: `.actor/actor.json has invalid format: "${field}" must be ${expected}.` };
}

export function resolveActorMemorySettings(sourceFiles: SourceFile[], actorPath = ''): ActorMemoryResolution {
	const actorJson = parseActorJson(sourceFiles, actorPath);
	if (actorJson.outcome === 'unparseable') return { outcome: 'failure', message: actorJson.message };
	if (actorJson.outcome === 'absent') return { outcome: 'resolved', settings: undefined };
	const specification = actorJson.specification;
	if (typeof specification !== 'object' || specification === null)
		return { outcome: 'resolved', settings: undefined };

	const { defaultMemoryMbytes, minMemoryMbytes, maxMemoryMbytes } = specification as Record<string, unknown>;
	const bounds = `an integer from ${MIN_MEMORY_MBYTES} to ${MAX_MEMORY_MBYTES}`;
	const settings: ActorMemorySettings = {};
	if (minMemoryMbytes !== undefined) {
		if (!isMemoryMbytes(minMemoryMbytes)) return invalidField('minMemoryMbytes', bounds);
		settings.minMemoryMbytes = minMemoryMbytes;
	}
	if (maxMemoryMbytes !== undefined) {
		if (!isMemoryMbytes(maxMemoryMbytes)) return invalidField('maxMemoryMbytes', bounds);
		settings.maxMemoryMbytes = maxMemoryMbytes;
	}
	if (defaultMemoryMbytes !== undefined) {
		if (typeof defaultMemoryMbytes !== 'string' && !isMemoryMbytes(defaultMemoryMbytes)) {
			return invalidField('defaultMemoryMbytes', `a memory expression string or ${bounds}`);
		}
		settings.defaultMemoryMbytes = defaultMemoryMbytes;
	}
	return { outcome: 'resolved', settings: Object.keys(settings).length > 0 ? settings : undefined };
}

export interface RunMemoryContext {
	/** The caller's `memory`; takes precedence over `defaultMemoryMbytes` but is still clamped. */
	requestedMemoryMbytes: number | undefined;
	/** Used when neither the caller nor the Actor sets a memory, and when the expression fails. */
	fallbackMemoryMbytes: number;
	/** What the expression sees as `runOptions`; its `memoryMbytes` is the fallback, as on the platform. */
	runOptions: Omit<ActorRunOptions, 'memoryMbytes'>;
	input: { body: Buffer; contentType: string } | undefined;
}

export interface RunMemory {
	memoryMbytes: number;
	logLines: string[];
}

export async function resolveRunMemory(
	settings: ActorMemorySettings | undefined,
	context: RunMemoryContext,
): Promise<RunMemory> {
	const logLines: string[] = [];
	let memoryMbytes = context.requestedMemoryMbytes ?? context.fallbackMemoryMbytes;

	const defaultMemoryMbytes = settings?.defaultMemoryMbytes;
	if (context.requestedMemoryMbytes === undefined && defaultMemoryMbytes !== undefined) {
		try {
			const body = context.input?.body.toString('utf8');
			memoryMbytes = await calculateRunDynamicMemory(String(defaultMemoryMbytes), {
				runOptions: { ...context.runOptions, memoryMbytes: context.fallbackMemoryMbytes },
				input: body ? (JSON.parse(body) as Record<string, unknown>) : {},
			});
		} catch (error) {
			// The platform falls back the same way, but silently - locally the Actor's author is the one reading.
			logLines.push(
				`Warning: could not evaluate "defaultMemoryMbytes" from .actor/actor.json ` +
					`(${(error as Error).message}); running with ${context.fallbackMemoryMbytes} MB instead.`,
			);
		}
	}

	// `min` wins over `max` when the two contradict, as in the platform's own clamp.
	const unclamped = memoryMbytes;
	const { minMemoryMbytes, maxMemoryMbytes } = settings ?? {};
	if (minMemoryMbytes !== undefined && memoryMbytes < minMemoryMbytes) memoryMbytes = minMemoryMbytes;
	else if (maxMemoryMbytes !== undefined && memoryMbytes > maxMemoryMbytes) memoryMbytes = maxMemoryMbytes;
	if (memoryMbytes !== unclamped) {
		const bound = memoryMbytes === minMemoryMbytes ? 'minMemoryMbytes' : 'maxMemoryMbytes';
		logLines.push(`Memory of ${unclamped} MB adjusted to ${memoryMbytes} MB by "${bound}" in .actor/actor.json.`);
	}
	return { memoryMbytes, logLines };
}

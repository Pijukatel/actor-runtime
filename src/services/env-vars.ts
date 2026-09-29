import { createHash } from 'node:crypto';

import type { ActorEnvVarRecord, ActorVersionRecord } from '../storage/entities.js';

/** The platform's own limits (`@apify-packages/actor`'s `EnvVarSchema`). */
const MAX_NAME_LENGTH = 100;
const MAX_VALUE_LENGTH = 50_000;

export type EnvVarValidation<T> = { kind: 'ok'; value: T } | { kind: 'invalid'; message: string };

export function validateEnvVar(raw: unknown): EnvVarValidation<ActorEnvVarRecord> {
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
		return { kind: 'invalid', message: 'Environment variable must be an object' };
	}
	const { name, value, isSecret } = raw as Record<string, unknown>;
	if (typeof name !== 'string' || name.length === 0 || name.length > MAX_NAME_LENGTH) {
		return {
			kind: 'invalid',
			message: `Environment variable "name" must be a string of 1 to ${MAX_NAME_LENGTH} characters`,
		};
	}
	if (name.includes('=')) {
		return { kind: 'invalid', message: `Environment variable name "${name}" must not contain "="` };
	}
	if (typeof value !== 'string' || value.length > MAX_VALUE_LENGTH) {
		return {
			kind: 'invalid',
			message: `Environment variable "${name}" must have a string "value" of at most ${MAX_VALUE_LENGTH} characters`,
		};
	}
	if (isSecret !== undefined && isSecret !== null && typeof isSecret !== 'boolean') {
		return { kind: 'invalid', message: `Environment variable "${name}" has a non-boolean "isSecret"` };
	}
	return { kind: 'ok', value: { name, value, ...(typeof isSecret === 'boolean' ? { isSecret } : {}) } };
}

/** `undefined` passes through, so a version body that does not mention `envVars` keeps meaning "unchanged". */
export function validateEnvVars(raw: unknown): EnvVarValidation<ActorEnvVarRecord[] | undefined> {
	if (raw === undefined || raw === null) return { kind: 'ok', value: undefined };
	if (!Array.isArray(raw)) return { kind: 'invalid', message: '"envVars" must be an array' };
	const envVars: ActorEnvVarRecord[] = [];
	for (const entry of raw) {
		const result = validateEnvVar(entry);
		if (result.kind === 'invalid') return result;
		envVars.push(result.value);
	}
	return { kind: 'ok', value: envVars };
}

/**
 * What the API shows for an env var. A secret loses its value, as on the platform; `withValueHash` adds
 * the platform's short `valueHash` (the version endpoints do, the env-var endpoints do not) so a client
 * can tell a changed secret from an unchanged one.
 */
export function publicEnvVar(
	envVar: ActorEnvVarRecord,
	withValueHash: boolean,
): Omit<ActorEnvVarRecord, 'value'> & { value?: string; valueHash?: string } {
	if (!envVar.isSecret) return envVar;
	const { value, ...rest } = envVar;
	return withValueHash ? { ...rest, valueHash: createHash('sha256').update(value).digest('hex').slice(0, 6) } : rest;
}

/** The Docker build arguments for a version's build; `undefined` unless `applyEnvVarsToBuild` is on. */
export function buildArgsOf(version: ActorVersionRecord): Record<string, string> | undefined {
	if (!version.applyEnvVarsToBuild || !version.envVars?.length) return undefined;
	return Object.fromEntries(version.envVars.map((envVar) => [envVar.name, envVar.value]));
}

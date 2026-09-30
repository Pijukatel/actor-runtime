import type { ActorEnvVarRecord, ActorRecord, ActorVersionRecord } from '../storage/entities.js';
import { decryptedEnvVars } from './secrets.js';

/** The platform's own limits (`@apify-packages/actor`'s `EnvVarSchema` and the version's `envVars`). */
const MAX_NAME_LENGTH = 100;
const MAX_VALUE_LENGTH = 50_000;
const MAX_ENV_VARS = 100;

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
	if (raw.length > MAX_ENV_VARS) {
		return { kind: 'invalid', message: `A version can have at most ${MAX_ENV_VARS} environment variables` };
	}
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
 * the platform's short `valueHash` - the start of the sealed value, so it changes whenever the secret is
 * set again (the version endpoints show it, the env-var endpoints do not).
 */
export function publicEnvVar(envVar: ActorEnvVarRecord, withValueHash: boolean) {
	if (!envVar.isSecret) {
		return { name: envVar.name, value: envVar.value, ...(envVar.isSecret === false ? { isSecret: false } : {}) };
	}
	return { name: envVar.name, isSecret: true, ...(withValueHash ? { valueHash: envVar.value.slice(0, 6) } : {}) };
}

/** The Docker build arguments for a version's build, secrets decrypted; `undefined` unless
 * `applyEnvVarsToBuild` is on. */
export function buildArgsOf(actor: ActorRecord, version: ActorVersionRecord): Record<string, string> | undefined {
	if (!version.applyEnvVarsToBuild || !version.envVars?.length) return undefined;
	return Object.fromEntries(decryptedEnvVars(actor, version.envVars).map((envVar) => [envVar.name, envVar.value]));
}

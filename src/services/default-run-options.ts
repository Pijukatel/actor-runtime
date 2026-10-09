/**
 * An Actor's `defaultRunOptions`: the platform's field set, defaults and validation rules (apify-core's
 * `ActorRunOptionsSchema`). They apply to a run whenever its caller leaves the matching option out.
 */
import type { ActorDefaultRunOptionsRecord, ActorRecord } from '../storage/entities.js';
import { DEFAULT_BUILD_TAG } from './actors.js';

export const DEFAULT_RUN_OPTIONS: ActorDefaultRunOptionsRecord = {
	build: DEFAULT_BUILD_TAG,
	timeoutSecs: 300,
	memoryMbytes: 1024,
};

const MIN_MEMORY_MBYTES = 128;
const MAX_MEMORY_MBYTES = 32_768;
const MAX_TIMEOUT_SECS = 999_999_999;
const BUILD_TAG_MAX_LENGTH = 30;
/** `@apify/consts`' `DNS_SAFE_NAME_REGEX`. */
const DNS_SAFE_NAME_REGEX = /^([a-zA-Z0-9]|[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9])$/;
const BUILD_NUMBER_REGEX = /^(\d{1,2})\.(\d{1,2})\.(\d{1,5})$/;
const PERMISSION_LEVELS = ['LIMITED_PERMISSIONS', 'FULL_PERMISSIONS'];
const OPTIONAL_FIELDS = ['maxTotalChargeUsd', 'maxItems', 'restartOnError', 'forcePermissionLevel'] as const;

export type DefaultRunOptionsUpdateResult =
	{ kind: 'ok'; defaultRunOptions: ActorDefaultRunOptionsRecord } | { kind: 'invalid'; message: string };

export function defaultRunOptionsOf(actor: ActorRecord): ActorDefaultRunOptionsRecord {
	return { ...DEFAULT_RUN_OPTIONS, ...actor.defaultRunOptions };
}

function isBuild(value: unknown): boolean {
	if (typeof value !== 'string') return false;
	const number = BUILD_NUMBER_REGEX.exec(value);
	if (number) return Number(number[3]) > 0;
	return DNS_SAFE_NAME_REGEX.test(value) && value.length <= BUILD_TAG_MAX_LENGTH;
}

function isNonNegativeNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function fieldError(key: string, rule: string): DefaultRunOptionsUpdateResult {
	return { kind: 'invalid', message: `defaultRunOptions.${key} ${rule}` };
}

/**
 * Merges `raw` over `current` (itself over the defaults), as the platform does for both create and a
 * partial update, then validates the result. An optional field set to `null` is cleared.
 */
export function mergeDefaultRunOptionsUpdate(
	raw: unknown,
	current: ActorDefaultRunOptionsRecord | undefined,
): DefaultRunOptionsUpdateResult {
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
		return { kind: 'invalid', message: '"defaultRunOptions" must be an object' };
	}
	const merged: ActorDefaultRunOptionsRecord = { ...DEFAULT_RUN_OPTIONS, ...current };
	for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
		if (value === undefined) continue;
		if (value === null && (OPTIONAL_FIELDS as readonly string[]).includes(key)) {
			delete merged[key as (typeof OPTIONAL_FIELDS)[number]];
			continue;
		}
		switch (key) {
			case 'build':
				// The platform's own message for this rule.
				if (!isBuild(value)) {
					return {
						kind: 'invalid',
						message: 'This value must be either a build tag or number, e.g. "latest" or "1.2.34".',
					};
				}
				merged.build = value as string;
				break;
			case 'timeoutSecs':
				if (!isNonNegativeNumber(value) || value > MAX_TIMEOUT_SECS) {
					return fieldError(key, `must be a number from 0 to ${MAX_TIMEOUT_SECS}`);
				}
				merged.timeoutSecs = value;
				break;
			case 'memoryMbytes':
				if (
					typeof value !== 'number' ||
					!Number.isInteger(value) ||
					value < MIN_MEMORY_MBYTES ||
					value > MAX_MEMORY_MBYTES
				) {
					return fieldError(key, `must be an integer from ${MIN_MEMORY_MBYTES} to ${MAX_MEMORY_MBYTES}`);
				}
				if (!Number.isInteger(Math.log2(value))) {
					return {
						kind: 'invalid',
						message: 'Memory needs to be a power of two, like 512, 1024, 2048, 4096, etc.',
					};
				}
				merged.memoryMbytes = value;
				break;
			case 'maxTotalChargeUsd':
				if (!isNonNegativeNumber(value)) return fieldError(key, 'must be a number >= 0');
				merged.maxTotalChargeUsd = value;
				break;
			case 'maxItems':
				if (!isNonNegativeNumber(value) || !Number.isInteger(value)) {
					return fieldError(key, 'must be an integer >= 0');
				}
				merged.maxItems = value;
				break;
			case 'restartOnError':
				if (typeof value !== 'boolean') return fieldError(key, 'must be a boolean');
				merged.restartOnError = value;
				break;
			case 'forcePermissionLevel':
				if (typeof value !== 'string' || !PERMISSION_LEVELS.includes(value)) {
					return fieldError(key, `must be one of ${PERMISSION_LEVELS.join(', ')}`);
				}
				merged.forcePermissionLevel = value;
				break;
			// Server-maintained on the platform; a client echoing an Actor back sends it.
			case 'isMaxTotalChargeUsdSetByUser':
				break;
			default:
				return { kind: 'invalid', message: `defaultRunOptions.${key} is not allowed by the schema` };
		}
	}
	return { kind: 'ok', defaultRunOptions: merged };
}

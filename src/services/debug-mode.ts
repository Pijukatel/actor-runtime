/**
 * Per-Actor debug mode (`actor-driver.md`'s "Debug mode" section). `setDebugMode` is the single
 * validate-and-persist entry point shared by the API route and the console form. `resolveDebugPlan`
 * is pure - no Docker or registry access - so it's unit-testable on its own.
 */
import type { ActorLocalDebug, ActorRecord, DebugLanguage, DebugLanguagePreference } from '../storage/entities.js';
import { getRegistries } from '../storage/registries.js';
import type { InspectedDebugTarget } from '../driver/types.js';

const ALLOWED_FIELDS = ['enabled', 'language', 'port'] as const;
const ALLOWED_LANGUAGES: readonly DebugLanguagePreference[] = ['auto', 'node', 'python'];
const MIN_PORT = 1024;
const MAX_PORT = 65535;

/** Default port per language, applied once a run's language actually resolves - not at toggle time,
 * when `language: 'auto'` may still be unresolved. */
export const DEFAULT_PORT_BY_LANGUAGE: Record<DebugLanguage, number> = { python: 5678, node: 9229 };

/** Toggle-time display port for an unresolved `language: 'auto'` - a nominal placeholder only. The
 * actual port is decided fresh at run start by `resolveDebugPlan`. */
const DISPLAY_DEFAULT_PORT_FOR_AUTO = DEFAULT_PORT_BY_LANGUAGE.python;

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validation result; `message` is reused verbatim by the API's 400 response and the console's inline error. */
export type ValidatedDebugModeBody =
	| { kind: 'ok'; enabled: boolean; language: DebugLanguagePreference; port?: number }
	| { kind: 'invalid'; message: string };

/** Strict-object body validation only; never touches the registry - `setDebugMode` below does that. */
export function validateDebugModeBody(body: unknown): ValidatedDebugModeBody {
	if (!isPlainObject(body)) {
		return { kind: 'invalid', message: 'Request body must be a JSON object' };
	}

	const unknownKey = Object.keys(body).find((key) => !(ALLOWED_FIELDS as readonly string[]).includes(key));
	if (unknownKey) {
		return {
			kind: 'invalid',
			message: `Unknown field "${unknownKey}" - allowed fields are "enabled", "language", "port".`,
		};
	}

	if (typeof body.enabled !== 'boolean') {
		return { kind: 'invalid', message: '"enabled" must be a boolean' };
	}

	if (
		body.language !== undefined &&
		(typeof body.language !== 'string' || !ALLOWED_LANGUAGES.includes(body.language as DebugLanguagePreference))
	) {
		return { kind: 'invalid', message: '"language" must be one of "auto", "node", "python"' };
	}

	if (body.port !== undefined) {
		if (
			typeof body.port !== 'number' ||
			!Number.isInteger(body.port) ||
			body.port < MIN_PORT ||
			body.port > MAX_PORT
		) {
			return { kind: 'invalid', message: `"port" must be an integer between ${MIN_PORT} and ${MAX_PORT}` };
		}
	}

	return {
		kind: 'ok',
		enabled: body.enabled,
		language: (body.language as DebugLanguagePreference | undefined) ?? 'auto',
		port: body.port as number | undefined,
	};
}

async function writeLocalDebug(actorId: string, localDebug: ActorLocalDebug | undefined): Promise<ActorRecord | null> {
	return getRegistries().actors.update(actorId, (current) => (current ? { ...current, localDebug } : current));
}

export type SetDebugModeResult = { kind: 'ok'; actor: ActorRecord } | { kind: 'invalid'; message: string };

/**
 * Single validate-and-persist path for both the API and console form. Enabling fully replaces
 * `localDebug` - an omitted field resets to its default rather than keeping its prior value. Writes
 * bypass `services/actors.ts: updateActor`, so toggling debug mode never bumps `modifiedAt`.
 */
export async function setDebugMode(actor: ActorRecord, rawBody: unknown): Promise<SetDebugModeResult> {
	const parsed = validateDebugModeBody(rawBody);
	if (parsed.kind === 'invalid') return parsed;

	if (!parsed.enabled) {
		if (!actor.localDebug) return { kind: 'ok', actor };
		const updated = await writeLocalDebug(actor.id, undefined);
		return { kind: 'ok', actor: updated ?? { ...actor, localDebug: undefined } };
	}

	const localDebug: ActorLocalDebug = {
		language: parsed.language,
		...(parsed.port !== undefined ? { port: parsed.port } : {}),
	};
	const updated = await writeLocalDebug(actor.id, localDebug);
	return { kind: 'ok', actor: updated ?? { ...actor, localDebug } };
}

export interface DebugStatus {
	/** `null` when debug mode is off (never toggled on, or explicitly cleared) for this Actor. */
	localDebug: { language: DebugLanguagePreference; port: number } | null;
}

/** Read-back shared by the API's toggle response and the console detail page (there is no separate `GET`).
 * An explicit non-`'auto'` language shows its own default port; unresolved `'auto'` shows the nominal
 * placeholder. */
export function debugStatus(actor: Pick<ActorRecord, 'localDebug'>): DebugStatus {
	if (!actor.localDebug) return { localDebug: null };
	const { language, port } = actor.localDebug;
	const displayDefaultPort = language === 'auto' ? DISPLAY_DEFAULT_PORT_FOR_AUTO : DEFAULT_PORT_BY_LANGUAGE[language];
	return { localDebug: { language, port: port ?? displayDefaultPort } };
}

// --- Run-start language resolution --------------------------------------------------------------

/** Env additions for a resolved plan. Node: `NODE_OPTIONS` (prepended, never replacing). Python:
 * `PYTHONPATH` (same prepend) plus `DEBUGPY_PORT_ENV_VAR`. Merged in `services/runs.ts: buildEnv` after
 * every platform-owned var, so a debug run can never shadow one. */
export interface DebugPlan {
	language: DebugLanguage;
	port: number;
	env: Record<string, string>;
}

export type ResolveDebugPlanResult =
	| { kind: 'plan'; plan: DebugPlan }
	| { kind: 'refused'; reason: 'package-manager'; command: string }
	| { kind: 'refused'; reason: 'unclassifiable' };

/** In-container path for the debugpy payload (built by `Dockerfile`'s debug stage); prepended onto
 * `PYTHONPATH` so CPython's `site` module imports `sitecustomize.py` before user code runs. */
export const PYTHON_DEBUG_PAYLOAD_DIR = '/opt/apify-debug';

/** Env var `docker/sitecustomize.py` reads its listen port from. The name is a contract with that file -
 * it can't import this module, so its own copy of the string must match verbatim. */
export const DEBUGPY_PORT_ENV_VAR = 'APIFY_ACTOR_RUNTIME_DEBUG_PORT';

/** Join convention for env keys that are lists of prepended values (`NODE_OPTIONS` space, `PYTHONPATH`
 * colon). A key absent here has no such convention - `prependDebugEnvValue` overwrites it outright. */
const ENV_LIST_SEPARATOR: Partial<Record<string, string>> = { NODE_OPTIONS: ' ', PYTHONPATH: ':' };

/** Prepends a debug value onto an existing value for the same env key from another source (the build
 * image's baked-in env, or an Actor version's `envVars`) - shared so both call sites use the identical
 * join discipline. */
export function prependDebugEnvValue(key: string, debugValue: string, existingValue: string | undefined): string {
	if (!existingValue) return debugValue;
	const separator = ENV_LIST_SEPARATOR[key];
	return separator !== undefined ? `${debugValue}${separator}${existingValue}` : debugValue;
}

const PYTHON_ARGV_TOKEN = /^python3?(\.\d+)?$/;
const NODE_ARGV_TOKENS = new Set(['node', 'tsx', 'ts-node']);
const PACKAGE_MANAGER_ARGV_TOKENS = new Set(['npm', 'yarn', 'pnpm']);

/** Flattens entrypoint+cmd into words, splitting each element on whitespace - a shell-form command
 * (`['/bin/sh', '-c', 'python3 -m src']`) puts multiple tokens in one array element. */
function argvWords(target: InspectedDebugTarget): string[] {
	const elements = [...(target.entrypoint ?? []), ...(target.cmd ?? [])];
	return elements.flatMap((element) => element.split(/\s+/)).filter((word) => word.length > 0);
}

type LanguageDetection =
	{ language: DebugLanguage } | { reason: 'package-manager'; command: string } | { reason: 'unclassifiable' };

/**
 * `language: 'auto'` detection, most specific first: exact python/node argv token, then a package-manager
 * launcher refusal - checked before the env fingerprint, since a custom base image built from upstream
 * `node` (unlike `apify/actor-node`) sets `NODE_VERSION` even under npm, which would otherwise
 * misclassify. The fingerprint is the last resort; no current Apify image sets it, so an Apify image with
 * no argv signal fails safely as unclassifiable rather than guessing.
 */
function detectLanguage(target: InspectedDebugTarget): LanguageDetection {
	const words = argvWords(target);
	if (words.some((word) => PYTHON_ARGV_TOKEN.test(word))) return { language: 'python' };
	if (words.some((word) => NODE_ARGV_TOKENS.has(word))) return { language: 'node' };

	const managerIndex = words.findIndex((word) => PACKAGE_MANAGER_ARGV_TOKENS.has(word));
	if (managerIndex !== -1) {
		return { reason: 'package-manager', command: words.slice(managerIndex, managerIndex + 2).join(' ') };
	}

	if (target.env.PYTHON_VERSION) return { language: 'python' };
	if (target.env.NODE_VERSION) return { language: 'node' };
	return { reason: 'unclassifiable' };
}

/** Turns a stored preference + inspected target into a `DebugPlan` or a classified refusal. An explicit
 * `language` override skips detection (and its refusals) entirely - those apply only to `'auto'`. */
export function resolveDebugPlan(localDebug: ActorLocalDebug, target: InspectedDebugTarget): ResolveDebugPlanResult {
	let language: DebugLanguage;
	if (localDebug.language !== 'auto') {
		language = localDebug.language;
	} else {
		const detected = detectLanguage(target);
		if ('reason' in detected) {
			return detected.reason === 'package-manager'
				? { kind: 'refused', reason: 'package-manager', command: detected.command }
				: { kind: 'refused', reason: 'unclassifiable' };
		}
		language = detected.language;
	}

	const port = localDebug.port ?? DEFAULT_PORT_BY_LANGUAGE[language];

	if (language === 'node') {
		const value = prependDebugEnvValue('NODE_OPTIONS', `--inspect-brk=0.0.0.0:${port}`, target.env.NODE_OPTIONS);
		return { kind: 'plan', plan: { language, port, env: { NODE_OPTIONS: value } } };
	}

	const pythonPath = prependDebugEnvValue('PYTHONPATH', PYTHON_DEBUG_PAYLOAD_DIR, target.env.PYTHONPATH);
	return {
		kind: 'plan',
		plan: { language, port, env: { PYTHONPATH: pythonPath, [DEBUGPY_PORT_ENV_VAR]: String(port) } },
	};
}

/** Refusal text for a non-debuggable image (`actor-driver.md`'s "Non-debuggable images" section). Returns
 * the bare reason with no `Cannot start run: ` prefix - `services/runs.ts` adds that at its call site.
 * `port` is the Actor's current stored override, threaded through so the suggested command doesn't
 * silently reset it (`setDebugMode` is full-replace). */
export function describeDebugRefusal(
	actorId: string,
	port: number | undefined,
	result: Extract<ResolveDebugPlanResult, { kind: 'refused' }>,
): string {
	const clearCommand = `apify api POST /actor-runtime/debug/${actorId} --body '{"enabled": false}'`;
	if (result.reason === 'package-manager') {
		const manager = result.command.split(' ')[0];
		return (
			`debug mode is on for this Actor, but its image starts the Actor through ` +
			`\`${result.command}\`. Node's --inspect-brk would attach to ${manager}, not to your Actor. Change ` +
			`the image's CMD to invoke \`node\` directly (e.g. CMD ["node", "dist/main.js"]), or clear debug ` +
			`mode with ${clearCommand}.`
		);
	}
	const portField = port !== undefined ? `, "port": ${port}` : '';
	return (
		`debug mode is on for this Actor with language "auto", but its image's command ` +
		`could not be classified as Python or Node. Set an explicit language with ` +
		`\`apify api POST /actor-runtime/debug/${actorId} --body '{"enabled": true, "language": "node"${portField}}'\` ` +
		`(or "python"), or clear debug mode with ${clearCommand}.`
	);
}

/** Message for a debug run whose host port is already bound - built from the driver's
 * `DebugPortInUseError` (`driver/types.ts`) after `container.start()` fails. Names the Actor's stored
 * `language` preference, not the run's resolved language, so the suggested command preserves it. */
export function describeDebugPortConflict(
	actorId: string,
	languagePreference: DebugLanguagePreference,
	port: number,
): string {
	return (
		`Host port ${port} is already in use. Stop whatever is using it, or set a different port with ` +
		`\`apify api POST /actor-runtime/debug/${actorId} --body '{"enabled": true, "language": ` +
		`"${languagePreference}", "port": <n>}'\`.`
	);
}

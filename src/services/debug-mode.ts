/**
 * Per-Actor debug mode (`actor-driver.md`'s "Debug mode" section): one validate-and-persist entry point
 * (`setDebugMode`) shared by the API's `POST /actor-runtime/debug/:actorId` (`api/routes/debug-mode.ts`)
 * and the console's three-field form (`console/server.ts`) - the exact `dev-folder.ts` split, just with
 * a strict-object body instead of a JSON string. This module also carries the run-start language
 * resolution (`resolveDebugPlan`), which needs no Docker and no registry access of its own - it is a
 * pure function over the toggle's stored preference and whatever `Driver.inspectDebugTarget` read off
 * the resolved build's image, so it is unit-testable with no stub Docker daemon at all.
 */
import type { ActorLocalDebug, ActorRecord, DebugLanguage, DebugLanguagePreference } from '../storage/entities.js';
import { getRegistries } from '../storage/registries.js';
import type { InspectedDebugTarget } from '../driver/types.js';

const ALLOWED_FIELDS = ['enabled', 'language', 'port'] as const;
const ALLOWED_LANGUAGES: readonly DebugLanguagePreference[] = ['auto', 'node', 'python'];
const MIN_PORT = 1024;
const MAX_PORT = 65535;

/** Language-specific default port, applied only once a run's language has actually resolved (never at
 * toggle time, when `language: 'auto'` may still be genuinely unresolved) - matches each ecosystem's
 * own IDE-default convention: 9229 is Node's own inspector default, 5678 is debugpy's. */
export const DEFAULT_PORT_BY_LANGUAGE: Record<DebugLanguage, number> = { python: 5678, node: 9229 };

/** The port a toggle-on response shows for an unresolved `language: 'auto'` when the caller didn't
 * override it - a nominal placeholder only (`api.md`'s own worked example), never a claim about what a
 * future run will actually publish: that is decided fresh at run start, from whichever language
 * *actually* resolves (`resolveDebugPlan` below), which for `language: 'auto'` this toggle-time response
 * cannot yet know. An explicitly-stored `'node'`/`'python'` preference is not "unresolved" - its display
 * default is that language's own real default port (`DEFAULT_PORT_BY_LANGUAGE`), never this placeholder. */
const DISPLAY_DEFAULT_PORT_FOR_AUTO = DEFAULT_PORT_BY_LANGUAGE.python;

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Every way a submitted body can fail validation, as a human-readable message - shared verbatim by
 * both surfaces (the API route wraps it in its own `400 invalid-request`; the console shows it inline). */
export type ValidatedDebugModeBody =
	| { kind: 'ok'; enabled: boolean; language: DebugLanguagePreference; port?: number }
	| { kind: 'invalid'; message: string };

/**
 * Pure shape/field validation - strict object body (`api.md`'s pin): every key must be one of
 * `enabled`/`language`/`port`, `enabled` is required and must be a boolean, `language` (if present) must
 * be one of `auto`/`node`/`python`, and `port` (if present) must be an integer in `1024..65535`. Never
 * touches the registry - `setDebugMode` below is the only thing that does.
 */
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
 * The one validate-and-persist path both the API endpoint and the console form funnel through. Every
 * accepted call fully replaces the Actor's `localDebug` (or clears it outright for `enabled: false`) -
 * there is no partial-merge semantics here (unlike `services/api-fallback.ts`'s patch-style `POST`): a
 * field the body omits resets to its own default (`language: 'auto'`, no port override), it never
 * "stays whatever it was before". Writes go straight to the registry, bypassing `services/actors.ts:
 * updateActor` exactly like `dev-folder.ts: setDevFolder` does, so toggling debug mode never bumps the
 * Actor's `modifiedAt`.
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

/** The one value both the API's toggle response and the console detail page show - doubling as the
 * read-back this design has no separate `GET` for (`api.md`). When no `port` override is stored, the
 * displayed default is language-appropriate: `'node'` shows `9229`, `'python'` shows `5678`, and only a
 * genuinely unresolved `'auto'` falls back to the nominal `DISPLAY_DEFAULT_PORT_FOR_AUTO` placeholder -
 * an explicit non-`'auto'` preference is never shown Python's default just because the constant used to
 * be applied unconditionally. */
export function debugStatus(actor: Pick<ActorRecord, 'localDebug'>): DebugStatus {
	if (!actor.localDebug) return { localDebug: null };
	const { language, port } = actor.localDebug;
	const displayDefaultPort = language === 'auto' ? DISPLAY_DEFAULT_PORT_FOR_AUTO : DEFAULT_PORT_BY_LANGUAGE[language];
	return { localDebug: { language, port: port ?? displayDefaultPort } };
}

// --- Run-start language resolution --------------------------------------------------------------

/** The env entries a resolved plan adds to the run's container. A Node plan has exactly one key
 * (`NODE_OPTIONS`, prepended to - never replacing - whatever value the image itself already set for that
 * key). A Python plan has two: `PYTHONPATH` (same prepend discipline) plus `DEBUGPY_PORT_ENV_VAR`
 * (`APIFY_ACTOR_RUNTIME_DEBUG_PORT`), a single opaque value with no list-join convention of its own (see
 * `ENV_LIST_SEPARATOR` below), so it always wins outright rather than being prepended - which never
 * actually collides, since no version defines its own Apify-internal debug-port var. Merged into
 * `services/runs.ts: buildEnv`'s result *below* every platform-owned var, so a debug run can never
 * accidentally shadow a real platform contract var (there happens to be no overlap today, but the
 * ordering is the same precedence discipline version `envVars` already follow). */
export interface DebugPlan {
	language: DebugLanguage;
	port: number;
	env: Record<string, string>;
}

export type ResolveDebugPlanResult =
	| { kind: 'plan'; plan: DebugPlan }
	| { kind: 'refused'; reason: 'package-manager'; command: string }
	| { kind: 'refused'; reason: 'unclassifiable' };

/** In-container path the debugpy payload is injected at (`Dockerfile`'s debug-payload build stage) -
 * prepended onto `PYTHONPATH` for a Python debug run, so `sitecustomize.py` there is what CPython's
 * `site` module imports before any user module runs. */
export const PYTHON_DEBUG_PAYLOAD_DIR = '/opt/apify-debug';

/** The env var the injected `sitecustomize.py` (`docker/sitecustomize.py`) reads its listen port from -
 * set on every Python debug run's container env alongside `PYTHONPATH`. The exact name is a driver<->
 * payload contract: `docker/sitecustomize.py`'s own copy of this string must match verbatim (it has no
 * way to import this module - it runs inside the Actor's container, not the runtime's own process). */
export const DEBUGPY_PORT_ENV_VAR = 'APIFY_ACTOR_RUNTIME_DEBUG_PORT';

/** The list-joining separator each env var's own convention uses, for the (currently two) debug-plan env
 * keys that are themselves lists of prepended values rather than a single opaque value: `NODE_OPTIONS`
 * space-separates flags, `PYTHONPATH` colon-separates directories. A key with no entry here (the
 * debug-port var) has no such convention, so `prependDebugEnvValue` below cannot meaningfully combine two
 * values for it and the debug value wins outright - which never actually collides in practice, since no
 * version defines its own Apify-internal debug-port var. */
const ENV_LIST_SEPARATOR: Partial<Record<string, string>> = { NODE_OPTIONS: ' ', PYTHONPATH: ':' };

/**
 * Prepends a debug plan's own value for one of its env keys onto an existing value for the *same key from
 * a different source* - used twice, for two different "other sources": here in `resolveDebugPlan`, onto
 * the resolved build image's own baked-in `Config.Env` value; and in `services/runs.ts: buildEnv`, onto an
 * Actor version's own `envVars` entry of the same name. Both call sites need the identical prepend-not-
 * clobber discipline and the identical separator convention, so it lives here once rather than being
 * duplicated (and risking drift) at each call site.
 */
export function prependDebugEnvValue(key: string, debugValue: string, existingValue: string | undefined): string {
	if (!existingValue) return debugValue;
	const separator = ENV_LIST_SEPARATOR[key];
	return separator !== undefined ? `${debugValue}${separator}${existingValue}` : debugValue;
}

const PYTHON_ARGV_TOKEN = /^python3?(\.\d+)?$/;
const NODE_ARGV_TOKENS = new Set(['node', 'tsx', 'ts-node']);
const PACKAGE_MANAGER_ARGV_TOKENS = new Set(['npm', 'yarn', 'pnpm']);

/** Flattens `Config.Entrypoint` + `Config.Cmd` into individual words, splitting each argv element on
 * whitespace too - a shell-form command (`['/bin/sh', '-c', 'python3 -m src']`) arrives from the daemon
 * as one long string in a single array element, so a plain per-element match would miss the `python3`
 * token entirely without this. Order is entrypoint-then-cmd, mirroring how Docker actually composes the
 * real process argv when both are set. */
function argvWords(target: InspectedDebugTarget): string[] {
	const elements = [...(target.entrypoint ?? []), ...(target.cmd ?? [])];
	return elements.flatMap((element) => element.split(/\s+/)).filter((word) => word.length > 0);
}

type LanguageDetection =
	{ language: DebugLanguage } | { reason: 'package-manager'; command: string } | { reason: 'unclassifiable' };

/**
 * `language: 'auto'`'s own detection, most specific first: an exact `python`/`python3`(`.N`) argv token
 * wins outright, then an exact `node`/`tsx`/`ts-node` token. A package-manager launcher
 * (`npm`/`yarn`/`pnpm`) is checked **before** falling back to the base-image env fingerprint -
 * deliberately: a *custom* base image that happens to bake its own `NODE_VERSION` env (as the plain
 * upstream `node` Docker Hub image does, unlike any `apify/actor-node` image, which sets neither var -
 * verified via `docker image inspect`) would otherwise make an `npm start`-style command look identically
 * classifiable as `'node'`, which is exactly the broken case `actor-driver.md`'s "Non-debuggable images"
 * section exists to catch (`--inspect-brk` would attach to npm's own node process, never the Actor's).
 * Only once the argv itself offers no definitive signal at all - no interpreter token, no package-manager
 * token - does the env fingerprint (`PYTHON_VERSION` / `NODE_VERSION`) get to make the call; failing that
 * too, the image is genuinely unclassifiable. For any current Apify base image this fingerprint never
 * fires (neither var is present on one), so an Apify-based image with no argv signal reaches the
 * "unclassifiable" refusal instead - a safe failure, not a silent misclassification; the fingerprint
 * exists only for a custom base image built directly from the plain upstream `node`/`python` images.
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

/**
 * Turns a Debug toggle's stored preference plus an inspected build target into either a concrete
 * `DebugPlan` or a classified refusal - pure and unit-testable, exactly mirroring how `probeDevFolder`
 * probes but `setDevFolder` decides. An explicit `language` override (`'node'`/`'python'`) always wins
 * outright, skipping detection (and therefore the package-manager/unclassifiable refusals) entirely -
 * those refusals exist only for `'auto'`, where this function itself has to guess.
 */
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

/** The run-log / `statusMessage` text for a refused debug run (`actor-driver.md`'s "Non-debuggable images
 * fail the run, loudly" section) - named after the actual command for a package-manager refusal, and
 * naming the `language` override as the fix for an unclassifiable one (criterion 14). Both name the exact
 * `apify api` invocation that clears debug mode for this Actor. Returns the reason text only, with no
 * `Cannot start run: ` prefix - `services/runs.ts: failBeforeContainer` owns that prefix for every
 * pre-container failure, so it is never baked into this string too (previously it was, which is what let
 * this path's `statusMessage` and the driver-unavailable path's drift into two differently-prefixed
 * strings for the same kind of failure). `port` is the Actor's own currently-stored port override (if
 * any) - threaded through so the suggested `language` override below preserves it: `setDebugMode` is a
 * full-replace `POST` (its own doc comment), so a suggested body that omitted a stored `port` would
 * silently reset it to the newly-resolved language's own default the moment the developer runs it
 * verbatim. */
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

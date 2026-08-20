/**
 * Upstream API fallback (`api.md`'s "Upstream fallback" section): when a call locally misses - either
 * because nothing in this runtime serves the path/method at all, or because it does but the specific
 * record id doesn't exist - and the matching toggle is on, the request is replayed against the real
 * Apify platform instead of failing, and a successful reply's status/body/headers are relayed back
 * (see the response-header note on `attemptFallback` below - not every repeated header line survives
 * relay byte-for-byte, because the HTTP client this module uses does not hand back every repeated
 * upstream header as separate entries; `Set-Cookie` is the one name it always keeps separate, and is
 * the one name this module always preserves as separate lines for exactly that reason). Both toggles
 * default off and reset on every restart; this module is the only place either fact is read or written,
 * by the API route (`api/routes/api-fallback.ts`), the console's `/settings` page, and
 * `console/templates.ts: layout()`'s per-page state indicator alike.
 *
 * `attemptFallback` is the single seam both of `server.ts`'s local-miss sites (the terminal catch-all
 * and the generic error middleware) call through - it alone knows the eligibility mapping below, the
 * replay request, and how a response does or doesn't get relayed.
 */
import type { Request, Response } from 'express';

import { upstreamApiBaseUrl } from './identity-resolution.js';

export interface ApiFallbackState {
	fallbackUnimplementedEnabled: boolean;
	fallbackNotFoundEnabled: boolean;
}

function defaultState(): ApiFallbackState {
	return { fallbackUnimplementedEnabled: false, fallbackNotFoundEnabled: false };
}

let state: ApiFallbackState = defaultState();

export function getApiFallbackState(): ApiFallbackState {
	return { ...state };
}

/** Merges `patch` into the existing state - either field, or both, whichever the caller supplies. Both
 * the API route (a genuinely partial `POST`) and the console form (which always sends both fields)
 * call this identically. */
export function setApiFallbackState(patch: Partial<ApiFallbackState>): ApiFallbackState {
	state = { ...state, ...patch };
	return { ...state };
}

/** Test-only: forget any toggle flips a previous test made, matching `services/users.ts`'s
 * `resetUsersForTests` convention. Never call this from runtime code. */
export function resetApiFallbackStateForTests(): void {
	state = defaultState();
}

/** No retries, and short enough that a hanging upstream never leaves the caller waiting indefinitely -
 * this only ever runs after a local miss, on an opt-in toggle. */
const FALLBACK_TIMEOUT_MS = 30_000;

/** RFC 7230's hop-by-hop set, plus `content-encoding`/`content-length`: the body handed to `fetch()`
 * already arrives decoded, and Express recomputes framing itself when `res.send()` writes the buffered
 * relayed body, so forwarding either would describe bytes that are no longer on the wire. */
const EXCLUDED_RESPONSE_HEADERS = new Set([
	'connection',
	'keep-alive',
	'proxy-authenticate',
	'proxy-authorization',
	'te',
	'trailer',
	'transfer-encoding',
	'upgrade',
	'content-encoding',
	'content-length',
]);

export type FallbackTrigger = 'unimplemented' | 'record-not-found';

/** The exhaustive mapping from a local error's `type` to the toggle that gates it (`api.md`). Every
 * other error `type` - `invalid-request`, `user-not-authenticated`, `cannot-remove-running-run`,
 * `deleting-unfinished-build`, any `dev-folder-*` type, `internal-error` - is never eligible, `null`. */
function triggerForErrorType(type: string): FallbackTrigger | null {
	if (type === 'not-found' || type === 'not-implemented') return 'unimplemented';
	if (type === 'record-not-found') return 'record-not-found';
	return null;
}

/** `/v2/*` only, and never this runtime's own non-Apify `/v2/actor-runtime/*` namespace (nothing
 * upstream to call for either exclusion - a request that never reached `/v2` at all was never
 * authenticated on this path either, see `server.ts`'s mount order). Read off `req.originalUrl` (never
 * `req.path`), since that is the one representation router mount-prefix-stripping never touches. */
function isEligibleUpstreamPath(originalUrl: string): boolean {
	const pathname = originalUrl.split('?')[0] ?? originalUrl;
	if (pathname === '/v2/actor-runtime' || pathname.startsWith('/v2/actor-runtime/')) return false;
	return pathname === '/v2' || pathname.startsWith('/v2/');
}

export interface LocalError {
	status: number;
	type: string;
	message: string;
}

/**
 * The one function both local-miss seams in `server.ts` call. Returns `true` when the response has been
 * fully sent from upstream (the caller must not also send the local error), `false` when this call was
 * never eligible, or eligible but abandoned - either way the original local error is still the caller's
 * to send.
 *
 * Eligibility, in order: the local error's `type` must map to a trigger (above) and that trigger's
 * toggle must be on; the request must be under `/v2/*`, excluding `/v2/actor-runtime/*`; the request
 * must be authenticated (`req.user` - every `/v2/*` request, off-spec paths included, passes `auth()`
 * before reaching either seam, so this only ever fails for a request this runtime never authenticated at
 * all, e.g. one outside `/v2` entirely). All HTTP methods are eligible once these hold, writes included.
 *
 * Replay is `<upstreamApiBaseUrl()><req.originalUrl>` (byte-exact, percent-encoding intact), the
 * caller's own presented token (`req.user.token`, unconditionally - see `services/users.ts`) as the only
 * `Authorization` header, `content-type`/`accept` forwarded when the inbound request carried them,
 * nothing else. One attempt, redirects followed, a 30s timeout. Only a final `2xx` is relayed: status
 * and body unchanged, headers minus the hop-by-hop exclusion set below. `Set-Cookie` is always relayed
 * as one line per cookie the platform set, via `Headers.getSetCookie()` - the one header name the
 * platform's HTTP client (`fetch`/undici) guarantees it can hand back as separate entries, which is also
 * the one name where comma-joining would be wrong (a cookie's own value can contain a comma). Any other
 * header the platform repeats is relayed as a single, comma-joined value - the RFC 7230-legitimate
 * representation for a repeated list-valued field, and the only representation `fetch`'s `Headers`
 * exposes for anything other than `Set-Cookie` (it joins repeated non-cookie header lines together
 * before this function ever sees them). Anything other than a final `2xx` - non-2xx, timeout, DNS/connect
 * failure - is fail-closed (this function returns `false`, changing nothing about the response), logged
 * at `warn`. A relay is logged at `log`.
 */
export async function attemptFallback(req: Request, res: Response, localError: LocalError): Promise<boolean> {
	if (res.headersSent) return false;

	const trigger = triggerForErrorType(localError.type);
	if (!trigger) return false;

	const current = getApiFallbackState();
	const toggleOn =
		trigger === 'unimplemented' ? current.fallbackUnimplementedEnabled : current.fallbackNotFoundEnabled;
	if (!toggleOn) return false;

	if (!isEligibleUpstreamPath(req.originalUrl)) return false;
	if (!req.user) return false;

	const method = req.method.toUpperCase();
	const headers: Record<string, string> = { authorization: `Bearer ${req.user.token}` };
	const contentType = req.header('content-type');
	if (contentType) headers['content-type'] = contentType;
	const accept = req.header('accept');
	if (accept) headers['accept'] = accept;

	const target = `${upstreamApiBaseUrl()}${req.originalUrl}`;
	// Every body arrives as a raw `Buffer` (`api/server.ts`'s `express.raw({ type: () => true })`), with
	// no other type ever assigned to `req.body` - same one-line coercion `api/routes/key-value-stores.ts`
	// inlines at its own call site, kept local here rather than imported from the API layer.
	const requestBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

	let upstreamResponse: Awaited<ReturnType<typeof fetch>>;
	try {
		upstreamResponse = await fetch(target, {
			method,
			headers,
			body: method === 'GET' || method === 'HEAD' ? undefined : requestBody,
			redirect: 'follow',
			signal: AbortSignal.timeout(FALLBACK_TIMEOUT_MS),
		});
	} catch (err) {
		console.warn(
			`api-fallback: upstream request failed for ${method} ${req.originalUrl} (trigger=${trigger}): ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
		return false;
	}

	if (upstreamResponse.status < 200 || upstreamResponse.status >= 300) {
		console.warn(
			`api-fallback: upstream answered ${upstreamResponse.status} for ${method} ${req.originalUrl} ` +
				`(trigger=${trigger}); returning the original local error instead`,
		);
		return false;
	}

	const bodyBuffer = Buffer.from(await upstreamResponse.arrayBuffer());
	res.status(upstreamResponse.status);
	upstreamResponse.headers.forEach((value, name) => {
		const lower = name.toLowerCase();
		// `set-cookie` is handled separately below, via `getSetCookie()` - skipped here so it is never
		// also appended from this generic loop, which would double every cookie the platform set.
		if (lower === 'set-cookie') return;
		if (EXCLUDED_RESPONSE_HEADERS.has(lower)) return;
		res.append(name, value);
	});
	for (const cookie of upstreamResponse.headers.getSetCookie()) {
		res.append('set-cookie', cookie);
	}
	res.append('x-actor-runtime-fallback', upstreamApiBaseUrl());
	res.append('x-actor-runtime-fallback-trigger', trigger);
	res.send(bodyBuffer);

	console.log(`api-fallback: relayed ${method} ${req.originalUrl} to ${upstreamApiBaseUrl()} (trigger=${trigger})`);
	return true;
}

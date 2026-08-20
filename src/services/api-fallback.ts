/**
 * Upstream API fallback (`api.md`'s "Upstream fallback" section): when a call locally misses - either
 * because nothing in this runtime serves the path/method at all, or because it does but the specific
 * record id doesn't exist - and the matching toggle is on, the request is replayed verbatim against the
 * real Apify platform instead of failing. Both toggles default off and reset on every restart; this
 * module is the only place either fact is read or written, by the API route (`api/routes/api-fallback.ts`),
 * the console's `/settings` page, and `console/templates.ts: layout()`'s per-page state indicator alike.
 *
 * `attemptFallback` is the single seam both of `server.ts`'s local-miss sites (the terminal catch-all
 * and the generic error middleware) call through - it alone knows the eligibility mapping below, the
 * replay request, and how a response does or doesn't get relayed.
 */
import type { Request, Response } from 'express';

import { rawBody } from '../api/handler.js';

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

/** Same env var `services/identity-resolution.ts` already established for the identity probe - reused
 * verbatim rather than inventing a second one. Trailing slashes trimmed so `<upstreamApiBaseUrl()>
 * <req.originalUrl>` never produces a doubled `//`. */
export function upstreamBaseUrl(): string {
	const configured = process.env.APIFY_UPSTREAM_API_BASE_URL ?? 'https://api.apify.com';
	return configured.replace(/\/+$/, '');
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
 * Replay is `<upstreamBaseUrl()><req.originalUrl>` (byte-exact, percent-encoding intact), the caller's
 * own presented token (`req.user.token`, unconditionally - see `services/users.ts`) as the only
 * `Authorization` header, `content-type`/`accept` forwarded when the inbound request carried them,
 * nothing else. One attempt, redirects followed, a 30s timeout. Only a final `2xx` is relayed verbatim,
 * with both marker headers added; anything else - non-2xx, timeout, DNS/connect failure - is fail-closed
 * (this function returns `false`, changing nothing about the response), logged at `warn`. A relay is
 * logged at `log`.
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

	const target = `${upstreamBaseUrl()}${req.originalUrl}`;

	let upstreamResponse: Awaited<ReturnType<typeof fetch>>;
	try {
		upstreamResponse = await fetch(target, {
			method,
			headers,
			body: method === 'GET' || method === 'HEAD' ? undefined : rawBody(req),
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
		if (EXCLUDED_RESPONSE_HEADERS.has(name.toLowerCase())) return;
		res.append(name, value);
	});
	res.append('x-actor-runtime-fallback', upstreamBaseUrl());
	res.append('x-actor-runtime-fallback-trigger', trigger);
	res.send(bodyBuffer);

	console.log(`api-fallback: relayed ${method} ${req.originalUrl} to ${upstreamBaseUrl()} (trigger=${trigger})`);
	return true;
}

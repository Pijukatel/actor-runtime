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
 * this only ever runs after a local miss, on an opt-in toggle. Mutable only for tests (see
 * `setFallbackTimeoutMsForTests` below) - runtime code never changes it. */
const DEFAULT_FALLBACK_TIMEOUT_MS = 30_000;
let fallbackTimeoutMs = DEFAULT_FALLBACK_TIMEOUT_MS;

/** Test-only: shrink the upstream timeout so the "hangs past the timeout" fail-closed case can be
 * asserted in real wall-clock time instead of waiting out the full 30s production value. Never call
 * from runtime code. */
export function setFallbackTimeoutMsForTests(ms: number): void {
	fallbackTimeoutMs = ms;
}

/** Test-only: restore the production timeout value. Never call from runtime code. */
export function resetFallbackTimeoutMsForTests(): void {
	fallbackTimeoutMs = DEFAULT_FALLBACK_TIMEOUT_MS;
}

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
 * `req.path`), since that is the one representation router mount-prefix-stripping never touches.
 *
 * Lower-cased and collapsed to single slashes before either comparison: Express routes case-
 * insensitively and does not collapse repeated slashes, so `/v2/ACTOR-RUNTIME/...` and
 * `/v2//actor-runtime/...` both reach this function with the exclusion's casing/spelling intact but
 * still describe the excluded namespace - a naive string comparison would miss both and relay the
 * caller's token to `/v2/actor-runtime/*` itself, which has nothing upstream to answer it. Normalising
 * only affects this eligibility check, never the byte-exact replay URL below. */
function isEligibleUpstreamPath(originalUrl: string): boolean {
	const pathname = (originalUrl.split('?')[0] ?? originalUrl).toLowerCase().replace(/\/{2,}/g, '/');
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
 * failure, or the upstream dying *after* a final `2xx` status/headers but before the body finishes -
 * is fail-closed (this function returns `false`, changing nothing about the response), logged at
 * `warn`. A relay is logged at `log`.
 *
 * This function never rejects: both call sites in `server.ts` are the terminal middleware for their
 * respective seam, so a rejection here would escape to Express's own `finalhandler` instead of
 * producing the local error response - every fallible step between the status check and `res.send()` is
 * therefore wrapped in its own `try`/`catch` that logs and returns `false` on any throw, exactly like the
 * initial `fetch` itself already does. The one deliberate exception is the success log and `return true`
 * that follow `res.send()`: they sit outside that `try` on purpose, and cannot themselves turn a
 * completed relay back into `false` - see the comment just above them.
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
			signal: AbortSignal.timeout(fallbackTimeoutMs),
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

	// From here on, the upstream already committed to a final 2xx status line and headers - but the body
	// itself can still fail mid-stream (the connection resets, a declared Content-Length is never fully
	// delivered, ...). That failure surfaces as a rejection from `arrayBuffer()` below - the *first*
	// statement of this try, before `res` is touched at all - and everything after it must never let such
	// a rejection escape this function - see the doc comment above. No cleanup of `res` is needed on catch:
	// nothing in this block can mutate `res` and then have a *later* statement in the same block throw.
	// `arrayBuffer()` rejecting is first, so a throw there leaves `res` untouched. Past that point,
	// `res.status()` only ever receives the already-range-checked 2xx integer above, and every
	// `res.append()` call relays a header value that already survived the upstream HTTP response parser
	// (a value that parser wouldn't accept - e.g. a raw control character - fails `fetch()` itself, which
	// is caught by the earlier `try` around the request, never reaching here) or is one of this module's
	// own literal strings, neither of which Node's header validation rejects. So the only way into this
	// `catch` is `arrayBuffer()` rejecting, before any mutation - there is nothing to undo.
	try {
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
	} catch (err) {
		console.warn(
			`api-fallback: upstream response for ${method} ${req.originalUrl} (trigger=${trigger}) failed while ` +
				`relaying its body: ${err instanceof Error ? err.message : String(err)}; returning the original ` +
				`local error instead`,
		);
		return false;
	}

	// Deliberately outside the `try`: once `res.send()` above returns without throwing, the relay has
	// unconditionally happened, and nothing past this point may turn that back into a `false` - logging
	// the success can't retroactively fail the relay it's merely describing.
	console.log(`api-fallback: relayed ${method} ${req.originalUrl} to ${upstreamApiBaseUrl()} (trigger=${trigger})`);
	return true;
}

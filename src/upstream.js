/**
 * Fallback proxy to the real Apify API on a local 404.
 *
 * Opt-in (`Service.upstreamFallbackEnabled`, default off): when a request to
 * an allowlisted by-id `/v2` resource route -- an Actor, run, build, or one
 * of the three storage types, reached by its id -- resolves locally to a
 * 404, the same request (method, query string, body) is replayed against
 * `settings.apifyUpstreamBaseUrl` using the caller's own bound token -- only
 * for a request that itself presented a token resolving to a known user; a
 * credential-less request is never eligible and never borrows anyone else's
 * token. A 2xx upstream reply is relayed back verbatim; any failure --
 * non-2xx, timeout, connect error, a malformed upstream base URL, or a
 * caller identity that fails to resolve -- falls back to the original local
 * 404, logged for debuggability.
 *
 * Identity for that bearer credential is resolved by `src/auth.js`'s
 * `resolveForwardableToken` -- see its own docstring for the full contract
 * (why it is a pure lookup, never `resolveUser`'s bootstrap-or-reject).
 *
 * Deliberately excludes standby forwarding (`/v2/actor-standby/...`, a
 * local-only route with no equivalent reachable the same way), logs, the
 * console and the runtime-config toggle itself.
 */
import { request as undiciRequest } from 'undici';

import { resolveForwardableToken } from './auth.js';
import { response } from './http.js';

// The full RFC 7230 hop-by-hop set, plus two headers that only make sense
// for THIS upstream hop -- the client has already decoded the body (so a
// forwarded `content-encoding` would describe bytes that are no longer
// encoded) and the server recomputes its own response framing (so a
// forwarded `content-length` could describe the wrong body).
const EXCLUDED_RESPONSE_HEADERS = new Set([
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'trailers',
    'transfer-encoding',
    'upgrade',
    'content-encoding',
    'content-length',
]);

// Connect-only bound, mirroring the standby-forwarding proxy's own: a
// legitimately slow upstream response is never cut short, only a connect
// that never completes fails fast.
const CONNECT_TIMEOUT_MS = 10_000;

// By-id `/v2` resource routes: an Actor, run, build or storage reached by
// its id, plus any nested subpath (versions, records, items, requests, ...).
// Deliberately excludes a bare collection (`POST /v2/acts`, no id yet to be
// "missing"), and every local-only route (actor-standby forwarding, logs,
// console, the runtime-config toggle) -- none of those have a real-platform
// equivalent reachable the same way.
const ALLOWLISTED = /^\/v2\/(?:acts|actors|actor-runs|actor-builds|key-value-stores|datasets|request-queues)\/[^/]+/;

/** Whether the request's (decoded) path is on the fallback allowlist. */
export function isAllowlisted(pathname) {
    return ALLOWLISTED.test(pathname);
}

/**
 * The request's path and query exactly as they arrived on the wire, still
 * percent-encoded, joined as `path?query` (or bare `path` when there is no
 * query). Node's `req.url` IS the raw request target, so no decoded
 * representation is ever involved -- a resource id, key, or query value
 * containing an encoded character (e.g. `%2F`, `%23`, `%3F`) reaches the
 * upstream API byte-for-byte rather than as a decoded,
 * differently-structured request.
 */
export function rawTarget(ctx) {
    return ctx.rawUrl;
}

/**
 * Replay the request against the real API; `null` on any failure.
 *
 * The caller already confirmed the local response was a 404 before calling
 * this -- a `null` return means "return that original 404 unchanged", never
 * an upstream error status/body, and never an exception, of its own. That
 * "any failure" umbrella covers more than the upstream HTTP call itself: it
 * also covers whatever `resolveForwardableToken` throws while looking the
 * caller up. Everything below -- identity resolution, building the outgoing
 * request, the upstream call itself, and building the relayed response -- is
 * one single, deliberate trust boundary in one try/catch: NOTHING past the
 * point the caller already decided "this was a local 404" is allowed to
 * surface its own failure mode.
 */
export async function fetchUpstreamFallback(ctx, body) {
    try {
        const url = `${ctx.settings.apifyUpstreamBaseUrl}${rawTarget(ctx)}`;

        const headers = {};
        if (ctx.headers['content-type']) headers['content-type'] = ctx.headers['content-type'];
        // `body` is replayed exactly as captured -- still compressed, if it
        // was. The SDK's storage writes send `Content-Encoding: br` by
        // default, so a write replay that drops this header hands the
        // upstream API compressed bytes under a plain content-type, which it
        // cannot parse.
        if (ctx.headers['content-encoding']) headers['content-encoding'] = ctx.headers['content-encoding'];

        // `null` means nothing to forward -- abandon the attempt; `''` means
        // a resolved caller with no bound token yet, forwarded anonymously.
        const forwardToken = await resolveForwardableToken(ctx);
        if (forwardToken === null) return null;
        if (forwardToken) headers.authorization = `Bearer ${forwardToken}`;

        const upstream = await undiciRequest(url, {
            method: ctx.method,
            headers,
            body: body?.length ? body : undefined,
            headersTimeout: CONNECT_TIMEOUT_MS,
            bodyTimeout: 0,
        });

        const responseBody = Buffer.from(await upstream.body.arrayBuffer());
        if (upstream.statusCode < 200 || upstream.statusCode >= 300) {
            console.warn(
                `Upstream fallback ${ctx.method} ${ctx.path} got ${upstream.statusCode}; keeping the local 404`,
            );
            return null;
        }

        // Built as a LIST of pairs (which preserves duplicates) rather than
        // an object, so a header name the upstream repeats (e.g. two
        // Set-Cookie headers) is never collapsed to only the last value.
        const responseHeaders = [];
        for (const [name, value] of Object.entries(upstream.headers)) {
            if (EXCLUDED_RESPONSE_HEADERS.has(name.toLowerCase())) continue;
            for (const single of Array.isArray(value) ? value : [value]) {
                responseHeaders.push([name, single]);
            }
        }
        return response({ status: upstream.statusCode, headers: responseHeaders, body: responseBody });
    } catch (err) {
        // Deliberately broad -- see the docstring above. Covers any fault
        // raised while looking the caller up, a malformed upstream base URL,
        // and every network error from the upstream call itself.
        console.warn(`Upstream fallback ${ctx.method} ${ctx.path} failed: ${err?.message ?? err}`);
        return null;
    }
}

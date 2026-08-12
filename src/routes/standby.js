/**
 * Standby-actor request forwarding: flat `/v2/actor-standby/{actorId}/{path}`.
 *
 * A path-based route -- rather than the real platform's per-actor DNS
 * hostname, which needs a wildcard DNS zone this runtime does not provision
 * -- that resolves and authorizes the caller exactly like every other Actor
 * endpoint, lazily warms the actor's standby container, waits for its
 * readiness probe, and reverse-proxies the request with a streamed response.
 */
import { request as undiciRequest } from 'undici';

import { resolveStandbyCaller } from '../auth.js';
import { notFound, readRawBody, response, standbyStartFailed, standbyUnavailable } from '../http.js';
import { StandbyReadinessTimeout, StandbyStartError } from '../standby.js';

// This proxy's own fixed exclusion set, used on BOTH the outgoing request to
// the container and the relayed response: `connection`/`transfer-encoding`
// (kept deliberately narrower than the fuller RFC 7230 set src/upstream.js
// uses -- this route is a black box to whatever the standby Actor's own HTTP
// server does with the rest) plus `host` (would otherwise name this
// runtime's own address instead of the container's) and `content-length`
// (recomputed on each leg).
const EXCLUDED_HEADERS = new Set(['connection', 'transfer-encoding', 'host', 'content-length']);

// Connect-only bound on the forwarding request below. Read/write intentionally
// stay unbounded so a legitimately long-lived or slowly-streamed response is
// never cut off (multi-chunk streaming is a supported case); only the initial
// connect -- to a container that just answered its readiness probe moments
// earlier, so this can't false-positive on a merely-slow response -- is
// bounded, so a container that goes unreachable between the probe and the
// forward fails fast instead of hanging the caller indefinitely.
const STANDBY_FORWARD_CONNECT_TIMEOUT_MS = 10_000;

// The literal, fixed portion of this route's own path template, preceding
// the `*path` suffix -- used by `rawForwardTarget` below to locate that
// suffix's raw (still percent-encoded) bytes.
const STANDBY_PATH_PREFIX = '/v2/actor-standby/';

/**
 * Build `{endpoint}/{path}?{query}` from the request's raw wire bytes, never
 * from the router's decoded `path` param -- an encoded `%23`/`%3F` in the
 * caller's sub-path must reach the Actor exactly as sent, still encoded,
 * with the real query string intact alongside it; a decoded `#` would
 * truncate everything after it as a URL fragment and a decoded `?` would
 * split the string a second time, corrupting the query entirely. Node's
 * `req.url` (exposed as `ctx.rawUrl`) is the raw request target, so the
 * suffix after the fixed `/v2/actor-standby/{actorId}/` prefix is located by
 * the first literal `/` byte following that prefix -- a literal `/` is never
 * itself the product of percent-decoding, so this is the same boundary the
 * router's own (decoded-path) matching already agreed on.
 */
export function rawForwardTarget(endpoint, ctx, decodedPath = '') {
    const rawUrl = ctx.rawUrl;
    if (rawUrl.startsWith(STANDBY_PATH_PREFIX)) {
        const remainder = rawUrl.slice(STANDBY_PATH_PREFIX.length);
        const queryIndex = remainder.indexOf('?');
        const searchEnd = queryIndex === -1 ? remainder.length : queryIndex;
        const slashIndex = remainder.slice(0, searchEnd).indexOf('/');
        let rest = '';
        if (slashIndex !== -1) {
            rest = remainder.slice(slashIndex + 1);
        } else if (queryIndex !== -1) {
            rest = remainder.slice(queryIndex);
        }
        return `${endpoint}/${rest}`;
    }
    // Fallback, mirroring the Python predecessor's `_raw_forward_target`: the
    // raw request target does not literally start with the fixed prefix (a
    // caller percent-encoded some of the prefix's own bytes -- the router's
    // DECODED match still agreed this is a standby request, but the raw
    // byte-offset extraction above no longer applies). Re-quote the router's
    // decoded `*path` param instead of silently forwarding to the endpoint
    // root. Unavoidably lossy (a literal `#`/`?` and its percent-encoded form
    // decode to the same string) but still a usable, correctly-encoded target,
    // with the raw query string kept intact alongside it.
    const queryIndex = rawUrl.indexOf('?');
    const query = queryIndex === -1 ? '' : rawUrl.slice(queryIndex);
    const requoted = decodedPath.split('/').map(encodeURIComponent).join('/');
    return `${endpoint}/${requoted}${query}`;
}

export function registerStandbyRoutes(router) {
    router.add(
        ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'],
        '/v2/actor-standby/:actorId/*path',
        async (ctx, { actorId, path }) => {
            const svc = ctx.service;
            const user = await resolveStandbyCaller(ctx);
            // `getActor(..., user)` is the SAME ownership check every other
            // Actor endpoint uses: a cross-user or unknown actor id is 404
            // here too, so standby access follows the rest of the API's
            // visibility rules exactly (no separate, standby-only access
            // model).
            const actor = svc.getActor(actorId, user);
            if (!actor || !(actor.actorStandby ?? {}).isEnabled) {
                // Identical 404 for "no such actor", "someone else's actor"
                // and "not standby-enabled" -- never a silent on-demand run
                // as a fallback.
                return notFound(`Actor '${actorId}' has no standby endpoint.`);
            }

            let endpoint;
            try {
                endpoint = await svc.ensureStandbyRun(actorId);
            } catch (err) {
                if (err instanceof StandbyReadinessTimeout) {
                    return standbyUnavailable(`Actor '${actorId}' never became ready.`);
                }
                if (err instanceof StandbyStartError) {
                    // Distinct from "no successful build" (404, below): the
                    // Actor DOES have a build, but launching its container
                    // failed for an infrastructure reason. Report it as the
                    // run failure it actually is -- a 5xx with the real cause.
                    return standbyStartFailed(err.message);
                }
                throw err;
            }
            if (endpoint === null) {
                return notFound(`Actor '${actorId}' has no successful build to serve from standby.`);
            }

            // Tracked for the ENTIRE duration of the forward below, including
            // while a streamed response is still being read -- this is what
            // stops the idle-reap watchdog from tearing down a container out
            // from under a single request that legitimately outlives
            // idleTimeoutSecs.
            svc.markStandbyRequestStarted(actorId);
            let upstream;
            try {
                const body = await readRawBody(ctx);
                // A LIST of raw header pairs, not an object: an object would
                // keep only the last value for any header name the caller
                // repeats (e.g. two Cookie headers), silently breaking the
                // "headers... unchanged" forwarding guarantee. undici accepts
                // the flat rawHeaders array and preserves duplicates through
                // to the wire.
                const forwardHeaders = [];
                for (let i = 0; i < ctx.req.rawHeaders.length; i += 2) {
                    const name = ctx.req.rawHeaders[i];
                    if (!EXCLUDED_HEADERS.has(name.toLowerCase())) {
                        forwardHeaders.push(name, ctx.req.rawHeaders[i + 1]);
                    }
                }
                const targetUrl = rawForwardTarget(endpoint, ctx, path);

                // Only the initial connect is bounded (headersTimeout also
                // caps the wait for response headers; body reads stay
                // unbounded so a long-lived or slowly-streamed response is
                // never cut short).
                upstream = await undiciRequest(targetUrl, {
                    method: ctx.method,
                    headers: forwardHeaders,
                    body: body.length ? body : undefined,
                    headersTimeout: STANDBY_FORWARD_CONNECT_TIMEOUT_MS,
                    bodyTimeout: 0,
                });
            } catch (err) {
                // A container that was ready an instant ago but died/dropped
                // the connection before this specific call -- surface it
                // observably rather than a bare 500.
                svc.markStandbyRequestFinished(actorId);
                return standbyUnavailable(`Actor '${actorId}' did not respond: ${err?.message ?? err}`);
            }

            // Relay the response headers as a LIST of pairs (preserving
            // duplicates), so e.g. two Set-Cookie headers from a standby
            // Actor both reach the original caller intact.
            const responseHeaders = [];
            for (const [name, value] of Object.entries(upstream.headers)) {
                if (EXCLUDED_HEADERS.has(name.toLowerCase())) continue;
                for (const single of Array.isArray(value) ? value : [value]) {
                    responseHeaders.push([name, single]);
                }
            }

            async function* relayBody() {
                try {
                    for await (const chunk of upstream.body) {
                        yield chunk;
                    }
                } finally {
                    svc.markStandbyRequestFinished(actorId);
                }
            }

            return response({ status: upstream.statusCode, headers: responseHeaders, stream: relayBody() });
        },
    );
}

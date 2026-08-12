/**
 * Upstream-API fallback layer (src/upstream.js) + the runtime-config toggle
 * it reads. All Docker-free: the `wireUpstream` helper points
 * `Settings.apifyUpstreamBaseUrl` at a `FakeUpstreamServer` -- an in-process
 * HTTP stub standing in for api.apify.com -- instead of the real platform.
 * See requirements/api.md's "Upstream fallback" section.
 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeUpstreamServer, makeSettings, wire } from '../helpers.js';

// Spy on undici's `request` -- the one HTTP client src/upstream.js dials the
// upstream with -- recording every call's URL and options while delegating to
// the real implementation. The JS analogue of the Python suite's monkeypatch
// spy on `httpx.AsyncClient.request`: it proves a dial attempt genuinely
// happened (or captured which timeout options the running code built) rather
// than trusting a collapsed 404 alone. Tests still filter recorded calls by
// the configured upstream base, mirroring the Python original's rationale --
// other code (e.g. the standby forwarding proxy) may also use undici, and
// only calls aimed at the upstream base prove anything here.
const upstreamSpy = vi.hoisted(() => ({ calls: [] }));
vi.mock('undici', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        request: async (url, options) => {
            upstreamSpy.calls.push({ url: String(url), options });
            return actual.request(url, options);
        },
    };
});

function auth(token) {
    return { authorization: `Bearer ${token}` };
}

async function createUser(client, name) {
    await client.post('/v2/users', { json: { name } });
}

/** The `wired_upstream` fixture: `wire()` pointed at a FakeUpstreamServer. */
async function wireUpstream(fake) {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'actor-runtime-upstream-'));
    return wire({ settings: makeSettings(tmpDir, { apifyUpstreamBaseUrl: fake.baseUrl }), tmpDir });
}

/** Calls the spy recorded against this wiring's configured upstream base. */
function dialAttempts(ctx) {
    return upstreamSpy.calls.filter((call) => call.url.startsWith(ctx.settings.apifyUpstreamBaseUrl));
}

// ------------------------------------------------------------------- toggle

describe('runtime-config toggle', () => {
    let ctx;

    beforeEach(async () => {
        ctx = await wire();
    });

    afterEach(async () => {
        await ctx.close();
    });

    it('GET is token-free and defaults off', async () => {
        const resp = await ctx.client.get('/v2/runtime-config');
        expect(resp.status).toBe(200);
        expect(resp.json().data).toEqual({ upstreamFallbackEnabled: false });
    });

    it('GET ignores a presented token', async () => {
        // Token-free means GET never validates a presented credential either
        // -- a bearer matching no user must not be rejected here (mirrors GET
        // /v2/users' own token-free contract), unlike PUT below.
        const resp = await ctx.client.get('/v2/runtime-config', { headers: auth('stale-unknown-token') });
        expect(resp.status).toBe(200);
    });

    it('PUT with no token works', async () => {
        // No credential at all is never rejected -- the same "absent token ->
        // default user" rule every other endpoint follows, not GET's
        // token-free carve-out -- so a bare PUT with no Authorization header
        // still succeeds.
        const resp = await ctx.client.put('/v2/runtime-config', { json: { upstreamFallbackEnabled: true } });
        expect(resp.status).toBe(200);
        expect(ctx.service.upstreamFallbackEnabled).toBe(true);
    });

    it('PUT rejects an unresolvable token', async () => {
        // PUT is NOT token-free: a present token matching no existing user is
        // 401. Bootstrap the default user's credential with a first token via
        // ordinary authenticated work, then present a SECOND, different (now
        // genuinely unresolvable) token to the PUT itself -- this must still
        // 401 even once the default user is already claimed.
        await ctx.client.get('/v2/users/me', { headers: auth('first-token') }); // bootstraps the default user

        const resp = await ctx.client.put('/v2/runtime-config', {
            json: { upstreamFallbackEnabled: true },
            headers: auth('second-token'),
        });
        expect(resp.status).toBe(401);
        expect(ctx.service.upstreamFallbackEnabled).toBe(false); // never touched
    });

    it('PUT on a fresh runtime rejects an unknown token without bootstrapping', async () => {
        // Regression: on a FRESH runtime (no user ever resolved before --
        // unlike the test above, which already bootstraps the default user
        // before presenting its second token), `PUT /v2/runtime-config` with
        // an unknown bearer token used to bind that token as the default
        // user's credential, since the handler resolved identity via
        // `resolveUser`'s bootstrap-or-reject. That let an attacker-supplied
        // (or stale, e.g. from a console tab left open across a data-dir
        // reset) token be silently claimed here, and permanently locked the
        // real operator's own later login out (a bound default user can never
        // again satisfy `resolveUser`'s own unclaimed-token bootstrap
        // condition). Must 401 with NO state mutation at all, and the
        // operator's own subsequent real login must still succeed.
        const before = (await ctx.client.get('/v2/users')).json().data.items;
        expect(before).toEqual([]);

        const resp = await ctx.client.put('/v2/runtime-config', {
            json: { upstreamFallbackEnabled: true },
            headers: auth('attacker-token'),
        });
        expect(resp.status).toBe(401);
        expect(ctx.service.upstreamFallbackEnabled).toBe(false); // never touched

        const after = (await ctx.client.get('/v2/users')).json().data.items;
        expect(after).toEqual([]); // no user created or bound as a side effect

        // The operator was never locked out: a later, real login token still
        // bootstraps the default user exactly as it would have on a truly
        // fresh runtime -- proving "attacker-token" above was never claimed.
        const login = await ctx.client.get('/v2/users/me', { headers: auth('real-operator-token') });
        expect(login.status).toBe(200);
        expect(login.json().data.token).toBe('real-operator-token');
    });

    it('PUT with a valid token works', async () => {
        await createUser(ctx.client, 'alice'); // alice.token == "alice"
        const resp = await ctx.client.put('/v2/runtime-config', {
            json: { upstreamFallbackEnabled: true },
            headers: auth('alice'),
        });
        expect(resp.status).toBe(200);
        expect(resp.json().data).toEqual({ upstreamFallbackEnabled: true });
        expect(ctx.service.upstreamFallbackEnabled).toBe(true);
    });

    it('PUT takes effect immediately', async () => {
        const resp = await ctx.client.put('/v2/runtime-config', { json: { upstreamFallbackEnabled: true } });
        expect(resp.status).toBe(200);
        expect(resp.json().data).toEqual({ upstreamFallbackEnabled: true });
        expect(ctx.service.upstreamFallbackEnabled).toBe(true);

        const again = await ctx.client.get('/v2/runtime-config');
        expect(again.json().data).toEqual({ upstreamFallbackEnabled: true });

        const off = await ctx.client.put('/v2/runtime-config', { json: { upstreamFallbackEnabled: false } });
        expect(off.json().data).toEqual({ upstreamFallbackEnabled: false });
        expect(ctx.service.upstreamFallbackEnabled).toBe(false);
    });

    it('PUT rejects a non-boolean', async () => {
        const resp = await ctx.client.put('/v2/runtime-config', { json: { upstreamFallbackEnabled: 'yes' } });
        expect(resp.status).toBe(400);
        expect(ctx.service.upstreamFallbackEnabled).toBe(false);
    });
});

// ------------------------------------------------- fallback (wired upstream)

describe('upstream fallback', () => {
    let fake;
    let ctx;
    let client;
    let service;

    beforeEach(async () => {
        fake = await new FakeUpstreamServer().start();
        ctx = await wireUpstream(fake);
        ({ client, service } = ctx);
        upstreamSpy.calls.length = 0;
    });

    afterEach(async () => {
        await ctx.close();
        fake.stop();
        vi.restoreAllMocks();
    });

    // -------------------------------------------------- fallback: read (GET)

    it('toggle off never attempts upstream', async () => {
        // Covers both "off by default" (a fresh `Service`'s
        // `upstreamFallbackEnabled` is a plain in-memory attribute with no
        // persistence path, so it starts `false`) and "off means off" (the
        // same explicit assignment): a request for a resource missing locally
        // returns the exact same local `404` as before this change, and the
        // upstream stub receives zero requests.
        expect(service.upstreamFallbackEnabled).toBe(false);
        service.upstreamFallbackEnabled = false;
        const resp = await client.get('/v2/key-value-stores/nobody~nothing/keys');
        expect(resp.status).toBe(404);
        expect(resp.json().error.type).toBe('record-not-found');
        expect(fake.requests).toEqual([]);
    });

    it('GET relays an upstream 2xx verbatim', async () => {
        service.upstreamFallbackEnabled = true;
        await createUser(client, 'caller');
        fake.setResponse(
            200,
            JSON.stringify({ data: { items: [{ key: 'OUTPUT' }], count: 1, limit: 1, isTruncated: false } }),
            { 'content-type': 'application/json', 'x-test-marker': 'hello' },
        );

        const resp = await client.get('/v2/key-value-stores/nobody~nothing/keys', { headers: auth('caller') });
        expect(resp.status).toBe(200);
        expect(resp.json().data.items).toEqual([{ key: 'OUTPUT' }]);
        expect(resp.headers.get('x-test-marker')).toBe('hello');
        expect(fake.requests.length).toBe(1);
        const seen = fake.requests[0];
        expect(seen.method).toBe('GET');
        expect(seen.path).toBe('/v2/key-value-stores/nobody~nothing/keys');
    });

    it('a relayed response still carries CORS headers', async () => {
        // The fallback layer discards the local handler's response and builds
        // a brand-new one from the upstream reply on a relay -- that new
        // response must still get the CORS response headers `handle()`
        // (src/app.js) appends to every response, exactly like every other
        // response.
        service.upstreamFallbackEnabled = true;
        await createUser(client, 'caller');
        fake.setResponse(
            200,
            JSON.stringify({ data: { items: [], count: 0, limit: 0, isTruncated: false } }),
            { 'content-type': 'application/json' },
        );

        const resp = await client.get('/v2/key-value-stores/nobody~nothing/keys', {
            headers: { ...auth('caller'), origin: 'https://example.com' },
        });
        expect(resp.status).toBe(200);
        expect(resp.headers.get('access-control-allow-origin')).toBe('*');
    });

    it('a relay preserves duplicate response headers', async () => {
        // Building the relayed headers as an object keyed by name would
        // silently keep only the last value for a header name the upstream
        // repeats -- e.g. two Set-Cookie headers -- contradicting
        // `fetchUpstreamFallback`'s own "relayed back verbatim" contract.
        // Mirrors the same regression check the standby routes' own upstream
        // proxy has for its duplicate-header-preserving pair-list relay.
        service.upstreamFallbackEnabled = true;
        await createUser(client, 'caller');
        fake.setResponse(200, '{}', [
            ['content-type', 'application/json'],
            ['set-cookie', 'a=1'],
            ['set-cookie', 'b=2'],
        ]);

        const resp = await client.get('/v2/key-value-stores/nobody~nothing/keys', { headers: auth('caller') });
        expect(resp.status).toBe(200);
        expect(resp.headers.getSetCookie()).toEqual(['a=1', 'b=2']);
    });

    it('a relay strips the full hop-by-hop response header set', async () => {
        // `src/upstream.js`'s own `EXCLUDED_RESPONSE_HEADERS` is the full
        // RFC 7230 hop-by-hop set, not just the two extra members
        // (`content-encoding`/`content-length`) this proxy adds on top to
        // handle its own decoded-body/recomputed-framing needs -- none of
        // these ever belongs on a relayed response.
        // `content-encoding`/`content-length` are exercised separately, over
        // an actually-compressed response, in the compressed-response test
        // below -- a mismatched-but-unused value here wouldn't prove anything
        // about stripping vs. blind forwarding the way a real compressed body
        // does.
        //
        // Port note: unlike the in-process ASGI-transport Python original,
        // this suite talks to the runtime over a REAL socket, and node's own
        // HTTP server legitimately adds its own `Connection: keep-alive` and
        // `Keep-Alive: timeout=5` to every response. So for those two names
        // the upstream stub replies with DISTINCTIVE values (`close`,
        // `max=99`) and the test asserts those values never surface --
        // blind forwarding would have carried them through `writeHead` --
        // while the remaining six headers (never server-generated) are
        // asserted absent outright.
        service.upstreamFallbackEnabled = true;
        await createUser(client, 'caller');
        fake.setResponse(200, '{}', [
            ['content-type', 'application/json'],
            // Declaring `Trailer` on a fixed-length response is invalid HTTP
            // -- node's stub server refuses to send it -- so the stub's
            // reply is framed chunked instead, which also puts a real
            // `transfer-encoding` (itself a hop-by-hop member) on the wire
            // for the relay to strip.
            ['transfer-encoding', 'chunked'],
            ['connection', 'close'],
            ['keep-alive', 'timeout=7, max=99'],
            ['proxy-authenticate', 'Basic'],
            ['proxy-authorization', 'Basic abc'],
            ['te', 'trailers'],
            ['trailer', 'X-Something'],
            ['trailers', 'X-Something'],
            ['upgrade', 'h2c'],
        ]);

        const resp = await client.get('/v2/key-value-stores/nobody~nothing/keys', { headers: auth('caller') });
        expect(resp.status).toBe(200);
        expect(resp.headers.get('connection')).not.toBe('close');
        expect(resp.headers.get('keep-alive') ?? '').not.toContain('max=99');
        // Blind forwarding would have carried the upstream's chunked framing
        // through; the relayed response's framing is the runtime's own.
        expect(resp.headers.get('transfer-encoding')).toBeNull();
        for (const header of ['proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'trailers', 'upgrade']) {
            expect(resp.headers.get(header), header).toBeNull();
        }
    });

    it('a relay strips content-encoding and recomputes content-length for a compressed response', async () => {
        // `content-encoding`/`content-length` are the two members
        // src/upstream.js's `EXCLUDED_RESPONSE_HEADERS` adds beyond its own
        // RFC 7230 hop-by-hop set: the relay hands the caller the DECODED
        // bytes while the upstream headers still describe the compressed wire
        // -- forwarding either verbatim would hand the caller a mismatched
        // body/header pair. A real gzip body is the only way to prove they're
        // actually stripped-and-recomputed, not just coincidentally correct.
        service.upstreamFallbackEnabled = true;
        await createUser(client, 'caller');
        const plaintext = JSON.stringify({
            data: { items: [{ key: 'OUTPUT' }], count: 1, limit: 1, isTruncated: false },
        });
        const compressed = zlib.gzipSync(plaintext);
        expect(compressed.length).not.toBe(Buffer.byteLength(plaintext)); // the case this test exists to catch
        fake.setResponse(200, compressed, [
            ['content-type', 'application/json'],
            ['content-encoding', 'gzip'],
            ['content-length', String(compressed.length)],
        ]);

        const resp = await client.get('/v2/key-value-stores/nobody~nothing/keys', { headers: auth('caller') });
        expect(resp.status).toBe(200);
        expect(resp.json().data.items).toEqual([{ key: 'OUTPUT' }]); // relayed decoded
        expect(resp.headers.get('content-encoding')).toBeNull();
        // Recomputed by node from the actual (decompressed) relayed body --
        // not the original (compressed, shorter) upstream value -- so the
        // caller never receives a `content-length` inconsistent with the
        // bytes on the wire.
        expect(resp.headers.get('content-length')).toBe(String(Buffer.byteLength(plaintext)));
    });

    it('an upstream non-2xx collapses to the local 404', async () => {
        await createUser(client, 'caller');
        // Capture the plain local 404 with fallback OFF, before any upstream
        // attempt could shape it.
        const localOnly = await client.get('/v2/key-value-stores/nobody~nothing/keys', { headers: auth('caller') });
        expect(localOnly.status).toBe(404);
        const localBody = localOnly.json();

        service.upstreamFallbackEnabled = true;
        fake.setResponse(500, 'boom');
        const resp = await client.get('/v2/key-value-stores/nobody~nothing/keys', { headers: auth('caller') });
        expect(resp.status).toBe(404);
        expect(resp.json()).toEqual(localBody);
        expect(fake.requests.length).toBe(1); // the attempt was made, and failed
    });

    it('an upstream failure logs at warning level', async () => {
        // Port note: the Python app logged through the `app.upstream` logger
        // and this test pinned the WARNING level (uvicorn left app loggers at
        // their default effective WARNING level, so an `info` diagnostic
        // would never reach an operator). The JS app's warning channel is
        // `console.warn` -- the design's own mitigation for this failure mode
        // ("a clear log line so it's debuggable") holds as long as the
        // collapse-to-404 diagnostic is emitted there, spied on here.
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        service.upstreamFallbackEnabled = true;
        await createUser(client, 'caller');
        fake.setResponse(500, 'boom');

        const resp = await client.get('/v2/key-value-stores/nobody~nothing/keys', { headers: auth('caller') });
        expect(resp.status).toBe(404);
        expect(warnSpy.mock.calls.some((args) => String(args[0]).includes('Upstream fallback'))).toBe(true);
    });

    it('an upstream connect error collapses to the local 404', async () => {
        // A resolvable, presented token is required here -- with no token at
        // all `resolveForwardableToken` returns `null` and
        // `fetchUpstreamFallback` abandons before ever dialing, so the
        // stopped server would never actually be dialed and this test would
        // pass for the wrong reason. The undici `request` spy (rather than
        // trusting the collapsed 404 alone) proves the connect attempt
        // genuinely happened.
        service.upstreamFallbackEnabled = true;
        await createUser(client, 'caller');
        fake.stop(); // nothing listens at this port any more

        const resp = await client.get('/v2/key-value-stores/nobody~nothing/keys', { headers: auth('caller') });
        expect(resp.status).toBe(404);
        expect(resp.json().error.type).toBe('record-not-found');
        expect(dialAttempts(ctx).length).toBe(1); // genuinely tried to connect, not abandoned pre-dial
    });

    it('the upstream timeout is a connect-only bound', async () => {
        // Regression guard on the module's own comment promising a
        // connect-only bound ("a legitimately slow upstream response is never
        // cut short, only a connect that never completes fails fast"),
        // mirroring the standby routes' own upstream proxy. Waiting out a
        // real long transfer in a unit test isn't practical, so this captures
        // the actual timeout options the running code passes to undici during
        // a real fallback call (via the module spy), rather than merely
        // re-deriving the expected values independently.
        //
        // Port note: undici has no per-call connect timeout, so
        // src/upstream.js expresses the bound as `headersTimeout` (failing
        // fast when no response ever starts, standing in for httpx's
        // `connect=10.0`) plus `bodyTimeout: 0` -- the load-bearing half: the
        // body read is never time-bounded, so a legitimately slow, large
        // response is never cut short (httpx's `read=None`).
        service.upstreamFallbackEnabled = true;
        await createUser(client, 'caller');
        fake.setResponse(200, '[]', { 'content-type': 'application/json' });

        const resp = await client.get('/v2/datasets/nobody~nothing/items', { headers: auth('caller') });
        expect(resp.status).toBe(200);
        const dials = dialAttempts(ctx);
        expect(dials.length, 'fetchUpstreamFallback never dialed the upstream').toBe(1);
        expect(dials[0].options.headersTimeout).toBe(10_000);
        expect(dials[0].options.bodyTimeout).toBe(0);
    });

    // -------------------------- fallback: identity resolution failures

    it('an unresolvable token on the SPA catch-all 404 collapses to the local 404', async () => {
        // An allowlisted-prefix path that matches no registered route 404s
        // via the router's own not-found (the JS analogue of the Python SPA
        // catch-all's 404) WITHOUT ever resolving identity -- unlike every
        // registered handler on these prefixes, which authenticates before it
        // can 404. So `fetchUpstreamFallback`'s own lookup is the FIRST
        // identity resolution for a request like this one, and a token
        // matching no existing user there must collapse to the original local
        // 404 like any other fallback failure.
        // Ground truth: the plain local 404, captured with no token involved
        // at all.
        const localOnly = await client.get('/v2/actors/someuser~someactor/no-such-nested-path');
        expect(localOnly.status).toBe(404);
        const localBody = localOnly.json();

        service.upstreamFallbackEnabled = true;
        // Bind the default user's credential to a first token.
        const bootstrap = await client.get('/v2/users/me', { headers: auth('FIRST-TOKEN') });
        expect(bootstrap.status).toBe(200);

        // A second, unknown token matches no existing user -- there is
        // nothing to forward, so this must collapse to the local 404 rather
        // than reach the upstream call at all.
        const resp = await client.get('/v2/actors/someuser~someactor/no-such-nested-path', {
            headers: auth('SECOND-UNKNOWN-TOKEN'),
        });
        expect(resp.status).toBe(404);
        expect(resp.json()).toEqual(localBody);
        expect(fake.requests).toEqual([]); // never got far enough to attempt the upstream call
    });

    it('disabled: an unresolvable token on the SPA catch-all is the plain local 404', async () => {
        // Companion to the test above with the toggle OFF: the same request
        // must still be the plain local 404 either way -- with fallback
        // disabled the layer short-circuits before ever attempting an
        // identity lookup, so an unresolvable token is irrelevant.
        expect(service.upstreamFallbackEnabled).toBe(false);
        const bootstrap = await client.get('/v2/users/me', { headers: auth('FIRST-TOKEN') });
        expect(bootstrap.status).toBe(200);

        const resp = await client.get('/v2/actors/someuser~someactor/no-such-nested-path', {
            headers: auth('SECOND-UNKNOWN-TOKEN'),
        });
        expect(resp.status).toBe(404);
        expect(resp.json().error.type).toBe('record-not-found');
        expect(fake.requests).toEqual([]);
    });

    it('an unmatched path with an unknown token never binds or creates a user', async () => {
        // Regression: enabling the toggle used to let an UNMATCHED
        // allowlisted path's fallback attempt bootstrap/bind the default
        // user's credential to whatever token was presented, since the
        // fallback re-called the bootstrap-or-reject resolver -- which is not
        // a pure lookup. On a completely fresh instance (no user ever
        // created), a GET carrying an unknown ("not a real Apify credential")
        // bearer token to an unmatched allowlisted path must 404 exactly as
        // before AND leave the user table untouched: a token matching no
        // existing user has nothing to forward, so the whole attempt must
        // collapse to the local 404 with zero state mutation, never a bind.
        // Upstream is stubbed to fail (401) -- as a placeholder token
        // genuinely would against the real platform -- so the OLD, buggy
        // code's own bind-then-forward-then-fail sequence still ends in a
        // 404, making the DB-state assertion below the only thing that tells
        // the two behaviours apart.
        service.upstreamFallbackEnabled = true;
        fake.setResponse(401, '{"error":{"message":"bad token"}}');

        const before = (await client.get('/v2/users')).json().data.items;
        expect(before).toEqual([]);

        const resp = await client.get('/v2/actors/someuser~someactor/no-such-nested-path', {
            headers: auth('GARBAGE-TOKEN'),
        });
        expect(resp.status).toBe(404);
        expect(resp.json().error.type).toBe('record-not-found');
        expect(fake.requests).toEqual([]); // nothing to forward -- never even attempted

        const after = (await client.get('/v2/users')).json().data.items;
        expect(after).toEqual([]); // no user created or bound as a side effect
    });

    it('an unmatched path with a known token still forwards it', async () => {
        // Companion to the test above: on the same unmatched-allowlisted-path
        // branch, a token that DOES match an existing user's bound credential
        // must still be forwarded exactly as before -- the pure-lookup fix
        // only changes the unmatched-token case, never this one.
        service.upstreamFallbackEnabled = true;
        await createUser(client, 'alice'); // alice.token == "alice"
        fake.setResponse(200, '[]', { 'content-type': 'application/json' });

        const resp = await client.get('/v2/actors/someuser~someactor/no-such-nested-path', {
            headers: auth('alice'),
        });
        expect(resp.status).toBe(200);
        expect(fake.requests.length).toBe(1);
        expect(fake.requests[0].headers.authorization).toBe('Bearer alice');
    });

    it('a non-invalid-token fault during identity resolution collapses to the local 404', async () => {
        // Regression: `fetchUpstreamFallback`'s failure boundary used to only
        // catch `InvalidTokenError` (plus the upstream-call exceptions) --
        // any OTHER fault raised while resolving the caller's identity, e.g.
        // a transient DB error from `Service.getUser`, escaped uncaught as a
        // raw 500, never the original local 404 the module's own contract
        // promises for "any failure" on this path. `service.getUser` throwing
        // a plain `Error` stands in for that DB fault; with one broad
        // try/catch covering the whole fallback attempt, this must collapse
        // to the exact same local 404 as if fallback were off.
        await createUser(client, 'alice');

        // Ground truth: the plain local 404, captured before any fault is
        // injected.
        const localOnly = await client.get('/v2/key-value-stores/alice~nonexistent/keys', {
            headers: auth('alice'),
        });
        expect(localOnly.status).toBe(404);
        const localBody = localOnly.json();

        service.upstreamFallbackEnabled = true;
        service.getUser = () => {
            throw new Error('simulated transient DB fault');
        };

        const resp = await client.get('/v2/key-value-stores/alice~nonexistent/keys', { headers: auth('alice') });
        expect(resp.status).toBe(404);
        expect(resp.json()).toEqual(localBody);
        expect(fake.requests).toEqual([]); // never got far enough to attempt the upstream call
    });

    // ------------------------------ fallback: writes (POST/PUT/DELETE)

    it('DELETE relays an upstream 2xx verbatim', async () => {
        service.upstreamFallbackEnabled = true;
        await createUser(client, 'caller');
        fake.setResponse(200, JSON.stringify({ data: { id: 'nobody~nothing' } }), {
            'content-type': 'application/json',
        });

        const resp = await client.delete('/v2/key-value-stores/nobody~nothing', { headers: auth('caller') });
        expect(resp.status).toBe(200);
        expect(resp.json().data).toEqual({ id: 'nobody~nothing' });
        expect(fake.requests.length).toBe(1);
        expect(fake.requests[0].method).toBe('DELETE');
    });

    it('DELETE upstream failure collapses to the local 404', async () => {
        await createUser(client, 'caller');
        const localOnly = await client.delete('/v2/key-value-stores/nobody~nothing', { headers: auth('caller') });
        expect(localOnly.status).toBe(404);
        const localBody = localOnly.json();

        service.upstreamFallbackEnabled = true;
        fake.setResponse(401, '{"error":{"message":"bad token"}}');
        const resp = await client.delete('/v2/key-value-stores/nobody~nothing', { headers: auth('caller') });
        expect(resp.status).toBe(404);
        expect(resp.json()).toEqual(localBody);
        expect(fake.requests.length).toBe(1); // the attempt was made, and failed
    });

    it('a write replays body and query verbatim', async () => {
        // A PUT that 404s locally replays the SAME method, query string AND
        // body, not just the path.
        service.upstreamFallbackEnabled = true;
        await createUser(client, 'caller');
        fake.setResponse(201, '{"data":{"key":"K"}}', { 'content-type': 'application/json' });

        const resp = await client.put('/v2/key-value-stores/otheruser~theirs/records/K?foo=bar', {
            body: JSON.stringify({ hello: 'world' }),
            headers: { ...auth('caller'), 'content-type': 'application/json' },
        });
        expect(resp.status).toBe(201);
        expect(fake.requests.length).toBe(1);
        const seen = fake.requests[0];
        expect(seen.method).toBe('PUT');
        expect(seen.path).toBe('/v2/key-value-stores/otheruser~theirs/records/K?foo=bar');
        expect(JSON.parse(seen.body.toString('utf8'))).toEqual({ hello: 'world' });
        expect(seen.headers['content-type']).toBe('application/json');
    });

    it('replays the raw percent-encoded path, not the decoded one', async () => {
        // Regression: the replay used to build its outgoing URL from the
        // already-decoded path -- so a key containing an encoded `%2F`
        // decoded to a literal `/` there, forwarding upstream as a real path
        // separator and hitting a different resource than the caller asked
        // for. The replay must instead use the raw, still-encoded wire target
        // (`ctx.rawUrl` -- node's `req.url` IS the raw request target), so
        // the caller's exact percent-encoding survives to the upstream
        // request unchanged. The route's own `:key` parameter still matches
        // (segments split before decoding), but no store named
        // `nobody~nothing` exists, so this 404s locally first, exactly like
        // any other allowlisted-path miss.
        service.upstreamFallbackEnabled = true;
        await createUser(client, 'caller');
        fake.setResponse(200, '{"data":{"ok":true}}', { 'content-type': 'application/json' });

        const resp = await client.get('/v2/key-value-stores/nobody~nothing/records/we%2Fird%23key', {
            headers: auth('caller'),
        });
        expect(resp.status).toBe(200);
        expect(fake.requests.length).toBe(1);
        expect(fake.requests[0].path).toBe('/v2/key-value-stores/nobody~nothing/records/we%2Fird%23key');
    });

    it('an encoded hash or question mark in the path still replays the query', async () => {
        // Regression: the replay used to rebuild its query string from a
        // re-parse of the DECODED path concatenated with the query. Once the
        // decoded path segment contained a `#`, everything after it parsed as
        // a URL fragment instead, so the query was silently dropped; a `?` in
        // the decoded segment split the string a second time and corrupted
        // it. Both cases are exercised here WITH a real query parameter
        // present, the exact combination that previously broke: an encoded
        // `#` or `?` in the id/key segment (which the route pattern still
        // matches, so this reaches the fallback attempt) plus `?foo=bar` on
        // the same request must both survive to the upstream call
        // byte-for-byte.
        service.upstreamFallbackEnabled = true;
        await createUser(client, 'caller');
        fake.setResponse(200, '{"data":{"ok":true}}', { 'content-type': 'application/json' });

        let resp = await client.get('/v2/key-value-stores/nobody~nothing/records/we%23ird?foo=bar', {
            headers: auth('caller'),
        });
        expect(resp.status).toBe(200);
        expect(fake.requests.length).toBe(1);
        expect(fake.requests[0].path).toBe('/v2/key-value-stores/nobody~nothing/records/we%23ird?foo=bar');

        fake.requests.length = 0;
        resp = await client.get('/v2/key-value-stores/nobody~nothing/records/we%3Ford?foo=bar', {
            headers: auth('caller'),
        });
        expect(resp.status).toBe(200);
        expect(fake.requests.length).toBe(1);
        expect(fake.requests[0].path).toBe('/v2/key-value-stores/nobody~nothing/records/we%3Ford?foo=bar');
    });

    it('a write forwards content-encoding for a compressed body', async () => {
        // A write with a compressed body (apify-client 3.x sends every
        // storage write with `Content-Encoding: br` by default -- used here
        // too, via node's own zlib) must replay `Content-Encoding` upstream,
        // not just the compressed bytes -- otherwise the real API tries to
        // parse still-compressed bytes as plain JSON, the upstream call
        // fails, and the fallback's own upstream-failure-collapses-to-404
        // rule silently swallows what should have been a successful write.
        service.upstreamFallbackEnabled = true;
        await createUser(client, 'caller');
        fake.setResponse(201, '{"data":{"key":"K"}}', { 'content-type': 'application/json' });

        const compressed = zlib.brotliCompressSync(JSON.stringify({ hello: 'world' }));
        const resp = await client.put('/v2/key-value-stores/otheruser~theirs/records/K', {
            body: compressed,
            headers: { ...auth('caller'), 'content-type': 'application/json', 'content-encoding': 'br' },
        });
        expect(resp.status).toBe(201);
        expect(fake.requests.length).toBe(1);
        const seen = fake.requests[0];
        expect(seen.headers['content-encoding']).toBe('br');
        expect(seen.body.equals(compressed)).toBe(true); // replayed byte-for-byte, still compressed
    });

    it('with fallback enabled, a locally-successful write is unaffected and not proxied', async () => {
        // The body-buffering branch (`readRawBody` before dispatch in
        // src/app.js's `handle()`) runs for every allowlisted write while the
        // toggle is on -- including the common case where the write actually
        // SUCCEEDS locally (e.g. writing to a storage the caller already
        // owns), the arm every real Actor write takes. That case must never
        // reach `fetchUpstreamFallback` at all (only a local 404 does), and
        // pre-reading the body for a possible replay must not corrupt what
        // the handler itself receives: read the write back and confirm it
        // round-tripped intact.
        service.upstreamFallbackEnabled = true;
        await createUser(client, 'gwen');
        await client.post('/v2/key-value-stores', { json: { name: 'mine' }, headers: auth('gwen') });

        const resp = await client.put('/v2/key-value-stores/gwen~mine/records/K', {
            body: JSON.stringify({ hello: 'world' }),
            headers: { ...auth('gwen'), 'content-type': 'application/json' },
        });
        expect(resp.status).toBe(200);
        expect(fake.requests).toEqual([]);

        const readback = await client.get('/v2/key-value-stores/gwen~mine/records/K', { headers: auth('gwen') });
        expect(readback.status).toBe(200);
        expect(readback.json()).toEqual({ hello: 'world' });
    });

    // Base URL normalization (a trailing slash on `APIFY_UPSTREAM_BASE_URL`
    // producing a double slash in the outgoing path) is pinned at the one
    // boundary every construction path goes through --
    // config.test.js's "strips a trailing slash from the upstream base URL"
    // -- rather than here: node `http.Server`'s own request parser collapses
    // a doubled `//` before a stub handler ever sees it (a CVE mitigation,
    // gh-87389, in the Python stdlib stub this suite was ported from; the
    // same "can't discriminate at the stub" logic applies), so a same-request
    // test built on one cannot discriminate this fix from its absence, only
    // a real HTTP capture (out of scope for this Docker-free suite) or a
    // `Settings`-construction-boundary pin can.

    // ------------------------------------------------------- guardrails

    it('excludes the logs path even on a local 404', async () => {
        // `/v2/logs/...` has no real-platform analogue reachable the same way
        // -- excluded from the allowlist regardless of toggle state.
        service.upstreamFallbackEnabled = true;
        const resp = await client.get('/v2/logs/no-such-job');
        expect(resp.status).toBe(404);
        expect(fake.requests).toEqual([]);
    });

    it('excludes the bare actor collection route', async () => {
        // `POST /v2/acts` (no id yet) is a bare collection route, not a by-id
        // resource -- it is excluded from the allowlist (and never 404s
        // locally anyway, since it always creates), so it must never reach
        // upstream.
        service.upstreamFallbackEnabled = true;
        await createUser(client, 'creator');
        const resp = await client.post('/v2/acts', { json: { name: 'x' }, headers: auth('creator') });
        expect(resp.status).toBe(201);
        expect(fake.requests).toEqual([]);
    });

    it('excludes the actor-standby forwarding path', async () => {
        // `/v2/actor-standby/...` is a local-only route (container
        // forwarding), with no equivalent reachable the same way upstream.
        service.upstreamFallbackEnabled = true;
        await createUser(client, 'prober');
        const resp = await client.get('/v2/actor-standby/no-such-actor/ping', { headers: auth('prober') });
        expect(resp.status).toBe(404);
        expect(fake.requests).toEqual([]);
    });

    it('excludes an unmatched runtime-config subpath', async () => {
        // An unmatched path under `/v2/runtime-config/...` 404s via the
        // catch-all -- it must stay excluded (the toggle endpoint itself is
        // local-only, and this sub-path matches no registered route at all).
        service.upstreamFallbackEnabled = true;
        const resp = await client.get('/v2/runtime-config/nope');
        expect(resp.status).toBe(404);
        expect(fake.requests).toEqual([]);
    });

    it('never proxied when the resource exists locally', async () => {
        service.upstreamFallbackEnabled = true;
        await createUser(client, 'eve');
        await client.post('/v2/key-value-stores', { json: { name: 'mine' }, headers: auth('eve') });

        const resp = await client.get('/v2/key-value-stores/eve~mine/keys', { headers: auth('eve') });
        expect(resp.status).toBe(200);
        expect(fake.requests).toEqual([]);
    });

    it('never proxied for a non-404 local status', async () => {
        service.upstreamFallbackEnabled = true;
        await createUser(client, 'owner');
        await createUser(client, 'reader');
        const created = await client.post('/v2/key-value-stores', { json: { name: 'shared' }, headers: auth('owner') });
        const storeId = created.json().data.id;
        await client.post(`/v2/key-value-stores/${storeId}/access-rights`, {
            json: { grantee: 'reader', level: 'READ' },
            headers: auth('owner'),
        });

        // A READ grantee's write is a local 403 -- never proxied, even with
        // fallback on.
        const resp = await client.put(`/v2/key-value-stores/${storeId}/records/K`, {
            body: JSON.stringify({ v: 1 }),
            headers: { ...auth('reader'), 'content-type': 'application/json' },
        });
        expect(resp.status).toBe(403);
        expect(fake.requests).toEqual([]);
    });

    // ---------------------------------------------------- token identity

    it('forwards different callers\' different tokens', async () => {
        service.upstreamFallbackEnabled = true;
        await createUser(client, 'alice');
        await createUser(client, 'bob');
        fake.setResponse(200, '[]', { 'content-type': 'application/json' });

        await client.get('/v2/datasets/alice~nonexistent/items', { headers: auth('alice') });
        await client.get('/v2/datasets/bob~nonexistent/items', { headers: auth('bob') });
        expect(fake.requests.length).toBe(2);
        expect(fake.requests[0].headers.authorization).toBe('Bearer alice');
        expect(fake.requests[1].headers.authorization).toBe('Bearer bob');
    });

    it('forwards the real token, not the container token', async () => {
        // `resolveForwardableToken`'s own documented contract (see its
        // docstring in src/auth.js): `userForToken` matches either a user's
        // bound `token` OR their `containerToken` -- so an Actor container's
        // own injected `APIFY_TOKEN` also resolves a caller here -- but the
        // row's own real `token` is what must be forwarded upstream, never
        // the container token that happened to resolve it. Authenticate this
        // fallback-triggering request via alice's `containerToken` (exactly
        // as an apify-sdk call made from inside her Actor's own container
        // would present it) and confirm the upstream call carries alice's
        // real bound `token`, never the container token used to
        // authenticate.
        service.upstreamFallbackEnabled = true;
        await createUser(client, 'alice'); // alice.token == "alice"
        const containerToken = service.containerTokenFor('alice');
        expect(containerToken).not.toBe('alice');
        fake.setResponse(200, '[]', { 'content-type': 'application/json' });

        const resp = await client.get('/v2/datasets/alice~nonexistent/items', { headers: auth(containerToken) });
        expect(resp.status).toBe(200);
        expect(fake.requests.length).toBe(1);
        expect(fake.requests[0].headers.authorization).toBe('Bearer alice');
    });

    it('a resolved caller with no bound token proceeds headerless', async () => {
        // The third, distinct outcome of `resolveForwardableToken` (see its
        // docstring in src/auth.js): a PRESENT token that resolves to a known
        // user who has no bound `token` of their own yet must PROCEED with
        // the fallback attempt, forwarding no `Authorization` header at all
        // -- unlike a request presenting no token at all, which abandons
        // before any upstream call is made (see the anonymous-caller tests
        // below). The still-unclaimed default user, authenticated via its own
        // `containerToken` before any real token has ever been bound to it,
        // is the concrete case that reaches this arm.
        service.upstreamFallbackEnabled = true;
        service.ensureDefaultUser();
        const containerToken = service.containerTokenFor('local-user');
        const defaultUser = service.getUser('local-user');
        expect(defaultUser.token ?? null).toBeNull(); // still unclaimed -- this arm's precondition
        fake.setResponse(200, '[]', { 'content-type': 'application/json' });

        const resp = await client.get('/v2/datasets/local-user~nonexistent/items', {
            headers: auth(containerToken),
        });
        expect(resp.status).toBe(200);
        expect(fake.requests.length).toBe(1);
        expect(fake.requests[0].headers.authorization).toBeUndefined();
    });

    it('an anonymous caller never forwards while the default user is unclaimed', async () => {
        // A request presenting no `Authorization` header at all has nothing
        // to forward -- the attempt is abandoned before any upstream call is
        // made, even while the default user's own credential is still
        // unclaimed (i.e. there would be nothing sensitive to leak either
        // way). The caller sees the plain local 404, and the upstream stub is
        // never contacted.
        service.upstreamFallbackEnabled = true;
        fake.setResponse(200, '[]', { 'content-type': 'application/json' });

        const resp = await client.get('/v2/datasets/local-user~nonexistent/items'); // no Authorization header
        expect(resp.status).toBe(404);
        expect(fake.requests).toEqual([]);
    });

    it('an anonymous caller never forwards the operator\'s real bound token', async () => {
        // The dangerous case: the default user's credential is ALREADY bound
        // to a real-looking Apify secret (exactly the state after a developer
        // has logged in once via apify-cli). A request presenting no
        // credential at all must still be abandoned before any upstream call
        // is attempted -- it must never borrow that bound token on the
        // anonymous caller's behalf. The stub must receive zero requests and
        // the caller must get the plain local 404, regardless of whose
        // credential the default user happens to hold.
        const bootstrap = await client.get('/v2/users/me', { headers: auth('apify_api_REALSECRET') });
        expect(bootstrap.status).toBe(200);
        expect(bootstrap.json().data.token).toBe('apify_api_REALSECRET');

        service.upstreamFallbackEnabled = true;
        fake.setResponse(200, '[]', { 'content-type': 'application/json' });

        const resp = await client.get('/v2/datasets/local-user~nonexistent/items'); // no Authorization header
        expect(resp.status).toBe(404);
        expect(fake.requests).toEqual([]); // the operator's real token never left the process
    });

    it('an anonymous caller never forwards on the SPA catch-all', async () => {
        // Companion to the unresolvable-token SPA-catch-all tests above: the
        // unauthenticated catch-all path must also never forward for a
        // request presenting no credential at all, even with the default
        // user's credential already bound to a real-looking token.
        const bootstrap = await client.get('/v2/users/me', { headers: auth('apify_api_REALSECRET') });
        expect(bootstrap.status).toBe(200);

        service.upstreamFallbackEnabled = true;
        fake.setResponse(200, '[]', { 'content-type': 'application/json' });

        const resp = await client.get('/v2/actors/someuser~someactor/no-such-nested-path'); // no Authorization header
        expect(resp.status).toBe(404);
        expect(resp.json().error.type).toBe('record-not-found');
        expect(fake.requests).toEqual([]);
    });

    // ---------------------- toggle + fallback layer wired together

    it('toggling via the runtime-config endpoint enables fallback immediately', async () => {
        await createUser(client, 'caller');
        fake.setResponse(200, '[]', { 'content-type': 'application/json' });

        const before = await client.get('/v2/datasets/nobody~nothing/items', { headers: auth('caller') });
        expect(before.status).toBe(404);
        expect(fake.requests).toEqual([]);

        // The toggle itself is flipped anonymously here on purpose -- PUT
        // /v2/runtime-config falls back to the default user for its own
        // token-validity check, same as every other mutating endpoint (see
        // requirements/api.md's "Upstream fallback" section); it is the
        // SUBSEQUENT request's own presented token that decides whether
        // anything gets forwarded.
        const put = await client.put('/v2/runtime-config', { json: { upstreamFallbackEnabled: true } });
        expect(put.status).toBe(200);

        const after = await client.get('/v2/datasets/nobody~nothing/items', { headers: auth('caller') });
        expect(after.status).toBe(200);
        expect(fake.requests.length).toBe(1);
    });

    it('toggling off stops further fallback attempts mid-session', async () => {
        service.upstreamFallbackEnabled = true;
        await createUser(client, 'caller');
        fake.setResponse(200, '[]', { 'content-type': 'application/json' });

        const first = await client.get('/v2/datasets/nobody~nothing/items', { headers: auth('caller') });
        expect(first.status).toBe(200);
        expect(fake.requests.length).toBe(1);

        const off = await client.put('/v2/runtime-config', { json: { upstreamFallbackEnabled: false } });
        expect(off.status).toBe(200);

        const second = await client.get('/v2/datasets/nobody~nothing/items', { headers: auth('caller') });
        expect(second.status).toBe(404);
        expect(fake.requests.length).toBe(1); // no new attempt
    });
});

// ------------------------------------- fallback: malformed upstream base URL

describe('upstream fallback with a malformed base URL', () => {
    let ctx;

    beforeEach(async () => {
        // Like `wireUpstream`, but `apifyUpstreamBaseUrl` is malformed in a
        // way undici rejects while BUILDING the request (before any
        // connection is attempted) -- simulating a misconfigured
        // `APIFY_UPSTREAM_BASE_URL` (e.g. missing scheme, unparsable host).
        // No fake server needed: the failure happens before any network I/O.
        const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'actor-runtime-upstream-'));
        ctx = await wire({ settings: makeSettings(tmpDir, { apifyUpstreamBaseUrl: 'http://[::1' }), tmpDir });
        upstreamSpy.calls.length = 0;
    });

    afterEach(async () => {
        await ctx.close();
        vi.restoreAllMocks();
    });

    it('a malformed upstream base URL collapses to the local 404', async () => {
        // The invalid-URL error is raised while undici builds the outgoing
        // request -- not a network error -- so a misconfigured
        // `APIFY_UPSTREAM_BASE_URL` must still collapse to the original local
        // 404 like every other fallback failure, not crash the request.
        //
        // A resolvable, presented token is required to reach that code at all
        // -- with no token at all `resolveForwardableToken` returns `null`
        // and `fetchUpstreamFallback` abandons before the malformed URL is
        // ever handed to undici, so this would pass for the wrong reason
        // without one. The undici `request` spy proves the malformed URL
        // genuinely reached undici instead.
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { client, service } = ctx;
        await createUser(client, 'caller');
        const localOnly = await client.get('/v2/key-value-stores/nobody~nothing/keys', { headers: auth('caller') });
        expect(localOnly.status).toBe(404);
        const localBody = localOnly.json();

        service.upstreamFallbackEnabled = true;
        const resp = await client.get('/v2/key-value-stores/nobody~nothing/keys', { headers: auth('caller') });
        expect(resp.status).toBe(404);
        expect(resp.json()).toEqual(localBody);
        // undici genuinely got the malformed URL, not abandoned pre-dial.
        expect(dialAttempts(ctx).length).toBe(1);
        warnSpy.mockRestore();
    });
});

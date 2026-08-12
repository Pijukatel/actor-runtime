/**
 * Standby-actor coverage: opt-in parsing, standbyUrl, env-dict alignment,
 * forwarding/readiness/auth/visibility, and idle reap -- all Docker-free via
 * the in-process `wire` helpers (StubDriver + FakeStandbyServer, see
 * tests/helpers.js). Ported from tests/unit/test_standby.py.
 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ApifyClient } from 'apify-client';
import { request as undiciRequest } from 'undici';
import { afterEach, describe, expect, it } from 'vitest';

import { authHeaders as auth, makeSettings, wire } from '../helpers.js';

const NOT_FOUND = 'record-not-found';

function sleep(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

let ctx;

afterEach(async () => {
    await ctx?.close();
    ctx = undefined;
});

/** `wire()` with settings overrides applied on a fresh temp dir. */
async function wireWith(overrides = {}) {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'actor-runtime-test-'));
    return wire({ settings: makeSettings(tmpDir, overrides), tmpDir });
}

/**
 * Like `wire()` but with a near-instant standby idle timeout and a short
 * readiness-wait bound, for deterministic idle-reap and never-ready tests
 * (criteria that would otherwise need multi-second/minute real waits).
 *
 * Unlike the Python fixture (whose ASGI test transport never ran the app's
 * lifespan, so no watchdog ever started), `createApp` starts the background
 * idle-reap watchdog at boot -- stop it here so a 0.2s-idle run is only ever
 * reaped when a test drives a reap pass (or restarts the watchdog) itself.
 */
async function wireFastStandby() {
    const wired = await wireWith({ standbyIdleOverrideSecs: 0.2, standbyReadyTimeoutSecs: 1.0 });
    wired.service.stopStandbyWatchdog();
    return wired;
}

async function createUser(client, name) {
    await client.post('/v2/users', { json: { name } });
}

function standbyManifest(name, usesStandbyMode = true) {
    return JSON.stringify({
        actorSpecification: 1,
        name,
        version: '0.0',
        buildTag: 'latest',
        usesStandbyMode,
    });
}

/**
 * Push an Actor (creating `token` as a user first) and return its serialized
 * body.
 *
 * `manifest` (if given) is written inline as `.actor/actor.json`, exactly as
 * `apify push` would send it -- this is how standby opt-in is signalled.
 */
async function pushActor(client, token, { name = 'an-actor', manifest = null, actorStandby = null } = {}) {
    await createUser(client, token);
    const sourceFiles = [{ name: 'main.py', format: 'TEXT', content: "print('hi')\n" }];
    if (manifest !== null) {
        sourceFiles.push({ name: '.actor/actor.json', format: 'TEXT', content: manifest });
    }
    const body = {
        name,
        versions: [{ versionNumber: '0.0', sourceType: 'SOURCE_FILES', sourceFiles }],
    };
    if (actorStandby !== null) {
        body.actorStandby = actorStandby;
    }
    const resp = await client.post('/v2/acts', { json: body, headers: auth(token) });
    return resp.json().data;
}

async function buildActor(client, service, actorId, token) {
    const build = (await client.post(`/v2/acts/${actorId}/builds?version=0.0`, { headers: auth(token) })).json().data;
    await service.waitIdle();
    return build;
}

async function provisionStandbyActor(client, service, token, name = 'standby-actor') {
    const actor = await pushActor(client, token, { name, manifest: standbyManifest(name) });
    await buildActor(client, service, actor.id, token);
    return actor.id;
}

async function provisionOndemandRun(client, service, token, { name = 'on-demand-actor', greeting = 'hi' } = {}) {
    const actor = await pushActor(client, token, { name });
    await buildActor(client, service, actor.id, token);
    let run = (
        await client.post(`/v2/acts/${actor.id}/runs`, {
            body: JSON.stringify({ greeting }),
            headers: { ...auth(token), 'content-type': 'application/json' },
        })
    ).json().data;
    await service.waitIdle();
    run = (await client.get(`/v2/actor-runs/${run.id}`, { headers: auth(token) })).json().data;
    return [actor.id, run];
}

async function listRuns(client, actorId, token) {
    return (await client.get(`/v2/acts/${actorId}/runs`, { headers: auth(token) })).json().data.items;
}

// -- A. Standby opt-in and actor metadata -----------------------------------
describe('standby opt-in and actor metadata', () => {
    it('actor.json usesStandbyMode enables standby and standbyUrl', async () => {
        ctx = await wire();
        const { client, service } = ctx;
        const actorId = await provisionStandbyActor(client, service, 'alice');
        const actor = (await client.get(`/v2/actors/${actorId}`, { headers: auth('alice') })).json().data;
        expect(actor.standbyUrl).toBe(`http://actor-runtime:3333/v2/actor-standby/${actorId}`);
    });

    it('actor without usesStandbyMode has no standbyUrl', async () => {
        ctx = await wire();
        const actor = await pushActor(ctx.client, 'bob', { name: 'plain-actor' });
        expect('standbyUrl' in actor).toBe(false);
    });

    it('explicit API field overrides actor.json in the same push', async () => {
        // apify-core's own precedence rule: the API payload's `actorStandby`
        // always wins over `.actor/actor.json`'s `usesStandbyMode` when both
        // are present on the SAME create call.
        ctx = await wire();
        const actor = await pushActor(ctx.client, 'carol', {
            name: 'override-actor',
            manifest: standbyManifest('override-actor', true),
            actorStandby: { isEnabled: false },
        });
        expect('standbyUrl' in actor).toBe(false);
    });

    it('explicit override persists across a later actor.json-only push', async () => {
        // Regression: design decision 2 states an explicit `actorStandby`
        // field "persists until the next call that carries an explicit
        // actorStandby field" -- a LATER push that carries only
        // `.actor/actor.json` (no `actorStandby` field on that call) must not
        // silently revert a previously-set explicit override by re-inferring
        // from `usesStandbyMode`.
        ctx = await wire();
        const { client } = ctx;
        const manifest = standbyManifest('explicit-actor', true);

        // Call 1: explicit override disables standby even though actor.json
        // says usesStandbyMode: true.
        let actor = await pushActor(client, 'erin', {
            name: 'explicit-actor',
            manifest,
            actorStandby: { isEnabled: false },
        });
        expect('standbyUrl' in actor).toBe(false);

        // Call 2: a plain actor.json-only push (no actorStandby field at all)
        // -- must NOT re-enable standby by inferring from usesStandbyMode
        // again.
        actor = await pushActor(client, 'erin', { name: 'explicit-actor', manifest });
        expect('standbyUrl' in actor).toBe(false);

        // A THIRD call with its own explicit field still takes precedence
        // (the override is not permanently frozen, only sticky until the next
        // explicit call, exactly as decision 2 says).
        actor = await pushActor(client, 'erin', {
            name: 'explicit-actor',
            manifest,
            actorStandby: { isEnabled: true },
        });
        expect(actor.standbyUrl).toBeTruthy();
    });

    it('non-standby actor behaves exactly as before', async () => {
        // Regression: an Actor pushed without usesStandbyMode still runs
        // on-demand, with no standby container and no standbyUrl.
        ctx = await wire();
        const { client, service } = ctx;
        const [actorId, run] = await provisionOndemandRun(client, service, 'dave');
        expect(run.status).toBe('SUCCEEDED');
        const actor = (await client.get(`/v2/actors/${actorId}`, { headers: auth('dave') })).json().data;
        expect('standbyUrl' in actor).toBe(false);
    });

    it('standbyUrl discovery is generic via the real apify-client Actor model', async () => {
        // Design decision 7: callers must read the standby URL off the fetched
        // Actor's `standbyUrl` attribute via the real apify-client package,
        // never a raw hand-rolled request. Validated here for two standby
        // Actors and one non-standby Actor by round-tripping each through the
        // real npm `apify-client` (which, unlike the Python client's strict
        // pydantic model, passes the parsed JSON through -- the discovery
        // contract asserted is identical).
        ctx = await wire();
        const { client, service } = ctx;
        const actorIdOne = await provisionStandbyActor(client, service, 'frank', 'standby-actor-one');
        const actorIdTwo = await provisionStandbyActor(client, service, 'frank', 'standby-actor-two');
        const plainActor = await pushActor(client, 'frank', { name: 'plain-actor-for-model-check' });

        const apifyClient = new ApifyClient({ baseUrl: ctx.baseUrl, token: 'frank' });
        const modelOne = await apifyClient.actor(actorIdOne).get();
        const modelTwo = await apifyClient.actor(actorIdTwo).get();
        const modelPlain = await apifyClient.actor(plainActor.id).get();

        // Distinct, correct per-Actor-id URLs -- proves the discovery
        // mechanism generalizes over N standby Actors rather than one
        // hardcoded case.
        expect(modelOne.standbyUrl).toBe(`http://actor-runtime:3333/v2/actor-standby/${actorIdOne}`);
        expect(modelTwo.standbyUrl).toBe(`http://actor-runtime:3333/v2/actor-standby/${actorIdTwo}`);
        expect(modelOne.standbyUrl).not.toBe(modelTwo.standbyUrl);

        // A non-standby Actor's response still resolves cleanly through the
        // same client, with no standbyUrl (absent on the wire).
        expect(modelPlain.standbyUrl).toBeUndefined();

        // Each Actor's own standbyUrl must route to THAT Actor's own warm
        // container, not a shared one: call each Actor's path directly (same
        // in-process app, host/port already asserted equal above) and confirm
        // each cold-starts independently -- counter starts at 1 for both.
        const pathOne = new URL(modelOne.standbyUrl).pathname;
        const pathTwo = new URL(modelTwo.standbyUrl).pathname;
        const respOneA = await client.get(`${pathOne}/echo`, { headers: auth('frank') });
        const respTwoA = await client.get(`${pathTwo}/echo`, { headers: auth('frank') });
        expect(respOneA.json().requestCount).toBe(1);
        expect(respTwoA.json().requestCount).toBe(1);

        // A repeat call reuses each Actor's own warm container (counter -> 2)
        // without affecting the other's -- traffic never crosses between them.
        const respOneB = await client.get(`${pathOne}/echo`, { headers: auth('frank') });
        const respTwoB = await client.get(`${pathTwo}/echo`, { headers: auth('frank') });
        expect(respOneB.json().requestCount).toBe(2);
        expect(respTwoB.json().requestCount).toBe(2);
    });
});

// -- D. Environment-variable alignment --------------------------------------
describe('environment-variable alignment', () => {
    it('env dict alignment for every run', async () => {
        ctx = await wire();
        const { client, service } = ctx;
        const [actorId, run] = await provisionOndemandRun(client, service, 'alice');
        const env = service.driver.capturedEnvs.at(-1);

        expect(env.APIFY_IS_AT_HOME).toBe('1');
        expect(env.APIFY_API_BASE_URL).toBe('http://actor-runtime:3333');
        expect(env.APIFY_META_ORIGIN).toBe('API');

        expect(env.APIFY_DEFAULT_KEY_VALUE_STORE_ID).toBe(run.defaultKeyValueStoreId);
        expect(env.APIFY_DEFAULT_DATASET_ID).toBe(run.defaultDatasetId);
        expect(env.APIFY_DEFAULT_REQUEST_QUEUE_ID).toBe(run.defaultRequestQueueId);

        expect(env.ACTOR_ID).toBe(actorId);
        expect(env.APIFY_ACTOR_ID).toBe(actorId);
        expect(env.ACTOR_RUN_ID).toBe(run.id);
        expect(env.APIFY_ACTOR_RUN_ID).toBe(run.id);

        // APIFY_TOKEN is a WORKING bearer credential for the owner, distinct
        // from the bound token ("alice") used to authenticate the calls above.
        expect(env.APIFY_TOKEN).not.toBe('alice');
        const me = (await client.get('/v2/users/me', { headers: auth(env.APIFY_TOKEN) })).json().data;
        expect(me.username).toBe('alice');
    });

    it('APIFY_TOKEN env tracks the owner across users', async () => {
        // The container token is per-owner, not a constant -- exercised for
        // two different users so the value is shown to track ownership, not
        // be fixed.
        ctx = await wire();
        const { client, service } = ctx;
        await provisionOndemandRun(client, service, 'alice');
        const tokenAlice = service.driver.capturedEnvs.at(-1).APIFY_TOKEN;
        await provisionOndemandRun(client, service, 'bob');
        const tokenBob = service.driver.capturedEnvs.at(-1).APIFY_TOKEN;
        expect(tokenAlice).not.toBe(tokenBob);

        const meAlice = (await client.get('/v2/users/me', { headers: auth(tokenAlice) })).json().data;
        const meBob = (await client.get('/v2/users/me', { headers: auth(tokenBob) })).json().data;
        expect(meAlice.username).toBe('alice');
        expect(meBob.username).toBe('bob');
    });

    it('APIFY_PROXY_PASSWORD reaches the actor container when configured', async () => {
        // `Settings.apifyProxyPassword` (from `APIFY_PROXY_PASSWORD` in the
        // runtime's own environment, see `loadSettings`) is forwarded into
        // the Actor container unchanged. On-demand and standby runs share
        // `buildEnvironment`, so this on-demand run exercises the single
        // choke point both paths funnel through.
        ctx = await wireWith({ apifyProxyPassword: 'dummy-proxy-password' });
        const { client, service } = ctx;
        await provisionOndemandRun(client, service, 'alice');
        const env = service.driver.capturedEnvs.at(-1);
        expect(env.APIFY_PROXY_PASSWORD).toBe('dummy-proxy-password');
    });

    it('APIFY_PROXY_PASSWORD is absent when not configured', async () => {
        // The default (no `APIFY_PROXY_PASSWORD` in the runtime's own
        // environment) must never inject a placeholder/fake value into the
        // Actor container -- the key is simply absent.
        ctx = await wire();
        const { client, service } = ctx;
        await provisionOndemandRun(client, service, 'alice');
        const env = service.driver.capturedEnvs.at(-1);
        expect('APIFY_PROXY_PASSWORD' in env).toBe(false);
    });
});

// -- B. Warm start, readiness, forwarding, authorization --------------------
describe('standby warm start, readiness, forwarding, authorization', () => {
    it('cold start forwards and reuses the warm container', async () => {
        ctx = await wireFastStandby();
        const { client, service } = ctx;
        const actorId = await provisionStandbyActor(client, service, 'alice');

        // Before any request: no run yet.
        let runs = await listRuns(client, actorId, 'alice');
        expect(runs).toEqual([]);

        const resp1 = await client.get(`/v2/actor-standby/${actorId}/echo?greeting=hi`, { headers: auth('alice') });
        expect(resp1.status).toBe(200);
        const body1 = resp1.json();
        expect(body1.method).toBe('GET');
        expect(body1.path).toBe('/echo?greeting=hi');
        expect(body1.requestCount).toBe(1);

        // Standby-origin runs carry the platform-documented mode signal, so
        // an Actor can branch on standby vs standard start.
        const standbyEnv = service.driver.capturedEnvs.at(-1);
        expect(standbyEnv.APIFY_META_ORIGIN).toBe('STANDBY');
        expect(standbyEnv.ACTOR_STANDBY_PORT).toBeTruthy();

        runs = await listRuns(client, actorId, 'alice');
        expect(runs.length).toBe(1);
        expect(runs[0].status).toBe('RUNNING');
        const firstRunId = runs[0].id;

        // Second request while still warm reuses the SAME container: no new
        // run, and the fake Actor's in-memory counter proves it's the same
        // process.
        const resp2 = await client.get(`/v2/actor-standby/${actorId}/echo?greeting=hi`, { headers: auth('alice') });
        expect(resp2.json().requestCount).toBe(2);
        runs = await listRuns(client, actorId, 'alice');
        expect(runs.length).toBe(1);
        expect(runs[0].id).toBe(firstRunId);
    });

    it('forwards method, headers, query and body exactly', async () => {
        ctx = await wireFastStandby();
        const { client, service } = ctx;
        const actorId = await provisionStandbyActor(client, service, 'alice');
        const resp = await client.post(`/v2/actor-standby/${actorId}/submit?x=1&y=2`, {
            body: JSON.stringify({ hello: 'world' }),
            headers: { ...auth('alice'), 'content-type': 'application/json', 'x-custom-header': 'abc123' },
        });
        expect(resp.status).toBe(200);
        const body = resp.json();
        expect(body.method).toBe('POST');
        expect(body.path).toBe('/submit?x=1&y=2');
        expect(JSON.parse(body.body)).toEqual({ hello: 'world' });
        expect(body.headers['x-custom-header']).toBe('abc123');
    });

    it('forwarding preserves encoded hash and question mark in the sub-path', async () => {
        // Regression (from the Python predecessor): building the forwarded
        // target from the router's already-percent-decoded path would decode
        // a caller's encoded `#`/`?` sub-path bytes to literal characters --
        // the decoded `#` truncates everything after it as a URL fragment
        // (dropping the real query string entirely) and the decoded `?`
        // splits the string a second time, corrupting it further. The fix
        // (`rawForwardTarget`, built from the raw wire bytes of `req.url`)
        // must forward the sub-path and query byte-for-byte instead, matching
        // the same class of fix already applied to the upstream-fallback
        // proxy (src/upstream.js). fetch preserves the pre-encoded URL on the
        // wire, so this exercises the real socket path end to end.
        ctx = await wireFastStandby();
        const { client, service } = ctx;
        const actorId = await provisionStandbyActor(client, service, 'alice');
        const resp = await client.get(`/v2/actor-standby/${actorId}/weird%23name%3Fmore?real=value`, {
            headers: auth('alice'),
        });
        expect(resp.status).toBe(200);
        const body = resp.json();
        expect(body.path).toBe('/weird%23name%3Fmore?real=value');
    });

    it('forwarding falls back to the re-quoted decoded path when the raw prefix does not literally match', async () => {
        // Port of the Python "raw_path absent" fallback test. Node always
        // supplies the raw request target (`req.url`), so the Python
        // scenario (a hand-built ASGI scope with no `raw_path` at all)
        // cannot occur here -- but the SAME fallback contract has a real,
        // wire-reachable JS analog: a caller may percent-encode bytes of the
        // fixed `/v2/actor-standby/` prefix itself (here `%2D` for the `-`).
        // The router's DECODED matching still routes it as a standby request,
        // but the raw byte-offset extraction no longer applies, so
        // `rawForwardTarget` must fall back to re-quoting the decoded `*path`
        // param (lossy for a literal-vs-encoded `#`, but usable) with the
        // query intact -- instead of silently forwarding to the endpoint
        // root and dropping the sub-path.
        ctx = await wireFastStandby();
        const { client, service } = ctx;
        const actorId = await provisionStandbyActor(client, service, 'alice');

        const resp = await client.get(`/v2/actor%2Dstandby/${actorId}/weird%23name?real=value`, {
            headers: auth('alice'),
        });
        expect(resp.status).toBe(200);
        expect(resp.json().path).toBe('/weird%23name?real=value');
    });

    it('unset memory config caps the container at the same 1024 default', async () => {
        // Regression: an unset `memoryMbytes` in the Actor's standby config
        // must resolve to the SAME 1024 MB default in both the persisted
        // `run.options.memoryMbytes` (what the API reports) and the actual
        // value passed to the driver's `start()` (what would really cap the
        // container) -- previously these diverged, so a standby actor with no
        // explicit memory config ran genuinely uncapped despite the API
        // reporting a 1024 MB cap.
        ctx = await wireFastStandby();
        const { client, service } = ctx;
        const actorId = await provisionStandbyActor(client, service, 'alice');

        const resp = await client.get(`/v2/actor-standby/${actorId}/echo`, { headers: auth('alice') });
        expect(resp.status).toBe(200);

        const runs = await listRuns(client, actorId, 'alice');
        expect(runs[0].options.memoryMbytes).toBe(1024);
        expect(service.driver.capturedMemLimits.at(-1)).toBe(1024);
    });

    it('response streams incrementally, not fully buffered', async () => {
        // The forwarded response must reach the caller as it arrives, not be
        // fully buffered by the runtime before the first byte is returned.
        // The fake standby target's `/stream-slow` path (see FakeStandbyServer
        // in tests/helpers.js) writes its body in three flushed chunks with a
        // real 0.3s delay between them and closes the connection instead of
        // declaring Content-Length. Unlike the Python suite (whose test
        // transport buffered streamed responses, forcing a direct router-
        // function call), the JS server streams for real over the loopback
        // socket -- so read the chunks off a plain fetch with timestamps: if
        // the proxy buffered the whole body before returning anything, the
        // first chunk would arrive at (approximately) the same time as the
        // last one (~0.9s); observing it arrive well before that proves the
        // proxy forwards bytes as they arrive instead.
        ctx = await wireFastStandby();
        const { client, service, baseUrl } = ctx;
        const actorId = await provisionStandbyActor(client, service, 'alice');

        const resp = await fetch(`${baseUrl}/v2/actor-standby/${actorId}/stream-slow`, { headers: auth('alice') });
        expect(resp.status).toBe(200);

        const start = Date.now();
        const chunkTimes = [];
        const chunks = [];
        const reader = resp.body.getReader();
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            chunkTimes.push(Date.now() - start);
            chunks.push(Buffer.from(value));
        }

        expect(Buffer.concat(chunks).toString('utf8')).toBe('chunk-1\nchunk-2\nchunk-3\n');
        expect(chunkTimes.length, String(chunkTimes)).toBeGreaterThanOrEqual(2);
        // A comfortable margin below the total elapsed time absorbs
        // scheduling jitter without making the test flaky, while still
        // failing decisively if the whole body were buffered before any of it
        // were returned.
        expect(chunkTimes[0], String(chunkTimes)).toBeLessThan(chunkTimes.at(-1) - 250);
    });

    it('preserves repeated header names in both directions', async () => {
        // Regression: forwarding must not silently drop repeated header names
        // in either direction -- a plain object/dict keeps only the LAST
        // value for a duplicated header name (e.g. two Cookie headers from
        // the caller, or two Set-Cookie headers from the standby Actor),
        // contradicting the "headers... unchanged" forwarding guarantee.
        // Driven over the real socket with undici's raw-header-pairs client
        // (fetch's Headers object would coalesce the two Cookie headers
        // before they ever hit the wire), instead of the Python suite's
        // direct-router-call workaround.
        ctx = await wireFastStandby();
        const { client, service, baseUrl } = ctx;
        const actorId = await provisionStandbyActor(client, service, 'alice');

        const upstream = await undiciRequest(`${baseUrl}/v2/actor-standby/${actorId}/multi-header`, {
            method: 'GET',
            headers: ['authorization', 'Bearer alice', 'cookie', 'a=1', 'cookie', 'b=2'],
        });
        expect(upstream.statusCode).toBe(200);

        // Response side: the fake standby target sent two Set-Cookie headers
        // -- both must reach the original caller, not just the last one.
        expect(upstream.headers['set-cookie']).toEqual(['a=1', 'b=2']);

        // Request side: the fake standby target echoes exactly what it
        // received as an ordered list of pairs (never collapsed into an
        // object) -- both Cookie headers sent by the caller must have reached
        // it.
        const received = JSON.parse(await upstream.body.text()).receivedHeaderPairs;
        const cookieValues = received.filter(([name]) => name.toLowerCase() === 'cookie').map(([, value]) => value);
        expect(cookieValues, JSON.stringify(received)).toEqual(['a=1', 'b=2']);
    });

    it('never-ready container returns 503, does not hang', async () => {
        ctx = await wireFastStandby();
        const { client, service } = ctx;
        const actorId = await provisionStandbyActor(client, service, 'alice');
        service.driver.nextStartNeverReady = true;

        const resp = await client.get(`/v2/actor-standby/${actorId}/echo`, { headers: auth('alice') });
        expect(resp.status).toBe(503);

        // The failed attempt reaches a terminal status, never stuck RUNNING.
        const runs = await listRuns(client, actorId, 'alice');
        expect(runs.length).toBeGreaterThan(0);
        expect(runs[0].status).toBe('FAILED');
    });

    it('never-ready timeout is bounded by the configured setting', async () => {
        // Regression: the readiness wait's per-attempt probe timeout must
        // scale with `settings.standbyReadyTimeoutSecs`, not be a fixed 5.0s
        // -- otherwise a container that accepts the TCP connection but hangs
        // before answering the readiness probe can make a single attempt
        // block for the full fixed timeout regardless of a shrunk configured
        // budget, so the configured value would not be a true upper bound on
        // the total wait.
        //
        // `wireFastStandby` sets `standbyReadyTimeoutSecs` to 1.0s. The fake
        // standby server is made to hang for 8s before answering every
        // readiness probe -- well past both the 1.0s configured budget and
        // the old hardcoded 5.0s per-attempt timeout. With the fix, the whole
        // call must still return (503, never hang) within a couple of the
        // configured seconds; an unbounded-by-setting 5.0s per-attempt
        // timeout would instead make this take at least ~5s.
        ctx = await wireFastStandby();
        const { client, service } = ctx;
        const actorId = await provisionStandbyActor(client, service, 'alice');
        service.driver.nextStartReadinessHangSecs = 8.0;

        const started = Date.now();
        const resp = await client.get(`/v2/actor-standby/${actorId}/echo`, { headers: auth('alice') });
        const elapsedSecs = (Date.now() - started) / 1000;

        expect(resp.status).toBe(503);
        // Bounded by (a small multiple of) the configured 1.0s readiness
        // timeout, not a hardcoded 5.0s-per-attempt probe timeout.
        expect(elapsedSecs, String(elapsedSecs)).toBeLessThan(3.0);
    });

    it('start infra failure is 500, not 404', async () => {
        // Regression: a `driver.start()` infrastructure failure (e.g. the
        // shared Docker network never coming up at boot) must not collapse
        // into the same 404 used for "actor has no successful build" -- the
        // build is fine, only launching its container failed, for a reason a
        // developer debugging a "why won't my standby actor start" problem
        // should not be misled about by a not-found response. It must surface
        // as a 5xx naming the real cause.
        ctx = await wireFastStandby();
        const { client, service } = ctx;
        const actorId = await provisionStandbyActor(client, service, 'alice');

        service.driver.start = () => {
            throw new Error('simulated docker network failure');
        };

        const resp = await client.get(`/v2/actor-standby/${actorId}/echo`, { headers: auth('alice') });
        expect(resp.status).toBe(500);
        expect(resp.json().error.type).not.toBe(NOT_FOUND);
        expect(resp.json().error.message).toContain('simulated docker network failure');

        // The failed attempt still reaches a terminal status, never stuck
        // RUNNING.
        const runs = await listRuns(client, actorId, 'alice');
        expect(runs.length).toBeGreaterThan(0);
        expect(runs[0].status).toBe('FAILED');
    });

    it('missing token is 401 and starts nothing', async () => {
        ctx = await wireFastStandby();
        const { client, service } = ctx;
        const actorId = await provisionStandbyActor(client, service, 'alice');

        const resp = await client.get(`/v2/actor-standby/${actorId}/echo`);
        expect(resp.status).toBe(401);

        const runs = await listRuns(client, actorId, 'alice');
        expect(runs).toEqual([]);
    });

    it('unknown token after bootstrap is 401 and starts nothing', async () => {
        ctx = await wireFastStandby();
        const { client, service } = ctx;
        const actorId = await provisionStandbyActor(client, service, 'alice');
        await client.get('/v2/users/me', { headers: auth('claim-tok') }); // claim the bootstrap slot

        const resp = await client.get(`/v2/actor-standby/${actorId}/echo`, { headers: auth('totally-unknown') });
        expect(resp.status).toBe(401);

        const runs = await listRuns(client, actorId, 'alice');
        expect(runs).toEqual([]);
    });

    it('accepts a query token the same as bearer', async () => {
        ctx = await wireFastStandby();
        const { client, service } = ctx;
        const actorId = await provisionStandbyActor(client, service, 'alice');
        const resp = await client.get(`/v2/actor-standby/${actorId}/echo?token=alice`);
        expect(resp.status).toBe(200);
    });

    it('cross-user access is not-found and starts nothing', async () => {
        ctx = await wireFastStandby();
        const { client, service } = ctx;
        const actorId = await provisionStandbyActor(client, service, 'alice');
        await createUser(client, 'bob');

        const resp = await client.get(`/v2/actor-standby/${actorId}/echo`, { headers: auth('bob') });
        expect(resp.status).toBe(404);
        expect(resp.json().error.type).toBe(NOT_FOUND);

        const runs = await listRuns(client, actorId, 'alice');
        expect(runs).toEqual([]);
    });

    it('unknown actor id is not-found', async () => {
        ctx = await wireFastStandby();
        const resp = await ctx.client.get('/v2/actor-standby/local-user~does-not-exist/echo', {
            headers: auth('whoever'),
        });
        expect(resp.status).toBe(404);
        expect(resp.json().error.type).toBe(NOT_FOUND);
    });

    it('non-standby actor is not-found and starts nothing', async () => {
        ctx = await wireFastStandby();
        const { client, service } = ctx;
        const actor = await pushActor(client, 'alice', { name: 'plain-actor' });
        await buildActor(client, service, actor.id, 'alice');

        const resp = await client.get(`/v2/actor-standby/${actor.id}/echo`, { headers: auth('alice') });
        expect(resp.status).toBe(404);
        expect(resp.json().error.type).toBe(NOT_FOUND);

        const runs = await listRuns(client, actor.id, 'alice');
        expect(runs).toEqual([]);
    });

    it('concurrent first requests start exactly one container', async () => {
        ctx = await wireFastStandby();
        const { client, service } = ctx;
        const actorId = await provisionStandbyActor(client, service, 'alice');

        const results = await Promise.all(
            Array.from({ length: 5 }, () => client.get(`/v2/actor-standby/${actorId}/echo`, { headers: auth('alice') })),
        );
        expect(results.every((r) => r.status === 200)).toBe(true);

        const runs = await listRuns(client, actorId, 'alice');
        expect(runs.length).toBe(1);
    });
});

// -- C. Idle timeout and teardown --------------------------------------------
describe('standby idle timeout and teardown', () => {
    it('reapIdleStandbyRuns single pass is deterministic', async () => {
        // A single, directly-invoked reap pass (no background timing
        // involved) -- proves the countdown logic itself, independent of the
        // watchdog's own loop.
        ctx = await wireFastStandby();
        const { client, service } = ctx;
        const actorId = await provisionStandbyActor(client, service, 'alice');

        const resp = await client.get(`/v2/actor-standby/${actorId}/echo`, { headers: auth('alice') });
        expect(resp.status).toBe(200);

        await sleep(250); // exceed the fixture's 0.2s idle-timeout override
        await service.reapIdleStandbyRuns();

        const runs = await listRuns(client, actorId, 'alice');
        expect(runs[0].status).toBe('ABORTED');
    });

    it('idle teardown captures the container log', async () => {
        // Regression: a standby run has no live log sink like the blocking
        // one-shot run path, so its container's stdout/stderr must be fetched
        // explicitly at reap/teardown time instead of leaving run.log
        // permanently empty for the run's whole warm lifetime.
        ctx = await wireFastStandby();
        const { client, service } = ctx;
        const actorId = await provisionStandbyActor(client, service, 'alice');

        const resp = await client.get(`/v2/actor-standby/${actorId}/echo`, { headers: auth('alice') });
        expect(resp.status).toBe(200);
        const runs = await listRuns(client, actorId, 'alice');
        const runId = runs[0].id;

        await sleep(250); // exceed the fixture's 0.2s idle-timeout override
        await service.reapIdleStandbyRuns();

        const log = (await client.get(`/v2/logs/${runId}`, { headers: auth('alice') })).text();
        expect(log).toContain(`stub container log for ${service.containerName(runId)}`);
        expect(log).toContain('Standby Actor stopped after idle timeout.');
        // Runtime-written log lines carry a UTC timestamp prefix (container
        // output gets its own per-line timestamps from Docker, which stubs
        // don't emulate).
        expect(log).toMatch(
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z Standby Actor stopped after idle timeout\.$/m,
        );
    });

    it('warm run log is live-fetched from the container', async () => {
        // Regression: while a standby run is warm (RUNNING) its log exists
        // only inside the container -- the log endpoint must fetch it live
        // instead of serving the empty stored log until teardown persists it.
        ctx = await wireFastStandby();
        const { client, service } = ctx;
        const actorId = await provisionStandbyActor(client, service, 'alice');

        const resp = await client.get(`/v2/actor-standby/${actorId}/echo`, { headers: auth('alice') });
        expect(resp.status).toBe(200);
        const runs = await listRuns(client, actorId, 'alice');
        const runId = runs[0].id;
        expect(runs[0].status).toBe('RUNNING');

        const log = (await client.get(`/v2/logs/${runId}`, { headers: auth('alice') })).text();
        expect(log).toContain(`stub container log for ${service.containerName(runId)}`);
    });

    it('reapIdleStandbyRuns serializes with ensureStandbyRun', async () => {
        // Regression: reapIdleStandbyRuns() must take the SAME per-actor lock
        // ensureStandbyRun() uses, so a request arriving right at the idle
        // boundary can never have its warm endpoint reaped out from under it
        // mid-flight. Racing a reap pass against a concurrent request for the
        // same actor must always resolve to one of two consistent outcomes --
        // a clean cold start (if the reap wins) or a warm reuse (if the
        // request wins) -- and never surface as a broken/dropped request.
        ctx = await wireFastStandby();
        const { client, service } = ctx;
        const actorId = await provisionStandbyActor(client, service, 'alice');

        const resp = await client.get(`/v2/actor-standby/${actorId}/echo`, { headers: auth('alice') });
        expect(resp.status).toBe(200);

        // Force the entry to look idle right now, without waiting out the
        // real timeout, so the race is deterministic rather than
        // timing-dependent.
        const entry = service.standby.runs.get(actorId);
        entry.lastRequest -= entry.idleTimeout * 1000 + 1000;

        const [, resp2] = await Promise.all([
            service.reapIdleStandbyRuns(),
            client.get(`/v2/actor-standby/${actorId}/echo`, { headers: auth('alice') }),
        ]);
        expect(resp2.status).toBe(200);
    });

    it('idle clock does not reap mid-stream', async () => {
        // Regression: a single forwarded request's OWN duration must never be
        // treated as idle time, even if it legitimately outlives
        // idleTimeoutSecs -- e.g. a slow, multi-chunk streamed response (a
        // supported case). The watchdog here polls every 0.05s against a
        // 0.2s idle-timeout override, so without in-flight tracking the
        // ~0.9s `/stream-slow` response (three 0.3s-apart chunks, see
        // FakeStandbyServer) would get its container reaped out from under it
        // well before the stream finishes.
        ctx = await wireFastStandby();
        const { client, service } = ctx;
        const actorId = await provisionStandbyActor(client, service, 'alice');
        service.startStandbyWatchdog(0.05);

        const requestPromise = client.get(`/v2/actor-standby/${actorId}/stream-slow`, { headers: auth('alice') });

        // Let the request start (cold-start + readiness + at least the first
        // streamed chunk) and several idle-reap passes elapse while it is
        // still in flight -- comfortably past the 0.2s idle-timeout override,
        // but before the ~0.9s stream finishes.
        await sleep(500);
        let runs = await listRuns(client, actorId, 'alice');
        expect(
            runs.length > 0 && runs[0].status === 'RUNNING',
            'container was reaped while a request was still being forwarded',
        ).toBe(true);

        const resp = await requestPromise;
        expect(resp.status).toBe(200);
        expect(resp.text()).toBe('chunk-1\nchunk-2\nchunk-3\n');

        // Once the request has actually finished, the idle clock (refreshed
        // from the completion time) resumes counting down normally.
        await sleep(600);
        runs = await listRuns(client, actorId, 'alice');
        expect(runs[0].status).toBe('ABORTED');
    });

    it('watchdog survives a reap-pass exception', async () => {
        // Regression: startStandbyWatchdog()'s loop must not let one failing
        // pass permanently kill background reaping for the rest of the
        // process's life (the idempotency guard blocks ever restarting it) --
        // a failing pass must be logged and swallowed, and subsequent passes
        // must still run, proven here by making the very first pass raise and
        // confirming the standby run is STILL reaped by a later pass.
        ctx = await wireFastStandby();
        const { client, service } = ctx;
        const actorId = await provisionStandbyActor(client, service, 'alice');

        const resp = await client.get(`/v2/actor-standby/${actorId}/echo`, { headers: auth('alice') });
        expect(resp.status).toBe(200);

        const originalReap = service.reapIdleStandbyRuns.bind(service);
        const calls = { n: 0 };
        service.reapIdleStandbyRuns = async () => {
            calls.n += 1;
            if (calls.n === 1) {
                throw new Error('simulated reap-pass failure');
            }
            await originalReap();
        };
        service.startStandbyWatchdog(0.05);

        // Several passes: the first raises, later ones must still run and
        // eventually reap the (0.2s-override) idle standby run.
        await sleep(600);

        expect(calls.n, 'watchdog loop died after the first failing pass').toBeGreaterThan(1);
        const runs = await listRuns(client, actorId, 'alice');
        expect(runs[0].status).toBe('ABORTED');
    });

    it('idle watchdog reaps and the next request cold-starts', async () => {
        ctx = await wireFastStandby();
        const { client, service } = ctx;
        const actorId = await provisionStandbyActor(client, service, 'alice');
        service.startStandbyWatchdog(0.05);

        const resp1 = await client.get(`/v2/actor-standby/${actorId}/echo`, { headers: auth('alice') });
        expect(resp1.status).toBe(200);
        let runs = await listRuns(client, actorId, 'alice');
        expect(runs.length).toBe(1);
        expect(runs[0].status).toBe('RUNNING');
        const firstRunId = runs[0].id;

        // Give the watchdog time to notice the (0.2s-override) idle timeout
        // without any further request being sent -- the teardown must happen
        // on its own.
        await sleep(600);

        runs = await listRuns(client, actorId, 'alice');
        expect(runs.length).toBe(1);
        expect(runs[0].id).toBe(firstRunId);
        expect(runs[0].status).toBe('ABORTED');
        // Storage import ran on teardown too, exactly like a normal run's
        // finish.
        const output = await client.get(`/v2/key-value-stores/${runs[0].defaultKeyValueStoreId}/records/OUTPUT`, {
            headers: auth('alice'),
        });
        expect(output.status).toBe(200);

        // A fresh request after teardown is a cold start: a NEW run, not a
        // reuse of the now-dead one.
        const resp2 = await client.get(`/v2/actor-standby/${actorId}/echo`, { headers: auth('alice') });
        expect(resp2.status).toBe(200);
        runs = await listRuns(client, actorId, 'alice');
        expect(runs.length).toBe(2);
        const newRun = runs.find((r) => r.id !== firstRunId);
        expect(newRun.status).toBe('RUNNING');
    });

    it('aborting a standby run reaps the container and drops bookkeeping', async () => {
        // Aborting a standby run out-of-band must not leave the manager
        // forwarding into a now-dead container on the next request.
        ctx = await wireFastStandby();
        const { client, service } = ctx;
        const actorId = await provisionStandbyActor(client, service, 'alice');

        const resp1 = await client.get(`/v2/actor-standby/${actorId}/echo`, { headers: auth('alice') });
        expect(resp1.status).toBe(200);
        let runs = await listRuns(client, actorId, 'alice');
        const firstRunId = runs[0].id;

        const aborted = await client.post(`/v2/actor-runs/${firstRunId}/abort`, { headers: auth('alice') });
        expect(aborted.status).toBe(200);
        expect(aborted.json().data.status).toBe('ABORTED');

        const resp2 = await client.get(`/v2/actor-standby/${actorId}/echo`, { headers: auth('alice') });
        expect(resp2.status).toBe(200);
        runs = await listRuns(client, actorId, 'alice');
        expect(runs.length).toBe(2);
        const newRun = runs.find((r) => r.id !== firstRunId);
        expect(newRun.status).toBe('RUNNING');
    });

    it('aborting a standby run preserves storage output', async () => {
        // Regression: aborting a standby run must import whatever the Actor
        // wrote during its warm lifetime into the runtime's storage, exactly
        // like the idle-reap teardown path already does -- killing a warm
        // standby run (e.g. to push a new build) is a routine developer
        // action and must not silently discard its dataset/KV/request-queue
        // output.
        ctx = await wireFastStandby();
        const { client, service } = ctx;
        const actorId = await provisionStandbyActor(client, service, 'alice');

        const resp = await client.get(`/v2/actor-standby/${actorId}/echo`, { headers: auth('alice') });
        expect(resp.status).toBe(200);
        const runs = await listRuns(client, actorId, 'alice');
        const runId = runs[0].id;
        const kvStoreId = runs[0].defaultKeyValueStoreId;

        const aborted = await client.post(`/v2/actor-runs/${runId}/abort`, { headers: auth('alice') });
        expect(aborted.status).toBe(200);
        expect(aborted.json().data.status).toBe('ABORTED');

        const output = await client.get(`/v2/key-value-stores/${kvStoreId}/records/OUTPUT`, {
            headers: auth('alice'),
        });
        expect(output.status).toBe(200);
    });
});

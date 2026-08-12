/**
 * Console/API extension behaviours: token-free user listing (no bootstrap),
 * live-streamed run/build logs, and top-level standalone storage management.
 *
 * All Docker-free via `wire()`; the acting user is chosen per request with
 * `Authorization: Bearer <token>`. The real dockerode live-streaming path is
 * verified on a Docker-enabled host/CI, not here; the streaming stub driver
 * exercises the buffer, endpoint, terminal handoff, fallback and console
 * wiring, and a fake dockerode client exercises the concurrent
 * stream-plus-timeout path in `DockerDriver.run` (see the timeout regression
 * test).
 */
import { Readable } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';

import { NETWORK_NAME } from '../../src/config.js';
import { DockerDriver } from '../../src/driver.js';
import { authHeaders, StreamingStubDriver, wire } from '../helpers.js';

let ctx = null;

afterEach(async () => {
    if (ctx) await ctx.close();
    ctx = null;
});

/** Like `String.prototype.indexOf`, but fails the test when absent (Python's `str.index`). */
function indexOfOrFail(haystack, needle, from = 0) {
    const i = haystack.indexOf(needle, from);
    expect(i, `expected to find ${JSON.stringify(needle)}`).toBeGreaterThanOrEqual(0);
    return i;
}

function count(haystack, needle) {
    return haystack.split(needle).length - 1;
}

async function createUser(client, name) {
    await client.post('/v2/users', { json: { name } });
}

/** Push, build and run an Actor under `token`; return its run dict. */
async function provisionRun(client, service, token, { name = 'act', greeting = 'hi' } = {}) {
    await createUser(client, token);
    const actorId = `${token}~${name}`;
    await client.post('/v2/acts', {
        json: { name, versions: [{ versionNumber: '0.0', buildTag: 'latest' }] },
        headers: authHeaders(token),
    });
    await client.post(`/v2/actors/${actorId}/versions`, {
        json: {
            versionNumber: '0.0',
            sourceType: 'SOURCE_FILES',
            sourceFiles: [{ name: 'main.py', format: 'TEXT', content: "print('hi')\n" }],
        },
        headers: authHeaders(token),
    });
    await client.post(`/v2/acts/${actorId}/builds?version=0.0`, { headers: authHeaders(token) });
    await service.waitIdle();
    const resp = await client.post(`/v2/acts/${actorId}/runs`, {
        json: { greeting },
        headers: authHeaders(token),
    });
    await service.waitIdle();
    return resp.json().data;
}

/**
 * GET `path` and collect the response body's chunks as they arrive over the
 * real loopback socket (the JS analogue of iterating the Python endpoint's
 * StreamingResponse generator directly: the buffered test client cannot
 * surface a chunked response incrementally, `fetch` + `getReader()` can).
 */
async function readStreamPieces(baseUrl, urlPath, token = null) {
    const resp = await fetch(`${baseUrl}${urlPath}`, { headers: authHeaders(token) });
    const pieces = [];
    if (resp.body) {
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            const text = decoder.decode(value, { stream: true });
            if (text) pieces.push(text);
        }
    }
    return { status: resp.status, pieces };
}

// ------------------------------------------------------------------ (1) users

describe('users listing without bootstrap', () => {
    it('list users without auth returns 200 and does not bootstrap', async () => {
        ctx = await wire();
        const { client } = ctx;
        // No Authorization header: 200 with a well-formed user list.
        const resp = await client.get('/v2/users');
        expect(resp.status).toBe(200);
        const body = resp.json().data;
        expect(Array.isArray(body.items)).toBe(true);

        // No bootstrap side effect: a brand-new token presented afterward to a
        // real, authenticated endpoint still bootstraps as the default user.
        const me = await client.get('/v2/users/me', { headers: authHeaders('first-ever-token') });
        expect(me.status).toBe(200);
        expect(me.json().data.username).toBe('local-user');
        // A second, different fresh token is now rejected (default already claimed).
        expect((await client.get('/v2/users/me', { headers: authHeaders('second-token') })).status).toBe(401);
    });

    it('list users with a stale token does not bootstrap', async () => {
        ctx = await wire();
        const { client } = ctx;
        // Sending a never-seen bearer to the (token-free) list endpoint must not bind it.
        const resp = await client.get('/v2/users', { headers: authHeaders('stale-unknown-token') });
        expect(resp.status).toBe(200);

        // Proof the stale token was never claimed: a *different* fresh token
        // still bootstraps as the first one.
        const me = await client.get('/v2/users/me', { headers: authHeaders('real-first-token') });
        expect(me.status).toBe(200);
        expect(me.json().data.username).toBe('local-user');
        expect(me.json().data.token).toBe('real-first-token');
    });

    it('me and real work still bootstrap', async () => {
        ctx = await wire();
        const { client } = ctx;
        // Real work through an authenticated endpoint still binds the first token.
        const listing = await client.get('/v2/users/me/actors', { headers: authHeaders('work-token') });
        expect(listing.status).toBe(200);
        const me = await client.get('/v2/users/me', { headers: authHeaders('work-token') });
        expect(me.json().data.username).toBe('local-user');
        expect((await client.get('/v2/users/me', { headers: authHeaders('other-token') })).status).toBe(401);
    });

    it('console fetches the user list without auth', async () => {
        ctx = await wire();
        const js = (await ctx.client.get('/console/app.js')).text();
        // api() honours a per-call skipAuth opt-out...
        expect(js).toContain('!options.skipAuth');
        // ...and the two /v2/users fetches use it.
        expect(count(js, 'api("/v2/users", { skipAuth: true })')).toBe(2);
    });
});

// ------------------------------------------------------------- (2) log stream

describe('log streaming', () => {
    it('stream delivers incremental chunks while running', async () => {
        ctx = await wire({ driver: new StreamingStubDriver() });
        const { client, service, baseUrl } = ctx;
        ctx.driver.chunks = ['alpha\n', 'beta\n', 'gamma\n'];
        ctx.driver.delayMs = 0; // fast build
        const run = await provisionRun(client, service, 'streamer');
        const runId = run.id;

        // Re-arm the driver so the *run* streams slowly enough to observe >1 chunk.
        ctx.driver.delayMs = 500;

        // Start a fresh run (not awaited via waitIdle) and tail it while it is
        // still in progress.
        const resp = await client.post('/v2/acts/streamer~act/runs', {
            json: { greeting: 'hi' },
            headers: authHeaders('streamer'),
        });
        const liveRunId = resp.json().data.id;

        // Tail the endpoint over the real socket, collecting chunks as they
        // arrive (the buffered test client can't surface them incrementally).
        const { pieces } = await readStreamPieces(baseUrl, `/v2/logs/${liveRunId}/stream`, 'streamer');

        await service.waitIdle();
        expect(pieces.length, JSON.stringify(pieces)).toBeGreaterThanOrEqual(2);
        expect(pieces.join('')).toBe('alpha\nbeta\ngamma\n');
        const stored = (await client.get(`/v2/logs/${liveRunId}`, { headers: authHeaders('streamer') })).text();
        expect(stored).toBe('alpha\nbeta\ngamma\n');
        expect(runId).not.toBe(liveRunId);
    });

    it('stream for a finished job returns the full log', async () => {
        ctx = await wire();
        const { client, service, baseUrl } = ctx;
        const run = await provisionRun(client, service, 'finn', { greeting: 'done' });
        const runId = run.id;
        // Buffer discarded on finish -> stream falls back to the stored full log.
        const { pieces } = await readStreamPieces(baseUrl, `/v2/logs/${runId}/stream`, 'finn');
        const oneShot = (await client.get(`/v2/logs/${runId}`, { headers: authHeaders('finn') })).text();
        expect(pieces.join('')).toBe(oneShot);
        expect(oneShot).toBeTruthy(); // non-empty stored log
    });

    it('stream for an unknown job is 404', async () => {
        ctx = await wire();
        const resp = await ctx.client.get('/v2/logs/does-not-exist/stream');
        expect(resp.status).toBe(404);
    });

    it('build log streams and matches the stored log', async () => {
        ctx = await wire({ driver: new StreamingStubDriver() });
        const { client, service, baseUrl } = ctx;
        ctx.driver.chunks = ['build-1\n', 'build-2\n'];
        ctx.driver.delayMs = 0;
        await createUser(client, 'builder');
        await client.post('/v2/acts', {
            json: { name: 'b', versions: [{ versionNumber: '0.0', buildTag: 'latest' }] },
            headers: authHeaders('builder'),
        });
        await client.post('/v2/actors/builder~b/versions', {
            json: {
                versionNumber: '0.0',
                sourceType: 'SOURCE_FILES',
                sourceFiles: [{ name: 'main.py', format: 'TEXT', content: 'x=1\n' }],
            },
            headers: authHeaders('builder'),
        });
        const resp = await client.post('/v2/acts/builder~b/builds?version=0.0', { headers: authHeaders('builder') });
        const buildId = resp.json().data.id;
        await service.waitIdle();
        const { pieces } = await readStreamPieces(baseUrl, `/v2/logs/${buildId}/stream`, 'builder');
        expect(pieces.join('')).toBe('build-1\nbuild-2\n');
    });

    it('console log view consumes the stream', async () => {
        ctx = await wire();
        const js = (await ctx.client.get('/console/app.js')).text();
        expect(js).toContain('/stream');
        expect(js).toContain('getReader');
        expect(js).toContain('streamLogInto');
    });
});

// ----------------------------------------------- (2b) DockerDriver regressions

/** Minimal dockerode `modem` stand-in: pipe the raw stream into the sink. */
const fakeModem = {
    demuxStream(stream, out) {
        stream.on('data', (chunk) => out.write(chunk));
    },
};

/**
 * A fake docker client whose network lookup/creation always fails, so
 * `DockerDriver.ensureNetwork()` leaves `networkAvailable` false --
 * simulating a daemon that restricts user-defined network creation.
 */
function fakeNetworkUnavailableClient() {
    const state = { runConfig: null };
    const client = {
        getNetwork() {
            return {
                inspect: async () => {
                    const err = new Error('daemon rejected network lookup');
                    err.statusCode = 404; // "not found" -> the driver tries to create it next
                    throw err;
                },
            };
        },
        async createNetwork() {
            throw new Error('daemon rejected network creation');
        },
        async createContainer(config) {
            state.runConfig = config;
            return makeStubContainer();
        },
        modem: fakeModem,
    };
    return { client, state };
}

/** A container that exits immediately with status 0 and an empty log. */
function makeStubContainer() {
    return {
        async start() {},
        async logs({ follow = false } = {}) {
            if (!follow) return Buffer.alloc(0);
            const stream = new Readable({ read() {} });
            stream.push(null); // empty log, ends immediately
            return stream;
        },
        async wait() {
            return { StatusCode: 0 };
        },
        async kill() {},
        async remove() {},
    };
}

describe('DockerDriver (fake dockerode client)', () => {
    it('docker run enforces the timeout while streaming logs', async () => {
        // Regression for the real-run timeout path: with a `logSink` set (the
        // only path a real run takes), `DockerDriver.run` must enforce
        // `timeoutSecs` CONCURRENTLY with following the log stream. This fake
        // docker client's container emits log lines forever and never exits on
        // its own; the log-follow stream would stay open indefinitely, so the
        // timeout can only fire if `container.wait()` runs alongside the log
        // stream. Proves: after the timeout, `container.kill()` is called,
        // `run()` returns with `timedOut=true`, and the streamed chunks
        // reached the sink. The live docker daemon path stays host/CI-verified.
        const container = {
            killCalls: 0,
            killed: false,
            killWaiters: [],
            stream: new Readable({ read() {} }),
            interval: null,
            async start() {
                let i = 0;
                this.interval = setInterval(() => {
                    i += 1;
                    this.stream.push(`line-${i}\n`);
                }, 20);
            },
            async logs({ follow = false } = {}) {
                if (!follow) return Buffer.alloc(0);
                return this.stream;
            },
            wait() {
                return new Promise((resolve) => {
                    if (this.killed) resolve({ StatusCode: 0 });
                    else this.killWaiters.push(resolve);
                });
            },
            async kill() {
                this.killCalls += 1;
                this.killed = true;
                clearInterval(this.interval);
                this.stream.push(null);
                for (const waiter of this.killWaiters) waiter({ StatusCode: 0 });
                this.killWaiters = [];
            },
            async remove() {},
        };
        const fakeClient = {
            async createContainer() {
                return container;
            },
            modem: fakeModem,
        };

        const received = [];
        const driver = new DockerDriver({ client: fakeClient });
        const result = await driver.run('img:latest', '/tmp/nonexistent', {}, 1, null, null, (chunk) => received.push(chunk));

        expect(result.timedOut).toBe(true);
        expect(container.killCalls).toBeGreaterThanOrEqual(1);
        expect(result.exitCode).toBe(1);
        expect(received.length, 'streamed chunks were not delivered to the sink').toBeGreaterThan(0);
        expect(received.join('')).toBe(result.log);
    });

    it('docker run falls back to the bridge network when the named network is unavailable', async () => {
        // Regression: if `ensureNetwork()` could not create/look up the shared
        // user-defined network at boot, on-demand runs (`run()`) must still
        // work -- exactly like the pre-standby behavior -- via Docker's
        // default bridge network, rather than referencing a network name that
        // was never actually created. Blast radius of the bug this fixes was
        // the WHOLE run subsystem (on-demand included), not just standby.
        const { client, state } = fakeNetworkUnavailableClient();
        const driver = new DockerDriver({ client });
        await driver.ensureNetwork(); // fails -- logs a warning, leaves the network unavailable

        const result = await driver.run('img:latest', '/tmp/nonexistent', {}, 1);

        expect(result.exitCode).toBe(0);
        // dockerode expresses the network choice through the single
        // HostConfig.NetworkMode field (docker-py's separate network /
        // network_mode kwargs don't exist here).
        expect(state.runConfig.HostConfig.NetworkMode).toBe('bridge');
    });

    it('docker run uses the named network when available', async () => {
        // Counterpart to the fallback test above: when the shared network IS
        // available, `run()` must still join it by name (not silently fall
        // back to bridge), since that's what makes on-demand Actor containers
        // reachable by name and able to reach APIFY_API_BASE_URL.
        const state = { runConfig: null };
        const client = {
            getNetwork() {
                return {
                    inspect: async () => ({}),
                    connect: async () => {},
                };
            },
            getContainer() {
                return {
                    inspect: async () => {
                        throw new Error('no self-container in this fake -- self-attach best-effort skips');
                    },
                };
            },
            async createContainer(config) {
                state.runConfig = config;
                return makeStubContainer();
            },
            modem: fakeModem,
        };
        const driver = new DockerDriver({ client });
        await driver.ensureNetwork(); // succeeds -- self-attach then best-effort-fails, which is fine

        const result = await driver.run('img:latest', '/tmp/nonexistent', {}, 1);

        expect(result.exitCode).toBe(0);
        expect(state.runConfig.HostConfig.NetworkMode).toBe(NETWORK_NAME);
    });

    it('docker standby start raises a clear error when the network is unavailable', async () => {
        // Regression: `start()` (the non-blocking standby launch path) must
        // fail fast with an actionable error when the shared network isn't
        // available, rather than either silently joining a nonexistent network
        // (a bare docker APIError) or -- worse -- silently falling back to the
        // bridge network, which would make the container's DNS name (its only
        // forwarding address) unreachable.
        const { client, state } = fakeNetworkUnavailableClient();
        const driver = new DockerDriver({ client });
        await driver.ensureNetwork(); // fails -- network stays unavailable

        await expect(driver.start('img:latest', '/tmp/nonexistent', {}, 'ar-run-x')).rejects.toThrow(/network/);

        expect(state.runConfig, 'must not attempt to start a container at all').toBeNull();
    });
});

// ------------------------------------------------------------- (3) storages

describe('standalone storages', () => {
    it('create and list standalone storages', async () => {
        ctx = await wire();
        const { client } = ctx;
        await createUser(client, 'sam');
        const created = await client.post('/v2/key-value-stores', { json: { name: 'mystore' }, headers: authHeaders('sam') });
        expect(created.status).toBe(201);
        const storeId = created.json().data.id;
        expect(storeId).toBe('sam~mystore');

        const listed = (await client.get('/v2/users/me/key-value-stores', { headers: authHeaders('sam') })).json().data;
        const ids = listed.items.map((s) => s.id);
        expect(ids).toContain(storeId);
        const entry = listed.items.find((s) => s.id === storeId);
        expect(entry.name).toBe('mystore');
        expect(entry.type).toBe('key-value-store');

        // Each type has its own aggregate endpoint.
        await client.post('/v2/datasets', { json: { name: 'd1' }, headers: authHeaders('sam') });
        await client.post('/v2/request-queues', { json: { name: 'q1' }, headers: authHeaders('sam') });
        const ds = (await client.get('/v2/users/me/datasets', { headers: authHeaders('sam') })).json().data;
        const rq = (await client.get('/v2/users/me/request-queues', { headers: authHeaders('sam') })).json().data;
        expect(ds.items.map((s) => s.id)).toContain('sam~d1');
        expect(rq.items.map((s) => s.id)).toContain('sam~q1');
    });

    it('storage listing is scoped to the acting user', async () => {
        ctx = await wire();
        const { client } = ctx;
        for (const u of ['ann', 'ben']) {
            await createUser(client, u);
            await client.post('/v2/key-value-stores', { json: { name: 's' }, headers: authHeaders(u) });
        }
        const annIds = (await client.get('/v2/users/me/key-value-stores', { headers: authHeaders('ann') }))
            .json().data.items.map((s) => s.id);
        const benIds = (await client.get('/v2/users/me/key-value-stores', { headers: authHeaders('ben') }))
            .json().data.items.map((s) => s.id);
        expect(annIds).toEqual(['ann~s']);
        expect(benIds).toEqual(['ben~s']);
    });

    it('delete storage removes the listing and the data', async () => {
        ctx = await wire();
        const { client } = ctx;
        await createUser(client, 'deb');
        await client.post('/v2/key-value-stores', { json: { name: 'tmp' }, headers: authHeaders('deb') });
        const storeId = 'deb~tmp';
        await client.put(`/v2/key-value-stores/${storeId}/records/K`, {
            json: { v: 1 },
            headers: { ...authHeaders('deb'), 'content-type': 'application/json' },
        });
        expect((await client.get(`/v2/key-value-stores/${storeId}/records/K`, { headers: authHeaders('deb') })).status).toBe(200);

        const del = await client.delete(`/v2/key-value-stores/${storeId}`, { headers: authHeaders('deb') });
        expect(del.status).toBe(200);

        const listed = (await client.get('/v2/users/me/key-value-stores', { headers: authHeaders('deb') })).json().data.items;
        expect(listed.map((s) => s.id)).not.toContain(storeId);
        // Underlying data is gone: the id now reads as not-found.
        expect((await client.get(`/v2/key-value-stores/${storeId}/records/K`, { headers: authHeaders('deb') })).status).toBe(404);
    });

    it('delete storage removes access rights', async () => {
        ctx = await wire();
        const { client, service } = ctx;
        await createUser(client, 'owner');
        await createUser(client, 'guest');
        await client.post('/v2/key-value-stores', { json: { name: 'shared' }, headers: authHeaders('owner') });
        const storeId = 'owner~shared';
        await client.post(`/v2/key-value-stores/${storeId}/access-rights`, {
            json: { grantee: 'guest', level: 'READ' },
            headers: authHeaders('owner'),
        });
        expect((await service.listAccess(storeId)).length).toBe(1);

        await client.delete(`/v2/key-value-stores/${storeId}`, { headers: authHeaders('owner') });
        // No dangling grant survives.
        expect(await service.listAccess(storeId)).toEqual([]);
        // Listing access rights for the gone storage now 404s (owner-only path).
        expect((await client.get(`/v2/key-value-stores/${storeId}/access-rights`, { headers: authHeaders('owner') })).status).toBe(404);
        // The previously-granted user can no longer reach it (as unknown id).
        expect((await client.get(`/v2/key-value-stores/${storeId}`, { headers: authHeaders('guest') })).status).toBe(404);
    });

    it("deleting another user's storage is 404 and has no effect", async () => {
        ctx = await wire();
        const { client } = ctx;
        await createUser(client, 'aa');
        await createUser(client, 'bb');
        await client.post('/v2/key-value-stores', { json: { name: 'keep' }, headers: authHeaders('aa') });
        const storeId = 'aa~keep';
        // bb cannot delete aa's storage; existence is not leaked.
        expect((await client.delete(`/v2/key-value-stores/${storeId}`, { headers: authHeaders('bb') })).status).toBe(404);
        // Unknown id is the same 404.
        expect((await client.delete('/v2/key-value-stores/aa~nope', { headers: authHeaders('bb') })).status).toBe(404);
        // aa's storage is untouched.
        const listed = (await client.get('/v2/users/me/key-value-stores', { headers: authHeaders('aa') })).json().data;
        expect(listed.items.map((s) => s.id)).toContain(storeId);
    });

    it('run-derived storages are included and undeletable', async () => {
        ctx = await wire();
        const { client, service } = ctx;
        const run = await provisionRun(client, service, 'runner');
        const kvId = run.defaultKeyValueStoreId;
        expect(kvId.startsWith('kv_')).toBe(true);

        // The top-level list now surfaces run-derived storages too, marked unnamed.
        const listed = (await client.get('/v2/users/me/key-value-stores', { headers: authHeaders('runner') })).json().data.items;
        expect(listed.map((s) => s.id)).toContain(kvId);
        const entry = listed.find((s) => s.id === kvId);
        expect(entry.named).toBe(false);

        // Deleting a run-derived storage via this view is refused (400), not silent.
        const resp = await client.delete(`/v2/key-value-stores/${kvId}`, { headers: authHeaders('runner') });
        expect(resp.status).toBe(400);
        expect(resp.json().error.type).toBe('invalid-request');
        // The run's storage is still intact/readable.
        expect((await client.get(`/v2/key-value-stores/${kvId}`, { headers: authHeaders('runner') })).status).toBe(200);
    });

    it('named storage is marked named and coexists with run-derived', async () => {
        ctx = await wire();
        const { client, service } = ctx;
        const run = await provisionRun(client, service, 'coexist');
        const kvId = run.defaultKeyValueStoreId;
        const dsId = run.defaultDatasetId;
        const rqId = run.defaultRequestQueueId;

        const created = await client.post('/v2/key-value-stores', { json: { name: 'mystore' }, headers: authHeaders('coexist') });
        const namedId = created.json().data.id;

        const kvListed = (await client.get('/v2/users/me/key-value-stores', { headers: authHeaders('coexist') })).json().data.items;
        const dsListed = (await client.get('/v2/users/me/datasets', { headers: authHeaders('coexist') })).json().data.items;
        const rqListed = (await client.get('/v2/users/me/request-queues', { headers: authHeaders('coexist') })).json().data.items;

        // The run's own default storage ids appear in their corresponding per-type lists.
        expect(kvListed.map((s) => s.id)).toContain(kvId);
        expect(dsListed.map((s) => s.id)).toContain(dsId);
        expect(rqListed.map((s) => s.id)).toContain(rqId);

        // The standalone storage coexists alongside the run-derived one, marked named.
        const namedEntry = kvListed.find((s) => s.id === namedId);
        const runEntry = kvListed.find((s) => s.id === kvId);
        expect(namedEntry.named).toBe(true);
        expect(runEntry.named).toBe(false);

        // The named storage remains deletable as before.
        const del = await client.delete(`/v2/key-value-stores/${namedId}`, { headers: authHeaders('coexist') });
        expect(del.status).toBe(200);
        const remaining = (await client.get('/v2/users/me/key-value-stores', { headers: authHeaders('coexist') })).json().data.items;
        expect(remaining.map((s) => s.id)).not.toContain(namedId);
        expect(remaining.map((s) => s.id)).toContain(kvId);
    });

    it('run-derived and named storages are scoped per user', async () => {
        ctx = await wire();
        const { client, service } = ctx;
        const runA = await provisionRun(client, service, 'usera', { name: 'acta' });
        const runB = await provisionRun(client, service, 'userb', { name: 'actb' });
        await client.post('/v2/key-value-stores', { json: { name: 'mine' }, headers: authHeaders('usera') });
        await client.post('/v2/key-value-stores', { json: { name: 'mine' }, headers: authHeaders('userb') });

        const aIds = (await client.get('/v2/users/me/key-value-stores', { headers: authHeaders('usera') }))
            .json().data.items.map((s) => s.id);
        const bIds = (await client.get('/v2/users/me/key-value-stores', { headers: authHeaders('userb') }))
            .json().data.items.map((s) => s.id);

        expect(aIds).toContain(runA.defaultKeyValueStoreId);
        expect(aIds).toContain('usera~mine');
        expect(aIds).not.toContain(runB.defaultKeyValueStoreId);
        expect(aIds).not.toContain('userb~mine');

        expect(bIds).toContain(runB.defaultKeyValueStoreId);
        expect(bIds).toContain('userb~mine');
        expect(bIds).not.toContain(runA.defaultKeyValueStoreId);
        expect(bIds).not.toContain('usera~mine');
    });

    it('console has a storages tab', async () => {
        ctx = await wire();
        const html = (await ctx.client.get('/')).text();
        // Storage is a single top-level nav entry now (singular), reached at /storage.
        expect(html).toContain('id="tab-storage"');
        const js = (await ctx.client.get('/console/storage_tab.js')).text();
        expect(js).toContain('loadStorages');
        expect(js).toContain('createStorage');
        expect(js).toContain('deleteStorage');
        expect(js).toContain('/v2/users/me/');
    });

    it('console storages show the unnamed checkbox and a gated delete', async () => {
        ctx = await wire();
        const js = (await ctx.client.get('/console/storage_tab.js')).text();

        // A checkbox exists for the Storages tab, defaulting to checked (show
        // unnamed), and is wired via addEventListener (no inline handler).
        expect(js.includes('type = "checkbox"') || js.includes('type="checkbox"')).toBe(true);
        expect(js).toContain('showUnnamedStorages');
        expect(js).toContain('let showUnnamedStorages = true;');
        expect(js).toContain('toggle.addEventListener("change"');

        // Rows are not filtered out of the render path based on run-derived id
        // shape -- every fetched item is mapped, filtering only happens against
        // the checkbox state.
        expect(js).toContain('items.filter((st) => st.named === true)');
        expect(js).toContain('showUnnamedStorages ? items :');

        // The delete control is only constructed for named rows: locate the
        // actual gating conditional (not the unrelated marker-cell ternary) and
        // confirm the button construction follows it, so this assertion would
        // fail if the delete gating regressed to unconditional.
        const delIdx = indexOfOrFail(js, 'const del = st.named');
        expect(js.slice(delIdx, delIdx + 200)).toContain('mk("button"');

        // Toggling the checkbox is presentation-only: its change handler
        // re-renders from cached data (renderStorages) rather than refetching
        // (loadStorages).
        const toggleWireIdx = indexOfOrFail(js, 'toggle.addEventListener("change"');
        const changeHandler = js.slice(toggleWireIdx, indexOfOrFail(js, '});', toggleWireIdx));
        expect(changeHandler).toContain('renderStorages()');
        expect(changeHandler).not.toContain('loadStorages()');

        for (const handler of ['onclick=', 'onload=', 'onerror=', 'onmouseover=']) {
            expect(js).not.toContain(handler);
        }
    });

    it('console left column has separate nav and list boxes', async () => {
        ctx = await wire();
        const html = (await ctx.client.get('/')).text();

        // Top-level nav is exactly the three new sections (Actors / Storage /
        // Users); Builds and Runs are no longer top-level destinations (they
        // live under an actor's detail).
        for (const tabId of ['tab-actors', 'tab-storage', 'tab-users']) {
            expect(html).toContain(`id="${tabId}"`);
        }
        for (const gone of ['tab-builds', 'tab-runs', 'tab-storages']) {
            expect(html).not.toContain(`id="${gone}"`);
        }
        expect(html).toContain('id="actor-list"');
        expect(html).toContain('id="detail"');
        expect(html).toContain('id="top-tabs"');

        // The nav (#top-tabs) and the list (#actor-list) sit in two distinct
        // panel boxes, not one shared wrapper holding both.
        const navBoxStart = indexOfOrFail(html, 'id="nav-panel"');
        const navBoxClass = html.slice(navBoxStart, navBoxStart + 200);
        expect(navBoxClass).toContain('panel');

        const listBoxStart = indexOfOrFail(html, 'id="actors"');
        const listBoxClass = html.slice(listBoxStart, listBoxStart + 200);
        expect(listBoxClass).toContain('panel');

        // #top-tabs is inside the nav box, #actor-list is inside the
        // (different) list box.
        const topTabsPos = indexOfOrFail(html, 'id="top-tabs"');
        const actorListPos = indexOfOrFail(html, 'id="actor-list"');
        expect(navBoxStart).toBeLessThan(topTabsPos);
        expect(topTabsPos).toBeLessThan(listBoxStart);
        expect(listBoxStart).toBeLessThan(actorListPos);
    });
});

// --------------------------------------------------------- (4) console routing

describe('console routing', () => {
    it('console uses a History-API router', async () => {
        ctx = await wire();
        const js = (await ctx.client.get('/console/app.js')).text();
        // Real History-API routing off location.pathname (no hash routing).
        expect(js).toContain('location.pathname');
        expect(js).toContain('history.pushState');
        expect(js).toContain('addEventListener("popstate"');
        expect(js).toContain('function navigate(');
        // No hash routing anywhere: neither reading nor writing location.hash.
        expect(js).not.toContain('location.hash');
        // The slug -> kind map that backs the /storage/{slug} paths.
        expect(js).toContain('STORAGE_SLUG_TO_KIND');
        expect(js).toContain('"key-value-stores": "kv"');
    });

    it('console actor row navigates via pushState', async () => {
        ctx = await wire();
        const js = (await ctx.client.get('/console/app.js')).text();
        // Clicking an actor builds the /actors/{id} path and navigates
        // (pushState), not location.href/window.open, and the run/build
        // sub-paths are built too.
        expect(js).toContain('navigate(`/actors/${a.id}`)');
        expect(js).toContain('navigate(`/actors/${actorId}/runs`)');
        expect(js).toContain('navigate(`/actors/${actorId}/builds`)');
        expect(js).toContain('navigate(`/actors/${actorId}/runs/${r.id}`)');
        expect(js).not.toContain('location.href');
        expect(js).not.toContain('window.open(');
    });

    it('console build detail resolves by build number', async () => {
        ctx = await wire();
        const js = (await ctx.client.get('/console/app.js')).text();
        // Build detail is keyed by buildNumber in the path and resolved to a
        // build id client-side by fetching the actor's builds list and matching
        // on buildNumber.
        expect(js).toContain('navigate(`/actors/${actorId}/builds/${b.buildNumber}`)');
        expect(js).toContain('await api(`/v2/acts/${actorId}/builds`)');
        expect(js).toContain('builds.find((b) => b.buildNumber === buildNumber)');
    });

    it('console storage marker is a check and a cross', async () => {
        ctx = await wire();
        const js = (await ctx.client.get('/console/storage_tab.js')).text();
        // The named/run-derived marker is a check/cross glyph gated on
        // st.named, not the plain "run-derived" text label used before.
        expect(js).toContain('st.named ? "✅" : "❌"');
        expect(js).not.toContain('"run-derived"');
    });

    it('console storage detail inspects via showStore', async () => {
        ctx = await wire();
        const js = (await ctx.client.get('/console/storage_tab.js')).text();
        // The /storage/{slug}/{id} detail route renders contents by reusing
        // showStore with a kind derived from the slug, and rows link to that
        // detail path.
        expect(js).toContain('function showStorageDetail(');
        expect(js).toContain('STORAGE_SLUG_TO_KIND[slug]');
        expect(js).toContain('showStore(null, kind, resourceId)');
        expect(js).toContain('navigate(`/storage/${slug}/${st.id}`)');
    });
});

// --------------------------------------------- (5) server serves the SPA shell

/** Provision an actor with a build and a run; return {actorId, run, build}. */
async function provisionBuildAndRun(client, service, token = 'deep', name = 'act') {
    const run = await provisionRun(client, service, token, { name });
    const actorId = `${token}~${name}`;
    const builds = (await client.get(`/v2/acts/${actorId}/builds`, { headers: authHeaders(token) })).json().data.items;
    return { actorId, run, build: builds[0] };
}

describe('SPA shell serving', () => {
    it('server serves index.html for SPA paths', async () => {
        ctx = await wire();
        const { client, service } = ctx;
        const { actorId, run, build } = await provisionBuildAndRun(client, service);
        const runId = run.id;
        const buildNumber = build.buildNumber;

        const spaPaths = [
            '/actors',
            `/actors/${actorId}`,
            `/actors/${actorId}/runs/${runId}`,
            `/actors/${actorId}/builds/${buildNumber}`,
            '/storage/datasets',
            `/storage/datasets/${run.defaultDatasetId}`,
            '/users',
            // A resource that does not exist still serves the shell: "not
            // found" is a client-side concern, not a server 404.
            '/actors/no-such~actor',
        ];
        for (const urlPath of spaPaths) {
            const resp = await client.get(urlPath);
            expect(resp.status, `${urlPath} -> ${resp.status}`).toBe(200);
            expect(resp.text(), `${urlPath} did not serve the console shell`).toContain('id="detail"');
            expect(resp.text()).toContain('/console/app.js');
        }
    });

    it('SPA catch-all does not shadow the API or assets', async () => {
        ctx = await wire();
        const { client, baseUrl } = ctx;
        // An unknown /v2/* path is still a normal API 404 (Apify envelope),
        // NOT the console shell.
        const bogus = await client.get('/v2/bogus');
        expect(bogus.status).toBe(404);
        expect(bogus.json().error.type).toBe('record-not-found');
        expect(bogus.text()).not.toContain('id="detail"');

        // A non-SPA, non-API path is also a plain 404 (allowlist, not denylist).
        const other = await client.get('/totally-unknown');
        expect(other.status).toBe(404);
        expect(other.text()).not.toContain('id="detail"');

        // A non-GET request to an unknown path answers a uniform 404 (Apify
        // envelope), NOT a 405: the catch-all must not make a nonexistent path
        // look like it exists-but-rejects-the-verb.
        for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
            const resp = await fetch(`${baseUrl}/v2/bogus`, { method });
            expect(resp.status, `${method} /v2/bogus -> ${resp.status}`).toBe(404);
            expect((await resp.json()).error.type).toBe('record-not-found');
        }

        // The literal asset path still returns the JS, unshadowed.
        const appJs = await client.get('/console/app.js');
        expect(appJs.status).toBe(200);
        expect(appJs.headers.get('content-type') ?? '').toContain('application/javascript');
        expect(appJs.text().trim()).toBeTruthy();

        // The Input-tab's own script, split out of app.js, is served the same way.
        const inputTabJs = await client.get('/console/input_tab.js');
        expect(inputTabJs.status).toBe(200);
        expect(inputTabJs.headers.get('content-type') ?? '').toContain('application/javascript');
        expect(inputTabJs.text().trim()).toBeTruthy();

        // Likewise the Storage-tab's own script, also split out of app.js.
        const storageTabJs = await client.get('/console/storage_tab.js');
        expect(storageTabJs.status).toBe(200);
        expect(storageTabJs.headers.get('content-type') ?? '').toContain('application/javascript');
        expect(storageTabJs.text().trim()).toBeTruthy();

        // / still returns index.html.
        const root = await client.get('/');
        expect(root.status).toBe(200);
        expect(root.text()).toContain('id="detail"');
    });
});

// --------------------------------------------- (6) storage serializer fold-ins

describe('storage serializer fold-ins', () => {
    it('run-derived storage name is empty', async () => {
        ctx = await wire();
        const { client, service } = ctx;
        const run = await provisionRun(client, service, 'namer');
        for (const [endpoint, key] of [
            ['key-value-stores', 'defaultKeyValueStoreId'],
            ['datasets', 'defaultDatasetId'],
            ['request-queues', 'defaultRequestQueueId'],
        ]) {
            const listed = (await client.get(`/v2/users/me/${endpoint}`, { headers: authHeaders('namer') })).json().data.items;
            const entry = listed.find((s) => s.id === run[key]);
            expect(entry.name, `${endpoint}: expected empty name, got ${JSON.stringify(entry.name)}`).toBe('');
            expect(entry.named).toBe(false);
        }
    });

    it('named storage keeps its name', async () => {
        ctx = await wire();
        const { client } = ctx;
        await createUser(client, 'keeper');
        await client.post('/v2/datasets', { json: { name: 'mydata' }, headers: authHeaders('keeper') });
        const listed = (await client.get('/v2/users/me/datasets', { headers: authHeaders('keeper') })).json().data.items;
        const entry = listed.find((s) => s.id === 'keeper~mydata');
        expect(entry.name).toBe('mydata');
        expect(entry.named).toBe(true);
    });

    it('build number resolves to the correct build', async () => {
        // Console-facing data resolution: for an actor with multiple builds,
        // matching on buildNumber selects the row whose buildNumber equals the
        // target (5.4).
        ctx = await wire();
        const { client, service } = ctx;
        await createUser(client, 'multi');
        const actorId = 'multi~act';
        await client.post('/v2/acts', {
            json: { name: 'act', versions: [{ versionNumber: '0.0', buildTag: 'latest' }] },
            headers: authHeaders('multi'),
        });
        await client.post(`/v2/actors/${actorId}/versions`, {
            json: {
                versionNumber: '0.0',
                sourceType: 'SOURCE_FILES',
                sourceFiles: [{ name: 'main.py', format: 'TEXT', content: "print('hi')\n" }],
            },
            headers: authHeaders('multi'),
        });
        await client.post(`/v2/acts/${actorId}/builds?version=0.0`, { headers: authHeaders('multi') });
        await service.waitIdle();
        await client.post(`/v2/acts/${actorId}/builds?version=0.0`, { headers: authHeaders('multi') });
        await service.waitIdle();

        const builds = (await client.get(`/v2/acts/${actorId}/builds`, { headers: authHeaders('multi') })).json().data.items;
        const numbers = Object.fromEntries(builds.map((b) => [b.buildNumber, b.id]));
        expect(Object.keys(numbers).length, JSON.stringify(numbers)).toBeGreaterThanOrEqual(2);

        // The client resolution (find the row whose buildNumber equals the
        // target) picks the matching build, and different numbers resolve to
        // different ids.
        const [numA, numB] = Object.keys(numbers).sort();
        const matchA = builds.find((b) => b.buildNumber === numA);
        const matchB = builds.find((b) => b.buildNumber === numB);
        expect(matchA.buildNumber).toBe(numA);
        expect(matchB.buildNumber).toBe(numB);
        expect(matchA.id).not.toBe(matchB.id);
    });

    it('storage detail inspection is owner-scoped', async () => {
        // Every storage is inspectable at its detail path via the existing
        // per-storage read endpoints, and inspection stays scoped to the
        // acting user (6.4/6.6).
        ctx = await wire();
        const { client, service } = ctx;
        const run = await provisionRun(client, service, 'insp');
        const kvId = run.defaultKeyValueStoreId;

        // A named storage is inspectable and its content matches what was written.
        await client.post('/v2/key-value-stores', { json: { name: 'named' }, headers: authHeaders('insp') });
        await client.put('/v2/key-value-stores/insp~named/records/greeting', {
            json: { hello: 'world' },
            headers: { ...authHeaders('insp'), 'content-type': 'application/json' },
        });
        const rec = await client.get('/v2/key-value-stores/insp~named/records/greeting', { headers: authHeaders('insp') });
        expect(rec.status).toBe(200);
        expect(rec.json()).toEqual({ hello: 'world' });

        // A run-derived storage is inspectable too (only its delete affordance differs).
        const keys = (await client.get(`/v2/key-value-stores/${kvId}/keys`, { headers: authHeaders('insp') })).json().data.items;
        expect(keys.some((k) => k.key === 'OUTPUT')).toBe(true);

        // Owner-scoping: another user cannot inspect insp's run-derived storage.
        await createUser(client, 'other');
        const cross = await client.get(`/v2/key-value-stores/${kvId}/keys`, { headers: authHeaders('other') });
        expect(cross.status).toBe(404);
    });
});

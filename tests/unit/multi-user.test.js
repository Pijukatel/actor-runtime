/**
 * Multi-user and decoupled-identity behaviour: per-user ownership, isolation,
 * and namespaced storage creation. Storage-sharing (grant/revoke) coverage
 * lives in `tests/unit/storage-sharing.test.js`.
 *
 * Identity (username) and credential (token) are decoupled: a user is created
 * explicitly (username == token for console-created users), the default user
 * `local-user` is bootstrapped by the first token presented (or acts
 * token-less), and a token matching no user after bootstrap is rejected (401).
 * Everything runs Docker-free via `wire()`; the acting user is chosen per
 * request with `Authorization: Bearer <token>`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { STORAGE_KV } from '../../src/constants.js';
import { wire } from '../helpers.js';
import {
    DS,
    KV,
    RQ,
    auth,
    createUser,
    provision,
    push,
    readPaths,
    seedUsers,
    storageId,
    write,
} from './provisioning-harness.js';

const NOT_FOUND = 'record-not-found';

let ctx;

beforeEach(async () => {
    ctx = await wire();
    await seedUsers(ctx.client);
});

afterEach(async () => {
    await ctx.close();
});

describe('decoupled identity, bootstrap, reject', () => {
    it('token selects user and users/me reflects it', async () => {
        const { client } = ctx;
        // alice/bob are real users (seeded); their tokens select them.
        const alice = (await client.get('/v2/users/me', { headers: auth('alice') })).json().data;
        const bob = (await client.get('/v2/users/me', { headers: auth('bob') })).json().data;
        expect(alice.username).toBe('alice');
        expect(bob.username).toBe('bob');
        expect(alice.username).not.toBe(bob.username);
        expect(alice.username).not.toBe('local-user');
    });

    it('username and token are decoupled', async () => {
        // A console-created user has username == token; the default user, once
        // bootstrapped, has a token unequal to its username. The two identities
        // are independent -- neither username is derived from the other's token.
        const { client } = ctx;
        await createUser(client, 'n1');
        await client.get('/v2/users/me', { headers: auth('boot-xyz') }); // bootstrap local-user
        const users = Object.fromEntries(
            (await client.get('/v2/users')).json().data.items.map((u) => [u.username, u.token]),
        );
        expect(users.n1).toBe('n1');
        expect(users['local-user']).toBe('boot-xyz');
        expect(users['local-user']).not.toBe('local-user'); // token != username for the default user
        // Each token resolves to its own username, not a derivation of the other.
        expect((await client.get('/v2/users/me', { headers: auth('n1') })).json().data.username).toBe('n1');
        expect((await client.get('/v2/users/me', { headers: auth('boot-xyz') })).json().data.username).toBe(
            'local-user',
        );
    });

    it('known token resolves consistently', async () => {
        const { client } = ctx;
        await push(client, 'sample-actor', 'kt');
        // Repeated requests with the same known token resolve to the same user + object.
        for (let i = 0; i < 2; i += 1) {
            const me = (await client.get('/v2/users/me', { headers: auth('kt') })).json().data;
            expect(me.username).toBe('kt');
            const listing = (await client.get('/v2/users/me/actors', { headers: auth('kt') })).json().data;
            expect(listing.items.map((a) => a.name)).toEqual(['sample-actor']);
        }
    });

    it('no token is the default local user', async () => {
        const { client } = ctx;
        const me = (await client.get('/v2/users/me')).json().data;
        expect(me.username).toBe('local-user');
        const actor = (await client.post('/v2/acts', { json: { name: 'noauth' } })).json().data;
        expect(actor.id).toBe('local-user~noauth');
    });

    it('bootstrap: first token binds the default user and persists', async () => {
        const { client } = ctx;
        // The first present token acts as the default user (not a new user, not the token).
        const me = (await client.get('/v2/users/me', { headers: auth('first-boot-tok') })).json().data;
        expect(me.username).toBe('local-user');
        const actor = (
            await client.post('/v2/acts', { json: { name: 'boot' }, headers: auth('first-boot-tok') })
        ).json().data;
        expect(actor.id).toBe('local-user~boot');
        expect(actor.userId).toBe('local-user');
        // A subsequent no-token request still resolves to the same default user + sees it.
        const listing = (await client.get('/v2/users/me/actors')).json().data;
        expect(listing.items.map((a) => a.id)).toContain('local-user~boot');
    });

    it('unknown token is rejected after the default credential is claimed', async () => {
        const { client } = ctx;
        // Claim the default user's credential (bootstrap).
        const claimed = await client.get('/v2/users/me', { headers: auth('claim-tok') });
        expect(claimed.status).toBe(200);
        expect(claimed.json().data.username).toBe('local-user');
        // A different, never-seen token is now rejected with 401 + the Apify envelope.
        const rejected = await client.get('/v2/users/me', { headers: auth('intruder-xyz') });
        expect(rejected.status).toBe(401);
        expect(rejected.json().error.type).toBe('invalid-token');
        // No side effect: a create attempt is also rejected, and nothing was provisioned.
        const created = await client.post('/v2/acts', { json: { name: 'sneaky' }, headers: auth('intruder-xyz') });
        expect(created.status).toBe(401);
        const users = (await client.get('/v2/users')).json().data.items;
        expect(users.every((u) => u.username !== 'intruder-xyz')).toBe(true);
        expect(users.every((u) => u.token !== 'intruder-xyz')).toBe(true);
        const myActors = (await client.get('/v2/users/me/actors')).json().data.items;
        expect(myActors.every((a) => a.name !== 'sneaky')).toBe(true);
    });

    it('an absent Authorization header is never rejected', async () => {
        const { client } = ctx;
        // Even after a token is claimed and another rejected, a bare request succeeds.
        await client.get('/v2/users/me', { headers: auth('claimer-tok') });
        expect((await client.get('/v2/users/me', { headers: auth('stranger-tok') })).status).toBe(401);
        const me = await client.get('/v2/users/me');
        expect(me.status).toBe(200);
        expect(me.json().data.username).toBe('local-user');
    });

    it('create user: token equals name', async () => {
        const { client } = ctx;
        const created = await client.post('/v2/users', { json: { name: 'charlie' } });
        expect(created.status).toBe(201);
        const body = created.json().data;
        expect(body.username).toBe('charlie');
        expect(body.token).toBe('charlie');
        // The name works as a bearer token (token == name for console-created users).
        const me = (await client.get('/v2/users/me', { headers: auth('charlie') })).json().data;
        expect(me.username).toBe('charlie');
        // token == name does NOT apply to the default user's bootstrap credential.
        await client.get('/v2/users/me', { headers: auth('some-bootstrap-token') });
        const users = Object.fromEntries(
            (await client.get('/v2/users')).json().data.items.map((u) => [u.username, u.token]),
        );
        expect(users['local-user']).toBe('some-bootstrap-token');
        expect(users['local-user']).not.toBe('local-user');
    });

    it('duplicate user name conflicts', async () => {
        const { client } = ctx;
        expect((await client.post('/v2/users', { json: { name: 'dupe' } })).status).toBe(201);
        const second = await client.post('/v2/users', { json: { name: 'dupe' } });
        expect(second.status).toBe(409);
        expect(second.json().error.type).toBe('resource-conflict');
        const users = (await client.get('/v2/users')).json().data.items;
        expect(users.filter((u) => u.username === 'dupe').length).toBe(1);
    });

    it('concurrent bootstrap binds exactly one winner', async () => {
        // Two concurrent first-tokens race for the bootstrap slot. Exactly one
        // may win the compare-and-swap; the loser must NOT be told it
        // bootstrapped and then be rejected later. Regression for the
        // non-atomic get->check->set bind, which could report true to both
        // callers while only one token actually persisted.
        const { client, service } = ctx;
        const results = await Promise.all([
            Promise.resolve().then(() => service.bindDefaultToken('race-A')),
            Promise.resolve().then(() => service.bindDefaultToken('race-B')),
        ]);
        expect(results.filter(Boolean).length).toBe(1); // exactly one caller won the CAS
        const winner = service.getUser('local-user').token;
        expect(['race-A', 'race-B']).toContain(winner);
        const loser = winner === 'race-A' ? 'race-B' : 'race-A';
        // The winner's token consistently resolves to the default user on a later request.
        const me = await client.get('/v2/users/me', { headers: auth(winner) });
        expect(me.status).toBe(200);
        expect(me.json().data.username).toBe('local-user');
        // The loser's token is rejected (401) on a later request -- never a
        // "successful" bootstrap that is later 401'd.
        const rejected = await client.get('/v2/users/me', { headers: auth(loser) });
        expect(rejected.status).toBe(401);
        expect(rejected.json().error.type).toBe('invalid-token');
    });

    it('higher-concurrency bootstrap binds exactly one winner', async () => {
        // Beyond the 2-way race: 8 concurrent first-tokens contend for the
        // single bootstrap slot on a fresh DB. Exactly one wins the CAS, NONE
        // throws (no storage-contention error propagating as a 500), the
        // winner's token later resolves to the default user, and every loser
        // is rejected 401. Deterministic and fast (one fresh DB, tiny writes
        // serialized by the single-threaded runtime).
        const { client, service } = ctx;
        const tokens = Array.from({ length: 8 }, (_, i) => `race-${i}`);
        const results = await Promise.all(
            tokens.map((t) =>
                Promise.resolve()
                    .then(() => service.bindDefaultToken(t))
                    .catch((err) => err),
            ),
        );
        expect(results.some((r) => r instanceof Error)).toBe(false); // no 500/exception
        expect(results.filter((r) => r === true).length).toBe(1); // exactly one caller won the CAS
        const winner = service.getUser('local-user').token;
        expect(tokens).toContain(winner);
        const me = await client.get('/v2/users/me', { headers: auth(winner) });
        expect(me.status).toBe(200);
        expect(me.json().data.username).toBe('local-user');
        for (const loser of tokens.filter((t) => t !== winner)) {
            const rejected = await client.get('/v2/users/me', { headers: auth(loser) });
            expect(rejected.status).toBe(401);
            expect(rejected.json().error.type).toBe('invalid-token');
        }
    });

    it('create user rejects a non-string name without a 500', async () => {
        // A non-string `name` (number, null, array, object, boolean) must be
        // rejected 400 invalid-request via the type guard -- never an
        // unhandled TypeError / bare 500 -- and must create no user.
        const { client } = ctx;
        const before = new Set((await client.get('/v2/users')).json().data.items.map((u) => u.username));
        for (const bad of [123, null, ['x'], { k: 'v' }, true]) {
            const resp = await client.post('/v2/users', { json: { name: bad } });
            expect(resp.status, JSON.stringify(bad)).toBe(400);
            expect(resp.json().error.type, JSON.stringify(bad)).toBe('invalid-request');
        }
        const after = new Set((await client.get('/v2/users')).json().data.items.map((u) => u.username));
        expect(after).toEqual(before); // no user created by any rejected request
    });

    it('create user rejects all-punctuation names', async () => {
        // A "safe" name must contain at least one alphanumeric char;
        // all-punctuation names (`.`, `..`, `---`) are rejected 400 while a
        // normal name works.
        const { client } = ctx;
        const bads = ['.', '..', '---', '_', '._-'];
        for (const bad of bads) {
            const resp = await client.post('/v2/users', { json: { name: bad } });
            expect(resp.status, bad).toBe(400);
            expect(resp.json().error.type, bad).toBe('invalid-request');
        }
        const users = new Set((await client.get('/v2/users')).json().data.items.map((u) => u.username));
        expect(bads.some((bad) => users.has(bad))).toBe(false);
        const ok = await client.post('/v2/users', { json: { name: 'normal-name.1' } });
        expect(ok.status).toBe(201);
        expect(ok.json().data.username).toBe('normal-name.1');
    });

    it('create user rejects unsafe names and keeps the id scheme', async () => {
        // A `~` or `/` in a username would break the `username~name` id scheme
        // and storage-id namespacing (self-locking the user out of storage
        // auto-create), so such names are rejected 400 and no user is created.
        const { client } = ctx;
        for (const bad of ['carol~evil', 'carol/evil', '']) {
            const resp = await client.post('/v2/users', { json: { name: bad } });
            expect(resp.status, bad).toBe(400);
            expect(resp.json().error.type, bad).toBe('invalid-request');
        }
        const users = new Set((await client.get('/v2/users')).json().data.items.map((u) => u.username));
        expect(users.has('carol~evil')).toBe(false);
        expect(users.has('carol/evil')).toBe(false);
        // A valid name works and can drive the full per-user storage flow.
        const ok = await client.post('/v2/users', { json: { name: 'carol' } });
        expect(ok.status).toBe(201);
        const put = await client.put(`/v2/${KV}/carol~default/records/foo`, {
            body: JSON.stringify({ hi: 1 }),
            headers: { ...auth('carol'), 'content-type': 'application/json' },
        });
        expect(put.status).toBe(200);
        const got = await client.get(`/v2/${KV}/carol~default/records/foo`, { headers: auth('carol') });
        expect(got.status).toBe(200);
        expect(got.json()).toEqual({ hi: 1 });
    });

    it('create-user name colliding with a bound token reports accurately', async () => {
        // A create-user name may collide with an existing user's unique
        // *token* rather than a username (here the default user's bootstrap
        // token). It is still a 409 resource-conflict, but the message must
        // not claim a *user named X* exists.
        const { client } = ctx;
        const boot = await client.get('/v2/users/me', { headers: auth('shared') });
        expect(boot.status).toBe(200);
        expect(boot.json().data.username).toBe('local-user');
        const resp = await client.post('/v2/users', { json: { name: 'shared' } });
        expect(resp.status).toBe(409);
        expect(resp.json().error.type).toBe('resource-conflict');
        const message = resp.json().error.message;
        expect(message).not.toContain('already exists'); // no such *username* exists
        expect(message).toContain('token');
        // No corruption: no username "shared", and the default user keeps token "shared".
        const users = Object.fromEntries(
            (await client.get('/v2/users')).json().data.items.map((u) => [u.username, u.token]),
        );
        expect('shared' in users).toBe(false);
        expect(users['local-user']).toBe('shared');
    });

    it('list users and users/me expose tokens', async () => {
        const { client } = ctx;
        await createUser(client, 'u1');
        await createUser(client, 'u2');
        const users = Object.fromEntries(
            (await client.get('/v2/users')).json().data.items.map((u) => [u.username, u]),
        );
        expect(users.u1.token).toBe('u1');
        expect(users.u2.token).toBe('u2');
        expect('local-user' in users).toBe(true); // the default user is listed too
        const me = (await client.get('/v2/users/me', { headers: auth('u1') })).json().data;
        expect(me.username).toBe('u1');
        expect(me.id).toBe('u1');
        expect(me.token).toBe('u1');
    });

    it('container env APIFY_USER_ID is the username', async () => {
        const { client, service, driver } = ctx;
        await provision(client, service, 'alice');
        const env = driver.capturedEnvs.at(-1);
        expect(env.APIFY_USER_ID).toBe('alice');
    });
});

// -- GET /v2/users/{userIdOrUsername} (public profile, any user) ----------
// Id and username are the same value in this runtime (a user record's primary
// key IS its username -- see 'container env APIFY_USER_ID is the username'
// above for the same fact from the container-env side), so "by id" and "by
// username" below exercise the identical lookup path.
describe('GET /v2/users/{userIdOrUsername}', () => {
    it('returns public data by id or username', async () => {
        const { client } = ctx;
        const resp = await client.get('/v2/users/alice', { headers: auth('bob') });
        expect(resp.status).toBe(200);
        const body = resp.json().data;
        expect(body.username).toBe('alice');
        expect(body.id).toBe('alice');
        // Public data only -- never the target's token, unlike /v2/users/me.
        expect('token' in body).toBe(false);
    });

    it('resolves without a token too', async () => {
        const { client } = ctx;
        // No token is never rejected here either -- same policy as every other route.
        const resp = await client.get('/v2/users/bob');
        expect(resp.status).toBe(200);
        expect(resp.json().data.username).toBe('bob');
    });

    it('unknown id or username is 404', async () => {
        const { client } = ctx;
        const resp = await client.get('/v2/users/does-not-exist', { headers: auth('alice') });
        expect(resp.status).toBe(404);
        expect(resp.json().error.type).toBe('record-not-found');
    });

    it('rejects an unknown token after bootstrap', async () => {
        const { client } = ctx;
        // Same bootstrap-or-reject guard as every other authenticated route
        // (see the unknown-token-rejected test above): claim the default
        // user's credential first, then a genuinely unknown token is rejected.
        const claimed = await client.get('/v2/users/me', { headers: auth('claim-tok') });
        expect(claimed.status).toBe(200);
        const rejected = await client.get('/v2/users/alice', { headers: auth('intruder-xyz') });
        expect(rejected.status).toBe(401);
        expect(rejected.json().error.type).toBe('invalid-token');
    });

    it('the /v2/users/me route still takes priority over the path param', async () => {
        const { client } = ctx;
        // Regression: the new `/v2/users/{userIdOrUsername}` route must not
        // shadow the literal `/v2/users/me` route declared above it -- `me`
        // must keep resolving to the acting user (with `token`), not a public
        // lookup for a user literally named "me".
        const resp = await client.get('/v2/users/me', { headers: auth('alice') });
        expect(resp.status).toBe(200);
        expect(resp.json().data.username).toBe('alice');
        expect(resp.json().data.token).toBe('alice');
    });
});

// -- THE ANTI-LEAK GUARANTEE (narrowed) ------------------------------------
// Scope: this guarantee covers exactly the FIRST BOUND token -- the
// credential apify-cli's first-ever request presented, bound to the default
// local-user, which may be a real externally-issued secret. It does NOT cover
// every token in the system: every user's `containerToken` (injected as
// APIFY_TOKEN -- see Service.buildEnvironment) is a runtime-fabricated
// credential and is BY DESIGN expected to appear in container env; that is
// exactly the mechanism the positive half of this test asserts below, not
// something this guarantee forbids.
describe('anti-leak guarantee', () => {
    it('the secret token never leaks into ids, responses or env', async () => {
        const { client, service, driver } = ctx;
        const secret = 'apify_api_SECRET123';
        const actor = (await client.post('/v2/acts', { json: { name: 'leaky' }, headers: auth(secret) }))
            .json().data;
        await client.post(`/v2/actors/${actor.id}/versions`, {
            json: {
                versionNumber: '0.0',
                sourceType: 'SOURCE_FILES',
                sourceFiles: [{ name: 'main.py', format: 'TEXT', content: "print('hi')\n" }],
            },
            headers: auth(secret),
        });
        const build = (
            await client.post(`/v2/acts/${actor.id}/builds?version=0.0`, { headers: auth(secret) })
        ).json().data;
        await service.waitIdle();
        let run = (
            await client.post(`/v2/acts/${actor.id}/runs`, {
                body: JSON.stringify({ greeting: 'hi' }),
                headers: { ...auth(secret), 'content-type': 'application/json' },
            })
        ).json().data;
        await service.waitIdle();
        run = (await client.get(`/v2/actor-runs/${run.id}`, { headers: auth(secret) })).json().data;
        const fetchedBuild = (await client.get(`/v2/actor-builds/${build.id}`, { headers: auth(secret) }))
            .json().data;

        // Identity fields are the default username, never the token.
        expect(actor.id).toBe('local-user~leaky');
        for (const obj of [actor, fetchedBuild, run]) {
            expect(obj.userId).toBe('local-user');
            expect(obj.username).toBe('local-user');
        }

        const buildRow = service.getBuild(build.id);
        const env = driver.capturedEnvs.at(-1);
        expect(env.APIFY_USER_ID).toBe('local-user');

        // -- Negative half: the bound secret appears NOWHERE, including as
        // the value of APIFY_TOKEN itself -- the one place it could plausibly
        // have coincided with the container credential had `containerToken`
        // not been a distinct, second, fabricated value (this closes the gap
        // the narrowed scope note above calls out: local-user's own runs,
        // where the bound token and APIFY_TOKEN could otherwise coincide).
        const haystacks = [
            actor.id, actor.userId, actor.username,
            fetchedBuild.id, fetchedBuild.userId, fetchedBuild.username,
            run.id, run.userId, run.username, run.actId,
            buildRow.imageTag,
            run.defaultKeyValueStoreId, run.defaultDatasetId, run.defaultRequestQueueId,
            ...Object.keys(env), ...Object.values(env).map((v) => String(v)),
        ];
        const blob = haystacks.map((h) => String(h)).join('\n');
        // raw token leaked into an id/response/tag/storage-id/env?
        expect(blob).not.toContain(secret);
        // token fragment leaked?
        expect(blob).not.toContain('SECRET123');

        // -- Positive half: APIFY_TOKEN is nonetheless a WORKING credential
        // for local-user. The anti-leak guarantee narrows to the bound
        // secret; it does not (and must not) forbid a *different*, fabricated
        // token from doing its job as a real bearer credential.
        expect(env.APIFY_TOKEN).toBeTruthy();
        expect(env.APIFY_TOKEN).not.toBe(secret);
        const me = (
            await client.get('/v2/users/me', { headers: { authorization: `Bearer ${env.APIFY_TOKEN}` } })
        ).json().data;
        expect(me.username).toBe('local-user');
    });
});

describe('per-user ownership', () => {
    it('actor is owned by the acting user', async () => {
        const { client } = ctx;
        const actor = (
            await client.post('/v2/acts', { json: { name: 'sample-actor' }, headers: auth('alice') })
        ).json().data;
        expect(actor.username).toBe('alice');
        expect(actor.userId).toBe('alice');
        expect(actor.id).toBe('alice~sample-actor');
    });

    it('build and run are owned by the acting user', async () => {
        const { client, service } = ctx;
        const { build, run } = await provision(client, service, 'alice');
        const fetchedBuild = (
            await client.get(`/v2/actor-builds/${build.id}`, { headers: auth('alice') })
        ).json().data;
        expect(fetchedBuild.username).toBe('alice');
        expect(run.username).toBe('alice');
    });

    it('two users with the same actor name do not collide', async () => {
        const { client } = ctx;
        const a = (await client.post('/v2/acts', { json: { name: 'sample-actor' }, headers: auth('alice') }))
            .json().data;
        const b = (await client.post('/v2/acts', { json: { name: 'sample-actor' }, headers: auth('bob') }))
            .json().data;
        expect(a.id).toBe('alice~sample-actor');
        expect(b.id).toBe('bob~sample-actor');
        expect(a.id).not.toBe(b.id);
        // Bob creating did not surface or overwrite alice's actor.
        const aliceList = (await client.get('/v2/users/me/actors', { headers: auth('alice') })).json().data;
        expect(aliceList.items.map((x) => x.id)).toEqual(['alice~sample-actor']);
    });
});

describe('strict isolation: actors, builds, runs', () => {
    it('lists are disjoint per user', async () => {
        const { client, service } = ctx;
        const { actorId: aliceActor } = await provision(client, service, 'alice');
        const { actorId: bobActor } = await provision(client, service, 'bob');

        for (const [token, ownActor, otherActor] of [
            ['alice', aliceActor, bobActor],
            ['bob', bobActor, aliceActor],
        ]) {
            const actors = (await client.get('/v2/acts', { headers: auth(token) })).json().data.items;
            expect(actors.map((a) => a.id)).toEqual([ownActor]);
            const builds = (await client.get('/v2/users/me/builds', { headers: auth(token) })).json().data.items;
            expect(builds.length).toBeGreaterThan(0);
            expect(builds.every((b) => b.username === token)).toBe(true);
            const runs = (await client.get('/v2/users/me/runs', { headers: auth(token) })).json().data.items;
            expect(runs.length).toBeGreaterThan(0);
            expect(runs.every((r) => r.username === token)).toBe(true);
            // Actor-scoped build/run lists for the other user's actor are empty for me.
            const otherBuilds = (await client.get(`/v2/acts/${otherActor}/builds`, { headers: auth(token) }))
                .json().data;
            expect(otherBuilds.items).toEqual([]);
            const otherRuns = (await client.get(`/v2/acts/${otherActor}/runs`, { headers: auth(token) }))
                .json().data;
            expect(otherRuns.items).toEqual([]);
        }
    });

    it('cross-user get by id is not found', async () => {
        const { client, service } = ctx;
        const { actorId: aliceActor, build: aliceBuild, run: aliceRun } = await provision(client, service, 'alice');

        for (const urlPath of [
            `/v2/actors/${aliceActor}`,
            `/v2/actor-builds/${aliceBuild.id}`,
            `/v2/actor-runs/${aliceRun.id}`,
            `/v2/actors/${aliceActor}/input-schema`,
        ]) {
            const resp = await client.get(urlPath, { headers: auth('bob') });
            expect(resp.status, urlPath).toBe(404);
            expect(resp.json().error.type).toBe(NOT_FOUND);
        }
        // Identical to a genuinely invented id.
        const invented = await client.get('/v2/actor-runs/does-not-exist', { headers: auth('bob') });
        expect(invented.status).toBe(404);
        expect(invented.json().error.type).toBe(NOT_FOUND);
    });

    it('cross-user mutation is not found and has no effect', async () => {
        const { client, service } = ctx;
        const { actorId: aliceActor, run: aliceRun } = await provision(client, service, 'alice');

        // Abort another user's run.
        let resp = await client.post(`/v2/actor-runs/${aliceRun.id}/abort`, { headers: auth('bob') });
        expect(resp.status).toBe(404);
        expect(resp.json().error.type).toBe(NOT_FOUND);
        // Update another user's actor.
        resp = await client.put(`/v2/actors/${aliceActor}`, {
            json: { defaultRunOptions: { timeoutSecs: 999 } },
            headers: auth('bob'),
        });
        expect(resp.status).toBe(404);
        expect(resp.json().error.type).toBe(NOT_FOUND);
        // Trigger a build on another user's actor.
        resp = await client.post(`/v2/acts/${aliceActor}/builds?version=0.0`, { headers: auth('bob') });
        expect(resp.status).toBe(404);
        expect(resp.json().error.type).toBe(NOT_FOUND);

        // Alice's run is untouched (still SUCCEEDED, not ABORTED).
        const still = (await client.get(`/v2/actor-runs/${aliceRun.id}`, { headers: auth('alice') }))
            .json().data;
        expect(still.status).toBe('SUCCEEDED');
    });
});

describe('owner drives own flow including storages', () => {
    it('owner full flow including storages', async () => {
        const { client, service } = ctx;
        const { build, run } = await provision(client, service, 'alice', { greeting: 'howdy' });
        expect(
            (await client.get(`/v2/actor-builds/${build.id}`, { headers: auth('alice') })).json().data.status,
        ).toBe('SUCCEEDED');
        expect(run.status).toBe('SUCCEEDED');

        const kv = run.defaultKeyValueStoreId;
        const ds = run.defaultDatasetId;
        const rq = run.defaultRequestQueueId;
        const output = (await client.get(`/v2/${KV}/${kv}/records/OUTPUT`, { headers: auth('alice') })).json();
        expect(output.greeting).toBe('howdy');
        const items = (await client.get(`/v2/${DS}/${ds}/items`, { headers: auth('alice') })).json();
        expect(items).toEqual([{ message: 'howdy world', index: 1 }]);
        const meta = (await client.get(`/v2/${RQ}/${rq}`, { headers: auth('alice') })).json().data;
        expect(meta.totalRequestCount).toBe(1);
    });
});

describe('run-storage isolation', () => {
    it('run storages are private on read', async () => {
        const { client, service } = ctx;
        const { run } = await provision(client, service, 'alice');
        for (const stype of [KV, DS, RQ]) {
            const sid = storageId(run, stype);
            for (const urlPath of readPaths(stype, sid)) {
                const ok = await client.get(urlPath, { headers: auth('alice') });
                expect(ok.status, `owner denied: ${urlPath}`).toBe(200);
                const denied = await client.get(urlPath, { headers: auth('bob') });
                expect(denied.status, `cross-user leak: ${urlPath}`).toBe(404);
                expect(denied.json().error.type).toBe(NOT_FOUND);
            }
            // Indistinguishable from an invented id of the same type.
            const invented = await client.get(`/v2/${stype}/invented-${stype}`, { headers: auth('bob') });
            expect(invented.status).toBe(404);
            expect(invented.json().error.type).toBe(NOT_FOUND);
        }
    });

    it('run storages are private on write', async () => {
        const { client, service } = ctx;
        const { run } = await provision(client, service, 'alice');
        for (const stype of [KV, DS, RQ]) {
            const sid = storageId(run, stype);
            const resp = await write(client, stype, sid, 'bob');
            expect(resp.status, `${stype} write leaked`).toBe(404);
            expect(resp.json().error.type).toBe(NOT_FOUND);
        }
        // Alice's storages are unchanged (no bob payload).
        const keys = (
            await client.get(`/v2/${KV}/${run.defaultKeyValueStoreId}/keys`, { headers: auth('alice') })
        ).json().data;
        expect(keys.items.every((k) => k.key !== 'GRANTEE')).toBe(true);
        const items = (
            await client.get(`/v2/${DS}/${run.defaultDatasetId}/items`, { headers: auth('alice') })
        ).json();
        expect(items).toEqual([{ message: 'hi world', index: 1 }]);
    });
});

// -- Regression: standalone create-echo storages are per-user -------------
// The client-supplied name must never become a GLOBAL un-namespaced storage
// id: two users' `POST {"name":"foo"}` must not collide on one row, and no
// user may seize another's not-yet-created name via a bare write.
describe('per-user namespaced storage creation', () => {
    it('create storage is namespaced and usable per user', async () => {
        const { client } = ctx;
        // Alice and Bob both create a KV store with the SAME name.
        const a = await client.post('/v2/key-value-stores', { json: { name: 'shared' }, headers: auth('alice') });
        const b = await client.post('/v2/key-value-stores', { json: { name: 'shared' }, headers: auth('bob') });
        expect(a.status).toBe(201);
        expect(b.status).toBe(201);
        const aid = a.json().data.id;
        const bid = b.json().data.id;
        // Distinct, namespaced ids owned by their creators (never a shared "default").
        expect(aid).toBe('alice~shared');
        expect(bid).toBe('bob~shared');
        expect(aid).not.toBe(bid);

        // The returned id is actually usable by its owner: alice writes then reads.
        const put = await client.put(`/v2/${KV}/${aid}/records/K`, {
            body: JSON.stringify({ who: 'alice' }),
            headers: { ...auth('alice'), 'content-type': 'application/json' },
        });
        expect(put.status).toBe(200);
        const got = await client.get(`/v2/${KV}/${aid}/records/K`, { headers: auth('alice') });
        expect(got.status).toBe(200);
        expect(got.json()).toEqual({ who: 'alice' });

        // Bob cannot read or write alice's namespaced store (isolation preserved).
        expect((await client.get(`/v2/${KV}/${aid}`, { headers: auth('bob') })).status).toBe(404);
        const bobWrite = await client.put(`/v2/${KV}/${aid}/records/K`, {
            body: JSON.stringify({ who: 'bob' }),
            headers: { ...auth('bob'), 'content-type': 'application/json' },
        });
        expect(bobWrite.status).toBe(404);
        expect(bobWrite.json().error.type).toBe(NOT_FOUND);
        // Alice's content is untouched by bob's rejected write.
        const reread = (await client.get(`/v2/${KV}/${aid}/records/K`, { headers: auth('alice') })).json();
        expect(reread).toEqual({ who: 'alice' });
    });

    it('a write cannot squat another user\'s namespaced id', async () => {
        const { client } = ctx;
        // Bob writes to an id in alice's namespace that has no backing row yet.
        const squat = await client.put(`/v2/${KV}/alice~notyet/records/X`, {
            body: JSON.stringify({ who: 'bob' }),
            headers: { ...auth('bob'), 'content-type': 'application/json' },
        });
        // He must NOT seize it: 404, not a silent auto-create owned by bob.
        expect(squat.status).toBe(404);
        expect(squat.json().error.type).toBe(NOT_FOUND);

        // Alice can now legitimately create + own it via the documented flow.
        const created = await client.post('/v2/key-value-stores', {
            json: { name: 'notyet' },
            headers: auth('alice'),
        });
        expect(created.status).toBe(201);
        const aid = created.json().data.id;
        expect(aid).toBe('alice~notyet');
        // And use it; bob still cannot see it.
        const put = await client.put(`/v2/${KV}/${aid}/records/X`, {
            body: JSON.stringify({ who: 'alice' }),
            headers: { ...auth('alice'), 'content-type': 'application/json' },
        });
        expect(put.status).toBe(200);
        expect((await client.get(`/v2/${KV}/${aid}`, { headers: auth('bob') })).status).toBe(404);
    });

    it('write auto-create rejects an invalid embedded name', async () => {
        // A write to an absent, caller-chosen namespaced id (`owner~name` or
        // `owner~{type}~name`) must reject a `name` portion that would not
        // pass `validateStorageName` -- not only bare
        // `POST .../key-value-stores?name=` calls, which already reject it.
        //
        // Unlike a name chosen through the documented `POST ...?name=` route,
        // a write's target `storeId` is an arbitrary URL path segment: the
        // caller can put anything after the owner's `~` prefix, including
        // something that is not a valid storage name at all. Without this
        // check, the write would still auto-create a row there, and a later
        // `GET` would hand back that invalid string verbatim as the storage's
        // `name` field -- exactly the shape crawlee's own domain objects
        // reject the instant a real SDK Actor opens a storage by that name.
        const { client } = ctx;
        for (const badId of [
            'alice~has_underscore', // underscore is not in NAME_REGEX
            'alice~-leading-hyphen',
            'alice~fake-type~name', // not a real type prefix -> derived name still has "~"
            'alice~', // empty name
        ]) {
            const resp = await client.put(`/v2/${KV}/${badId}/records/X`, {
                body: JSON.stringify({ who: 'alice' }),
                headers: { ...auth('alice'), 'content-type': 'application/json' },
            });
            expect(resp.status, `${badId}: expected 404, got ${resp.status} (${resp.text()})`).toBe(404);
            // Nothing was minted at that id -- not even visible to its own writer.
            expect((await client.get(`/v2/${KV}/${badId}`, { headers: auth('alice') })).status).toBe(404);
        }

        // A validly-named namespaced id is unaffected -- still auto-creates.
        const ok = await client.put(`/v2/${KV}/alice~valid-name/records/X`, {
            body: JSON.stringify({ who: 'alice' }),
            headers: { ...auth('alice'), 'content-type': 'application/json' },
        });
        expect(ok.status).toBe(200);
        expect((await client.get(`/v2/${KV}/alice~valid-name`, { headers: auth('alice') })).status).toBe(200);
    });

    it('create storage is idempotent for the owner and covers datasets', async () => {
        const { client } = ctx;
        const first = await client.post('/v2/datasets', { json: { name: 'd' }, headers: auth('alice') });
        expect(first.status).toBe(201);
        const did = first.json().data.id;
        expect(did).toBe('alice~d');
        // Re-creating the same storage as the owner is idempotent, not a misleading new 201.
        const again = await client.post('/v2/datasets', { json: { name: 'd' }, headers: auth('alice') });
        expect(again.status).toBe(200);
        expect(again.json().data.id).toBe(did);

        // Bob creating "d" gets his OWN distinct dataset, never alice's row.
        const bob = await client.post('/v2/datasets', { json: { name: 'd' }, headers: auth('bob') });
        expect(bob.status).toBe(201);
        expect(bob.json().data.id).toBe('bob~d');
        const pushResp = await client.post(`/v2/${DS}/bob~d/items`, {
            body: JSON.stringify({ who: 'bob' }),
            headers: { ...auth('bob'), 'content-type': 'application/json' },
        });
        expect(pushResp.status).toBe(201);
        // Bob's push landed only in his dataset; alice's stays empty and private.
        expect((await client.get(`/v2/${DS}/${did}`, { headers: auth('bob') })).status).toBe(404);
        const aliceItems = await client.get(`/v2/${DS}/${did}/items`, { headers: auth('alice') });
        expect(aliceItems.status).toBe(200);
        expect(aliceItems.json()).toEqual([]);
    });
});

// -- Regression: absent-write race cannot land in another owner's store ---
// A writer that loses the create race for a fresh bare id must never have its
// payload persisted into the winner's storage -- that would be a cross-user
// write with no grant. `ensureStorage` must be authoritative about who owns
// the id, and the guard must deny the race loser 404.
describe('absent-write ownership race', () => {
    it('ensureStorage owner is authoritative, not the caller', async () => {
        const { service } = ctx;
        // First caller wins ownership of a fresh bare id.
        expect(service.ensureStorage('bare-race', STORAGE_KV, 'alice')).toBe('alice');
        // A second caller for the SAME id is told alice owns it -- never
        // itself, so the guard can always tell the race winner from the loser.
        expect(service.ensureStorage('bare-race', STORAGE_KV, 'bob')).toBe('alice');
    });

    it('a write to an already-owned bare id cannot land', async () => {
        const { client, service } = ctx;
        // Deterministic sequential analogue of the race: alice already owns a
        // fresh bare id (as if she won the create race).
        service.ensureStorage('bare-shared', STORAGE_KV, 'alice');
        const alicePut = await client.put(`/v2/${KV}/bare-shared/records/K`, {
            body: JSON.stringify({ who: 'alice' }),
            headers: { ...auth('alice'), 'content-type': 'application/json' },
        });
        expect(alicePut.status).toBe(200);
        // A different user's write to that same bare id is denied and never persisted.
        const bobPut = await client.put(`/v2/${KV}/bare-shared/records/K`, {
            body: JSON.stringify({ who: 'bob' }),
            headers: { ...auth('bob'), 'content-type': 'application/json' },
        });
        expect(bobPut.status).toBe(404);
        expect(bobPut.json().error.type).toBe(NOT_FOUND);
        // Alice's content is unchanged -- bob's payload never landed in her storage.
        const reread = (await client.get(`/v2/${KV}/bare-shared/records/K`, { headers: auth('alice') })).json();
        expect(reread).toEqual({ who: 'alice' });
    });
});

describe('storage.type is validated against the route', () => {
    it('wrong-type route is not found', async () => {
        const { client, service } = ctx;
        const { run } = await provision(client, service, 'alice');
        const kv = run.defaultKeyValueStoreId;
        // A KV id addressed through the dataset route does not exist AS a
        // dataset: 404, even for its owner -- indistinguishable from an
        // invented dataset id.
        const resp = await client.get(`/v2/${DS}/${kv}/items`, { headers: auth('alice') });
        expect(resp.status).toBe(404);
        expect(resp.json().error.type).toBe(NOT_FOUND);
        // The correct-type route still works for the owner (no false positives).
        expect((await client.get(`/v2/${KV}/${kv}`, { headers: auth('alice') })).status).toBe(200);
        // A write to the wrong-type route is likewise 404 and does not auto-create.
        const wrongWrite = await client.post(`/v2/${DS}/${kv}/items`, {
            body: JSON.stringify({ x: 1 }),
            headers: { ...auth('alice'), 'content-type': 'application/json' },
        });
        expect(wrongWrite.status).toBe(404);
        expect(wrongWrite.json().error.type).toBe(NOT_FOUND);
    });
});

// -- create-echo 409 when the computed id is owned by another -------------
// With per-user namespacing a create always targets `{caller}~{name}`, so this
// branch is unreachable through the public API; seed the row directly to give
// the defensive branch regression coverage and prove it never leaks the other
// owner.
describe('create-echo conflict on a foreign-owned id', () => {
    it('conflicts without leaking the other owner', async () => {
        const { client, service } = ctx;
        // Seed a storages row at the exact id alice's create-echo would
        // compute, owned by bob (only reachable via direct seeding under the
        // namespacing invariant).
        service.ensureStorage('alice~conflict', STORAGE_KV, 'bob');
        const resp = await client.post('/v2/key-value-stores', {
            json: { name: 'conflict' },
            headers: auth('alice'),
        });
        expect(resp.status).toBe(409);
        expect(resp.json().error.type).toBe('resource-conflict');
        // The other owner's name is never leaked in the conflict response.
        expect(resp.text()).not.toContain('bob');
    });
});

describe('console (Users section + switch dropdown)', () => {
    it('console has login and per-user tabs', async () => {
        const { client } = ctx;
        const index = (await client.get('/')).text();
        const appJs = (await client.get('/console/app.js')).text();
        // No longer the fixed single-user text.
        expect(index).not.toContain('(single local user)');
        // Switch-user control is now a dropdown of existing users; current-user display kept.
        expect(index).toContain('id="user-select"');
        expect(index).toContain('id="current-user"');
        // No free-text token prompt.
        expect(!appJs.includes('prompt(') || !appJs.includes('Enter your API token')).toBe(true);
        // Top-level nav is the three new sections; Builds and Runs are no
        // longer top-level (they live under an actor's detail).
        for (const tab of ['id="tab-actors"', 'id="tab-storage"', 'id="tab-users"']) {
            expect(index).toContain(tab);
        }
        for (const gone of ['id="tab-builds"', 'id="tab-runs"']) {
            expect(index).not.toContain(gone);
        }
        // The actors list is backed by the per-user aggregate endpoint; an
        // actor's builds/runs are fetched from that actor's own per-actor
        // endpoints; the token is sent.
        expect(appJs).toContain('/v2/users/me/actors');
        expect(appJs).toContain('/v2/acts/${actorId}/builds');
        expect(appJs).toContain('/v2/acts/${actorId}/runs');
        expect(appJs).toContain('Authorization');
        expect(appJs).toContain('Bearer');
    });

    it('console users section wires list, reveal, switch and create', async () => {
        const { client } = ctx;
        const appJs = (await client.get('/console/app.js')).text();
        // Users view + header dropdown are populated from GET /v2/users.
        expect(appJs).toContain('/v2/users');
        // Create-by-name posts to the users endpoint; switch sets the target's token.
        expect(appJs).toContain('createUser');
        expect(appJs).toContain('switchTo');
        expect(appJs).toContain('setToken');
        // Reveal/switch/create are wired with addEventListener, never inline handlers.
        expect(appJs).toContain('addEventListener');
        for (const handler of ['onclick=', 'onload=', 'onerror=']) {
            expect(appJs.toLowerCase()).not.toContain(handler);
        }
        // Every fetch still routes through the shared authenticated helper.
        expect(appJs).toContain('async function api(');
    });
});

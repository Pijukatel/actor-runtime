/**
 * Storage sharing: grant/revoke READ or WRITE access on an individual storage
 * to another user, and the visibility/authorization rules around it.
 *
 * Identity model matches `tests/unit/multi-user.test.js`: users are decoupled
 * username/token pairs, created via the open, token-less `/v2/users` endpoint.
 * Everything runs Docker-free via `wire()`; the acting user is chosen per
 * request with `Authorization: Bearer <token>`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { wire } from '../helpers.js';
import { DS, KV, RQ, auth, provision, readPaths, seedUsers, storageId, write } from './provisioning-harness.js';

const NOT_FOUND = 'record-not-found';

let ctx;

beforeEach(async () => {
    ctx = await wire();
    await seedUsers(ctx.client);
});

afterEach(async () => {
    await ctx.close();
});

describe('storage sharing', () => {
    it('grant READ lets the grantee read', async () => {
        const { client, service } = ctx;
        const { run } = await provision(client, service, 'alice');
        for (const stype of [KV, DS, RQ]) {
            const sid = storageId(run, stype);
            // Before the grant: bob is blind.
            expect((await client.get(`/v2/${stype}/${sid}`, { headers: auth('bob') })).status).toBe(404);
            const grant = await client.post(`/v2/${stype}/${sid}/access-rights`, {
                json: { grantee: 'bob', level: 'READ' },
                headers: auth('alice'),
            });
            expect(grant.status).toBe(201);
            // After the grant: every read succeeds and matches alice's content.
            for (const urlPath of readPaths(stype, sid)) {
                const bobResp = await client.get(urlPath, { headers: auth('bob') });
                const aliceResp = await client.get(urlPath, { headers: auth('alice') });
                expect(bobResp.status, urlPath).toBe(200);
                expect(bobResp.json(), urlPath).toEqual(aliceResp.json());
            }
        }
    });

    it('grant WRITE lets the grantee write and the owner sees it', async () => {
        const { client, service } = ctx;
        const { run } = await provision(client, service, 'alice');
        for (const stype of [KV, DS, RQ]) {
            const sid = storageId(run, stype);
            await client.post(`/v2/${stype}/${sid}/access-rights`, {
                json: { grantee: 'bob', level: 'WRITE' },
                headers: auth('alice'),
            });
            const resp = await write(client, stype, sid, 'bob');
            expect([200, 201], `${stype} grantee write refused`).toContain(resp.status);

            if (stype === KV) {
                const bobVal = (await client.get(`/v2/${KV}/${sid}/records/GRANTEE`, { headers: auth('bob') }))
                    .json();
                const aliceVal = (await client.get(`/v2/${KV}/${sid}/records/GRANTEE`, { headers: auth('alice') }))
                    .json();
                expect(bobVal).toEqual({ from: 'bob' });
                expect(aliceVal).toEqual({ from: 'bob' });
                const keys = (await client.get(`/v2/${KV}/${sid}/keys`, { headers: auth('alice') })).json().data;
                expect(keys.items.some((k) => k.key === 'GRANTEE')).toBe(true);
            } else if (stype === DS) {
                const bobItems = (await client.get(`/v2/${DS}/${sid}/items`, { headers: auth('bob') })).json();
                const aliceItems = (await client.get(`/v2/${DS}/${sid}/items`, { headers: auth('alice') }))
                    .json();
                expect(bobItems).toContainEqual({ from: 'bob' });
                expect(bobItems).toEqual(aliceItems);
            } else {
                const bobReqs = (await client.get(`/v2/${RQ}/${sid}/requests`, { headers: auth('bob') }))
                    .json().data.items;
                const aliceReqs = (await client.get(`/v2/${RQ}/${sid}/requests`, { headers: auth('alice') }))
                    .json().data.items;
                expect(bobReqs.some((r) => r.url === 'https://example.com/bob')).toBe(true);
                expect(bobReqs.length).toBe(aliceReqs.length);
            }
        }
    });

    it('a READ grantee\'s write is forbidden, distinct from not-found', async () => {
        const { client, service } = ctx;
        const { run } = await provision(client, service, 'alice');
        for (const stype of [KV, DS, RQ]) {
            const sid = storageId(run, stype);
            await client.post(`/v2/${stype}/${sid}/access-rights`, {
                json: { grantee: 'bob', level: 'READ' },
                headers: auth('alice'),
            });
            const resp = await write(client, stype, sid, 'bob');
            expect(resp.status, `${stype}: expected forbidden`).toBe(403);
            expect(resp.json().error.type).not.toBe(NOT_FOUND);
            expect(resp.json().error.type).toBe('insufficient-permissions');
        }
        // Alice's storage unchanged.
        const items = (
            await client.get(`/v2/${DS}/${run.defaultDatasetId}/items`, { headers: auth('alice') })
        ).json();
        expect(items).toEqual([{ message: 'hi world', index: 1 }]);
    });

    it('only the owner can manage shares', async () => {
        const { client, service } = ctx;
        const { run } = await provision(client, service, 'alice');
        const sid = run.defaultKeyValueStoreId;

        // A stranger (no access) cannot grant, list or revoke.
        expect(
            (
                await client.post(`/v2/${KV}/${sid}/access-rights`, {
                    json: { grantee: 'mallory', level: 'READ' },
                    headers: auth('bob'),
                })
            ).status,
        ).toBe(403);
        expect((await client.get(`/v2/${KV}/${sid}/access-rights`, { headers: auth('bob') })).status).toBe(403);
        expect(
            (await client.delete(`/v2/${KV}/${sid}/access-rights/anyone`, { headers: auth('bob') })).status,
        ).toBe(403);

        // A WRITE grantee still cannot manage (no re-share / escalation).
        await client.post(`/v2/${KV}/${sid}/access-rights`, {
            json: { grantee: 'bob', level: 'WRITE' },
            headers: auth('alice'),
        });
        expect(
            (
                await client.post(`/v2/${KV}/${sid}/access-rights`, {
                    json: { grantee: 'carol', level: 'WRITE' },
                    headers: auth('bob'),
                })
            ).status,
        ).toBe(403);
        expect((await client.get(`/v2/${KV}/${sid}/access-rights`, { headers: auth('bob') })).status).toBe(403);
        expect(
            (await client.delete(`/v2/${KV}/${sid}/access-rights/bob`, { headers: auth('bob') })).status,
        ).toBe(403);

        // State unchanged: bob is still exactly WRITE, carol was never added.
        const rights = (await client.get(`/v2/${KV}/${sid}/access-rights`, { headers: auth('alice') }))
            .json().data.items;
        const grantees = Object.fromEntries(rights.map((r) => [r.grantee, r.level]));
        expect(grantees).toEqual({ bob: 'WRITE' });
    });

    it('a grant is per-storage only', async () => {
        const { client, service } = ctx;
        const { actorId, build, run } = await provision(client, service, 'alice');
        const shared = run.defaultKeyValueStoreId;
        await client.post(`/v2/${KV}/${shared}/access-rights`, {
            json: { grantee: 'bob', level: 'READ' },
            headers: auth('alice'),
        });

        // Bob can reach only the shared KV store.
        expect((await client.get(`/v2/${KV}/${shared}`, { headers: auth('bob') })).status).toBe(200);
        // The other two storages of the same run stay invisible.
        expect((await client.get(`/v2/${DS}/${run.defaultDatasetId}`, { headers: auth('bob') })).status).toBe(404);
        expect(
            (await client.get(`/v2/${RQ}/${run.defaultRequestQueueId}`, { headers: auth('bob') })).status,
        ).toBe(404);
        // The run/build/actor behind it stay invisible.
        expect((await client.get(`/v2/actor-runs/${run.id}`, { headers: auth('bob') })).status).toBe(404);
        expect((await client.get(`/v2/actor-builds/${build.id}`, { headers: auth('bob') })).status).toBe(404);
        expect((await client.get(`/v2/actors/${actorId}`, { headers: auth('bob') })).status).toBe(404);
        // Bob's own lists still show none of alice's objects.
        expect((await client.get('/v2/users/me/actors', { headers: auth('bob') })).json().data.items).toEqual([]);
        expect((await client.get('/v2/users/me/runs', { headers: auth('bob') })).json().data.items).toEqual([]);
    });

    it('revoke returns the storage to not-found', async () => {
        const { client, service } = ctx;
        const { run } = await provision(client, service, 'alice');
        const sid = run.defaultKeyValueStoreId;
        await client.post(`/v2/${KV}/${sid}/access-rights`, {
            json: { grantee: 'bob', level: 'WRITE' },
            headers: auth('alice'),
        });
        expect((await client.get(`/v2/${KV}/${sid}`, { headers: auth('bob') })).status).toBe(200);

        const revoke = await client.delete(`/v2/${KV}/${sid}/access-rights/bob`, { headers: auth('alice') });
        expect(revoke.status).toBe(200);

        const read = await client.get(`/v2/${KV}/${sid}`, { headers: auth('bob') });
        expect(read.status).toBe(404);
        expect(read.json().error.type).toBe(NOT_FOUND);
        const writeResp = await write(client, KV, sid, 'bob');
        expect(writeResp.status).toBe(404);
        expect(writeResp.json().error.type).toBe(NOT_FOUND);
        // Alice still reads her unchanged store.
        expect((await client.get(`/v2/${KV}/${sid}/records/OUTPUT`, { headers: auth('alice') })).status).toBe(200);
    });

    it('listing grantees reflects grants and revokes', async () => {
        const { client, service } = ctx;
        const { run } = await provision(client, service, 'alice');
        const sid = run.defaultDatasetId;

        await client.post(`/v2/${DS}/${sid}/access-rights`, {
            json: { grantee: 'bob', level: 'READ' },
            headers: auth('alice'),
        });
        let rights = (await client.get(`/v2/${DS}/${sid}/access-rights`, { headers: auth('alice') }))
            .json().data.items;
        expect(Object.fromEntries(rights.map((r) => [r.grantee, r.level]))).toEqual({ bob: 'READ' });

        // Upgrade to WRITE (re-grant updates the level in place).
        await client.post(`/v2/${DS}/${sid}/access-rights`, {
            json: { grantee: 'bob', level: 'WRITE' },
            headers: auth('alice'),
        });
        rights = (await client.get(`/v2/${DS}/${sid}/access-rights`, { headers: auth('alice') }))
            .json().data.items;
        expect(Object.fromEntries(rights.map((r) => [r.grantee, r.level]))).toEqual({ bob: 'WRITE' });

        // Revoke removes bob from the listing.
        await client.delete(`/v2/${DS}/${sid}/access-rights/bob`, { headers: auth('alice') });
        rights = (await client.get(`/v2/${DS}/${sid}/access-rights`, { headers: auth('alice') }))
            .json().data.items;
        expect(rights).toEqual([]);
    });
});

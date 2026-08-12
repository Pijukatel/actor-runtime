/**
 * Storage-naming: server-side name validation, per-owner/type collision
 * handling, and the concurrency scenarios `getOrCreateNamedStorage`
 * (src/storage-access.js) must resolve safely.
 *
 * All Docker-free via `wire()` (in-process app + StubDriver, see
 * tests/helpers.js).
 *
 * Porting note on the concurrency tests: the Python predecessor's
 * `get_or_create_named_storage` awaited between its read and its create, so
 * racing coroutines could interleave inside it and it needed per-(owner,
 * name) asyncio locks. The JS port's read-decide-create sequence is fully
 * synchronous over the in-memory store (no awaits), so that interleaving is
 * structurally impossible - the race tests below are kept as end-to-end
 * invariant checks (concurrent HTTP creates still converge on correct,
 * per-type ids), and the Python lock-map bookkeeping test is adapted to
 * assert the invariant the lock existed to protect (one storage row per
 * distinct owner+name, never one per request).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { STORAGE_DS, STORAGE_RQ } from '../../src/constants.js';
import { StorageTypeCollisionError } from '../../src/storage-access.js';
import { wire } from '../helpers.js';

let ctx;

beforeEach(async () => {
    ctx = await wire();
});

afterEach(async () => {
    await ctx.close();
});

describe('storage naming', () => {
    it('create-storage honors the query-param name', async () => {
        // The real `apify-client` sends a get-or-create's `name` as a query
        // parameter, never in the JSON body -
        // `ResourceClientAsync._get_or_create()` builds the request via
        // `params=self._build_params(name=name)`, with the body left `None`
        // or schema-only. This is exactly the request shape
        // `Actor.open_dataset(name=...)`/`open_key_value_store(name=...)`/
        // `open_request_queue(name=...)` produce. A create route that only
        // read `body.name` would silently create (or resolve to) a storage
        // named "default" regardless of the name actually requested.
        const { client } = ctx;
        const resp = await client.post('/v2/key-value-stores?name=query-named');
        expect(resp.status).toBe(201);
        expect(resp.json().data).toEqual({ id: 'local-user~query-named', name: 'query-named' });

        // Same route, real request-queue get-or-create shape: no body at all.
        const resp2 = await client.post('/v2/request-queues?name=query-named-rq');
        expect(resp2.status).toBe(201);
        expect(resp2.json().data.id).toBe('local-user~query-named-rq');

        // Idempotent: calling again with the same query-param name resolves
        // to the same storage, not a fresh "default".
        const again = await client.post('/v2/key-value-stores?name=query-named');
        expect(again.status).toBe(200);
        expect(again.json().data.id).toBe('local-user~query-named');
    });

    it('same name across different types yields distinct storages', async () => {
        // A KV store and a dataset (etc.) created with the identical
        // owner+name must be two distinct, independently-usable storages -
        // never a silent misroute to the first one's type, and never a crash.
        // An existing-row check that only compared `owner`, never `type`,
        // would make the second create's route echo back the FIRST type's id
        // as if it were the second type; the next metadata fetch through the
        // correct-type route then 404s (or, worse, an unrelated write lands
        // in the wrong storage).
        const { client } = ctx;
        const kv = (await client.post('/v2/key-value-stores?name=shared-name')).json().data;
        const ds = (await client.post('/v2/datasets?name=shared-name')).json().data;
        const rq = (await client.post('/v2/request-queues?name=shared-name')).json().data;

        const ids = new Set([kv.id, ds.id, rq.id]);
        expect(ids.size, `expected 3 distinct ids, got ${JSON.stringify([...ids])}`).toBe(3);

        // Each id actually works as its own storage type (no misrouting/404),
        // and every GET's `name` field is the bare requested name - never a
        // raw first-`~` split of a type-qualified id, which would leave the
        // type prefix attached (e.g. "dataset~shared-name" instead of
        // "shared-name"). That mis-derived name is a string crawlee's own
        // storage-name validation rejects outright (it contains `~`), so it
        // would crash a real SDK Actor that opens a dataset and a KV store
        // under the same name - an entirely ordinary usage pattern, not an
        // edge case.
        const kvGet = await client.get(`/v2/key-value-stores/${kv.id}`);
        const dsGet = await client.get(`/v2/datasets/${ds.id}`);
        const rqGet = await client.get(`/v2/request-queues/${rq.id}`);
        expect(kvGet.status).toBe(200);
        expect(dsGet.status).toBe(200);
        expect(rqGet.status).toBe(200);
        expect(kvGet.json().data.name).toBe('shared-name');
        expect(dsGet.json().data.name).toBe('shared-name');
        expect(rqGet.json().data.name).toBe('shared-name');

        // And they are independently writable/readable without cross-talk.
        await client.put(`/v2/key-value-stores/${kv.id}/records/K`, {
            body: JSON.stringify({ which: 'kv' }),
            headers: { 'content-type': 'application/json' },
        });
        const push = await client.post(`/v2/datasets/${ds.id}/items`, {
            body: JSON.stringify({ which: 'ds' }),
            headers: { 'content-type': 'application/json' },
        });
        expect(push.status).toBe(201);
        const kvRecord = (await client.get(`/v2/key-value-stores/${kv.id}/records/K`)).json();
        expect(kvRecord).toEqual({ which: 'kv' });
        const dsItems = (await client.get(`/v2/datasets/${ds.id}/items`)).json();
        expect(dsItems).toEqual([{ which: 'ds' }]);

        // Repeating the create for each type with the same name+type is
        // still idempotent, resolving back to the same (possibly
        // type-qualified) id.
        const kvAgain = (await client.post('/v2/key-value-stores?name=shared-name')).json().data;
        expect(kvAgain.id).toBe(kv.id);
        const dsAgain = (await client.post('/v2/datasets?name=shared-name')).json().data;
        expect(dsAgain.id).toBe(ds.id);
    });

    it('concurrent cross-type creates of one fresh name are safe', async () => {
        // Concurrent get-or-create of DIFFERENT storage types under one
        // fresh, not-yet-existing owner+name must not misroute any caller to
        // an id that does not actually hold the type it asked for.
        //
        // In the Python predecessor this was a genuine TOCTOU race (the
        // read-and-decide ran across awaits, so racers could all observe the
        // unqualified id as absent and more than one type would claim it; a
        // standalone repro hit it 30/30 trials, fixed by a per-(owner, name)
        // lock). In this port `getOrCreateNamedStorage` is synchronous, so
        // the interleaving cannot occur - the test still drives three
        // genuinely concurrent HTTP creates and asserts the same observable
        // invariant: every returned id resolves via its own type's GET route,
        // and the three ids are pairwise distinct.
        const { client } = ctx;
        const routes = {
            kv: ['/v2/key-value-stores', (id) => `/v2/key-value-stores/${id}`],
            ds: ['/v2/datasets', (id) => `/v2/datasets/${id}`],
            rq: ['/v2/request-queues', (id) => `/v2/request-queues/${id}`],
        };
        const name = 'race-name';

        const results = Object.fromEntries(
            await Promise.all(
                Object.keys(routes).map(async (kind) => {
                    const [createPath] = routes[kind];
                    const resp = await client.post(`${createPath}?name=${name}`);
                    expect([200, 201], resp.text()).toContain(resp.status);
                    return [kind, resp.json().data];
                }),
            ),
        );

        const ids = new Set(Object.values(results).map((payload) => payload.id));
        expect(ids.size, `expected 3 distinct ids for 3 distinct types, got ${JSON.stringify(results)}`).toBe(3);

        for (const [kind, payload] of Object.entries(results)) {
            const [, getTemplate] = routes[kind];
            const getResp = await client.get(getTemplate(payload.id));
            expect(
                getResp.status,
                `${kind} id '${payload.id}' does not resolve as a ${kind} storage ` +
                    `(got ${getResp.status}) - misrouted by the create race`,
            ).toBe(200);
            expect(getResp.json().data.name).toBe(name);
        }
    });

    it('concurrent same-type creates of one fresh name return one id', async () => {
        // Concurrent get-or-create calls for the SAME type and fresh
        // owner+name must converge on exactly one id: every racer either
        // creates (201) or observes the already-created row (200), never two
        // different ids.
        const { client } = ctx;
        const name = 'same-type-race-name';

        const results = await Promise.all(
            Array.from({ length: 8 }, async () => {
                const resp = await client.post(`/v2/key-value-stores?name=${name}`);
                expect([200, 201], resp.text()).toContain(resp.status);
                return resp.json().data;
            }),
        );
        const ids = new Set(results.map((payload) => payload.id));
        expect([...ids]).toEqual([`local-user~${name}`]);

        const getResp = await client.get(`/v2/key-value-stores/local-user~${name}`);
        expect(getResp.status).toBe(200);
        expect(getResp.json().data.name).toBe(name);
    });

    it('one storage row per distinct owner+name, never one per request', async () => {
        // Adapted from the Python `_named_storage_locks` boundedness test:
        // the JS `StorageAccessManager` needs no per-(owner, name) lock map
        // (its read-decide-create is synchronous), so this asserts the
        // invariant that map existed to protect instead - repeated and
        // concurrent creates of one name yield exactly one storage row per
        // distinct (owner, name), never one per request.
        const { client, service } = ctx;

        // Same name, requested repeatedly (sequentially): exactly one row.
        for (let i = 0; i < 5; i += 1) {
            const resp = await client.post('/v2/key-value-stores?name=lock-bound-repeat');
            expect([200, 201]).toContain(resp.status);
        }
        expect(
            service.db.data.storages.filter((st) => st.id === 'local-user~lock-bound-repeat'),
        ).toHaveLength(1);

        // Concurrent racers sharing one fresh name: still just one more row.
        await Promise.all(
            Array.from({ length: 6 }, () => client.post('/v2/datasets?name=lock-bound-concurrent')),
        );
        expect(
            service.db.data.storages.filter((st) => st.id === 'local-user~lock-bound-concurrent'),
        ).toHaveLength(1);
    });

    // -- Storage-name validation + type re-check ---------------------------
    //
    // Without server-side name validation, and without re-checking the
    // resolved row's type after computing the type-qualified id, a
    // caller-chosen name containing `~` (e.g. "key-value-store~shared") could
    // deterministically - no race needed - collide with an unrelated
    // storage's literal id, silently reporting success while actually
    // resolving to the WRONG storage.

    it('create-storage rejects an invalid name', async () => {
        // A `~`-containing (or otherwise non-conforming) name is rejected
        // with `400 invalid-request`, instead of silently being accepted and
        // potentially colliding with this runtime's own `owner~name` /
        // `owner~{type}~name` id-qualification scheme.
        const { client } = ctx;
        for (const badName of [
            'key-value-store~shared',
            'has_underscore',
            '-leading-hyphen',
            'trailing-hyphen-',
            '~',
        ]) {
            const resp = await client.post(`/v2/datasets?name=${encodeURIComponent(badName)}`);
            expect(resp.status, `'${badName}': expected 400, got ${resp.status} (${resp.text()})`).toBe(400);
            expect(resp.json().error.type).toBe('invalid-request');
        }

        // A conforming name (letters/digits/hyphen, not leading/trailing)
        // still works.
        const ok = await client.post('/v2/datasets?name=still-fine-1');
        expect(ok.status).toBe(201);
    });

    it('the deterministic name-collision scenario is safe', async () => {
        // Exercises the exact deterministic (non-concurrent) collision: a
        // dataset named "key-value-store~shared" would mint id
        // `local-user~key-value-store~shared` - the SAME id a key-value
        // store named plain "shared" computes as its type-qualified id once
        // `local-user~shared` is already taken by a different type. Without
        // validation this makes the KV-store "create" call return 200/201
        // success while actually resolving to the dataset's row
        // (`kv.id == ds.id`); any subsequent KV-store-typed read then 404s,
        // contradicting the success response.
        //
        // The poisoned name is rejected outright at the first call, so the
        // later, ordinarily-valid creates never see a colliding id at all.
        const { client } = ctx;

        const poisoned = await client.post(`/v2/datasets?name=${encodeURIComponent('key-value-store~shared')}`);
        expect(poisoned.status).toBe(400);

        // The request queue claims the unqualified id first (nothing else
        // named "shared" exists yet, since the poisoned dataset create above
        // never went through).
        const rq = (await client.post('/v2/request-queues?name=shared')).json().data;
        expect(rq.id).toBe('local-user~shared');

        // The key-value store, sharing that same name, is forced onto ITS
        // OWN type-qualified id - "local-user~key-value-store~shared" -
        // which is EXACTLY the id the (rejected) poisoned dataset name would
        // have produced. Without validation this would have collided with
        // that dataset's row; now the dataset never existed, so this id is
        // genuinely fresh and genuinely a key-value store.
        const kv = (await client.post('/v2/key-value-stores?name=shared')).json().data;
        expect(kv.id).toBe('local-user~key-value-store~shared');
        expect(kv.id).not.toBe(rq.id);

        // And the KV store genuinely IS a key-value store (no misrouting/404).
        const kvGet = await client.get(`/v2/key-value-stores/${kv.id}`);
        expect(kvGet.status).toBe(200);
        expect(kvGet.json().data.name).toBe('shared');

        // The poisoned dataset name was rejected outright - no dataset row
        // (or any row at all) exists at the id it would have minted.
        expect((await client.get(`/v2/datasets/${kv.id}`)).status).toBe(404);
    });

    it('getOrCreateNamedStorage raises on a type collision', async () => {
        // Defence-in-depth unit test for the (now normally unreachable,
        // thanks to `validateStorageName`) type re-check: if the
        // type-qualified id a `getOrCreateNamedStorage` call would compute is
        // somehow ALREADY occupied by a storage of a different type
        // (simulating pre-existing `~`-containing data written before
        // validation existed, or a future bug elsewhere), the function must
        // refuse to silently hand back that wrong-typed id - it must throw
        // `StorageTypeCollisionError` instead.
        //
        // Constructed directly against `StorageAccessManager` (bypassing the
        // now-validated HTTP create route on purpose) since a real caller can
        // no longer reach this state through the API.
        const { client, service } = ctx;
        const owner = 'local-user';

        // Claim the unqualified id as a KV store first, so a dataset create
        // for the same name is forced onto the type-qualified branch.
        const kv = (await client.post('/v2/key-value-stores?name=collide')).json().data;
        expect(kv.id).toBe(`${owner}~collide`);

        // Simulate pre-existing data at the type-qualified id the dataset
        // create would compute (`owner~dataset~collide`), but holding the
        // WRONG type (request-queue, not dataset) - bypassing
        // `getOrCreateNamedStorage` (and its validation) entirely, exactly
        // like data written before validation existed would look.
        const poisonedId = `${owner}~${STORAGE_DS}~collide`;
        service.storageAccess.ensureStorage(poisonedId, STORAGE_RQ, owner);

        expect(() => service.getOrCreateNamedStorage('collide', STORAGE_DS, owner)).toThrow(
            StorageTypeCollisionError,
        );
    });
});

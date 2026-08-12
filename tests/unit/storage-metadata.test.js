/**
 * Field-complete storage/run metadata for the SDK's storage clients, plus the
 * key-value-store per-record DELETE/HEAD routes that round out that surface.
 *
 * Dataset/KVS/RQ GET responses and `GET /v2/actor-runs/{id}` must carry every
 * field apify-sdk-python's own pydantic models require, so a real SDK Actor's
 * `Actor.get_input()`/`open_dataset()`/`open_request_queue()`/`Actor.init()`
 * calls succeed against this runtime instead of raising a validation error or
 * `KeyError`.
 *
 * All Docker-free via `wire()` (in-process app + StubDriver, see
 * tests/helpers.js); this module does not import any SDK client itself, so it
 * stays hermetic to this repo's own node_modules.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runDict } from '../../src/serializers.js';
import { wire } from '../helpers.js';

let ctx;

beforeEach(async () => {
    ctx = await wire();
});

afterEach(async () => {
    await ctx.close();
});

async function pushActor(client) {
    // Mirrors what apify-cli's push does: create actor, then upload source files.
    await client.post('/v2/acts', {
        json: { name: 'sample-actor', versions: [{ versionNumber: '0.0', buildTag: 'latest' }] },
    });
    await client.post('/v2/actors/local-user~sample-actor/versions', {
        json: {
            versionNumber: '0.0',
            sourceType: 'SOURCE_FILES',
            sourceFiles: [{ name: 'main.js', format: 'TEXT', content: "console.log('hi');\n" }],
        },
    });
}

describe('storage metadata', () => {
    it('storage metadata is field-complete', async () => {
        // Dataset/KVS/RQ GET responses must carry every field apify-client's
        // response models require (non-optional, no default): id, name,
        // userId, createdAt/modifiedAt/accessedAt, consoleUrl, plus
        // itemCount/cleanItemCount (dataset) and totalRequestCount/
        // hadMultipleClients/stats (request queue).
        //
        // Regression: the pre-fix Python runtime carried only
        // `{id, name, itemCount}`, which the SDK's own storage-client
        // metadata models (re-validated on every `Actor.open_dataset()` /
        // `Actor.get_input()` / `Actor.open_request_queue()` call) would
        // reject on the very first call. Two further constraints apply beyond
        // mere field presence: (1) a run-derived storage's `name` must NOT be
        // the raw id verbatim - crawlee's own domain objects validate a
        // non-empty `name` against `^[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9]$`,
        // and every id this runtime mints contains `_` or `~`, so handing it
        // back as-is made `Actor.get_input()` itself raise; (2) the
        // request-queue metadata's `stats` key is read via direct dict
        // indexing (`response['stats']`, not `.get()`) by the SDK's own
        // request-queue client's `get_metadata()`, so its total absence made
        // `Actor.open_request_queue()` raise a `KeyError`.
        const { client, service } = ctx;
        await pushActor(client);
        await client.post('/v2/acts/local-user~sample-actor/builds?version=0.0');
        await service.waitIdle();
        const run = (
            await client.post('/v2/acts/local-user~sample-actor/runs', {
                body: JSON.stringify({ greeting: 'howdy' }),
                headers: { 'content-type': 'application/json' },
            })
        ).json().data;
        await service.waitIdle();

        const kv = (await client.get(`/v2/key-value-stores/${run.defaultKeyValueStoreId}`)).json().data;
        const ds = (await client.get(`/v2/datasets/${run.defaultDatasetId}`)).json().data;
        const rq = (await client.get(`/v2/request-queues/${run.defaultRequestQueueId}`)).json().data;

        for (const [meta, label] of [[kv, 'kv'], [ds, 'ds'], [rq, 'rq']]) {
            for (const field of ['id', 'name', 'userId', 'createdAt', 'modifiedAt', 'accessedAt', 'consoleUrl']) {
                expect(meta, `${label}: missing '${field}' in ${JSON.stringify(meta)}`).toHaveProperty(field);
            }
            // A run-derived storage's name must be empty, never the raw
            // underscore-containing id (crawlee rejects non-alphanumeric/
            // hyphen names the instant an SDK Actor opens its default
            // storage).
            expect(meta.name, `${label}: run-derived storage name must be empty, got '${meta.name}'`).toBe('');
        }
        expect(ds).toHaveProperty('itemCount');
        expect(ds).toHaveProperty('cleanItemCount');
        expect(rq).toHaveProperty('hadMultipleClients');
        expect(rq).toHaveProperty('totalRequestCount');
        expect(rq).toHaveProperty('stats');
    });

    it('run metadata includes options.diskMbytes, meta and stats', async () => {
        // `GET /v2/actor-runs/{id}` must carry `options.diskMbytes`, `meta`
        // and `stats` - all three required (no default) by apify-sdk-python's
        // own `ActorRun`/`ActorRunOptions` pydantic models, which
        // `Actor.init()`'s charging manager re-validates the response against
        // on every run, regardless of which `apify-client` version is pinned.
        // This only exercises the presence/value of these fields over HTTP
        // through the wired stub-driver app (no Docker); it does not import
        // any SDK client itself (those are only ever installed inside the
        // sample-actor Docker images at build time).
        const { client, service } = ctx;
        await pushActor(client);
        await client.post('/v2/acts/local-user~sample-actor/builds?version=0.0');
        await service.waitIdle();
        let run = (
            await client.post('/v2/acts/local-user~sample-actor/runs', {
                body: JSON.stringify({ greeting: 'howdy' }),
                headers: { 'content-type': 'application/json' },
            })
        ).json().data;
        await service.waitIdle();

        run = (await client.get(`/v2/actor-runs/${run.id}`)).json().data;
        expect(run.options.diskMbytes).toBe(2048);
        expect(run.meta).toEqual({ origin: 'API' });
        expect(run.stats).toEqual({ restartCount: 0, resurrectCount: 0, computeUnits: 0.0 });
    });

    it('runDict reports STANDBY origin', () => {
        // Pure-unit companion to the HTTP round-trip above, for the `STANDBY`
        // branch of `runDict`'s `meta.origin` - deliberately NOT exercised
        // via a real standby run (the standby e2e/timing tests are flaky by
        // the task's own admission; `isStandby` is a plain boolean field, so
        // constructing a bare run record directly is a fully adequate,
        // deterministic substitute).
        const run = {
            id: 'r1',
            actorId: 'a1',
            username: 'local-user',
            buildId: 'b1',
            buildNumber: '0.0.1',
            status: 'RUNNING',
            kvStoreId: 'kv_r1',
            datasetId: 'ds_r1',
            requestQueueId: 'rq_r1',
            isStandby: true,
        };
        const out = runDict(run);
        expect(out.meta).toEqual({ origin: 'STANDBY' });
        expect(out.options.diskMbytes).toBe(2048);
        expect(out.stats).toEqual({ restartCount: 0, resurrectCount: 0, computeUnits: 0.0 });
    });

    it('kv per-record DELETE and HEAD', async () => {
        // KVS per-record DELETE and HEAD, matching apify-client's
        // `delete_record`/`record_exists`, which have no other coverage.
        const { client } = ctx;
        const kv = (await client.post('/v2/key-value-stores', { json: { name: 'recordops' } })).json().data;
        const kvId = kv.id;

        await client.put(`/v2/key-value-stores/${kvId}/records/FOO`, {
            body: JSON.stringify({ a: 1 }),
            headers: { 'content-type': 'application/json' },
        });
        expect((await client.head(`/v2/key-value-stores/${kvId}/records/FOO`)).status).toBe(200);
        expect((await client.head(`/v2/key-value-stores/${kvId}/records/MISSING`)).status).toBe(404);

        const deleted = await client.delete(`/v2/key-value-stores/${kvId}/records/FOO`);
        expect(deleted.status).toBe(200);
        expect((await client.get(`/v2/key-value-stores/${kvId}/records/FOO`)).status).toBe(404);
        expect((await client.head(`/v2/key-value-stores/${kvId}/records/FOO`)).status).toBe(404);
    });
});

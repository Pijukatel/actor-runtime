/**
 * Optional `limit`/`offset` pagination for the four listing surfaces (dataset
 * items, KV keys, RQ requests, per-user storage lists): a bare request
 * (neither param supplied) stays byte-for-byte identical to today's
 * unpaginated shape -- the contract every non-console (CLI/SDK/curl) caller
 * keeps relying on -- with two deliberate, additive exceptions: dataset items
 * now carry the `X-Apify-Pagination-*` response headers even bare, and every
 * KV-keys item (bare, `offset`-sliced, and cursor-mode alike) now carries a
 * `recordPublicUrl` (required by the real `apify-client`'s response model,
 * and matching the real API's own `ListOfKeys`, which always returns it).
 * Supplying `limit`/`offset` otherwise returns the corresponding slice plus
 * enough total-count information to page. KV keys additionally accept an
 * `exclusiveStartKey` cursor with a truthful `isTruncated`/
 * `nextExclusiveStartKey` (see the "KV keys" section below); its cursor-mode
 * envelope never carries a `total` (computing one would force the full-store
 * scan the cursor pushdown exists to avoid). See requirements/api.md's
 * "Pagination" section.
 */
import { ApifyClient } from 'apify-client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { authHeaders, wire } from '../helpers.js';

let ctx;

beforeEach(async () => {
    ctx = await wire();
});

afterEach(async () => {
    await ctx.close();
});

async function createUser(client, name) {
    await client.post('/v2/users', { json: { name } });
}

/**
 * Create a user and one storage for it, returning the created storage's id.
 * Shared by the real-`apify-client` tests below. (The Python suite needed a
 * separate real-`uvicorn` fixture for these because that client's transport
 * had no in-process hook; here `wire()` already serves the app on a real
 * loopback socket, so the same bootstrap works for every test alike.)
 */
async function bootstrapStorage(client, urlPath, name) {
    await createUser(client, name);
    const created = await client.post(urlPath, { json: { name }, headers: authHeaders(name) });
    return created.json().data.id;
}

// -------------------------------------------------------------- dataset items

describe('dataset items pagination', () => {
    it('bare request is an unpaginated bare array', async () => {
        const { client, service } = ctx;
        await createUser(client, 'ann');
        const created = await client.post('/v2/datasets', { json: { name: 'big' }, headers: authHeaders('ann') });
        const dsId = created.json().data.id;
        const items = Array.from({ length: 150 }, (_, i) => ({ i }));
        await service.storage.datasetPush(dsId, items);

        const resp = await client.get(`/v2/datasets/${dsId}/items`, { headers: authHeaders('ann') });
        expect(resp.status).toBe(200);
        const body = resp.json();
        expect(Array.isArray(body)).toBe(true);
        expect(body.length).toBe(150);
        expect(body[0]).toEqual({ i: 0 });
        expect(body[149]).toEqual({ i: 149 });
        // The BODY stays byte-for-byte identical to today, not just
        // parsed-equal: a bare request must reproduce the exact wire body
        // (item key order included) -- the literal thing requirements/api.md's
        // "byte-for-byte identical" promise means for this surface's body:
        // capture today's response, re-run the identical bare request, diff
        // the two -- the body must match exactly.
        expect(resp.text()).toBe(JSON.stringify(items));
        // The one deliberate, additive exception: the five
        // `X-Apify-Pagination-*` headers are now present even on a bare call
        // -- the real apify-client's dataset-items page parsing indexes them
        // directly, so a genuinely bare `listItems()` call would otherwise
        // fail before returning a single item (see sdk-compat.test.js). A
        // bare request reports `offset=0`, `count`/`total` equal to the full
        // item count, `limit` echoing that same count (never the internal
        // `DEFAULT_ITEM_LIMIT` sentinel), and `desc=false`.
        expect(resp.headers.get('x-apify-pagination-offset')).toBe('0');
        expect(resp.headers.get('x-apify-pagination-count')).toBe('150');
        expect(resp.headers.get('x-apify-pagination-total')).toBe('150');
        expect(resp.headers.get('x-apify-pagination-limit')).toBe('150');
        expect(resp.headers.get('x-apify-pagination-desc')).toBe('false');
    });

    it('limit+offset returns the slice and headers', async () => {
        const { client, service } = ctx;
        await createUser(client, 'ann2');
        const created = await client.post('/v2/datasets', { json: { name: 'big2' }, headers: authHeaders('ann2') });
        const dsId = created.json().data.id;
        await service.storage.datasetPush(dsId, Array.from({ length: 150 }, (_, i) => ({ i })));

        const resp = await client.get(`/v2/datasets/${dsId}/items?limit=20&offset=100`, {
            headers: authHeaders('ann2'),
        });
        expect(resp.status).toBe(200);
        const body = resp.json();
        expect(Array.isArray(body)).toBe(true);
        expect(body.length).toBe(20);
        expect(body[0]).toEqual({ i: 100 });
        expect(body[19]).toEqual({ i: 119 });
        expect(resp.headers.get('x-apify-pagination-offset')).toBe('100');
        expect(resp.headers.get('x-apify-pagination-count')).toBe('20');
        expect(resp.headers.get('x-apify-pagination-total')).toBe('150');
        expect(resp.headers.get('x-apify-pagination-limit')).toBe('20');
        // No `desc` query param exists on this surface -- items are always
        // returned in storage order, so this header is unconditionally
        // "false". The real apify-client's dataset-items page parsing reads
        // it directly, so its absence would break parsing before a single
        // item comes back -- see the real-client check below.
        expect(resp.headers.get('x-apify-pagination-desc')).toBe('false');
    });

    it('offset only keeps no-limit semantics', async () => {
        // Supplying only `offset` (no `limit`) still counts as "params given"
        // (the paginated branch), but the effective limit stays "no cap" --
        // matching the real API's own `dataset-items-get` documented default.
        // `-Limit` must therefore echo the actual returned count (5), never
        // the internal `DEFAULT_ITEM_LIMIT` sentinel (999999) the storage
        // layer applies under the hood for "no cap".
        const { client, service } = ctx;
        await createUser(client, 'ann3');
        const created = await client.post('/v2/datasets', { json: { name: 'big3' }, headers: authHeaders('ann3') });
        const dsId = created.json().data.id;
        await service.storage.datasetPush(dsId, Array.from({ length: 30 }, (_, i) => ({ i })));

        const resp = await client.get(`/v2/datasets/${dsId}/items?offset=25`, { headers: authHeaders('ann3') });
        expect(resp.status).toBe(200);
        const body = resp.json();
        expect(body.length).toBe(5);
        expect(body[0]).toEqual({ i: 25 });
        expect(body[4]).toEqual({ i: 29 });
        expect(resp.headers.get('x-apify-pagination-offset')).toBe('25');
        expect(resp.headers.get('x-apify-pagination-total')).toBe('30');
        expect(resp.headers.get('x-apify-pagination-count')).toBe('5');
        expect(resp.headers.get('x-apify-pagination-limit')).toBe('5');
        expect(resp.headers.get('x-apify-pagination-desc')).toBe('false');
    });

    it('limit only slices from the start', async () => {
        // `limit` without `offset` was previously untested for this surface
        // (only "offset-only" and "both supplied" were exercised) -- unlike
        // the KV-keys equivalent, exercises `paginate()`'s
        // `items.slice(start, start+limit)` branch with `start == 0` via the
        // default, not an explicit `offset=0`.
        const { client, service } = ctx;
        await createUser(client, 'ann4');
        const created = await client.post('/v2/datasets', { json: { name: 'big4' }, headers: authHeaders('ann4') });
        const dsId = created.json().data.id;
        await service.storage.datasetPush(dsId, Array.from({ length: 30 }, (_, i) => ({ i })));

        const resp = await client.get(`/v2/datasets/${dsId}/items?limit=5`, { headers: authHeaders('ann4') });
        expect(resp.status).toBe(200);
        const body = resp.json();
        expect(body.length).toBe(5);
        expect(body[0]).toEqual({ i: 0 });
        expect(body[4]).toEqual({ i: 4 });
        expect(resp.headers.get('x-apify-pagination-offset')).toBe('0');
        expect(resp.headers.get('x-apify-pagination-count')).toBe('5');
        expect(resp.headers.get('x-apify-pagination-total')).toBe('30');
        expect(resp.headers.get('x-apify-pagination-limit')).toBe('5');
        expect(resp.headers.get('x-apify-pagination-desc')).toBe('false');
    });

    it('pagination headers are CORS-exposed', async () => {
        // Regression: the predecessor's CORSMiddleware shipped with no
        // `expose_headers`, so a cross-origin browser caller could see the
        // five `X-Apify-Pagination-*` headers on the wire but never read them
        // from JS -- the browser hides any response header not explicitly
        // exposed -- silently forcing such a caller back onto `items.length`
        // to page. The shipped console itself is same-origin and unaffected;
        // this is about any OTHER browser-based caller of this permissive
        // (allow-origin `*`) API.
        const { client } = ctx;
        await createUser(client, 'cors');
        const created = await client.post('/v2/datasets', { json: { name: 'd' }, headers: authHeaders('cors') });
        const dsId = created.json().data.id;

        const resp = await client.get(`/v2/datasets/${dsId}/items?limit=5`, {
            headers: { ...authHeaders('cors'), Origin: 'https://example.com' },
        });
        expect(resp.status).toBe(200);
        const exposed = (resp.headers.get('access-control-expose-headers') ?? '').toLowerCase();
        for (const header of [
            'x-apify-pagination-offset',
            'x-apify-pagination-count',
            'x-apify-pagination-total',
            'x-apify-pagination-limit',
            'x-apify-pagination-desc',
        ]) {
            expect(exposed).toContain(header);
        }
    });

    it('negative limit is a bad request', async () => {
        const { client } = ctx;
        await createUser(client, 'neg');
        const created = await client.post('/v2/datasets', { json: { name: 'd' }, headers: authHeaders('neg') });
        const dsId = created.json().data.id;
        const resp = await client.get(`/v2/datasets/${dsId}/items?limit=-1`, { headers: authHeaders('neg') });
        expect(resp.status).toBe(400);
    });

    it('non-integer limit is a bad request', async () => {
        // The int-parse rejection branch, reached via `parsePage`'s
        // `optional()` closure, guards all four listing surfaces. "abc" is
        // not an integer, so this must be `400` -- reshaped by the
        // HttpError->400 handler (`src/app.js`) into this app's own
        // `{"error": {...}}` envelope, not a bare `{"detail": ...}` shape
        // (see requirements/api.md's Pagination section).
        const { client } = ctx;
        await createUser(client, 'nonint');
        const created = await client.post('/v2/datasets', { json: { name: 'd' }, headers: authHeaders('nonint') });
        const dsId = created.json().data.id;
        const resp = await client.get(`/v2/datasets/${dsId}/items?limit=abc`, { headers: authHeaders('nonint') });
        expect(resp.status).toBe(400);
        expect(resp.json().error).toEqual({
            type: 'invalid-request',
            message: "Query parameter 'limit' must be an integer.",
        });
    });

    it('non-integer offset is a bad request', async () => {
        // Same branch as above, exercised via `offset` instead of `limit`,
        // and with a value that looks numeric but isn't an integer ("1.5") --
        // a caller passing a float string must get the same `400`, not a
        // silently-truncated/ignored offset.
        const { client } = ctx;
        await createUser(client, 'nonint2');
        const created = await client.post('/v2/datasets', { json: { name: 'd' }, headers: authHeaders('nonint2') });
        const dsId = created.json().data.id;
        const resp = await client.get(`/v2/datasets/${dsId}/items?offset=1.5`, { headers: authHeaders('nonint2') });
        expect(resp.status).toBe(400);
        expect(resp.json().error).toEqual({
            type: 'invalid-request',
            message: "Query parameter 'offset' must be an integer.",
        });
    });

    it('empty-string params are treated as absent', async () => {
        // An empty `?limit=&offset=` (an explicit but blank query value) must
        // be treated identically to omitting the params entirely -- the same
        // unpaginated bare-array response, byte-for-byte, not a `400` from
        // trying to parse `""` as an integer.
        const { client, service } = ctx;
        await createUser(client, 'es');
        const created = await client.post('/v2/datasets', { json: { name: 'big' }, headers: authHeaders('es') });
        const dsId = created.json().data.id;
        await service.storage.datasetPush(dsId, Array.from({ length: 150 }, (_, i) => ({ i })));

        const bare = await client.get(`/v2/datasets/${dsId}/items`, { headers: authHeaders('es') });
        const empty = await client.get(`/v2/datasets/${dsId}/items?limit=&offset=`, { headers: authHeaders('es') });

        expect(empty.status).toBe(200);
        expect(empty.json()).toEqual(bare.json());
        expect(empty.json().length).toBe(150);
        // Empty-string params land on the identical unpaginated branch as no
        // params at all -- including the same bare-call pagination headers
        // (see the bare-request test above).
        expect(empty.headers.get('x-apify-pagination-total')).toBe('150');
        expect(bare.headers.get('x-apify-pagination-total')).toBe('150');
    });

    it('the real apify-client listItems parses this surface', async () => {
        // The REAL `apify-client` (package.json pins 2.25.0, not a
        // hand-rolled reproduction of it) must be able to read dataset items
        // back from this surface end to end via `listItems()`, driven over
        // the real loopback socket `wire()` serves.
        //
        // The client's dataset-items page parsing reads all five
        // `x-apify-pagination-*` response headers, so this is the regression
        // check for a response that carries only four of them: `total`/
        // `offset`/`limit` would come back `NaN` (and `desc` would break)
        // instead of the truthful numbers asserted here.
        const { client, service } = ctx;
        const datasetId = await bootstrapStorage(client, '/v2/datasets', 'pinned');
        await service.storage.datasetPush(datasetId, Array.from({ length: 30 }, (_, i) => ({ i })));

        const apify = new ApifyClient({ baseUrl: ctx.baseUrl, token: 'pinned' });
        const dataset = apify.dataset(datasetId);

        const page = await dataset.listItems({ limit: 10, offset: 5 });
        expect(page.items.map((item) => item.i)).toEqual(Array.from({ length: 10 }, (_, i) => i + 5));
        expect(page.total).toBe(30);
        expect(page.offset).toBe(5);
        expect(page.count).toBe(10);
        expect(page.limit).toBe(10);
        expect(page.desc).toBe(false);

        // The SDK path (`Actor.openDataset().getData()`/`iterateItems()`)
        // always sends an explicit offset=0 + huge-limit shape, taking this
        // paginated arm on every call -- exercised explicitly since it's the
        // shape most likely to exist against a running runtime in practice.
        const sdkShapedPage = await dataset.listItems({ offset: 0, limit: 999_999_999_999 });
        expect(sdkShapedPage.items.length).toBe(30);
        expect(sdkShapedPage.desc).toBe(false);
    });
});

// -------------------------------------------------------------------- KV keys

const k = (i) => `k${String(i).padStart(4, '0')}`;

async function seedKeys(client, storeId, token, count) {
    for (let i = 0; i < count; i += 1) {
        await client.put(`/v2/key-value-stores/${storeId}/records/${k(i)}`, {
            body: JSON.stringify({ v: i }),
            headers: { ...authHeaders(token), 'content-type': 'application/json' },
        });
    }
}

/**
 * Same key naming/content as `seedKeys`, but written directly against the
 * storage layer (no per-key HTTP round trip) -- for tests that need a store
 * larger than the real `apify-client`'s 1000-key paging chunk, where `count`
 * individual HTTP PUTs made this noticeably slower without testing anything
 * `seedKeys` doesn't already cover.
 */
async function seedKeysFast(service, storeId, count) {
    for (let i = 0; i < count; i += 1) {
        await service.storage.kvSet(storeId, k(i), { v: i }, 'application/json');
    }
}

describe('kv keys pagination', () => {
    it('bare request is unpaginated and unchanged', async () => {
        const { client } = ctx;
        await createUser(client, 'kate');
        const created = await client.post('/v2/key-value-stores', { json: { name: 'big' }, headers: authHeaders('kate') });
        const storeId = created.json().data.id;
        await seedKeys(client, storeId, 'kate', 120);

        const resp = await client.get(`/v2/key-value-stores/${storeId}/keys`, { headers: authHeaders('kate') });
        expect(resp.status).toBe(200);
        const body = resp.json().data;
        // Order-sensitive (not a set comparison, which is blind to a
        // reorder): this is the exact key order the surface had before
        // optional pagination existed, and no additive `total`.
        expect(Object.keys(body)).toEqual(['items', 'count', 'limit', 'isTruncated']);
        expect(body.count).toBe(120);
        expect(body.limit).toBe(120);
        expect(body.isTruncated).toBe(false);
        expect(body.items.length).toBe(120);
        // The deliberate exception: every item -- bare calls included -- now
        // carries `recordPublicUrl`, matching the real API's own `ListOfKeys`
        // (which always returns it) so the real apify-client's default bare
        // `listKeys()` validates. `key`/`size` stay present and in their
        // original order; `recordPublicUrl` is appended, with its exact value
        // asserted (not merely "is present") so this can't silently regress
        // to an empty string or the wrong path.
        const base = ctx.baseUrl;
        for (const item of body.items) {
            expect(Object.keys(item)).toEqual(['key', 'size', 'recordPublicUrl']);
            expect(item.recordPublicUrl).toBe(`${base}/v2/key-value-stores/${storeId}/records/${item.key}`);
        }
    }, 15_000);

    it('limit+offset returns the slice with total', async () => {
        // `offset`-mode paging (no `exclusiveStartKey`): `isTruncated` is
        // computed truthfully here too (`offset + limit < total`), even
        // though this is this runtime's own console-only mechanism with no
        // cursor to hand back -- there is deliberately no
        // `nextExclusiveStartKey` on this branch.
        const { client } = ctx;
        await createUser(client, 'kate2');
        const created = await client.post('/v2/key-value-stores', { json: { name: 'big2' }, headers: authHeaders('kate2') });
        const storeId = created.json().data.id;
        await seedKeys(client, storeId, 'kate2', 120);

        const resp = await client.get(`/v2/key-value-stores/${storeId}/keys?limit=10&offset=100`, {
            headers: authHeaders('kate2'),
        });
        expect(resp.status).toBe(200);
        const body = resp.json().data;
        expect(body.count).toBe(10);
        expect(body.limit).toBe(10);
        expect(body.total).toBe(120);
        expect(body.items.length).toBe(10);
        expect(body.isTruncated).toBe(true);
        expect(body).not.toHaveProperty('nextExclusiveStartKey');
        // Offset-mode items now carry `recordPublicUrl` too -- every path
        // through this endpoint does, not only cursor mode.
        const base = ctx.baseUrl;
        for (const item of body.items) {
            expect(Object.keys(item)).toEqual(['key', 'size', 'recordPublicUrl']);
            expect(item.recordPublicUrl).toBe(`${base}/v2/key-value-stores/${storeId}/records/${item.key}`);
        }
    }, 15_000);

    it('offset mode limit=0 is a non-truncating empty page', async () => {
        // Regression: the offset-sliced path's own `isTruncated` formula
        // (`offset + limit < keys.length`) had no `limit == 0` special case,
        // unlike the cursor path's own short-circuit (`Storage.kvKeysPage`)
        // -- so `?limit=0&offset=2` against a non-empty store reported
        // `isTruncated: true` for a page that is always empty, a loop hazard
        // for a naive "keep paging until isTruncated is false" caller. Must
        // mirror the cursor path's rule: `limit=0` is a zero-width window
        // with nothing to truncate, so it is never reported as truncated, on
        // EITHER path.
        const { client } = ctx;
        await createUser(client, 'zed3');
        const created = await client.post('/v2/key-value-stores', { json: { name: 'zed3' }, headers: authHeaders('zed3') });
        const storeId = created.json().data.id;
        await seedKeys(client, storeId, 'zed3', 5);

        const resp = await client.get(`/v2/key-value-stores/${storeId}/keys?limit=0&offset=2`, {
            headers: authHeaders('zed3'),
        });
        expect(resp.status).toBe(200);
        const body = resp.json().data;
        expect(body.items).toEqual([]);
        expect(body.count).toBe(0);
        expect(body.limit).toBe(0);
        expect(body.isTruncated).toBe(false);
        expect(body.total).toBe(5); // the offset path still reports a real total
        expect(body).not.toHaveProperty('nextExclusiveStartKey');
    });

    it('offset mode limit without truncation is not truncated', async () => {
        // The offset-sliced path's `isTruncated` formula previously had no
        // test for its OWN "not truncated" arm at all -- the only "not
        // truncated" coverage for this surface went through the DIFFERENT
        // cursor-path code, so a regression here (e.g. `<=` swapped for `<`)
        // could slip by with nothing failing. Exercises the boundary exactly
        // (`offset + limit == keys.length`), not just comfortably under it.
        const { client } = ctx;
        await createUser(client, 'kate2b');
        const created = await client.post('/v2/key-value-stores', { json: { name: 'kate2b' }, headers: authHeaders('kate2b') });
        const storeId = created.json().data.id;
        await seedKeys(client, storeId, 'kate2b', 5);

        const resp = await client.get(`/v2/key-value-stores/${storeId}/keys?limit=3&offset=2`, {
            headers: authHeaders('kate2b'),
        });
        expect(resp.status).toBe(200);
        const body = resp.json().data;
        expect(body.items.map((item) => item.key)).toEqual(['k0002', 'k0003', 'k0004']);
        expect(body.count).toBe(3);
        expect(body.total).toBe(5);
        expect(body.isTruncated).toBe(false);
    });

    it('limit only slices from the start (cursor path)', async () => {
        // `limit` alone (no `offset`, no `exclusiveStartKey`) takes the
        // cursor-pushdown path (see `src/storage.js::kvKeysPage`): a
        // truncating `limit` must report a truthful `isTruncated`/
        // `nextExclusiveStartKey`, not a hardcoded `isTruncated: false` --
        // this is exactly the shape the real `apify-client` sends on its
        // first page of any store larger than its chunk size. Cursor-mode
        // items each carry a `recordPublicUrl` (required by that client's
        // response model) and the envelope carries no `total` at all (see the
        // cursor-mode field-set test below, which pins the exact field set).
        //
        // `recordPublicUrl` must be anchored to THIS request's own host/port
        // -- a host-side caller (curl, or apify-client pointed at the
        // published API port) could never dereference a Docker-internal
        // hostname, so the exact origin, not merely the path suffix, is
        // asserted here.
        const { client } = ctx;
        await createUser(client, 'kate3');
        const created = await client.post('/v2/key-value-stores', { json: { name: 'big3' }, headers: authHeaders('kate3') });
        const storeId = created.json().data.id;
        await seedKeys(client, storeId, 'kate3', 30);

        const resp = await client.get(`/v2/key-value-stores/${storeId}/keys?limit=5`, { headers: authHeaders('kate3') });
        const body = resp.json().data;
        expect(body.count).toBe(5);
        expect(body).not.toHaveProperty('total');
        expect(body.isTruncated).toBe(true);
        expect(body.nextExclusiveStartKey).toBe('k0004');
        expect(body.items.map((item) => item.key)).toEqual(['k0000', 'k0001', 'k0002', 'k0003', 'k0004']);
        const base = ctx.baseUrl;
        for (const item of body.items) {
            expect(item.recordPublicUrl).toBe(`${base}/v2/key-value-stores/${storeId}/records/${item.key}`);
        }
    });

    it('cursor mode recordPublicUrl percent-encodes the key', async () => {
        // Regression: `recordPublicUrl` used to interpolate the raw key with
        // no percent-encoding, so a key containing a space or `#` produced a
        // malformed link -- `#` starts a URL fragment (everything after it is
        // dropped client-side) and a raw space breaks the URL outright. The
        // key itself (`body.items[0].key`) stays the literal, un-escaped
        // string; only the URL built from it is encoded.
        const { client } = ctx;
        await createUser(client, 'encodeme');
        const created = await client.post('/v2/key-value-stores', { json: { name: 'encodeme' }, headers: authHeaders('encodeme') });
        const storeId = created.json().data.id;
        const key = 'we ird#key';
        await client.put(`/v2/key-value-stores/${storeId}/records/${encodeURIComponent(key)}`, {
            body: JSON.stringify({ v: 1 }),
            headers: { ...authHeaders('encodeme'), 'content-type': 'application/json' },
        });

        const resp = await client.get(`/v2/key-value-stores/${storeId}/keys?limit=10`, {
            headers: authHeaders('encodeme'),
        });
        expect(resp.status).toBe(200);
        const body = resp.json().data;
        expect(body.items[0].key).toBe(key);
        const base = ctx.baseUrl;
        expect(body.items[0].recordPublicUrl).toBe(
            `${base}/v2/key-value-stores/${storeId}/records/we%20ird%23key`,
        );
    });

    it('exclusiveStartKey alone takes the cursor path unpaginated', async () => {
        // `exclusiveStartKey` supplied with no `limit` must ALSO take the
        // cursor-pushdown path (either param alone trips it) rather than only
        // when paired with `limit`: it resumes from the cursor and returns
        // every remaining key, non-truncated (no `limit` was given, so there
        // is nothing to truncate against), with no `total` (cursor mode never
        // computes one) and no `nextExclusiveStartKey` (nothing left to
        // resume from) -- but, being cursor mode, each item still carries a
        // `recordPublicUrl`.
        const { client } = ctx;
        await createUser(client, 'kate3c');
        const created = await client.post('/v2/key-value-stores', { json: { name: 'big3c' }, headers: authHeaders('kate3c') });
        const storeId = created.json().data.id;
        await seedKeys(client, storeId, 'kate3c', 10);

        const resp = await client.get(`/v2/key-value-stores/${storeId}/keys?exclusiveStartKey=k0004`, {
            headers: authHeaders('kate3c'),
        });
        expect(resp.status).toBe(200);
        const body = resp.json().data;
        expect(body.items.map((item) => item.key)).toEqual(['k0005', 'k0006', 'k0007', 'k0008', 'k0009']);
        expect(body.count).toBe(5);
        expect(body.limit).toBe(5); // no `limit` was given, so it echoes the actual page length
        expect(body.exclusiveStartKey).toBe('k0004');
        expect(body.isTruncated).toBe(false);
        expect(body).not.toHaveProperty('nextExclusiveStartKey');
        expect(body).not.toHaveProperty('total');
        const base = ctx.baseUrl;
        for (const item of body.items) {
            expect(item.recordPublicUrl).toBe(`${base}/v2/key-value-stores/${storeId}/records/${item.key}`);
        }
    });

    it('limit without truncation is not truncated', async () => {
        // A `limit` at or beyond the store's key count truncates nothing:
        // `isTruncated: false` and no `nextExclusiveStartKey` -- the direct
        // counterpart of the truncating case above, on the same
        // cursor-pushdown path.
        const { client } = ctx;
        await createUser(client, 'kate3b');
        const created = await client.post('/v2/key-value-stores', { json: { name: 'big3b' }, headers: authHeaders('kate3b') });
        const storeId = created.json().data.id;
        await seedKeys(client, storeId, 'kate3b', 5);

        const resp = await client.get(`/v2/key-value-stores/${storeId}/keys?limit=10`, { headers: authHeaders('kate3b') });
        const body = resp.json().data;
        // no total, no next cursor
        expect(Object.keys(body)).toEqual(['items', 'count', 'limit', 'isTruncated']);
        expect(body.count).toBe(5);
        expect(body.isTruncated).toBe(false);
        expect(body).not.toHaveProperty('nextExclusiveStartKey');
    });

    it('cursor mode field set has no total', async () => {
        // Pins cursor mode's exact envelope field set: `items, count, limit,
        // isTruncated, nextExclusiveStartKey` when truncated -- never a
        // `total`, unlike every other paginated branch on this and the other
        // three listing surfaces. Computing one would force a full-store
        // count on every page, defeating the point of the cursor pushdown
        // (see `src/routes/storages.js::kvKeysCursorEnvelope`).
        const { client } = ctx;
        await createUser(client, 'notallytal');
        const created = await client.post('/v2/key-value-stores', {
            json: { name: 'notallytal' },
            headers: authHeaders('notallytal'),
        });
        const storeId = created.json().data.id;
        await seedKeys(client, storeId, 'notallytal', 20);

        const resp = await client.get(`/v2/key-value-stores/${storeId}/keys?limit=5`, {
            headers: authHeaders('notallytal'),
        });
        const body = resp.json().data;
        expect(Object.keys(body)).toEqual(['items', 'count', 'limit', 'isTruncated', 'nextExclusiveStartKey']);
    });

    it('limit=0 is a non-truncating empty page', async () => {
        // `limit=0` is a zero-width window: it has nothing to truncate, so it
        // must report an empty page with `isTruncated: false` and no
        // `nextExclusiveStartKey` -- never a truncation claim with no real
        // cursor to resume from.
        const { client } = ctx;
        await createUser(client, 'zed');
        const created = await client.post('/v2/key-value-stores', { json: { name: 'zed' }, headers: authHeaders('zed') });
        const storeId = created.json().data.id;
        await seedKeys(client, storeId, 'zed', 5);

        const resp = await client.get(`/v2/key-value-stores/${storeId}/keys?limit=0`, { headers: authHeaders('zed') });
        expect(resp.status).toBe(200);
        const body = resp.json().data;
        expect(body.items).toEqual([]);
        expect(body.count).toBe(0);
        expect(body.limit).toBe(0);
        expect(body.isTruncated).toBe(false);
        expect(body).not.toHaveProperty('nextExclusiveStartKey');
        expect(body).not.toHaveProperty('total');
    });

    it('limit=0 with a cursor does not loop the cursor back', async () => {
        // The self-contradictory case the fix specifically targets: `limit=0`
        // ALONGSIDE an already-supplied `exclusiveStartKey` must not hand
        // that same cursor straight back as `nextExclusiveStartKey` -- a
        // naive "keep following `nextExclusiveStartKey` until it's absent"
        // follower would otherwise loop forever on the identical request.
        const { client } = ctx;
        await createUser(client, 'zed2');
        const created = await client.post('/v2/key-value-stores', { json: { name: 'zed2' }, headers: authHeaders('zed2') });
        const storeId = created.json().data.id;
        await seedKeys(client, storeId, 'zed2', 5);

        const resp = await client.get(`/v2/key-value-stores/${storeId}/keys?limit=0&exclusiveStartKey=k0001`, {
            headers: authHeaders('zed2'),
        });
        expect(resp.status).toBe(200);
        const body = resp.json().data;
        expect(body.items).toEqual([]);
        expect(body.isTruncated).toBe(false);
        expect(body).not.toHaveProperty('nextExclusiveStartKey');
    });

    it('offset only keeps no-limit semantics', async () => {
        // Supplying only `offset` (no `limit`) still counts as "params given"
        // (the paginated branch, gains the additive `total`), but the
        // effective limit stays "no cap" -- exercising `paginate`'s
        // `items.slice(start)` branch, not just `items.slice(start,
        // start+limit)`. No `limit` means nothing was truncated.
        const { client } = ctx;
        await createUser(client, 'kate4');
        const created = await client.post('/v2/key-value-stores', { json: { name: 'big4' }, headers: authHeaders('kate4') });
        const storeId = created.json().data.id;
        await seedKeys(client, storeId, 'kate4', 10);

        const resp = await client.get(`/v2/key-value-stores/${storeId}/keys?offset=7`, { headers: authHeaders('kate4') });
        expect(resp.status).toBe(200);
        const body = resp.json().data;
        expect(body.count).toBe(3);
        expect(body.total).toBe(10);
        expect(body.items.length).toBe(3);
        expect(body.isTruncated).toBe(false);
    });

    it('cursor cycle enumerates every key exactly once', async () => {
        // A curl-style `limit` + `exclusiveStartKey` cycle over a store
        // bigger than `limit` must visit every key exactly once, reporting
        // `isTruncated`/`nextExclusiveStartKey` correctly at each step
        // (true+cursor on every page but the last, false+no-cursor on the
        // last). Fast and hand-rolled -- pins the envelope mechanics without
        // paying for the big store the real-client test below needs.
        const { client } = ctx;
        await createUser(client, 'cyclist');
        const created = await client.post('/v2/key-value-stores', { json: { name: 'cyc' }, headers: authHeaders('cyclist') });
        const storeId = created.json().data.id;
        const total = 47;
        const limit = 10;
        await seedKeys(client, storeId, 'cyclist', total);
        const expected = Array.from({ length: total }, (_, i) => k(i));

        const seen = [];
        let cursor = null;
        let pages = 0;
        for (;;) {
            const qs = `limit=${limit}` + (cursor ? `&exclusiveStartKey=${cursor}` : '');
            const resp = await client.get(`/v2/key-value-stores/${storeId}/keys?${qs}`, {
                headers: authHeaders('cyclist'),
            });
            expect(resp.status).toBe(200);
            const body = resp.json().data;
            pages += 1;
            seen.push(...body.items.map((item) => item.key));
            cursor = body.nextExclusiveStartKey;
            if (!body.items.length || cursor === undefined) {
                expect(body.isTruncated).toBe(false);
                break;
            }
            expect(body.isTruncated).toBe(true);
            expect(pages).toBeLessThan(20); // sanity bound against an infinite loop on a bug
        }

        expect(seen).toEqual(expected); // every key, in order, no skip, no repeat
        expect(pages).toBe(5); // 47 keys / limit 10 -> 4 full pages + 1 remainder page
    }, 15_000);

    it('exclusiveStartKey with offset: the cursor wins', async () => {
        // `exclusiveStartKey` combined with `offset`: the real API's KV-keys
        // endpoint has no `offset` concept, so this runtime treats the cursor
        // as authoritative and ignores `offset` entirely -- the response must
        // be identical to the same request with `offset` omitted.
        const { client } = ctx;
        await createUser(client, 'combo');
        const created = await client.post('/v2/key-value-stores', { json: { name: 'combo' }, headers: authHeaders('combo') });
        const storeId = created.json().data.id;
        await seedKeys(client, storeId, 'combo', 20);

        const cursorOnly = await client.get(`/v2/key-value-stores/${storeId}/keys?exclusiveStartKey=k0004&limit=5`, {
            headers: authHeaders('combo'),
        });
        const cursorWithOffset = await client.get(
            `/v2/key-value-stores/${storeId}/keys?exclusiveStartKey=k0004&limit=5&offset=15`,
            { headers: authHeaders('combo') },
        );
        expect(cursorOnly.status).toBe(200);
        expect(cursorWithOffset.status).toBe(200);
        expect(cursorOnly.json()).toEqual(cursorWithOffset.json());
        const body = cursorOnly.json().data;
        expect(body.items.map((item) => item.key)).toEqual(['k0005', 'k0006', 'k0007', 'k0008', 'k0009']);
    });

    it('the real apify-client pages a store larger than its default chunk size', async () => {
        // The REAL `apify-client` (package.json pins 2.25.0, not a
        // hand-rolled reproduction of its loop) must page a store larger than
        // its Python sibling's internal chunk size (1000) end to end.
        //
        // Note an intentional adaptation from the Python original: the JS
        // client's `for await` iterator over `listKeys()` decides "one more
        // page exists" by `nextExclusiveStartKey !== null`, i.e. it requires
        // the field to be PRESENT (as an explicit JSON `null`) on the last
        // page -- but requirements/api.md pins that this runtime OMITS
        // `nextExclusiveStartKey` on a non-truncated page (matching the
        // pinned Python client, whose loop keys off `isTruncated` instead).
        // So the enumeration here drives the real client's `listKeys()` page
        // call in an explicit `isTruncated`/`exclusiveStartKey` cursor loop
        // -- the documented paging idiom from the client's own docs --
        // exercised at both the Python client's default chunk size (1000) and
        // a second, smaller one, over the SAME seeded store, so cursor-mode
        // correctness isn't accidentally tied to one particular page size.
        const { client, service } = ctx;
        const storeId = await bootstrapStorage(client, '/v2/key-value-stores', 'chunky');

        const total = 1050;
        await seedKeysFast(service, storeId, total);
        const expected = Array.from({ length: total }, (_, i) => k(i));

        const apify = new ApifyClient({ baseUrl: ctx.baseUrl, token: 'chunky' });
        const kvStore = apify.keyValueStore(storeId);
        for (const chunkSize of [1000, 250]) {
            const seen = [];
            let exclusiveStartKey;
            let pages = 0;
            for (;;) {
                const page = await kvStore.listKeys({ limit: chunkSize, exclusiveStartKey });
                seen.push(...page.items.map((item) => item.key));
                pages += 1;
                expect(pages).toBeLessThan(50); // sanity bound against an infinite loop on a bug
                if (!page.isTruncated) break;
                exclusiveStartKey = page.nextExclusiveStartKey;
            }
            expect(seen.length).toBe(total); // exactly once, no duplicates
            expect(new Set(seen).size).toBe(total);
            expect(seen).toEqual(expected);
        }
    }, 60_000);
});

// --------------------------------------------------------------- RQ requests

describe('rq requests pagination', () => {
    it('bare request is unpaginated and unchanged', async () => {
        const { client, service } = ctx;
        await createUser(client, 'rick');
        const created = await client.post('/v2/request-queues', { json: { name: 'big' }, headers: authHeaders('rick') });
        const rqId = created.json().data.id;
        await service.storage.rqAddBatch(
            rqId,
            Array.from({ length: 130 }, (_, i) => ({ url: `https://example.com/${i}`, uniqueKey: String(i) })),
        );

        const resp = await client.get(`/v2/request-queues/${rqId}/requests`, { headers: authHeaders('rick') });
        expect(resp.status).toBe(200);
        const body = resp.json().data;
        // Order-sensitive (not a set comparison): this surface's bare shape
        // never had an extra field to reorder, but pin it anyway alongside
        // the other three surfaces so a future change can't quietly slip one
        // in ahead of `limit` unnoticed.
        expect(Object.keys(body)).toEqual(['items', 'count', 'limit']); // no additive `total`
        expect(body.count).toBe(130);
        expect(body.limit).toBe(130);
        expect(body.items.length).toBe(130);
    });

    it('limit+offset returns the slice with total', async () => {
        const { client, service } = ctx;
        await createUser(client, 'rick2');
        const created = await client.post('/v2/request-queues', { json: { name: 'big2' }, headers: authHeaders('rick2') });
        const rqId = created.json().data.id;
        await service.storage.rqAddBatch(
            rqId,
            Array.from({ length: 130 }, (_, i) => ({ url: `https://example.com/${i}`, uniqueKey: String(i) })),
        );

        const resp = await client.get(`/v2/request-queues/${rqId}/requests?limit=30&offset=100`, {
            headers: authHeaders('rick2'),
        });
        expect(resp.status).toBe(200);
        const body = resp.json().data;
        expect(body.count).toBe(30);
        expect(body.limit).toBe(30);
        expect(body.total).toBe(130);
        expect(body.items.length).toBe(30);
    });
});

// ---------------------------------------------------------- per-user listings

describe('per-user storage listings pagination', () => {
    it('my key-value stores: bare request is unpaginated and unchanged', async () => {
        // The bare-request contract (requirements/api.md's Pagination
        // section) must hold for a resource with more than 100 items/entries
        // -- the other three surfaces already seed 150/120/130, so this
        // per-user listing (the fourth) seeds 110 too, rather than a count
        // small enough that the bare (uncapped) branch and a hypothetical
        // accidentally-introduced 100-item cap would look identical.
        const { client } = ctx;
        await createUser(client, 'stan');
        for (let i = 0; i < 110; i += 1) {
            await client.post('/v2/key-value-stores', {
                json: { name: `s${String(i).padStart(4, '0')}` },
                headers: authHeaders('stan'),
            });
        }

        const resp = await client.get('/v2/users/me/key-value-stores', { headers: authHeaders('stan') });
        expect(resp.status).toBe(200);
        const body = resp.json().data;
        // Order-sensitive: this is the same `total, count, items` order its
        // siblings `my_actors`/`my_builds`/`my_runs` use, unaffected by the
        // optional `limit`/`offset` this surface additionally accepts.
        expect(Object.keys(body)).toEqual(['total', 'count', 'items']);
        expect(body.total).toBe(110);
        expect(body.count).toBe(110);
        expect(body.items.length).toBe(110);
    }, 30_000);

    it('my key-value stores: limit+offset returns the slice', async () => {
        const { client } = ctx;
        await createUser(client, 'stan2');
        for (let i = 0; i < 15; i += 1) {
            await client.post('/v2/key-value-stores', { json: { name: `s${i}` }, headers: authHeaders('stan2') });
        }

        const resp = await client.get('/v2/users/me/key-value-stores?limit=5&offset=10', {
            headers: authHeaders('stan2'),
        });
        expect(resp.status).toBe(200);
        const body = resp.json().data;
        expect(body.total).toBe(15);
        expect(body.count).toBe(5);
        expect(body.items.length).toBe(5);
    });

    it('my datasets and request queues also paginate', async () => {
        // The other two aggregate storage listings (not just KV) get the same
        // optional slice.
        const { client } = ctx;
        await createUser(client, 'stan3');
        for (let i = 0; i < 12; i += 1) {
            await client.post('/v2/datasets', { json: { name: `d${i}` }, headers: authHeaders('stan3') });
            await client.post('/v2/request-queues', { json: { name: `q${i}` }, headers: authHeaders('stan3') });
        }

        const ds = (await client.get('/v2/users/me/datasets?limit=4&offset=8', { headers: authHeaders('stan3') }))
            .json().data;
        const rq = (await client.get('/v2/users/me/request-queues?limit=4&offset=8', { headers: authHeaders('stan3') }))
            .json().data;
        expect(ds.total).toBe(12);
        expect(ds.count).toBe(4);
        expect(ds.items.length).toBe(4);
        expect(rq.total).toBe(12);
        expect(rq.count).toBe(4);
        expect(rq.items.length).toBe(4);

        const bareDs = (await client.get('/v2/users/me/datasets', { headers: authHeaders('stan3') })).json().data;
        expect(bareDs.total).toBe(12);
        expect(bareDs.count).toBe(12);
        expect(bareDs.items.length).toBe(12);
    });
});

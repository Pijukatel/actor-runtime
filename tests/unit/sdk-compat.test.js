/**
 * Real `apify-client` compatibility checks: the bare-call idioms a real SDK
 * caller uses by default must parse and validate against this runtime, not
 * merely against a hand-rolled reproduction of the client's own
 * request/response shapes -- pagination.test.js already covers several
 * `limit`/`offset`-supplied and cursor-mode real-client shapes; this file is
 * scoped to the genuinely BARE call forms those don't exercise.
 *
 * (The Python original had to drive its pinned client against a separate
 * real-`uvicorn` fixture because that client's transport had no in-process
 * hook; here `wire()` already serves the app on a real loopback socket, so
 * the standard fixture works for the real JS client too.)
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

/** Create a user and one storage for it, returning the created storage's id. */
async function bootstrapStorage(client, urlPath, name) {
    await client.post('/v2/users', { json: { name } });
    const created = await client.post(urlPath, { json: { name }, headers: authHeaders(name) });
    return created.json().data.id;
}

describe('sdk compat (real apify-client)', () => {
    it('dataset listItems bare and paged and item iteration all parse', async () => {
        // `dataset.listItems()` called with ZERO arguments -- the genuinely
        // bare shape, sending no `limit`/`offset` query params at all (the
        // client drops undefined values) -- must parse and return the seeded
        // items without error.
        //
        // A dataset-items response that carries the five
        // `X-Apify-Pagination-*` headers only when the caller actually passed
        // `limit`/`offset` would leave a genuinely bare call with none of
        // them; the client's page parsing reads all five directly, so a bare
        // call would come back with `NaN` totals/offsets (and a broken
        // `desc`) instead of the truthful numbers asserted here.
        // `listItems({limit, offset})` and the client's async item iteration
        // are exercised too in the same test, so a fix that only patches one
        // call shape can't slip through unnoticed -- the iteration derives
        // its own explicit `offset`/`limit` continuation requests internally,
        // so it never actually exercises the bare branch beyond its first
        // page either way, but must still keep working.
        const { client, service } = ctx;
        const datasetId = await bootstrapStorage(client, '/v2/datasets', 'sdkbare');
        await service.storage.datasetPush(datasetId, Array.from({ length: 12 }, (_, i) => ({ i })));

        const apify = new ApifyClient({ baseUrl: ctx.baseUrl, token: 'sdkbare' });
        const dataset = apify.dataset(datasetId);

        // The genuinely bare call: zero arguments, no limit/offset on the wire.
        const barePage = await dataset.listItems();
        expect(barePage.items.map((item) => item.i)).toEqual(Array.from({ length: 12 }, (_, i) => i));
        expect(barePage.total).toBe(12);
        expect(barePage.offset).toBe(0);
        expect(barePage.count).toBe(12);
        expect(barePage.desc).toBe(false);

        const paged = await dataset.listItems({ limit: 5, offset: 3 });
        expect(paged.items.map((item) => item.i)).toEqual([3, 4, 5, 6, 7]);

        // The JS client's equivalent of the Python `iterate_items()` idiom:
        // `listItems()` is also an async iterable that pages through every
        // item (driven by the `-Total` header its continuation logic reads).
        const iterated = [];
        for await (const item of dataset.listItems()) {
            iterated.push(item);
        }
        expect(iterated.map((item) => item.i)).toEqual(Array.from({ length: 12 }, (_, i) => i));
    });

    it('key-value store listKeys bare and chunked enumeration validate', async () => {
        // The SDK's default in-Actor key-iteration idiom must yield every
        // seeded key exactly once. The Python original's `iterate_keys()`
        // always resolves its own internal chunk size to a real numeric
        // `limit` (1000 by default) before the request ever reaches the wire,
        // so that call shape takes this runtime's cursor-mode branch, which
        // always carries `recordPublicUrl` on each item. The JS equivalent
        // here drives the real client's `listKeys({limit})` page call in the
        // documented `isTruncated`/`exclusiveStartKey` cursor loop (the JS
        // client's own `for await` iterator over `listKeys()` instead
        // requires an explicit `nextExclusiveStartKey: null` on the last
        // page, which requirements/api.md pins this runtime to OMIT -- see
        // pagination.test.js's big-store real-client test for the details of
        // that intentional adaptation).
        //
        // The genuinely bare single call underneath -- `listKeys()` with no
        // cursor and no limit on the wire at all -- is asserted too: this is
        // the bare request whose items must ALSO carry `recordPublicUrl`
        // (required, with no default, by the pinned Python client's
        // `KeyValueStoreKey` response model that motivated the fix), asserted
        // here with its exact URL shape so it can't silently regress to an
        // empty string or the wrong path.
        const { client, service } = ctx;
        const storeId = await bootstrapStorage(client, '/v2/key-value-stores', 'sdkkv');
        const expected = Array.from({ length: 5 }, (_, i) => `k${String(i).padStart(4, '0')}`);
        for (let i = 0; i < 5; i += 1) {
            await service.storage.kvSet(storeId, expected[i], { v: i }, 'application/json');
        }

        const apify = new ApifyClient({ baseUrl: ctx.baseUrl, token: 'sdkkv' });
        const kvStore = apify.keyValueStore(storeId);

        // Chunked enumeration at the Python client's default chunk size.
        const seen = [];
        let exclusiveStartKey;
        for (;;) {
            const page = await kvStore.listKeys({ limit: 1000, exclusiveStartKey });
            seen.push(...page.items.map((item) => item.key));
            if (!page.isTruncated) break;
            exclusiveStartKey = page.nextExclusiveStartKey;
        }
        expect(seen).toEqual(expected);

        // The genuinely bare single call: no cursor, no limit, on the wire
        // at all. Each returned item must carry a valid `recordPublicUrl`.
        const bareList = await kvStore.listKeys();
        expect(bareList.items.map((item) => item.key)).toEqual(expected);
        for (const item of bareList.items) {
            expect(item.recordPublicUrl).toBe(
                `${ctx.baseUrl}/v2/key-value-stores/${storeId}/records/${item.key}`,
            );
        }
    });
});

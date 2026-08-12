/**
 * Request-queue HTTP surface: the full client route set (head, head/lock,
 * per-request GET/PUT/DELETE, per-request lock PUT/DELETE, batch add/delete,
 * requests/unlock) on top of the create/get/list/single-add routes, plus the
 * per-request field round-trips (headers/payload/userData/retryCount/noRetry/
 * loadedUrl/handledAt) and the head/lock and unlock-all regressions those
 * routes depend on.
 *
 * All Docker-free via `wire()` (in-process app + StubDriver, see
 * tests/helpers.js).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { requestIdFor } from '../../src/storage.js';
import { wire } from '../helpers.js';

let ctx;

beforeEach(async () => {
    ctx = await wire();
});

afterEach(async () => {
    await ctx.close();
});

describe('request queues', () => {
    it('full request-queue route surface', async () => {
        // Exercises every request-queue route the design adds (head,
        // head/lock, per-request GET/PUT/DELETE, per-request lock PUT/DELETE,
        // batch add/delete, requests/unlock) on top of the pre-existing
        // create/get/list/single-add surface. None of the four sample-actor
        // fixtures exercise these routes (they only add-and-forget through
        // the single/batch add path) - this is the sole coverage for the
        // fuller client surface apify-client 3.1.0's `RequestQueueClient`
        // exposes.
        const { client } = ctx;
        const rq = (await client.post('/v2/request-queues', { json: { name: 'full-surface' } })).json().data;
        const rqId = rq.id;

        // Batch add: two new requests.
        const add = (
            await client.post(`/v2/request-queues/${rqId}/requests/batch`, {
                json: [
                    { url: 'https://example.com/a', uniqueKey: 'https://example.com/a' },
                    { url: 'https://example.com/b', uniqueKey: 'https://example.com/b' },
                ],
            })
        ).json().data;
        expect(add.processedRequests).toHaveLength(2);
        expect(add.unprocessedRequests).toEqual([]);
        const reqAId = add.processedRequests.find((p) => p.uniqueKey === 'https://example.com/a').requestId;
        const reqBId = add.processedRequests.find((p) => p.uniqueKey === 'https://example.com/b').requestId;

        // Re-adding the same uniqueKey is reported as already present.
        const redo = (
            await client.post(`/v2/request-queues/${rqId}/requests/batch`, {
                json: [{ url: 'https://example.com/a', uniqueKey: 'https://example.com/a' }],
            })
        ).json().data;
        expect(redo.processedRequests[0].wasAlreadyPresent).toBe(true);

        // head: both unhandled requests come back, unlocked.
        const head = (await client.get(`/v2/request-queues/${rqId}/head`)).json().data;
        expect(new Set(head.items.map((i) => i.uniqueKey))).toEqual(
            new Set(['https://example.com/a', 'https://example.com/b']),
        );
        expect(head).toHaveProperty('queueModifiedAt');
        expect(head).toHaveProperty('hadMultipleClients');

        // head/lock: locks what it returns; a second call excludes the
        // now-locked ones.
        const locked = (await client.post(`/v2/request-queues/${rqId}/head/lock?lockSecs=60`)).json().data;
        expect(locked.items).toHaveLength(2);
        expect(locked.queueHasLockedRequests).toBe(true);
        // Regression: a second call with nothing NEW to lock must still
        // report `queueHasLockedRequests: true`, since both requests locked
        // by the prior call are still within their lock window. The buggy
        // formula (`len(available) > len(to_lock)`) compared
        // unlocked-inventory-vs-limit instead of locked-vs-total, and
        // happened to agree with the correct value whenever `to_lock` was
        // non-empty - exactly why this same test's first `head/lock` call
        // above could never catch it. `apify`'s own shared request-queue
        // client's `is_finished` (`len(head.items) == 0 and not
        // queue_has_locked_requests`) consumes this flag directly, so a
        // false-`false` here would make a multi-consumer crawl conclude it's
        // finished while another consumer still holds locked work.
        const stillLocked = (await client.post(`/v2/request-queues/${rqId}/head/lock?lockSecs=60`)).json().data;
        expect(stillLocked.items).toEqual([]);
        expect(stillLocked.queueHasLockedRequests).toBe(true);

        // Per-request GET; unknown id -> 404.
        const got = (await client.get(`/v2/request-queues/${rqId}/requests/${reqAId}`)).json().data;
        expect(got.url).toBe('https://example.com/a');
        expect((await client.get(`/v2/request-queues/${rqId}/requests/doesnotexist`)).status).toBe(404);

        // Per-request lock prolong, then release.
        const lock = (await client.put(`/v2/request-queues/${rqId}/requests/${reqAId}/lock?lockSecs=30`)).json().data;
        expect(lock).toHaveProperty('lockExpiresAt');
        expect((await client.delete(`/v2/request-queues/${rqId}/requests/${reqAId}/lock`)).status).toBe(200);

        // Unlock-all frees every remaining lock (from head/lock above).
        const unlockAll = (await client.post(`/v2/request-queues/${rqId}/requests/unlock`)).json().data;
        expect(unlockAll.unlockedCount).toBeGreaterThanOrEqual(1);
        const freed = (await client.post(`/v2/request-queues/${rqId}/head/lock?lockSecs=60`)).json().data;
        expect(freed.items).toHaveLength(2);

        // PUT marks a request handled; the queue metadata reflects it.
        const update = (
            await client.put(`/v2/request-queues/${rqId}/requests/${reqAId}`, {
                json: {
                    url: 'https://example.com/a',
                    uniqueKey: 'https://example.com/a',
                    handledAt: '2026-01-01T00:00:00.000Z',
                },
            })
        ).json().data;
        expect(update.wasAlreadyHandled).toBe(false);
        const metaAfterHandle = (await client.get(`/v2/request-queues/${rqId}`)).json().data;
        expect(metaAfterHandle.handledRequestCount).toBe(1);
        expect(metaAfterHandle.totalRequestCount).toBe(2);
        expect(metaAfterHandle.pendingRequestCount).toBe(1);

        // DELETE a single request: the aggregate counts on the queue's own
        // GET must drop along with it, not just the per-request GET going
        // 404. A row delete that bypasses the metadata bookkeeping would
        // leave totalRequestCount/pendingRequestCount permanently inflated.
        expect((await client.delete(`/v2/request-queues/${rqId}/requests/${reqBId}`)).status).toBe(200);
        expect((await client.get(`/v2/request-queues/${rqId}/requests/${reqBId}`)).status).toBe(404);
        const metaAfterDelete = (await client.get(`/v2/request-queues/${rqId}`)).json().data;
        expect(metaAfterDelete.totalRequestCount).toBe(1);
        expect(metaAfterDelete.pendingRequestCount).toBe(0);
        expect(metaAfterDelete.handledRequestCount).toBe(1);

        // Batch delete: same aggregate-metadata requirement as single delete.
        const more = (
            await client.post(`/v2/request-queues/${rqId}/requests/batch`, {
                json: [{ url: 'https://example.com/c', uniqueKey: 'https://example.com/c' }],
            })
        ).json().data;
        const reqCId = more.processedRequests[0].requestId;
        const metaAfterAddC = (await client.get(`/v2/request-queues/${rqId}`)).json().data;
        expect(metaAfterAddC.totalRequestCount).toBe(2);
        expect(metaAfterAddC.pendingRequestCount).toBe(1);
        const batchDel = (
            await client.delete(`/v2/request-queues/${rqId}/requests/batch`, { json: [{ id: reqCId }] })
        ).json().data;
        expect(batchDel.processedRequests.some((p) => p.requestId === reqCId)).toBe(true);
        expect((await client.get(`/v2/request-queues/${rqId}/requests/${reqCId}`)).status).toBe(404);
        const metaAfterBatchDelete = (await client.get(`/v2/request-queues/${rqId}`)).json().data;
        expect(metaAfterBatchDelete.totalRequestCount).toBe(1);
        expect(metaAfterBatchDelete.pendingRequestCount).toBe(0);
        expect(metaAfterBatchDelete.handledRequestCount).toBe(1);
    });

    it('head/lock reports locked requests from a prior call', async () => {
        // Isolated regression for the `queueHasLockedRequests` bug: a queue
        // with exactly one request, locked by an earlier `head/lock` call and
        // nothing left to lock, must still report
        // `queueHasLockedRequests: true` on a later call. The buggy formula
        // compared "unlocked inventory left over the limit" instead of "any
        // locked request exists" - the two formulas coincide whenever
        // something IS newly locked, which is why a same-call assertion never
        // caught it; they diverge exactly in this already-fully-locked case.
        const { client } = ctx;
        const rq = (await client.post('/v2/request-queues', { json: { name: 'lock-carryover' } })).json().data;
        const rqId = rq.id;
        await client.post(`/v2/request-queues/${rqId}/requests/batch`, {
            json: [{ url: 'https://example.com/only', uniqueKey: 'https://example.com/only' }],
        });

        const first = (await client.post(`/v2/request-queues/${rqId}/head/lock?lockSecs=60`)).json().data;
        expect(first.items).toHaveLength(1);
        expect(first.queueHasLockedRequests).toBe(true);

        const second = (await client.post(`/v2/request-queues/${rqId}/head/lock?lockSecs=60`)).json().data;
        expect(second.items).toEqual([]);
        expect(second.queueHasLockedRequests).toBe(true);
    });

    it('unlock-all counts only previously locked rows', async () => {
        // `unlockedCount` must count only rows whose lock was actually
        // cleared, not every row in the queue. An unlock-all that has no
        // "currently locked" filter would count every unhandled+handled row
        // regardless of lock state.
        const { client } = ctx;
        const rq = (await client.post('/v2/request-queues', { json: { name: 'unlock-count' } })).json().data;
        const rqId = rq.id;
        await client.post(`/v2/request-queues/${rqId}/requests/batch`, {
            json: [
                { url: 'https://example.com/locked', uniqueKey: 'https://example.com/locked' },
                { url: 'https://example.com/unlocked', uniqueKey: 'https://example.com/unlocked' },
            ],
        });
        // Lock only one of the two requests (per-request lock, not head/lock,
        // so exactly one request ends up holding a lock).
        const items = (await client.get(`/v2/request-queues/${rqId}/requests`)).json().data.items;
        const lockedId = items.find((p) => p.uniqueKey === 'https://example.com/locked').id;
        await client.put(`/v2/request-queues/${rqId}/requests/${lockedId}/lock?lockSecs=60`);

        const unlockAll = (await client.post(`/v2/request-queues/${rqId}/requests/unlock`)).json().data;
        expect(unlockAll.unlockedCount).toBe(1);
    });

    it('unlock-all does not count already-expired locks', async () => {
        // `unlockedCount` must count only rows whose *active* lock was
        // cleared by this call, not a row whose lock had already expired
        // before the call. Nothing proactively removes an expired lock entry
        // (`rqHead`/`rqHeadAndLock` merely treat an expired-lock row as
        // available again), so a stale row still has a lock entry at call
        // time - an unlock-all filtering only on entry presence would count
        // that stale row as "unlocked by this call" even though it was
        // already effectively unlocked beforehand.
        const { client } = ctx;
        const rq = (await client.post('/v2/request-queues', { json: { name: 'unlock-expired' } })).json().data;
        const rqId = rq.id;
        await client.post(`/v2/request-queues/${rqId}/requests/batch`, {
            json: [
                { url: 'https://example.com/stale', uniqueKey: 'https://example.com/stale' },
                { url: 'https://example.com/active', uniqueKey: 'https://example.com/active' },
            ],
        });
        const items = (await client.get(`/v2/request-queues/${rqId}/requests`)).json().data.items;
        const staleId = items.find((p) => p.uniqueKey === 'https://example.com/stale').id;
        const activeId = items.find((p) => p.uniqueKey === 'https://example.com/active').id;

        // A negative lockSecs deterministically puts the lock expiry in the
        // past (no sleep/timing dependency needed) - an already-expired
        // lock, entry still present.
        await client.put(`/v2/request-queues/${rqId}/requests/${staleId}/lock?lockSecs=-10`);
        // Genuinely active at call time.
        await client.put(`/v2/request-queues/${rqId}/requests/${activeId}/lock?lockSecs=60`);

        const unlockAll = (await client.post(`/v2/request-queues/${rqId}/requests/unlock`)).json().data;
        expect(unlockAll.unlockedCount).toBe(1);
    });

    // -- RQ request round-trip: headers/payload/userData/retryCount/noRetry/
    //    loadedUrl --
    //
    // Every field a real Actor's SDK actually sets on a request - not just
    // `url`/`method`/`uniqueKey` - must be forwarded by the add/update paths,
    // or it silently vanishes on write: read-back would show `userData: {}`,
    // `headers: {}`, `payload: null`, `retryCount: 0`, `noRetry: false`,
    // `loadedUrl: null`, regardless of what was actually sent.

    it('single add round-trips headers/payload/userData', async () => {
        // The single-add route (`POST .../requests`, backed by `rqAddBatch`
        // with a one-element list) must preserve caller-supplied `headers`/
        // `payload`/`userData`/`retryCount`/`noRetry`/`loadedUrl` - not just
        // `url`/`method`/`uniqueKey`.
        const { client } = ctx;
        const rq = (await client.post('/v2/request-queues?name=rq-single-fields')).json().data;
        const rqId = rq.id;

        const added = (
            await client.post(`/v2/request-queues/${rqId}/requests`, {
                json: {
                    url: 'https://example.com/single',
                    uniqueKey: 'https://example.com/single',
                    headers: { 'x-custom': '1' },
                    payload: 'some-payload',
                    userData: { foo: 'bar', label: 'DETAIL' },
                    retryCount: 2,
                    noRetry: true,
                    loadedUrl: 'https://example.com/single-redirected',
                },
            })
        ).json().data;
        const requestId = added.requestId;

        const got = (await client.get(`/v2/request-queues/${rqId}/requests/${requestId}`)).json().data;
        expect(got.headers).toEqual({ 'x-custom': '1' });
        expect(got.payload).toBe('some-payload');
        expect(got.userData.foo).toBe('bar');
        expect(got.userData.label).toBe('DETAIL');
        expect(got.retryCount).toBe(2);
        expect(got.noRetry).toBe(true);
        expect(got.loadedUrl).toBe('https://example.com/single-redirected');
    });

    it('batch add round-trips headers/payload/userData', async () => {
        // Batch add (`POST .../requests/batch`) must preserve per-request
        // `headers`/`payload`/`userData`/`retryCount`/`noRetry`/`loadedUrl`
        // for every request in the batch, not just the first/only one.
        const { client } = ctx;
        const rq = (await client.post('/v2/request-queues?name=rq-batch-fields')).json().data;
        const rqId = rq.id;

        const add = (
            await client.post(`/v2/request-queues/${rqId}/requests/batch`, {
                json: [
                    {
                        url: 'https://example.com/batch-a',
                        uniqueKey: 'https://example.com/batch-a',
                        headers: { 'x-a': '1' },
                        payload: 'payload-a',
                        userData: { which: 'a' },
                        retryCount: 1,
                        noRetry: false,
                        loadedUrl: 'https://example.com/batch-a-redirected',
                    },
                    {
                        url: 'https://example.com/batch-b',
                        uniqueKey: 'https://example.com/batch-b',
                        headers: { 'x-b': '2' },
                        payload: 'payload-b',
                        userData: { which: 'b' },
                        retryCount: 3,
                        noRetry: true,
                    },
                ],
            })
        ).json().data;
        const byKey = Object.fromEntries(add.processedRequests.map((p) => [p.uniqueKey, p.requestId]));

        const gotA = (
            await client.get(`/v2/request-queues/${rqId}/requests/${byKey['https://example.com/batch-a']}`)
        ).json().data;
        const gotB = (
            await client.get(`/v2/request-queues/${rqId}/requests/${byKey['https://example.com/batch-b']}`)
        ).json().data;
        expect(gotA.headers).toEqual({ 'x-a': '1' });
        expect(gotA.payload).toBe('payload-a');
        expect(gotA.userData.which).toBe('a');
        expect(gotA.retryCount).toBe(1);
        expect(gotA.noRetry).toBe(false);
        expect(gotA.loadedUrl).toBe('https://example.com/batch-a-redirected');
        expect(gotB.headers).toEqual({ 'x-b': '2' });
        expect(gotB.payload).toBe('payload-b');
        expect(gotB.userData.which).toBe('b');
        expect(gotB.retryCount).toBe(3);
        expect(gotB.noRetry).toBe(true);
    });

    it('PUT round-trips headers/payload/userData on both branches', async () => {
        // PUT (`rqUpdateRequest`) must preserve `headers`/`payload`/
        // `userData`/`retryCount`/`noRetry`/`loadedUrl` both when it upserts
        // a brand-new request (no existing row) and when it updates an
        // existing one via the `handledAt` (mark-handled) branch - the two
        // branches that actually persist the request to storage.
        const { client } = ctx;
        const rq = (await client.post('/v2/request-queues?name=rq-update-fields')).json().data;
        const rqId = rq.id;

        // Upsert branch: requestId has no existing record yet. A real caller
        // (the apify SDK) always computes the URL's request id as the
        // SHA-256-based hash of `uniqueKey` (`uniqueKeyToRequestId`, mirrored
        // here by `requestIdFor` - see src/storage.js), since that hash is
        // also what a later GET/lock/delete addresses the same request by.
        const newUniqueKey = 'https://example.com/put-new';
        const upsertId = requestIdFor(newUniqueKey);
        const putNew = (
            await client.put(`/v2/request-queues/${rqId}/requests/${upsertId}`, {
                json: {
                    url: 'https://example.com/put-new',
                    uniqueKey: newUniqueKey,
                    headers: { 'x-new': 'n' },
                    payload: 'payload-new',
                    userData: { which: 'new' },
                    retryCount: 1,
                    noRetry: false,
                    loadedUrl: 'https://example.com/put-new-redirected',
                },
            })
        ).json().data;
        expect(putNew.wasAlreadyPresent).toBe(false);
        const gotNew = (await client.get(`/v2/request-queues/${rqId}/requests/${upsertId}`)).json().data;
        expect(gotNew.headers).toEqual({ 'x-new': 'n' });
        expect(gotNew.payload).toBe('payload-new');
        expect(gotNew.userData.which).toBe('new');
        expect(gotNew.retryCount).toBe(1);
        expect(gotNew.noRetry).toBe(false);
        expect(gotNew.loadedUrl).toBe('https://example.com/put-new-redirected');

        // Mark-handled branch: an existing (added-via-batch) request, updated
        // via PUT with `handledAt` set and different headers/payload/userData
        // - this is the branch `apify`'s own `mark_request_as_handled`
        // drives, always sending the FULL current request dict.
        const add = (
            await client.post(`/v2/request-queues/${rqId}/requests/batch`, {
                json: [{ url: 'https://example.com/put-handle', uniqueKey: 'https://example.com/put-handle' }],
            })
        ).json().data;
        const handleId = add.processedRequests[0].requestId;
        const putHandled = (
            await client.put(`/v2/request-queues/${rqId}/requests/${handleId}`, {
                json: {
                    url: 'https://example.com/put-handle',
                    uniqueKey: 'https://example.com/put-handle',
                    handledAt: '2026-01-01T00:00:00.000Z',
                    headers: { 'x-handled': 'h' },
                    payload: 'payload-handled',
                    userData: { which: 'handled' },
                    retryCount: 2,
                    noRetry: true,
                    loadedUrl: 'https://example.com/put-handle-redirected',
                },
            })
        ).json().data;
        expect(putHandled.wasAlreadyPresent).toBe(true);
        const gotHandled = (await client.get(`/v2/request-queues/${rqId}/requests/${handleId}`)).json().data;
        expect(gotHandled.headers).toEqual({ 'x-handled': 'h' });
        expect(gotHandled.payload).toBe('payload-handled');
        expect(gotHandled.userData.which).toBe('handled');
        expect(gotHandled.retryCount).toBe(2);
        expect(gotHandled.noRetry).toBe(true);
        expect(gotHandled.loadedUrl).toBe('https://example.com/put-handle-redirected');
    });

    it('PUT with forefront=false (reclaim) releases the lock', async () => {
        // The real SDK's `request_queue.reclaim_request(request)` - the
        // standard way any crawlee/apify-based Actor requeues a request after
        // a processing failure - issues exactly this HTTP call: lock a
        // request via `head/lock`, then PUT it straight back with the default
        // `forefront=false` and no `handledAt`. That PUT must actually
        // release the lock so the request is fetchable again; reporting
        // `wasAlreadyPresent: true` while leaving the request locked for the
        // rest of its TTL would silently strand it (this is what
        // apify-client's `update_request(request, forefront=forefront)`
        // sends: the full request dict as JSON body, `forefront` as a query
        // param defaulting to falsy).
        const { client } = ctx;
        const rq = (await client.post('/v2/request-queues?name=rq-reclaim')).json().data;
        const rqId = rq.id;
        await client.post(`/v2/request-queues/${rqId}/requests`, {
            json: { url: 'https://example.com/reclaim', uniqueKey: 'https://example.com/reclaim' },
        });

        const locked = (await client.post(`/v2/request-queues/${rqId}/head/lock?lockSecs=180`)).json().data;
        expect(locked.items).toHaveLength(1);
        const requestId = locked.items[0].id;
        const body = locked.items[0];

        // No `handledAt`, default `forefront=false` - exactly the
        // reclaim-after-failure call pattern.
        const put = await client.put(`/v2/request-queues/${rqId}/requests/${requestId}`, { json: body });
        expect(put.status).toBe(200);
        expect(put.json().data.wasAlreadyPresent).toBe(true);

        // The request must be fetchable again - not still locked for the
        // rest of its (180s) TTL.
        const head = (await client.get(`/v2/request-queues/${rqId}/head`)).json().data;
        expect(head.items).toHaveLength(1);
        expect(head.items[0].id).toBe(requestId);
    });

    it('request list returns the wire-standard shape with handledAt', async () => {
        // `GET /request-queues/{id}/requests` (the plain list route, not the
        // per-request `GET .../requests/{id}`) must return the same
        // wire-standard per-request shape as every other per-request route -
        // including `handledAt` - not an ad hoc
        // `{id, url, uniqueKey, method, handled: bool}` subset.
        //
        // The real `apify` SDK's request-queue client's cache initialization
        // calls exactly this route (`list_requests(limit=10_000)`) on the
        // first `add_requests` against a request queue that already has rows
        // in it, and classifies each item purely from `handledAt`. A shape
        // with no `handledAt` key at all would make every already-handled
        // request classify as pending.
        const { client } = ctx;
        const rq = (await client.post('/v2/request-queues?name=rq-list-shape')).json().data;
        const rqId = rq.id;

        await client.post(`/v2/request-queues/${rqId}/requests`, {
            json: { url: 'https://example.com/list-pending', uniqueKey: 'https://example.com/list-pending' },
        });
        const handledKey = 'https://example.com/list-handled';
        const handledId = requestIdFor(handledKey);
        await client.put(`/v2/request-queues/${rqId}/requests/${handledId}`, {
            json: { url: handledKey, uniqueKey: handledKey, handledAt: '2026-02-02T00:00:00.000Z' },
        });

        const items = (await client.get(`/v2/request-queues/${rqId}/requests`)).json().data.items;
        expect(items).toHaveLength(2);
        const byKey = Object.fromEntries(items.map((i) => [i.uniqueKey, i]));
        for (const item of items) {
            for (const key of [
                'id',
                'url',
                'uniqueKey',
                'method',
                'retryCount',
                'noRetry',
                'loadedUrl',
                'handledAt',
                'headers',
                'userData',
                'payload',
            ]) {
                expect(item, `missing '${key}' in ${JSON.stringify(item)}`).toHaveProperty(key);
            }
        }

        expect(byKey['https://example.com/list-pending'].handledAt).toBeFalsy();
        expect(byKey[handledKey].handledAt).toBeTruthy();
    });

    it('PUT preserves a caller-supplied handledAt', async () => {
        // A PUT that marks a request handled must persist the caller's own
        // `handledAt` timestamp, not silently substitute the server's own
        // call time. Real Actor SDKs (`mark_request_as_handled`) always PUT
        // their own exact `handledAt` on the full request dict, and this
        // runtime's sibling fields (headers/payload/userData/retryCount/
        // noRetry/loadedUrl) already get this exact round-trip fidelity on
        // the same call path. Were `handledAt` dropped on write, the
        // read-back value would be a just-now timestamp, not the year-2020
        // one given below.
        const { client } = ctx;
        const rq = (await client.post('/v2/request-queues?name=rq-handled-at-fidelity')).json().data;
        const rqId = rq.id;

        const add = (
            await client.post(`/v2/request-queues/${rqId}/requests/batch`, {
                json: [
                    {
                        url: 'https://example.com/exact-handled-at',
                        uniqueKey: 'https://example.com/exact-handled-at',
                    },
                ],
            })
        ).json().data;
        const requestId = add.processedRequests[0].requestId;

        const givenHandledAt = '2020-01-01T00:00:00.000000Z';
        await client.put(`/v2/request-queues/${rqId}/requests/${requestId}`, {
            json: {
                url: 'https://example.com/exact-handled-at',
                uniqueKey: 'https://example.com/exact-handled-at',
                handledAt: givenHandledAt,
            },
        });

        const got = (await client.get(`/v2/request-queues/${rqId}/requests/${requestId}`)).json().data;
        expect(new Date(got.handledAt).getTime()).toBe(new Date(givenHandledAt).getTime());
    });
});

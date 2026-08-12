/** Unit tests for the crawlee-fs-backed storage layer (no Docker, no HTTP). */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Request } from '@crawlee/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Storage, requestIdFor } from '../../src/storage.js';

let tmpDir;
let storage;

beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'actor-runtime-storage-test-'));
    storage = new Storage(tmpDir);
});

afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

/**
 * Exact reproduction of the real SDK's own classification: feed the wire item
 * through the real, installed crawlee `Request` model. Adaptation from the
 * Python port: JS crawlee's `Request` constructor rejects explicit `null`
 * option values that Python's pydantic accepted as `None`, so null fields are
 * stripped first; and it exposes no `was_already_handled` computed property --
 * the JS SDK classifies by `handledAt` presence directly, so that is what the
 * assertion reads.
 */
function crawleeRequestFor(item) {
    return new Request(Object.fromEntries(Object.entries(item).filter(([, value]) => value !== null)));
}

describe('storage layer', () => {
    it('kv/dataset/rq roundtrip', async () => {
        await storage.kvSet('kv1', 'OUTPUT', { a: 1 }, 'application/json');
        const keys = await storage.kvKeys('kv1');
        expect(keys.some((k) => k.key === 'OUTPUT')).toBe(true);
        const record = await storage.kvRecord('kv1', 'OUTPUT');
        // `kvRecord` returns {value: Buffer, contentType}; the Python
        // predecessor returned parsed JSON here, so parse the bytes to make
        // the same assertion.
        expect(JSON.parse(record.value.toString('utf8'))).toEqual({ a: 1 });
        expect(record.contentType).toContain('json');

        await storage.datasetPush('ds1', [{ x: 1 }, { x: 2 }]);
        const page = await storage.datasetItems('ds1');
        expect(page.total).toBe(2);
        expect(page.items[0].x).toBe(1);

        await storage.rqAdd('rq1', [{ url: 'https://example.com/a' }]);
        const meta = await storage.rqMetadata('rq1');
        expect(meta.totalRequestCount).toBe(1);
        const reqs = await storage.rqRequests('rq1');
        expect(reqs[0].url).toBe('https://example.com/a');
    });

    it('import run storage', async () => {
        const runDir = path.join(tmpDir, 'storage');
        for (const kind of ['key_value_stores', 'datasets', 'request_queues']) {
            fs.mkdirSync(path.join(runDir, kind, 'default'), { recursive: true });
        }
        fs.writeFileSync(
            path.join(runDir, 'key_value_stores', 'default', 'OUTPUT.json'),
            JSON.stringify({ ok: true }),
        );
        fs.writeFileSync(path.join(runDir, 'datasets', 'default', '000000001.json'), JSON.stringify({ i: 1 }));
        fs.writeFileSync(
            path.join(runDir, 'request_queues', 'default', 'r1.json'),
            JSON.stringify({ url: 'https://example.com/x', uniqueKey: 'u1' }),
        );

        await storage.importRunStorage(runDir, 'kvX', 'dsX', 'rqX');

        const record = await storage.kvRecord('kvX', 'OUTPUT');
        expect(JSON.parse(record.value.toString('utf8'))).toEqual({ ok: true });
        expect((await storage.datasetItems('dsX')).items).toEqual([{ i: 1 }]);
        const reqs = await storage.rqRequests('rqX');
        expect(reqs[0].url).toBe('https://example.com/x');
    });

    it('import run storage isolates a binary kv record', async () => {
        // A binary KV record must not crash the whole import.
        //
        // Scenario: an Actor writes a binary KV file (a PNG screenshot)
        // alongside a dataset item and a queued request. Against the old
        // (Python) `path.read_text()` code, decoding the PNG bytes as UTF-8
        // raised and aborted the entire import - the dataset item and queued
        // request were silently lost too, even though only the KV file was
        // bad. The port must keep reading KV files as bytes with per-file
        // isolation.
        const runDir = path.join(tmpDir, 'storage');
        for (const kind of ['key_value_stores', 'datasets', 'request_queues']) {
            fs.mkdirSync(path.join(runDir, kind, 'default'), { recursive: true });
        }

        // Non-UTF-8 bytes (PNG magic header) - not decodable as text.
        const pngBytes = Buffer.concat([
            Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
            Buffer.from(Array.from({ length: 256 }, (_, i) => i)),
        ]);
        fs.writeFileSync(path.join(runDir, 'key_value_stores', 'default', 'shot.png'), pngBytes);
        fs.writeFileSync(
            path.join(runDir, 'key_value_stores', 'default', 'OUTPUT.json'),
            JSON.stringify({ ok: true }),
        );
        fs.writeFileSync(path.join(runDir, 'datasets', 'default', '000000001.json'), JSON.stringify({ i: 1 }));
        fs.writeFileSync(
            path.join(runDir, 'request_queues', 'default', 'r1.json'),
            JSON.stringify({ url: 'https://example.com/x', uniqueKey: 'u1' }),
        );

        // Must not raise, despite the binary KV record.
        await storage.importRunStorage(runDir, 'kvBin', 'dsBin', 'rqBin');

        // The binary record round-trips as raw bytes, unchanged.
        const shot = await storage.kvRecord('kvBin', 'shot');
        expect(shot.value.equals(pngBytes)).toBe(true);
        expect(shot.contentType).toBe('image/png');

        // The other KV record, dataset item and queued request all still made
        // it in - one bad file did not wipe out the rest of the import.
        const output = await storage.kvRecord('kvBin', 'OUTPUT');
        expect(JSON.parse(output.value.toString('utf8'))).toEqual({ ok: true });
        expect((await storage.datasetItems('dsBin')).items).toEqual([{ i: 1 }]);
        const reqs = await storage.rqRequests('rqBin');
        expect(reqs[0].url).toBe('https://example.com/x');
    });

    it('rqRequests returns the wire-standard shape with handledAt', async () => {
        // `Storage.rqRequests` (backing `GET /request-queues/{id}/requests`)
        // must return the same wire-standard per-request shape every other
        // per-request route in this module returns - not an ad hoc
        // `{id, url, uniqueKey, method, handled: bool}` subset.
        //
        // This directly locks the defect the real `apify` SDK hits: its
        // request-queue client's cache initialization calls this exact route
        // and classifies each returned item by feeding it straight through
        // the SDK's own `Request` model, reading `handledAt`. An item without
        // a `handledAt` key would always classify as not-yet-handled, so an
        // already-handled request would be re-fetched and re-processed.
        await storage.rqAddBatch('rq1', [
            { url: 'https://example.com/pending', uniqueKey: 'https://example.com/pending' },
            { url: 'https://example.com/done', uniqueKey: 'https://example.com/done' },
        ]);
        const doneId = requestIdFor('https://example.com/done');
        await storage.rqUpdateRequest('rq1', doneId, {
            url: 'https://example.com/done',
            uniqueKey: 'https://example.com/done',
            handledAt: '2026-01-01T00:00:00.000Z',
        });

        const items = await storage.rqRequests('rq1');
        expect(items).toHaveLength(2);
        const byKey = Object.fromEntries(items.map((i) => [i.uniqueKey, i]));

        // Wire-standard shape: every per-request field the wire dict
        // produces, not just id/url/uniqueKey/method.
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
            // Old ad hoc key is gone, not merely additive.
            expect(item).not.toHaveProperty('handled');
        }

        const pendingItem = byKey['https://example.com/pending'];
        const doneItem = byKey['https://example.com/done'];
        expect(pendingItem.handledAt).toBeFalsy();
        expect(doneItem.handledAt).toBeTruthy();

        // Reproduction of the real SDK's own classification (see
        // `crawleeRequestFor` for the JS-specific adaptation).
        expect(crawleeRequestFor(pendingItem).handledAt).toBeUndefined();
        expect(crawleeRequestFor(doneItem).handledAt).toBeTruthy();
    });

    it('rqUpdateRequest preserves a caller-supplied handledAt', async () => {
        // A PUT that marks a request handled must persist the caller's own
        // `handledAt` timestamp, not silently substitute the server's own
        // call time. The real `apify` SDK's `mark_request_as_handled` always
        // PUTs its own exact `handledAt` on the full request dict. Were the
        // update path to drop it, the read-back value would be a just-now
        // timestamp, not the given one below (from 2020).
        await storage.rqAddBatch('rq1', [
            { url: 'https://example.com/exact', uniqueKey: 'https://example.com/exact' },
        ]);
        const requestId = requestIdFor('https://example.com/exact');
        const givenHandledAt = '2020-01-01T00:00:00.000000Z';
        await storage.rqUpdateRequest('rq1', requestId, {
            url: 'https://example.com/exact',
            uniqueKey: 'https://example.com/exact',
            handledAt: givenHandledAt,
        });

        const found = await storage.rqGetRequest('rq1', requestId);
        expect(found).not.toBeNull();
        expect(new Date(found.handledAt).getTime()).toBe(new Date(givenHandledAt).getTime());
    });

    it('rqUpdateRequest with forefront=false (reclaim) releases the lock', async () => {
        // A PUT with the default `forefront=false` is what a real Actor's SDK
        // sends every time it requeues a request after a processing failure
        // (`request_queue.reclaim_request(request)` in the real `apify`
        // package). It must actually release the request's lock, not
        // silently no-op just because `forefront` is falsy.
        await storage.rqAddBatch('rq1', [
            { url: 'https://example.com/a', uniqueKey: 'https://example.com/a' },
        ]);

        // Lock it, exactly like a real consumer's `fetch_next_request` does
        // (`rqHeadAndLock`, backing `POST .../head/lock`).
        const locked = await storage.rqHeadAndLock('rq1', 10, 180);
        expect(locked.items).toHaveLength(1);
        const requestId = locked.items[0].id;

        // A real reclaim PUTs back exactly the body the lock/head read
        // returned - no `handledAt`, default `forefront=false`.
        const body = locked.items[0];
        const result = await storage.rqUpdateRequest('rq1', requestId, body, false);
        expect(result).not.toBeNull();
        expect(result.wasAlreadyPresent).toBe(true);

        // The request must be fetchable again - not still locked for the
        // rest of its (180s) TTL. A reclaim implementation that only acts
        // when `forefront` is truthy would leave the lock in place; the
        // reclaim must run unconditionally for an existing, not-yet-handled
        // request.
        const head = await storage.rqHead('rq1');
        expect(head.items).toHaveLength(1);
        expect(head.items[0].id).toBe(requestId);

        const headLock = await storage.rqHeadAndLock('rq1', 10, 60);
        expect(headLock.items).toHaveLength(1);
        expect(headLock.items[0].id).toBe(requestId);
    });
});

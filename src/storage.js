/**
 * Storage layer backed by crawlee v4's default file-system storage backend
 * (`@crawlee/fs-storage`, the `FileSystemStorageBackend` that `@crawlee/core`
 * creates when none is configured).
 *
 * Datasets and key-value stores delegate to the crawlee backend directly --
 * including the cursor-paged `listKeys` pushdown for KV keys, which the
 * native backend implements itself. Storages are addressed by a stable
 * string id (used verbatim as the crawlee storage `name`), so they can be
 * reopened across process restarts.
 *
 * Request queues are different: crawlee's request-queue backend is the
 * CONSUMER side of a crawl (`fetchNextRequest`/`markRequestAsHandled`/
 * `reclaimRequest`, with its own in-process locking and cached state), while
 * this runtime is the SERVER side of the full apify-client request-queue
 * protocol -- list requests, per-request get/put/delete, cooperative locks
 * with caller-chosen `lockSecs`, unlock-all -- none of which that backend
 * exposes. (The Python predecessor hit the same mismatch and had to bypass
 * its crawlee client into raw SQL rows for exactly these operations.) So the
 * runtime implements its request-queue store directly, using the same
 * file-per-request on-disk layout under the same `request_queues/` root, with
 * request ids computed by the same SHA-256/base64 hash of `uniqueKey` the
 * Apify SDK computes client-side -- see `requestIdFor`.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { FileSystemStorageBackend } from '@crawlee/fs-storage';

import { utcNow } from './constants.js';

// Effective "no cap" default applied when a dataset-items request omits
// `limit` -- large enough that no real local dataset exceeds it, so a bare
// (unpaginated) request keeps returning every item, exactly as it always has.
// The console's own 100-item paging always sends an explicit `limit`, so it
// never falls through to this default.
export const DEFAULT_ITEM_LIMIT = 999999;

// Default number of items a request-queue "head" read returns when the caller
// does not specify a limit (matches a reasonable single API-call page size).
export const DEFAULT_HEAD_LIMIT = 100;

/**
 * Deterministic request id for `uniqueKey`, matching the Apify SDK's own
 * client-side `uniqueKeyToRequestId` hash (SHA-256 -> URL-safe base64,
 * truncated to 15 chars). The SDK's request-queue client computes this same
 * hash itself for every get/fetch/lock call instead of trusting a
 * server-returned id, so this runtime must independently compute the
 * identical id from a request's `uniqueKey` for those per-request routes to
 * resolve to the request the SDK means.
 */
export function requestIdFor(uniqueKey) {
    return createHash('sha256')
        .update(uniqueKey, 'utf8')
        .digest('base64')
        .replace(/[+/=]/g, '')
        .slice(0, 15);
}

// Suffixes that are safe to decode as UTF-8 text when importing a KV record
// from disk. Anything else (images, PDFs, archives, ...) is imported as raw
// bytes so it round-trips unchanged, matching the HTTP put/get behaviour.
const TEXT_KV_SUFFIXES = new Set(['.txt', '.html', '.htm', '.csv', '.xml', '.md', '.log', '.yaml', '.yml']);

const MIME_BY_EXTENSION = {
    '.json': 'application/json',
    '.txt': 'text/plain',
    '.html': 'text/html',
    '.htm': 'text/html',
    '.csv': 'text/csv',
    '.xml': 'application/xml',
    '.md': 'text/markdown',
    '.log': 'text/plain',
    '.yaml': 'application/yaml',
    '.yml': 'application/yaml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf',
    '.zip': 'application/zip',
    '.gz': 'application/gzip',
};

function guessContentType(fileName, fallback) {
    return MIME_BY_EXTENSION[path.extname(fileName).toLowerCase()] ?? fallback;
}

/** The `{id, url, uniqueKey, method, ...}` wire shape every request route returns. */
function requestDict(record) {
    return {
        id: record.id,
        url: record.url,
        uniqueKey: record.uniqueKey,
        method: record.method ?? 'GET',
        retryCount: record.retryCount ?? 0,
        noRetry: record.noRetry ?? false,
        loadedUrl: record.loadedUrl ?? null,
        handledAt: record.handledAt ?? null,
        headers: record.headers ?? {},
        userData: record.userData ?? {},
        payload: record.payload ?? null,
    };
}

/**
 * The optional request fields a caller-supplied request dict may carry beyond
 * `url`/`method`/`uniqueKey`. Every one of these is a field the real Apify
 * SDK's request-queue client actually sets and sends on the wire, so dropping
 * any of them would silently discard state a real Actor depends on -- most
 * importantly `userData`, the standard Crawlee/Apify mechanism for
 * per-request state.
 */
function extraRequestFields(payload) {
    const fields = {};
    if (payload.headers !== undefined && payload.headers !== null) fields.headers = payload.headers;
    if (payload.payload !== undefined && payload.payload !== null) fields.payload = payload.payload;
    const userData = payload.userData ?? payload.user_data;
    if (userData !== undefined && userData !== null) fields.userData = userData;
    const handledAt = payload.handledAt ?? payload.handled_at;
    if (handledAt !== undefined && handledAt !== null) fields.handledAt = handledAt;
    if (payload.retryCount !== undefined || payload.retry_count !== undefined) {
        fields.retryCount = payload.retryCount ?? payload.retry_count;
    }
    if (payload.noRetry !== undefined || payload.no_retry !== undefined) {
        fields.noRetry = payload.noRetry ?? payload.no_retry;
    }
    if (payload.loadedUrl !== undefined || payload.loaded_url !== undefined) {
        fields.loadedUrl = payload.loadedUrl ?? payload.loaded_url;
    }
    return fields;
}

/**
 * One request queue's in-memory index + on-disk file-per-request persistence.
 *
 * Layout (same directory root and file-per-request convention as crawlee's
 * own file-system request queues): `request_queues/{queueId}/__metadata__.json`
 * plus one `{requestId}.json` per request. Locks are in-memory only -- they
 * are cooperative, short-lived crawl bookkeeping, and a restart releasing
 * every lock is safe (the requests themselves persist).
 */
class RequestQueueStore {
    constructor(dir, queueId) {
        this.dir = dir;
        this.queueId = queueId;
        /** @type {Map<string, object>} requestId -> stored record */
        this.records = new Map();
        /** @type {Map<string, number>} requestId -> lock expiry (ms epoch) */
        this.locks = new Map();
        this.createdAt = utcNow();
        this.modifiedAt = this.createdAt;
        this.#load();
    }

    #load() {
        let entries;
        try {
            entries = fs.readdirSync(this.dir);
        } catch {
            return;
        }
        try {
            const meta = JSON.parse(fs.readFileSync(path.join(this.dir, '__metadata__.json'), 'utf8'));
            this.createdAt = meta.createdAt ?? this.createdAt;
            this.modifiedAt = meta.modifiedAt ?? this.modifiedAt;
        } catch {
            // no metadata file yet
        }
        const loaded = [];
        for (const entry of entries) {
            if (!entry.endsWith('.json') || entry.startsWith('__')) continue;
            try {
                const record = JSON.parse(fs.readFileSync(path.join(this.dir, entry), 'utf8'));
                if (record && record.id) loaded.push(record);
            } catch {
                // one unreadable file must not take down the queue
            }
        }
        loaded.sort((a, b) => (a.orderNo ?? 0) - (b.orderNo ?? 0));
        for (const record of loaded) {
            this.records.set(record.id, record);
        }
    }

    get counts() {
        let handled = 0;
        for (const record of this.records.values()) {
            if (record.handledAt) handled += 1;
        }
        return {
            totalRequestCount: this.records.size,
            handledRequestCount: handled,
            pendingRequestCount: this.records.size - handled,
        };
    }

    #nextOrderNo(forefront) {
        let min = Infinity;
        let max = -Infinity;
        for (const record of this.records.values()) {
            const orderNo = record.orderNo ?? 0;
            if (orderNo < min) min = orderNo;
            if (orderNo > max) max = orderNo;
        }
        if (this.records.size === 0) return 1;
        return forefront ? min - 1 : max + 1;
    }

    #persistRecord(record) {
        fs.mkdirSync(this.dir, { recursive: true });
        fs.writeFileSync(path.join(this.dir, `${record.id}.json`), JSON.stringify(record));
        this.#persistMetadata();
    }

    #persistMetadata() {
        this.modifiedAt = utcNow();
        fs.mkdirSync(this.dir, { recursive: true });
        fs.writeFileSync(
            path.join(this.dir, '__metadata__.json'),
            JSON.stringify({
                id: this.queueId,
                name: this.queueId,
                createdAt: this.createdAt,
                modifiedAt: this.modifiedAt,
                accessedAt: this.modifiedAt,
                hadMultipleClients: false,
                ...this.counts,
            }),
        );
    }

    /** Every record ordered by `orderNo` (insertion order, forefront first). */
    ordered() {
        return [...this.records.values()].sort((a, b) => (a.orderNo ?? 0) - (b.orderNo ?? 0));
    }

    isLocked(requestId, nowMs) {
        const until = this.locks.get(requestId);
        return until !== undefined && until > nowMs;
    }

    add(payload, forefront) {
        const url = payload.url;
        const uniqueKey = payload.uniqueKey ?? payload.unique_key ?? url;
        const id = requestIdFor(uniqueKey);
        const existing = this.records.get(id);
        if (existing) {
            return {
                requestId: id,
                uniqueKey,
                wasAlreadyPresent: true,
                wasAlreadyHandled: Boolean(existing.handledAt),
            };
        }
        const record = {
            id,
            url,
            uniqueKey,
            method: payload.method ?? 'GET',
            orderNo: this.#nextOrderNo(forefront),
            ...extraRequestFields(payload),
        };
        this.records.set(id, record);
        this.#persistRecord(record);
        return { requestId: id, uniqueKey, wasAlreadyPresent: false, wasAlreadyHandled: false };
    }

    update(record) {
        this.records.set(record.id, record);
        this.#persistRecord(record);
    }

    delete(requestId) {
        const existing = this.records.get(requestId);
        if (!existing) return false;
        this.records.delete(requestId);
        this.locks.delete(requestId);
        try {
            fs.rmSync(path.join(this.dir, `${requestId}.json`), { force: true });
        } catch {
            // best effort -- the in-memory index is authoritative
        }
        this.#persistMetadata();
        return true;
    }

    drop() {
        this.records.clear();
        this.locks.clear();
        fs.rmSync(this.dir, { recursive: true, force: true });
    }
}

export class Storage {
    constructor(storageDir) {
        this.storageDir = storageDir;
        this.backend = new FileSystemStorageBackend({ localDataDirectory: storageDir });
        /** @type {Map<string, RequestQueueStore>} */
        this.queues = new Map();
    }

    async #kvs(storeId) {
        return this.backend.createKeyValueStoreBackend({ name: storeId });
    }

    async #dataset(datasetId) {
        return this.backend.createDatasetBackend({ name: datasetId });
    }

    #queue(queueId) {
        let queue = this.queues.get(queueId);
        if (!queue) {
            queue = new RequestQueueStore(
                path.join(this.storageDir, 'request_queues', queueId),
                queueId,
            );
            this.queues.set(queueId, queue);
        }
        return queue;
    }

    // -- key-value store ---------------------------------------------------
    async kvSet(storeId, key, value, contentType) {
        const kvs = await this.#kvs(storeId);
        let serialized = value;
        if (!Buffer.isBuffer(value) && typeof value !== 'string') {
            serialized = JSON.stringify(value ?? null);
        }
        await kvs.setValue({ key, value: serialized, contentType });
    }

    /** Every key in the store, unpaginated -- `kvKeysPage`'s own no-cursor, no-limit case. */
    async kvKeys(storeId) {
        return (await this.kvKeysPage(storeId)).items;
    }

    /**
     * Cursor-aware page of KV keys, pushed straight through to the crawlee
     * backend's own `listKeys(exclusiveStartKey, limit)` (implemented by the
     * native extension over its filesystem index) rather than slicing an
     * already-fetched full list -- so this scales with the page size, not the
     * store size.
     *
     * `limit == null` returns every remaining key (from `exclusiveStartKey`
     * onward, or from the start) with `isTruncated: false`, matching a bare
     * request's own no-cap behaviour -- the backend applies its own internal
     * page size, so "no limit" iterates pages until the cursor runs dry.
     * `limit === 0` is a zero-width window that by definition has nothing to
     * truncate: it short-circuits to an empty, non-truncated page without
     * probing at all, rather than reporting a truncation with no real key to
     * resume from.
     *
     * Returns `{items, isTruncated, nextExclusiveStartKey}` with `{key, size}`
     * items.
     */
    async kvKeysPage(storeId, exclusiveStartKey = null, limit = null) {
        if (limit === 0) {
            return { items: [], isTruncated: false, nextExclusiveStartKey: null };
        }
        const kvs = await this.#kvs(storeId);
        if (limit != null) {
            const page = await kvs.listKeys({
                exclusiveStartKey: exclusiveStartKey ?? undefined,
                limit,
            });
            return {
                items: page.items.map(({ key, size }) => ({ key, size: size ?? 0 })),
                isTruncated: page.isTruncated,
                nextExclusiveStartKey: page.isTruncated ? (page.nextExclusiveStartKey ?? null) : null,
            };
        }
        const items = [];
        let cursor = exclusiveStartKey ?? undefined;
        for (;;) {
            const page = await kvs.listKeys({ exclusiveStartKey: cursor });
            items.push(...page.items.map(({ key, size }) => ({ key, size: size ?? 0 })));
            if (!page.isTruncated || !page.nextExclusiveStartKey) break;
            cursor = page.nextExclusiveStartKey;
        }
        return { items, isTruncated: false, nextExclusiveStartKey: null };
    }

    /** Return `{value: Buffer, contentType}` or `null` when the record is absent. */
    async kvRecord(storeId, key) {
        const kvs = await this.#kvs(storeId);
        const record = await kvs.getValue(key);
        if (record === undefined) return null;
        const value = Buffer.isBuffer(record.value) ? record.value : Buffer.from(record.value ?? '');
        return { value, contentType: record.contentType || 'application/octet-stream' };
    }

    async kvDeleteRecord(storeId, key) {
        const kvs = await this.#kvs(storeId);
        try {
            await kvs.deleteValue(key);
        } catch {
            // deleting an absent record is a no-op, matching the real API
        }
    }

    // -- dataset -----------------------------------------------------------
    async datasetPush(datasetId, items) {
        if (!items.length) return;
        const ds = await this.#dataset(datasetId);
        await ds.pushData(items);
    }

    /** Returns `{items, total, count, offset}` for the requested slice. */
    async datasetItems(datasetId, offset = 0, limit = DEFAULT_ITEM_LIMIT) {
        const ds = await this.#dataset(datasetId);
        const page = await ds.getData({ offset, limit });
        return { items: [...page.items], total: page.total, count: page.count, offset: page.offset };
    }

    // -- request queue -------------------------------------------------------
    /**
     * Fire-and-forget add: used only by the post-run disk-import fallback
     * (`#importRequestQueueDir`), which has no caller waiting on a per-request
     * processed/unprocessed result.
     */
    async rqAdd(queueId, requests) {
        const queue = this.#queue(queueId);
        for (const request of requests) {
            if (!request || !request.url) continue;
            queue.add({ url: request.url, method: request.method, uniqueKey: request.uniqueKey }, false);
        }
    }

    /**
     * Backing implementation for `POST /request-queues/{id}/requests/batch`
     * (and, via a one-element list, the single-add route). Returns the
     * `processedRequests`/`unprocessedRequests` shape apify-client's
     * `batchAddRequests` expects.
     */
    async rqAddBatch(queueId, requests, forefront = false) {
        const queue = this.#queue(queueId);
        const processed = [];
        const unprocessed = [];
        for (const request of requests) {
            if (!request || !request.url) {
                unprocessed.push({
                    uniqueKey: request?.uniqueKey ?? '',
                    url: request?.url ?? '',
                    method: request?.method ?? 'GET',
                });
                continue;
            }
            processed.push(queue.add(request, forefront));
        }
        return { processedRequests: processed, unprocessedRequests: unprocessed };
    }

    /** Backing implementation for `DELETE /request-queues/{id}/requests/batch`. */
    async rqBatchDelete(queueId, requests) {
        const queue = this.#queue(queueId);
        const processed = [];
        for (const request of requests) {
            const id = request?.id || (request?.uniqueKey ? requestIdFor(request.uniqueKey) : null);
            if (!id) continue;
            const existing = queue.records.get(id);
            if (existing && queue.delete(id)) {
                processed.push({ requestId: id, uniqueKey: existing.uniqueKey });
            }
        }
        return { processedRequests: processed, unprocessedRequests: [] };
    }

    async rqMetadata(queueId) {
        const queue = this.#queue(queueId);
        return {
            id: queueId,
            ...queue.counts,
            hadMultipleClients: false,
            // Required (no default) by the apify SDK's own request-queue
            // metadata parsing, which indexes `response.stats` directly. This
            // runtime tracks no separate read/write/delete counters, so an
            // empty object is the honest value.
            stats: {},
        };
    }

    /** Every request in the queue, ordered, in the standard wire shape. */
    async rqRequests(queueId) {
        return this.#queue(queueId).ordered().map(requestDict);
    }

    async rqGetRequest(queueId, requestId) {
        const record = this.#queue(queueId).records.get(requestId);
        return record ? requestDict(record) : null;
    }

    /**
     * Backing implementation for `PUT /request-queues/{id}/requests/{requestId}`.
     *
     * Acts as an upsert (matching the real API): a `requestId` with no
     * existing record adds the request. An existing record is either marked
     * handled (`handledAt` set) or reclaimed (`handledAt` absent) -- the
     * reclaim path is what the real SDK PUTs on every retry after a
     * processing failure, always with `forefront=false`; reclaiming still
     * clears the record's lock and persists the given request data -- it only
     * additionally re-sequences the request to the back (or, with
     * `forefront=true`, the front) of the queue. Treating a
     * `forefront=false` reclaim as a no-op would leave the request's lock in
     * place for the rest of its TTL, silently hiding it from every
     * subsequent `head`/`head/lock` read even though the PUT reports success.
     */
    async rqUpdateRequest(queueId, requestId, body, forefront = false) {
        const queue = this.#queue(queueId);
        const existing = queue.records.get(requestId);
        const uniqueKey = body.uniqueKey ?? existing?.uniqueKey;
        const url = body.url ?? existing?.url;
        if (!uniqueKey || !url) return null;
        const wasAlreadyPresent = existing !== undefined;
        const wasAlreadyHandled = Boolean(existing?.handledAt);

        const record = {
            id: requestId,
            url,
            uniqueKey,
            method: body.method ?? existing?.method ?? 'GET',
            orderNo: existing?.orderNo,
            ...extraRequestFields(body),
        };
        if (body.handledAt) {
            record.handledAt = body.handledAt;
        } else if (wasAlreadyPresent) {
            // Reclaim: clear the lock, drop any stale handledAt, re-sequence
            // to the back (or, with forefront, the front) of the queue.
            delete record.handledAt;
            queue.locks.delete(requestId);
            record.orderNo = undefined;
        }
        if (record.orderNo === undefined) {
            const ordered = queue.ordered().filter((r) => r.id !== requestId);
            record.orderNo = ordered.length
                ? (forefront ? ordered[0].orderNo - 1 : ordered.at(-1).orderNo + 1)
                : 1;
        }
        queue.update(record);
        return { requestId, uniqueKey, wasAlreadyPresent, wasAlreadyHandled };
    }

    async rqDeleteRequest(queueId, requestId) {
        return this.#queue(queueId).delete(requestId);
    }

    /** Unhandled, not-currently-locked head of the queue, in order. */
    async rqHead(queueId, limit = DEFAULT_HEAD_LIMIT) {
        const queue = this.#queue(queueId);
        const nowMs = Date.now();
        const available = queue
            .ordered()
            .filter((record) => !record.handledAt && !queue.isLocked(record.id, nowMs))
            .slice(0, limit);
        return {
            limit,
            hadMultipleClients: false,
            queueModifiedAt: queue.modifiedAt,
            items: available.map(requestDict),
        };
    }

    async rqHeadAndLock(queueId, limit, lockSecs) {
        const queue = this.#queue(queueId);
        const nowMs = Date.now();
        const lockUntil = nowMs + lockSecs * 1000;
        const unhandled = queue.ordered().filter((record) => !record.handledAt);
        const available = unhandled.filter((record) => !queue.isLocked(record.id, nowMs));
        const toLock = available.slice(0, limit);
        for (const record of toLock) {
            queue.locks.set(record.id, lockUntil);
        }
        // "Does this queue have any locked, unhandled request" -- whether
        // locked by this call (`toLock`) or already locked by a PRIOR call (an
        // unhandled record not in `available`, i.e. still within its lock
        // window). This flag backs the apify SDK's own shared request-queue
        // client's `isFinished` check, so under-reporting it would make a
        // multi-consumer crawl think it's finished while another consumer
        // still holds locked work.
        const hasLockedRequests = unhandled.length > available.length || toLock.length > 0;
        return {
            limit,
            hadMultipleClients: false,
            queueHasLockedRequests: hasLockedRequests,
            queueModifiedAt: queue.modifiedAt,
            items: toLock.map(requestDict),
        };
    }

    async rqLockRequest(queueId, requestId, lockSecs) {
        const queue = this.#queue(queueId);
        if (!queue.records.has(requestId)) return null;
        const lockUntil = new Date(Date.now() + lockSecs * 1000);
        queue.locks.set(requestId, lockUntil.getTime());
        return { lockExpiresAt: lockUntil.toISOString() };
    }

    async rqDeleteRequestLock(queueId, requestId) {
        const queue = this.#queue(queueId);
        if (!queue.records.has(requestId)) return false;
        queue.locks.delete(requestId);
        return true;
    }

    /**
     * Release every currently-active lock; returns how many were released.
     * Only an unexpired lock counts -- an already-expired entry was
     * effectively unlocked before this call and must not inflate the count
     * apify-client hands straight back to the caller as `unlockedCount`.
     */
    async rqUnlockAll(queueId) {
        const queue = this.#queue(queueId);
        const nowMs = Date.now();
        let released = 0;
        for (const [requestId, until] of queue.locks) {
            if (until > nowMs) released += 1;
            queue.locks.delete(requestId);
        }
        return released;
    }

    // -- drop (hard-delete underlying data) --------------------------------
    async kvDrop(storeId) {
        const kvs = await this.#kvs(storeId);
        await kvs.drop();
        // Evict the dropped client from the backend's cache so a later
        // create-by-the-same-name opens a fresh store instead of reusing the
        // dropped one.
        const cache = this.backend.keyValueStoreBackendCache;
        const index = cache.indexOf(kvs);
        if (index !== -1) cache.splice(index, 1);
    }

    async datasetDrop(datasetId) {
        const ds = await this.#dataset(datasetId);
        await ds.drop();
        const cache = this.backend.datasetBackendCache;
        const index = cache.indexOf(ds);
        if (index !== -1) cache.splice(index, 1);
    }

    async rqDrop(queueId) {
        this.#queue(queueId).drop();
        this.queues.delete(queueId);
    }

    // -- import from an Actor run's local storage directory ----------------
    /**
     * Import the Apify-style local storage a finished Actor wrote on disk.
     *
     * Layout (Apify/crawlee local storage convention):
     *   storage/key_value_stores/default/<key>.<ext>
     *   storage/datasets/default/*.json         (one item per file)
     *   storage/request_queues/default/*.json   (one request per file)
     *
     * `trustedRoot` is the real (`fs.realpath`) path of `storageDir` captured
     * at a trusted time, before any Actor code ran. Every imported file is
     * validated against this fixed anchor -- the anchor is NOT re-derived from
     * `storageDir` at import time, because by then the untrusted Actor may
     * have swapped a directory below it for a symlink pointing outside the
     * run dir.
     */
    async importRunStorage(storageDir, kvStoreId, datasetId, requestQueueId, trustedRoot = null) {
        const anchor = trustedRoot ?? (await realpathOrNull(storageDir)) ?? storageDir;

        // Each phase (and each file within a phase) is isolated: a single
        // malformed or binary file must not take down the other stores.
        try {
            await this.#importKvDir(storageDir, anchor, kvStoreId);
        } catch (err) {
            console.error(`Failed to import key-value store from ${storageDir}:`, err);
        }
        try {
            await this.#importDatasetDir(storageDir, anchor, datasetId);
        } catch (err) {
            console.error(`Failed to import dataset from ${storageDir}:`, err);
        }
        try {
            await this.#importRequestQueueDir(storageDir, anchor, requestQueueId);
        } catch (err) {
            console.error(`Failed to import request queue from ${storageDir}:`, err);
        }
    }

    async #importKvDir(storageDir, anchor, kvStoreId) {
        const kvDir = path.join(storageDir, 'key_value_stores', 'default');
        for (const filePath of await listFilesSorted(kvDir)) {
            const name = path.basename(filePath);
            if (name.startsWith('__')) continue;
            if (!(await safeFile(filePath, storageDir, anchor))) continue;
            try {
                const key = name.slice(0, name.length - path.extname(name).length) || name;
                const { value, contentType } = await readKvFile(filePath);
                await this.kvSet(kvStoreId, key, value, contentType);
            } catch (err) {
                console.error(`Failed to import key-value record ${filePath}:`, err);
            }
        }
    }

    async #importDatasetDir(storageDir, anchor, datasetId) {
        const dsDir = path.join(storageDir, 'datasets', 'default');
        const items = [];
        for (const filePath of await listFilesSorted(dsDir)) {
            const name = path.basename(filePath);
            if (name.startsWith('__') || path.extname(name) !== '.json') continue;
            if (!(await safeFile(filePath, storageDir, anchor))) continue;
            try {
                items.push(JSON.parse(await fsp.readFile(filePath, 'utf8')));
            } catch (err) {
                console.error(`Failed to import dataset item ${filePath}:`, err);
            }
        }
        await this.datasetPush(datasetId, items);
    }

    async #importRequestQueueDir(storageDir, anchor, requestQueueId) {
        const rqDir = path.join(storageDir, 'request_queues', 'default');
        const requests = [];
        for (const filePath of await listFilesSorted(rqDir)) {
            const name = path.basename(filePath);
            if (name.startsWith('__') || path.extname(name) !== '.json') continue;
            if (!(await safeFile(filePath, storageDir, anchor))) continue;
            try {
                requests.push(JSON.parse(await fsp.readFile(filePath, 'utf8')));
            } catch (err) {
                console.error(`Failed to import queued request ${filePath}:`, err);
            }
        }
        await this.rqAdd(requestQueueId, requests);
    }
}

async function listFilesSorted(dir) {
    let entries;
    try {
        entries = await fsp.readdir(dir);
    } catch {
        return [];
    }
    return entries.sort().map((entry) => path.join(dir, entry));
}

async function realpathOrNull(target) {
    try {
        return await fsp.realpath(target);
    } catch {
        return null;
    }
}

/**
 * Read one on-disk KV record, matching the HTTP put/get handling: `.json`
 * files are parsed and stored as JSON; other known-text suffixes are decoded
 * as UTF-8; everything else (screenshots, PDFs, archives -- anything an Actor
 * can legitimately write into its KV store) is read as raw bytes with a
 * content type guessed from the extension, so it round-trips unchanged.
 */
async function readKvFile(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.json') {
        const text = await fsp.readFile(filePath, 'utf8');
        return { value: JSON.parse(text || 'null'), contentType: 'application/json' };
    }
    if (TEXT_KV_SUFFIXES.has(ext)) {
        return {
            value: await fsp.readFile(filePath, 'utf8'),
            contentType: guessContentType(filePath, 'text/plain'),
        };
    }
    return {
        value: await fsp.readFile(filePath),
        contentType: guessContentType(filePath, 'application/octet-stream'),
    };
}

/**
 * True only for a regular file reachable from `storageRoot` with no symlink.
 *
 * The Actor's own (untrusted) container has read-write access to the
 * bind-mounted run storage dir, so it can plant symlinks -- not only on a
 * leaf file, but by replacing an entire intermediate directory (e.g.
 * `key_value_stores/default`) with a symlink to an arbitrary location such as
 * `/etc` or the runtime's own source. Following any of those would let a
 * malicious Actor exfiltrate host files back through the KV/dataset/queue API.
 *
 * Defence: walk every path component from the trusted `storageRoot` down to
 * the file and reject if ANY of them (including the leaf) is a symlink; then
 * confirm the file's real path still lives under `trustedRoot` -- the anchor
 * captured before any Actor code ran, never re-derived from the
 * possibly-swapped tree.
 */
export async function safeFile(filePath, storageRoot, trustedRoot) {
    try {
        const rel = path.relative(storageRoot, filePath);
        if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
        let current = storageRoot;
        for (const part of rel.split(path.sep)) {
            current = path.join(current, part);
            const stat = await fsp.lstat(current);
            if (stat.isSymbolicLink()) return false;
        }
        const stat = await fsp.lstat(filePath);
        if (!stat.isFile()) return false;
        const real = await fsp.realpath(filePath);
        return real === trustedRoot || real.startsWith(trustedRoot + path.sep);
    } catch {
        return false;
    }
}

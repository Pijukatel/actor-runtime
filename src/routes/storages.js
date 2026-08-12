/** Key-value store, dataset and request-queue endpoints. */
import { resolveUser } from '../auth.js';
import {
    STORAGE_DS,
    STORAGE_KV,
    STORAGE_RQ,
    isRunStorageId,
    storageNameFromId,
} from '../constants.js';
import {
    HttpError,
    badRequest,
    conflict,
    data,
    forbidden,
    jsonResponse,
    notFound,
    readBody,
    readJson,
    response,
    textResponse,
} from '../http.js';
import { pagedEnvelope, parsePage } from '../pagination.js';
import {
    ACCESS_ABSENT,
    ACCESS_ALLOW,
    ACCESS_FORBIDDEN,
    InvalidStorageNameError,
    LEVEL_READ,
    LEVEL_WRITE,
    StorageTypeCollisionError,
    validateStorageName,
} from '../storage-access.js';
import { DEFAULT_HEAD_LIMIT } from '../storage.js';

/**
 * Field-complete base metadata shared by dataset/KVS/RQ GET responses.
 *
 * `id`/`userId`/`createdAt` are sourced from the storage's own row; this
 * runtime does not track separate modification/access timestamps, so
 * `modifiedAt`/`accessedAt` are synthesized equal to `createdAt` -- still
 * valid, present datetimes, which is all apify-client's response models
 * require. `consoleUrl` is likewise synthesized (the runtime never sets a
 * real public console host).
 *
 * `name` is derived by the single shared helper `storageNameFromId` (also
 * used by `serializers.storageDict`, so the two paths can never drift
 * apart): empty for a run-derived id, the `name` half of a `username~name`
 * id, or -- for a type-qualified `username~{type}~name` id -- the part after
 * the type prefix, NOT the raw id: crawlee's own storage domain objects
 * validate a non-empty `name` the instant an SDK Actor opens its default
 * storage, and every id this runtime mints contains `_` or `~` -- neither is
 * a legal storage name, so handing back the id verbatim as `name` would make
 * `Actor.getInput()` itself throw before any Actor code runs.
 */
function storageMeta(svc, storage, kind) {
    return {
        id: storage.id,
        name: storageNameFromId(storage.id, storage.type),
        userId: storage.owner,
        createdAt: storage.createdAt,
        modifiedAt: storage.createdAt,
        accessedAt: storage.createdAt,
        consoleUrl: `${svc.settings.containerApiBaseUrl}/storage/${kind}/${storage.id}`,
    };
}

/** Return the user a namespaced storage id (`owner~name`) belongs to, else null. */
function namespaceOwner(storageId) {
    return storageId.includes('~') ? storageId.split('~', 1)[0] : null;
}

/**
 * Whether an absent-id write may auto-create a storage owned by `user`.
 *
 * Airtight rule: a write may only ever create a storage the writer owns
 * under the writer's own space. It must never mint an id another user would
 * be handed by the documented flow -- i.e. another user's namespaced
 * `owner~name` id, or a run-derived `kv_/ds_/rq_` id (always created at run
 * start, never here).
 *
 * A namespaced id is additionally checked against the same naming rule the
 * by-name create route enforces (`validateStorageName`, applied to whatever
 * `name` this id would report via `storageNameFromId`): this
 * write-auto-create path can address ANY caller-chosen id, so without this
 * check a caller could mint a storage here whose derived `name` field is not
 * a valid storage name -- crawlee's own domain objects reject exactly that
 * name the instant a real SDK Actor opens a storage by it.
 */
function canAutocreate(storageId, user, storageType) {
    if (isRunStorageId(storageId)) return false;
    const owner = namespaceOwner(storageId);
    if (owner !== null && owner !== user) return false;
    if (storageId.includes('~')) {
        try {
            validateStorageName(storageNameFromId(storageId, storageType));
        } catch (err) {
            if (err instanceof InvalidStorageNameError) return false;
            throw err;
        }
    }
    return true;
}

function isTextual(contentType) {
    const ct = contentType.toLowerCase();
    return (
        ct.startsWith('text/') ||
        ct.includes('json') ||
        ct.includes('xml') ||
        ct.includes('javascript') ||
        ct.includes('x-www-form-urlencoded')
    );
}

/**
 * Return `{user, storage, denied}` for a storage read/write.
 *
 * A read denial (another user's storage, or an unknown/absent id) hides
 * existence with `notFound()` (404). An id that exists as a different
 * storage type than `storageType` is also 404 -- as this type it does not
 * exist. A write to an absent id auto-creates the storage owned by the
 * writer -- but only for an id the writer may legitimately own (see
 * `canAutocreate`); a write to an absent id that belongs to another user's
 * namespace (or a run-derived id) is 404, never seized. A write denial on a
 * storage the caller can already see (READ-only grantee) returns
 * `forbidden()` (403); a write to a storage the caller cannot see at all
 * returns 404.
 *
 * `storage` is the row `checkStorageAccess` already read to decide access --
 * present whenever the call is allowed against an existing row, `null`
 * otherwise -- so a caller that also needs the row (the per-storage metadata
 * GETs) can reuse this single read.
 */
async function guard(ctx, storageId, need, storageType) {
    const svc = ctx.service;
    const user = await resolveUser(ctx);
    const { decision, storage } = svc.checkStorageAccess(storageId, user, need, storageType);
    if (decision === ACCESS_ALLOW) return { user, storage, denied: null };
    if (decision === ACCESS_ABSENT) {
        if (need === LEVEL_WRITE && canAutocreate(storageId, user, storageType)) {
            const owner = svc.ensureStorage(storageId, storageType, user);
            if (owner !== user) return { user, storage: null, denied: notFound() };
            return { user, storage: null, denied: null };
        }
        return { user, storage: null, denied: notFound() };
    }
    if (decision === ACCESS_FORBIDDEN) {
        return { user, storage: null, denied: forbidden('You do not have permission to write to this storage.') };
    }
    return { user, storage: null, denied: notFound() };
}

/**
 * Return `{storage, denied}`; access-rights management is owner-only. An id
 * with no backing storage row hides existence with 404, like every other
 * unknown-resource path; 403 is reserved for a row that exists but is not
 * owned by the caller.
 */
async function ownerOrForbidden(ctx, storageId) {
    const svc = ctx.service;
    const user = await resolveUser(ctx);
    const storage = svc.getStorage(storageId);
    if (!storage) return { storage: null, denied: notFound() };
    if (storage.owner !== user) {
        return { storage: null, denied: forbidden('Only the storage owner can manage its access rights.') };
    }
    return { storage, denied: null };
}

/**
 * Create-echo (get-or-create) a standalone storage, namespaced per user like
 * Actors.
 *
 * `name` is read from the query string first: the real apify-client's
 * get-or-create -- exactly what `Actor.openDataset(name)` etc. call
 * underneath -- sends `?name=...` with an empty JSON body, so a real SDK
 * Actor opening a named storage never puts `name` in the body at all. The
 * JSON body `name` key is kept as a fallback (query param wins if both are
 * present) so this runtime's own tests/console keep working unchanged.
 *
 * The returned id is normally `username~name` so two users never collide on
 * a global id. Two *different* storage types sharing the same owner+name get
 * the qualified-id treatment -- see
 * `StorageAccessManager.getOrCreateNamedStorage`. Creating again as the same
 * owner+type is idempotent (200); an id that already resolves to another
 * user's row is a conflict (409), never a misleading 201 that fails to grant
 * ownership. An invalid name is `400 invalid-request`; the (normally
 * unreachable, defence-in-depth) case where the qualified id nonetheless
 * resolves to a different type is `409 resource-conflict` rather than a
 * silent misroute.
 */
async function createStorage(ctx, storageType) {
    const svc = ctx.service;
    const user = await resolveUser(ctx);
    let body = await readJson(ctx);
    if (typeof body !== 'object' || body === null || Array.isArray(body)) body = {};
    const name = ctx.query.get('name') || body.name || 'default';
    let result;
    try {
        result = svc.getOrCreateNamedStorage(name, storageType, user);
    } catch (err) {
        if (err instanceof InvalidStorageNameError) return badRequest(err.message);
        if (err instanceof StorageTypeCollisionError) return conflict(err.message);
        throw err;
    }
    const { storageId, actualOwner, created } = result;
    if (!created) {
        if (actualOwner !== user) {
            return conflict('A storage with this id already exists under another owner.');
        }
        return data({ id: storageId, name }, 200);
    }
    return data({ id: storageId, name }, 201);
}

/**
 * Owner-only hard delete of a standalone storage of `storageType`.
 *
 * Cross-user or unknown ids are hidden as 404 (existence is never leaked). A
 * run-derived id owned by the caller is refused `400 invalid-request`: it is
 * managed with its run and deleting it would orphan the run's storage
 * references. Success removes the row, its access-rights grants and the data.
 */
async function deleteStorage(ctx, storageId, storageType) {
    const svc = ctx.service;
    const user = await resolveUser(ctx);
    const storage = svc.getStorage(storageId);
    if (!storage || storage.owner !== user || storage.type !== storageType) {
        return notFound();
    }
    if (isRunStorageId(storageId)) {
        return badRequest(
            'This storage belongs to an Actor run and is managed with its run; it cannot be deleted here.',
        );
    }
    const result = await svc.deleteStorage(storageId, user);
    if (result !== ACCESS_ALLOW) return notFound();
    return data({ id: storageId });
}

/**
 * Attach `recordPublicUrl` to each `{key, size}` item, on EVERY KV-keys
 * response path alike (bare, cursor-mode, and the `offset`-sliced console
 * path) -- matching the real Apify API's `ListOfKeys`, which always returns
 * this field regardless of how the request was paged.
 *
 * Built from the handling request's own origin -- the host/port this same
 * request actually arrived on -- rather than `settings.containerApiBaseUrl`
 * (the fixed Docker-network hostname `standbyUrl`/`consoleUrl` use): this
 * route's callers are typically host-side (curl, or apify-client pointed at
 * the published API port), and a Docker-internal hostname would not resolve
 * for them at all.
 */
function withRecordPublicUrl(items, ctx, storeId) {
    const base = ctx.baseUrl;
    return items.map((item) => ({
        ...item,
        // encodeURIComponent percent-encodes every reserved character
        // (including `/`) -- a key containing e.g. a space or `#` would
        // otherwise land in the URL unescaped, so a client following the
        // link would either mis-split it or fetch a different record than
        // the one this envelope describes.
        recordPublicUrl: `${base}/v2/key-value-stores/${storeId}/records/${encodeURIComponent(item.key)}`,
    }));
}

/**
 * Cursor-mode envelope for `GET /v2/key-value-stores/{id}/keys`: pushes
 * `exclusiveStartKey`/`limit` straight through to the crawlee backend's own
 * cursor-paged `listKeys` (see `Storage.kvKeysPage`), matching the real
 * API's `ListOfKeys` cursor contract. The envelope never gains a `total`
 * field, cursor mode or bare -- unlike the offset-sliced path, which already
 * holds the full list and can report one for free, computing a store-wide
 * count here would force exactly the full-store scan the cursor pushdown
 * exists to avoid.
 */
async function kvKeysCursorEnvelope(svc, ctx, storeId, exclusiveStartKey, limit) {
    const page = await svc.storage.kvKeysPage(storeId, exclusiveStartKey, limit);
    const items = withRecordPublicUrl(page.items, ctx, storeId);
    const envelope = { items, count: items.length };
    envelope.limit = limit !== null ? limit : items.length;
    if (exclusiveStartKey !== null) envelope.exclusiveStartKey = exclusiveStartKey;
    envelope.isTruncated = page.isTruncated;
    if (page.nextExclusiveStartKey !== null) envelope.nextExclusiveStartKey = page.nextExclusiveStartKey;
    return envelope;
}

export function registerStorageRoutes(router) {
    // -- key-value stores -----------------------------------------------------
    router.add('POST', '/v2/key-value-stores', (ctx) => createStorage(ctx, STORAGE_KV));

    router.add('GET', '/v2/key-value-stores/:storeId', async (ctx, { storeId }) => {
        const svc = ctx.service;
        const { storage, denied } = await guard(ctx, storeId, LEVEL_READ, STORAGE_KV);
        if (denied) return denied;
        if (!storage) return notFound();
        const keys = await svc.storage.kvKeys(storeId);
        const meta = storageMeta(svc, storage, 'key-value-stores');
        meta.itemCount = keys.length;
        return data(meta);
    });

    /**
     * List a KV store's keys. Two independent, mutually-exclusive-in-practice
     * paging mechanisms share this one endpoint: a caller-supplied
     * `exclusiveStartKey` cursor (pushed down to crawlee, ascending,
     * real-API-shaped `isTruncated`/`nextExclusiveStartKey`) and the
     * console's own `offset`-based paging (an already-fetched full list
     * sliced here, unaffected by cursor support). `offset` has no equivalent
     * in the real API's own KV-keys contract, so a request naming BOTH
     * treats the cursor as authoritative and ignores `offset` entirely. A
     * bare request takes the cursor path with everything null, which
     * reproduces the unpaginated shape exactly except for the additive
     * `recordPublicUrl` on each item every path now carries.
     */
    router.add('GET', '/v2/key-value-stores/:storeId/keys', async (ctx, { storeId }) => {
        const svc = ctx.service;
        const { denied } = await guard(ctx, storeId, LEVEL_READ, STORAGE_KV);
        if (denied) return denied;
        const { limit, offset } = parsePage(ctx);
        const exclusiveStartKey = ctx.query.get('exclusiveStartKey') || null;
        if (exclusiveStartKey !== null || offset === null) {
            return data(await kvKeysCursorEnvelope(svc, ctx, storeId, exclusiveStartKey, limit));
        }
        const keys = await svc.storage.kvKeys(storeId);
        // `limit === 0` is a zero-width window with nothing to truncate,
        // exactly like the cursor path's own short-circuit -- without this,
        // `offset + limit < keys.length` reports `isTruncated: true` for a
        // page that is always empty, a loop hazard for a naive "keep paging
        // until isTruncated is false" caller.
        const isTruncated = limit !== null && limit > 0 && offset + limit < keys.length;
        const envelope = pagedEnvelope(keys, limit, offset, { isTruncated });
        envelope.items = withRecordPublicUrl(envelope.items, ctx, storeId);
        return data(envelope);
    });

    router.add('GET', '/v2/key-value-stores/:storeId/records/:key', async (ctx, { storeId, key }) => {
        const svc = ctx.service;
        const { denied } = await guard(ctx, storeId, LEVEL_READ, STORAGE_KV);
        if (denied) return denied;
        const record = await svc.storage.kvRecord(storeId, key);
        if (record === null) return notFound(`Record '${key}' was not found.`);
        const { value, contentType } = record;
        if (contentType.includes('json')) {
            let parsed = null;
            try {
                parsed = JSON.parse(value.toString('utf8') || 'null');
            } catch {
                return textResponse(value.toString('utf8'), 200, [], contentType.split(';')[0]);
            }
            return jsonResponse(parsed);
        }
        if (isTextual(contentType)) {
            return textResponse(value.toString('utf8'), 200, [], contentType.split(';')[0]);
        }
        return response({ status: 200, headers: [['content-type', contentType]], body: value });
    });

    router.add('PUT', '/v2/key-value-stores/:storeId/records/:key', async (ctx, { storeId, key }) => {
        const svc = ctx.service;
        const { denied } = await guard(ctx, storeId, LEVEL_WRITE, STORAGE_KV);
        if (denied) return denied;
        const contentType = ctx.headers['content-type'] ?? 'application/octet-stream';
        const raw = await readBody(ctx);
        let value;
        if (contentType.includes('json')) {
            try {
                value = raw.length ? JSON.parse(raw.toString('utf8')) : null;
            } catch (err) {
                throw new HttpError(400, `Malformed JSON record body: ${err.message}`);
            }
        } else if (isTextual(contentType)) {
            // Decode only genuinely textual payloads; binary (PNG, PDF, ...)
            // must be stored as raw bytes so it round-trips through PUT/GET
            // unchanged.
            value = raw.toString('utf8');
        } else {
            value = raw;
        }
        await svc.storage.kvSet(storeId, key, value, contentType);
        return data({ key });
    });

    router.add('DELETE', '/v2/key-value-stores/:storeId/records/:key', async (ctx, { storeId, key }) => {
        const svc = ctx.service;
        const { denied } = await guard(ctx, storeId, LEVEL_WRITE, STORAGE_KV);
        if (denied) return denied;
        await svc.storage.kvDeleteRecord(storeId, key);
        return data({ key });
    });

    router.add('HEAD', '/v2/key-value-stores/:storeId/records/:key', async (ctx, { storeId, key }) => {
        const svc = ctx.service;
        const { denied } = await guard(ctx, storeId, LEVEL_READ, STORAGE_KV);
        if (denied) return response({ status: denied.status });
        const record = await svc.storage.kvRecord(storeId, key);
        return response({ status: record !== null ? 200 : 404 });
    });

    router.add('DELETE', '/v2/key-value-stores/:storeId', (ctx, { storeId }) =>
        deleteStorage(ctx, storeId, STORAGE_KV));

    // -- datasets -------------------------------------------------------------
    router.add('POST', '/v2/datasets', (ctx) => createStorage(ctx, STORAGE_DS));

    router.add('GET', '/v2/datasets/:datasetId', async (ctx, { datasetId }) => {
        const svc = ctx.service;
        const { storage, denied } = await guard(ctx, datasetId, LEVEL_READ, STORAGE_DS);
        if (denied) return denied;
        if (!storage) return notFound();
        const result = await svc.storage.datasetItems(datasetId);
        const meta = storageMeta(svc, storage, 'datasets');
        // No separate "clean" (non-empty/non-hidden-field) count is tracked;
        // the full item count is a reasonable, always-present stand-in.
        meta.itemCount = result.total;
        meta.cleanItemCount = result.total;
        return data(meta);
    });

    /**
     * List a dataset's items. The response BODY stays a bare JSON array
     * either way -- bare or paged -- matching the pre-pagination shape
     * exactly. The `X-Apify-Pagination-*` headers, however, are emitted on
     * EVERY response, bare calls included: apify-client's dataset-items page
     * parsing indexes all five directly, so a genuinely bare call would
     * otherwise fail before returning a single item.
     */
    router.add('GET', '/v2/datasets/:datasetId/items', async (ctx, { datasetId }) => {
        const svc = ctx.service;
        const { denied } = await guard(ctx, datasetId, LEVEL_READ, STORAGE_DS);
        if (denied) return denied;
        const { limit, offset } = parsePage(ctx);
        const result = await svc.storage.datasetItems(
            datasetId,
            offset ?? 0,
            limit !== null ? limit : undefined,
        );
        return response({
            status: 200,
            headers: [
                ['content-type', 'application/json'],
                ['X-Apify-Pagination-Offset', String(result.offset)],
                ['X-Apify-Pagination-Count', String(result.count)],
                ['X-Apify-Pagination-Total', String(result.total)],
                // Effective limit -- the requested value, or (when `limit`
                // was omitted, bare or offset-only) the slice's own returned
                // length, never the internal "no cap" sentinel the storage
                // layer applies underneath.
                ['X-Apify-Pagination-Limit', String(limit !== null ? limit : result.count)],
                // This surface has no `desc` query param -- items are always
                // returned in storage (insertion) order -- but the header is
                // still required, bare calls included: apify-client indexes
                // all five headers directly.
                ['X-Apify-Pagination-Desc', 'false'],
            ],
            body: JSON.stringify(result.items),
        });
    });

    router.add('POST', '/v2/datasets/:datasetId/items', async (ctx, { datasetId }) => {
        const svc = ctx.service;
        const { denied } = await guard(ctx, datasetId, LEVEL_WRITE, STORAGE_DS);
        if (denied) return denied;
        const payload = await readJson(ctx);
        const items = Array.isArray(payload) ? payload : [payload];
        await svc.storage.datasetPush(datasetId, items);
        return data({ count: items.length }, 201);
    });

    router.add('DELETE', '/v2/datasets/:datasetId', (ctx, { datasetId }) =>
        deleteStorage(ctx, datasetId, STORAGE_DS));

    // -- request queues ---------------------------------------------------------
    router.add('POST', '/v2/request-queues', (ctx) => createStorage(ctx, STORAGE_RQ));

    router.add('GET', '/v2/request-queues/:queueId', async (ctx, { queueId }) => {
        const svc = ctx.service;
        const { storage, denied } = await guard(ctx, queueId, LEVEL_READ, STORAGE_RQ);
        if (denied) return denied;
        if (!storage) return notFound();
        const meta = storageMeta(svc, storage, 'request-queues');
        Object.assign(meta, await svc.storage.rqMetadata(queueId));
        return data(meta);
    });

    router.add('GET', '/v2/request-queues/:queueId/head', async (ctx, { queueId }) => {
        const svc = ctx.service;
        const { denied } = await guard(ctx, queueId, LEVEL_READ, STORAGE_RQ);
        if (denied) return denied;
        const limit = boundedIntOr(ctx, 'limit', DEFAULT_HEAD_LIMIT);
        return data(await svc.storage.rqHead(queueId, limit));
    });

    router.add('POST', '/v2/request-queues/:queueId/head/lock', async (ctx, { queueId }) => {
        const svc = ctx.service;
        const { denied } = await guard(ctx, queueId, LEVEL_WRITE, STORAGE_RQ);
        if (denied) return denied;
        const limit = boundedIntOr(ctx, 'limit', DEFAULT_HEAD_LIMIT);
        const lockSecs = boundedIntOr(ctx, 'lockSecs', 60);
        return data(await svc.storage.rqHeadAndLock(queueId, limit, lockSecs));
    });

    router.add('GET', '/v2/request-queues/:queueId/requests', async (ctx, { queueId }) => {
        const svc = ctx.service;
        const { denied } = await guard(ctx, queueId, LEVEL_READ, STORAGE_RQ);
        if (denied) return denied;
        const items = await svc.storage.rqRequests(queueId);
        const { limit, offset } = parsePage(ctx);
        return data(pagedEnvelope(items, limit, offset));
    });

    router.add('POST', '/v2/request-queues/:queueId/requests', async (ctx, { queueId }) => {
        const svc = ctx.service;
        const { denied } = await guard(ctx, queueId, LEVEL_WRITE, STORAGE_RQ);
        if (denied) return denied;
        const body = await readJson(ctx);
        const forefront = ctx.query.get('forefront') === 'true';
        const result = await svc.storage.rqAddBatch(queueId, [body], forefront);
        const processed = result.processedRequests;
        if (processed.length) return data(processed[0], 201);
        const unprocessed = result.unprocessedRequests;
        const detail = unprocessed.length ? unprocessed[0] : body;
        return badRequest(`Could not add request: ${JSON.stringify(detail)}`);
    });

    router.add('POST', '/v2/request-queues/:queueId/requests/batch', async (ctx, { queueId }) => {
        const svc = ctx.service;
        const { denied } = await guard(ctx, queueId, LEVEL_WRITE, STORAGE_RQ);
        if (denied) return denied;
        const payload = await readJson(ctx);
        const requests = Array.isArray(payload) ? payload : [payload];
        const forefront = ctx.query.get('forefront') === 'true';
        const result = await svc.storage.rqAddBatch(queueId, requests, forefront);
        return data(result, 201);
    });

    router.add('DELETE', '/v2/request-queues/:queueId/requests/batch', async (ctx, { queueId }) => {
        const svc = ctx.service;
        const { denied } = await guard(ctx, queueId, LEVEL_WRITE, STORAGE_RQ);
        if (denied) return denied;
        const payload = await readJson(ctx);
        const requests = Array.isArray(payload) ? payload : [payload];
        return data(await svc.storage.rqBatchDelete(queueId, requests));
    });

    router.add('POST', '/v2/request-queues/:queueId/requests/unlock', async (ctx, { queueId }) => {
        const svc = ctx.service;
        const { denied } = await guard(ctx, queueId, LEVEL_WRITE, STORAGE_RQ);
        if (denied) return denied;
        const count = await svc.storage.rqUnlockAll(queueId);
        return data({ unlockedCount: count });
    });

    router.add('GET', '/v2/request-queues/:queueId/requests/:requestId', async (ctx, { queueId, requestId }) => {
        const svc = ctx.service;
        const { denied } = await guard(ctx, queueId, LEVEL_READ, STORAGE_RQ);
        if (denied) return denied;
        const found = await svc.storage.rqGetRequest(queueId, requestId);
        if (found === null) return notFound(`Request '${requestId}' was not found.`);
        return data(found);
    });

    router.add('PUT', '/v2/request-queues/:queueId/requests/:requestId', async (ctx, { queueId, requestId }) => {
        const svc = ctx.service;
        const { denied } = await guard(ctx, queueId, LEVEL_WRITE, STORAGE_RQ);
        if (denied) return denied;
        const body = await readJson(ctx);
        const forefront = ctx.query.get('forefront') === 'true';
        const result = await svc.storage.rqUpdateRequest(queueId, requestId, body, forefront);
        if (result === null) {
            return badRequest(`Request body must include a 'url' (and 'uniqueKey'): ${JSON.stringify(body)}`);
        }
        return data(result);
    });

    router.add('DELETE', '/v2/request-queues/:queueId/requests/:requestId', async (ctx, { queueId, requestId }) => {
        const svc = ctx.service;
        const { denied } = await guard(ctx, queueId, LEVEL_WRITE, STORAGE_RQ);
        if (denied) return denied;
        await svc.storage.rqDeleteRequest(queueId, requestId);
        return data({ id: requestId });
    });

    router.add('PUT', '/v2/request-queues/:queueId/requests/:requestId/lock', async (ctx, { queueId, requestId }) => {
        const svc = ctx.service;
        const { denied } = await guard(ctx, queueId, LEVEL_WRITE, STORAGE_RQ);
        if (denied) return denied;
        const lockSecs = boundedIntOr(ctx, 'lockSecs', 60);
        const result = await svc.storage.rqLockRequest(queueId, requestId, lockSecs);
        if (result === null) return notFound(`Request '${requestId}' was not found.`);
        return data(result);
    });

    router.add('DELETE', '/v2/request-queues/:queueId/requests/:requestId/lock', async (ctx, { queueId, requestId }) => {
        const svc = ctx.service;
        const { denied } = await guard(ctx, queueId, LEVEL_WRITE, STORAGE_RQ);
        if (denied) return denied;
        await svc.storage.rqDeleteRequestLock(queueId, requestId);
        return data({ id: requestId });
    });

    router.add('DELETE', '/v2/request-queues/:queueId', (ctx, { queueId }) =>
        deleteStorage(ctx, queueId, STORAGE_RQ));

    // -- access rights (sharing) ----------------------------------------------
    // Nested under each storage type; all three routes are owner-only (403
    // otherwise).
    for (const slug of ['key-value-stores', 'datasets', 'request-queues']) {
        router.add('POST', `/v2/${slug}/:storageId/access-rights`, async (ctx, { storageId }) => {
            const svc = ctx.service;
            const { storage, denied } = await ownerOrForbidden(ctx, storageId);
            if (denied) return denied;
            const body = await readJson(ctx);
            const grantee = body?.grantee;
            const level = body?.level;
            if (!grantee || (level !== LEVEL_READ && level !== LEVEL_WRITE)) {
                throw new HttpError(400, "Body must include 'grantee' and 'level' (READ or WRITE).");
            }
            svc.grantAccess(storageId, storage.type, grantee, level);
            return data({ resourceId: storageId, grantee, level }, 201);
        });

        router.add('GET', `/v2/${slug}/:storageId/access-rights`, async (ctx, { storageId }) => {
            const svc = ctx.service;
            const { denied } = await ownerOrForbidden(ctx, storageId);
            if (denied) return denied;
            const items = svc.listAccess(storageId).map((r) => ({ grantee: r.grantee, level: r.level }));
            return data({ total: items.length, count: items.length, items });
        });

        router.add('DELETE', `/v2/${slug}/:storageId/access-rights/:grantee`, async (ctx, { storageId, grantee }) => {
            const svc = ctx.service;
            const { denied } = await ownerOrForbidden(ctx, storageId);
            if (denied) return denied;
            svc.revokeAccess(storageId, grantee);
            return data({ resourceId: storageId, grantee });
        });
    }
}

/** Parse an optional positive-int query param with a plain default (no 400 contract). */
function boundedIntOr(ctx, key, defaultValue) {
    const raw = ctx.query.get(key);
    if (raw === null || raw === '') return defaultValue;
    const value = Number(raw);
    return Number.isInteger(value) ? value : defaultValue;
}

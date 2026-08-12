/**
 * Query-param parsing and slicing for the optional `limit`/`offset`
 * pagination shared by the four listing surfaces (dataset items, KV keys, RQ
 * requests, the per-user storage lists) and the pre-existing bounded-int
 * query params (the runs route's `memory`/`timeout`).
 */
import { HttpError } from './http.js';

function parseInt_(raw, key, minimum, message) {
    const value = Number(raw);
    if (!Number.isInteger(value) || String(raw).trim() === '') {
        throw new HttpError(400, `Query parameter '${key}' must be an integer.`);
    }
    if (value < minimum) {
        throw new HttpError(400, message);
    }
    return value;
}

/**
 * Parse an integer query param with a lower bound, or raise a 400 (never a
 * bare 500). A non-integer or out-of-range value is caller error, so it maps
 * to HTTP 400 in the Apify error shape. `minimum: 1` yields "must be
 * positive" semantics; `minimum: 0` yields "must not be negative" semantics.
 */
export function boundedInt(query, key, defaultValue, minimum, message) {
    const raw = query.get(key);
    if (raw === null || raw === '') return defaultValue;
    return parseInt_(raw, key, minimum, message);
}

/**
 * Return `{limit, offset}` from the query string, each `null` when absent --
 * "absent" stays distinguishable from any concrete integer, including `0`,
 * so callers can tell "keep today's unpaginated behaviour" apart from "an
 * explicit zero". Shared by every listing surface that supports optional
 * `limit`/`offset` slicing so "both omitted" -- the byte-for-byte-unchanged
 * contract every non-console caller relies on -- is decided identically
 * everywhere.
 */
export function parsePage(ctx) {
    const optional = (key) => {
        const raw = ctx.query.get(key);
        if (raw === null || raw === '') return null;
        return parseInt_(raw, key, 0, `Query parameter '${key}' must not be negative.`);
    };
    return { limit: optional('limit'), offset: optional('offset') };
}

/**
 * Slice `items` by `(limit, offset)`: an absent `offset` defaults to 0; an
 * absent `limit` means "no cap", matching the real API's own documented
 * dataset-items default.
 */
export function paginate(items, limit, offset) {
    const start = offset ?? 0;
    return limit !== null && limit !== undefined ? items.slice(start, start + limit) : items.slice(start);
}

/**
 * Build the `{items, count, limit, ...}` envelope shared by RQ requests
 * (bare and paginated alike) and KV keys' own `offset`-sliced path.
 *
 * A bare request (`limit` and `offset` both absent) returns every item
 * unsliced, with `limit` echoing the slice's own length -- the SAME key
 * order (`items, count, limit, ...`) each surface's response had before
 * optional pagination existed, so a bare request stays byte-for-byte
 * identical, key order included. Supplying either adds an additive `total`
 * field, appended last so it never disturbs that order. `extra` (e.g. KV
 * keys' offset-mode `isTruncated`) is merged in right after `limit`.
 */
export function pagedEnvelope(items, limit, offset, extra = {}) {
    const paginated = limit !== null || offset !== null;
    const page = paginated ? paginate(items, limit, offset) : items;
    const envelope = { items: page, count: page.length };
    envelope.limit = limit !== null ? limit : page.length;
    Object.assign(envelope, extra);
    if (paginated) envelope.total = items.length;
    return envelope;
}

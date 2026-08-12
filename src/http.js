/**
 * Minimal HTTP layer: a tiny first-match-wins router over `node:http`, the
 * public-Apify-style response envelope / error shapes, and request-body
 * reading with transparent gzip/brotli decompression.
 *
 * Handlers receive a request context (`ctx`) and RETURN a plain response
 * descriptor (`{status, headers, body|stream}`), so cross-cutting layers --
 * CORS, the upstream-fallback proxy -- can inspect and replace a response
 * before anything is written to the wire (the same shape FastAPI middleware
 * gave the Python predecessor).
 */
import zlib from 'node:zlib';

/** Caller error carrying an HTTP status; 400s render the invalid-request envelope. */
export class HttpError extends Error {
    constructor(status, detail) {
        super(detail);
        this.status = status;
    }
}

/**
 * Response descriptor. `headers` is a LIST of [name, value] pairs -- not an
 * object -- so repeated header names (e.g. multiple Set-Cookie) survive all
 * the way to the wire. `body` is a string/Buffer; `stream` (an async
 * iterable of chunks) takes precedence when set and is written chunked.
 */
export function response({ status = 200, headers = [], body = null, stream = null }) {
    return { status, headers, body, stream };
}

export function jsonResponse(payload, status = 200, headers = []) {
    return response({
        status,
        headers: [['content-type', 'application/json'], ...headers],
        body: JSON.stringify(payload ?? null),
    });
}

export function textResponse(text, status = 200, headers = [], mediaType = 'text/plain') {
    return response({
        status,
        headers: [['content-type', `${mediaType}; charset=utf-8`], ...headers],
        body: text,
    });
}

export function data(payload, status = 200) {
    return jsonResponse({ data: payload }, status);
}

function errorEnvelope(type, message, status) {
    return jsonResponse({ error: { type, message } }, status);
}

export function badRequest(message = 'The request is not valid.') {
    return errorEnvelope('invalid-request', message, 400);
}

export function notFound(message = 'We did not find the resource you were looking for.') {
    return errorEnvelope('record-not-found', message, 404);
}

export function forbidden(message = 'You do not have permission to perform this action.') {
    return errorEnvelope('insufficient-permissions', message, 403);
}

export function conflict(message = 'A resource with this id already exists.') {
    return errorEnvelope('resource-conflict', message, 409);
}

export function unauthorized(message = 'The provided API token is not valid.') {
    return errorEnvelope('invalid-token', message, 401);
}

export function standbyUnavailable(message = 'The standby Actor did not become ready in time.') {
    return errorEnvelope('actor-standby-unavailable', message, 503);
}

/**
 * An infrastructure/driver failure while launching a standby container --
 * distinct from `notFound` ("no successful build") and from
 * `standbyUnavailable` ("started but never became ready"): here the container
 * never even started, for a reason that has nothing to do with whether the
 * Actor id or its build exist. 500-family, not 404, so a developer isn't
 * misled into thinking they need to push a new build.
 */
export function standbyStartFailed(message = 'The standby Actor failed to start.') {
    return errorEnvelope('actor-standby-start-failed', message, 500);
}

/**
 * Read the raw request body bytes exactly as they arrived on the wire
 * (still compressed if they were). Cached, so the upstream-fallback layer's
 * pre-read and a handler's own read see the same bytes.
 */
export async function readRawBody(ctx) {
    if (ctx._rawBody !== undefined) return ctx._rawBody;
    const chunks = [];
    for await (const chunk of ctx.req) {
        chunks.push(chunk);
    }
    ctx._rawBody = Buffer.concat(chunks);
    return ctx._rawBody;
}

/**
 * Read the request body, transparently decompressing it if needed.
 *
 * apify-client sends some payloads (e.g. the Actor version source files)
 * with `Content-Encoding: gzip`, and the SDK's own internal API client sends
 * storage writes with `Content-Encoding: br` (Brotli). A body that claims
 * one of these encodings but is malformed yields a 400, not a bare 500.
 */
export async function readBody(ctx) {
    const raw = await readRawBody(ctx);
    if (!raw.length) return raw;
    const encoding = (ctx.headers['content-encoding'] ?? '').toLowerCase();
    if (encoding.includes('br')) {
        try {
            return zlib.brotliDecompressSync(raw);
        } catch (err) {
            throw new HttpError(400, `Malformed brotli request body: ${err.message}`);
        }
    }
    if (encoding.includes('gzip')) {
        try {
            return zlib.gunzipSync(raw);
        } catch (err) {
            throw new HttpError(400, `Malformed gzip request body: ${err.message}`);
        }
    }
    return raw;
}

export async function readJson(ctx) {
    const body = await readBody(ctx);
    if (!body.length) return {};
    try {
        return JSON.parse(body.toString('utf8'));
    } catch (err) {
        throw new HttpError(400, `Malformed JSON request body: ${err.message}`);
    }
}

/**
 * First-match-wins router. Patterns are `/`-separated with `:name` params
 * (one decoded segment) and a trailing `*name` catch-all (the rest of the
 * path, decoded per segment). Registration order decides precedence, exactly
 * like the route-include order in the FastAPI predecessor.
 */
export class Router {
    constructor() {
        /** @type {{method: string, segments: string[], handler: Function}[]} */
        this.routes = [];
    }

    add(methods, pattern, handler) {
        const segments = pattern.split('/').filter((s, i) => i !== 0 || s !== '');
        for (const method of Array.isArray(methods) ? methods : [methods]) {
            this.routes.push({ method: method.toUpperCase(), segments, handler });
        }
    }

    /**
     * Match `method` + decoded path segments; returns `{handler, params}` or
     * null. A HEAD request also matches GET routes (mirroring Starlette,
     * which serves HEAD from every GET route); the server layer strips the
     * body from the written response.
     */
    match(method, pathSegments) {
        for (const route of this.routes) {
            if (route.method !== method && !(method === 'HEAD' && route.method === 'GET')) continue;
            const params = matchSegments(route.segments, pathSegments);
            if (params !== null) return { handler: route.handler, params, explicit: route.method === method };
        }
        return null;
    }
}

function matchSegments(patternSegments, pathSegments) {
    const params = {};
    for (let index = 0; index < patternSegments.length; index += 1) {
        const pattern = patternSegments[index];
        if (pattern.startsWith('*')) {
            params[pattern.slice(1)] = pathSegments.slice(index).join('/');
            return params;
        }
        const segment = pathSegments[index];
        if (segment === undefined) return null;
        if (pattern.startsWith(':')) {
            params[pattern.slice(1)] = segment;
        } else if (pattern !== segment) {
            return null;
        }
    }
    return patternSegments.length === pathSegments.length ? params : null;
}

/**
 * Split a RAW request path into decoded segments. Splitting happens BEFORE
 * decoding, so a percent-encoded `/` (`%2F`) inside a segment (e.g. a KV
 * record key) stays within its segment instead of splitting the path.
 */
export function decodePathSegments(rawPath) {
    return rawPath
        .split('/')
        .slice(1)
        .map((segment) => {
            try {
                return decodeURIComponent(segment);
            } catch {
                return segment;
            }
        });
}

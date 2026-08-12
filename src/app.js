/**
 * Application factory: wires the router, the service (DB + storage + driver)
 * and the cross-cutting layers (CORS, upstream fallback, error envelopes)
 * into a single `node:http` request listener served on both ports.
 */
import fsp from 'node:fs/promises';

import { InvalidTokenError } from './auth.js';
import { loadSettings } from './config.js';
import { Database } from './db.js';
import {
    HttpError,
    Router,
    badRequest,
    decodePathSegments,
    jsonResponse,
    notFound,
    readRawBody,
    response,
    unauthorized,
} from './http.js';
import { registerActorRoutes, registerMeRoutes } from './routes/actors.js';
import { registerConsoleRoutes } from './routes/console.js';
import { registerRuntimeConfigRoutes } from './routes/runtime-config.js';
import { registerActorRunRoutes, registerFlatRunRoutes } from './routes/runs.js';
import { registerStandbyRoutes } from './routes/standby.js';
import { registerStorageRoutes } from './routes/storages.js';
import { registerUserRoutes } from './routes/users.js';
import { Service } from './service.js';
import { Storage } from './storage.js';
import { fetchUpstreamFallback, isAllowlisted } from './upstream.js';

// Exposed so a cross-origin browser caller (the shipped console is
// same-origin and unaffected) can actually read the pagination headers
// dataset-items responses carry -- the browser hides any response header not
// explicitly listed here.
const CORS_EXPOSE_HEADERS = [
    'X-Apify-Pagination-Offset',
    'X-Apify-Pagination-Count',
    'X-Apify-Pagination-Total',
    'X-Apify-Pagination-Limit',
    'X-Apify-Pagination-Desc',
].join(', ');

export function buildRouter() {
    const router = new Router();
    // /v2/users/me + its aggregates, then user management (list / create),
    // then the public per-user profile lookup (inside registerMeRoutes,
    // after every `me` route).
    registerUserRoutes(router);
    registerMeRoutes(router);
    // Actor + version + build-trigger + start-run endpoints, under both
    // spellings (the CLI uses /v2/actors).
    for (const prefix of ['/v2/acts', '/v2/actors']) {
        registerActorRoutes(router, prefix);
        registerActorRunRoutes(router, prefix);
    }
    // Flat resources and storages.
    registerFlatRunRoutes(router);
    registerStandbyRoutes(router);
    registerStorageRoutes(router);
    // Global fallback toggle.
    registerRuntimeConfigRoutes(router);
    // Console SPA -- its catch-all is registered last so it never shadows
    // the API.
    registerConsoleRoutes(router);
    return router;
}

/**
 * Create the runtime application.
 *
 * Performs the boot sequence the FastAPI predecessor ran in its lifespan:
 * data dirs, metadata DB, storage backend, the Docker driver's network
 * setup, stale-job reconciliation and the standby watchdog. Returns
 * `{service, settings, handler, close}` where `handler` is a `node:http`
 * request listener servable on any number of ports.
 */
export async function createApp({ settings = null, driver = null } = {}) {
    settings = settings ?? loadSettings();

    await fsp.mkdir(settings.dataDir, { recursive: true });
    await fsp.mkdir(settings.runsDir, { recursive: true });
    await fsp.mkdir(settings.buildsDir, { recursive: true });

    const db = new Database(settings.metaPath);
    const storage = new Storage(settings.storageDir);

    let drv = driver;
    if (drv === null) {
        const { DockerDriver } = await import('./driver.js');
        drv = new DockerDriver({ networkName: settings.networkName });
    }
    // Create (if absent) the shared network and self-attach under the
    // container-facing alias; guarded no-op when not running as a container.
    await drv.ensureNetwork();

    const service = new Service(settings, db, storage, drv);
    // Sweep any build/run rows left RUNNING by a previous unclean shutdown.
    await service.reconcileStaleJobs();
    // Background idle-reap loop for warm standby runs.
    service.startStandbyWatchdog();

    const router = buildRouter();

    /** Route the request and map thrown errors to envelope responses. */
    async function dispatch(ctx) {
        const match = router.match(ctx.method, ctx.segments);
        if (!match) return notFound();
        try {
            return await match.handler(ctx, match.params);
        } catch (err) {
            if (err instanceof InvalidTokenError) return unauthorized();
            if (err instanceof HttpError) {
                // Reshape a plain 400 into this app's own `{"error": {...}}`
                // envelope, matching every other 4xx this API returns. Any
                // OTHER status code -- none raised via HttpError today --
                // falls through as a plain JSON detail.
                if (err.status === 400) return badRequest(err.message);
                return jsonResponse({ detail: err.message }, err.status);
            }
            console.error(`Unhandled error on ${ctx.method} ${ctx.path}:`, err);
            return jsonResponse({ error: { type: 'internal-error', message: String(err?.message ?? err) } }, 500);
        }
    }

    async function handle(ctx) {
        // CORS preflight (allow everything, like the predecessor's
        // allow_origins=["*"] CORSMiddleware).
        if (ctx.method === 'OPTIONS' && ctx.headers['access-control-request-method']) {
            return response({
                status: 204,
                headers: [
                    ['access-control-allow-origin', '*'],
                    ['access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS'],
                    ['access-control-allow-headers', ctx.headers['access-control-request-headers'] ?? '*'],
                    ['access-control-max-age', '600'],
                ],
            });
        }

        // Upstream fallback: read (and thereby cache) the body up front,
        // scoped to the allowlisted+enabled branch only, so every other
        // request pays nothing. Many handlers on this allowlist 404 from a
        // denied ownership/existence check BEFORE ever reading the body
        // themselves; reading it here is the only way to still have the
        // caller's actual body available to forward upstream. `readRawBody`
        // caches, so the handler's own read sees the same bytes.
        const fallbackEligible = service.upstreamFallbackEnabled && isAllowlisted(ctx.path);
        let rawBody = null;
        if (fallbackEligible) {
            rawBody = await readRawBody(ctx);
        }

        let result = await dispatch(ctx);

        if (fallbackEligible && result.status === 404 && service.upstreamFallbackEnabled) {
            const fallback = await fetchUpstreamFallback(ctx, rawBody);
            if (fallback !== null) result = fallback;
        }

        // CORS response headers on every response -- including a relayed
        // upstream reply, which is a brand-new response and must still get
        // them.
        result.headers = [
            ...result.headers,
            ['access-control-allow-origin', '*'],
            ['access-control-expose-headers', CORS_EXPOSE_HEADERS],
        ];
        return result;
    }

    /** The `node:http` request listener. */
    function handler(req, res) {
        const url = new URL(req.url, 'http://placeholder');
        const host = req.headers.host ?? 'localhost';
        const ctx = {
            req,
            method: req.method,
            rawUrl: req.url,
            path: decodeURIComponent(url.pathname),
            segments: decodePathSegments(url.pathname),
            query: url.searchParams,
            headers: req.headers,
            baseUrl: `http://${host}`,
            service,
            settings,
        };
        handle(ctx)
            .then(async (result) => {
                writeHead(res, result);
                if (req.method === 'HEAD') {
                    res.end();
                    if (result.stream) await drainStream(result.stream);
                    return;
                }
                if (result.stream) {
                    try {
                        for await (const chunk of result.stream) {
                            res.write(chunk);
                            // flush eagerly -- streamed logs/standby responses
                            // must reach the client as they are produced.
                            res.flushHeaders?.();
                        }
                    } catch {
                        // upstream died mid-stream; close what we have
                    }
                    res.end();
                } else {
                    res.end(result.body ?? '');
                }
            })
            .catch((err) => {
                console.error('Request handling failed:', err);
                if (!res.headersSent) {
                    res.writeHead(500, { 'content-type': 'application/json' });
                }
                res.end(JSON.stringify({ error: { type: 'internal-error', message: 'Internal error.' } }));
            });
    }

    async function close() {
        service.stopStandbyWatchdog();
        await service.waitIdle();
    }

    return { service, settings, db, storage, driver: drv, handler, close };
}

function writeHead(res, result) {
    // Group repeated header names into arrays so node writes each occurrence
    // as its own header line (e.g. multiple Set-Cookie headers).
    const grouped = new Map();
    for (const [name, value] of result.headers) {
        const key = name.toLowerCase();
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key).push(value);
    }
    for (const [name, values] of grouped) {
        res.setHeader(name, values.length === 1 ? values[0] : values);
    }
    res.statusCode = result.status;
}

async function drainStream(stream) {
    try {
        // eslint-disable-next-line no-unused-vars
        for await (const _chunk of stream) {
            // discard -- HEAD responses carry no body
        }
    } catch {
        // ignore
    }
}

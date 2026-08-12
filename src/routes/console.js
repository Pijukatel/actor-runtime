/** Serves the static console single-page app. */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { notFound, response } from '../http.js';

const CONSOLE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'console');

// Without an explicit Cache-Control, browsers apply HEURISTIC caching to
// these static files and can keep serving a stale app.js for hours after the
// runtime image was rebuilt with new console code. `no-cache` means
// "revalidate before every use", so the console always picks up a rebuilt
// image without hard refreshes.
const NO_CACHE = [['cache-control', 'no-cache']];

// First path segment of every client route the SPA owns. A deep link or
// refresh to any of these must render the app shell (index.html), so the
// browser can run the client router. Anything else is not a console route.
const SPA_PREFIXES = new Set(['actors', 'storage', 'users']);

async function serveFile(fileName, mediaType) {
    const body = await fsp.readFile(path.join(CONSOLE_DIR, fileName));
    return response({
        status: 200,
        headers: [['content-type', mediaType], ...NO_CACHE],
        body,
    });
}

export function registerConsoleRoutes(router) {
    router.add('GET', '/', () => serveFile('index.html', 'text/html; charset=utf-8'));
    router.add('GET', '/console', () => serveFile('index.html', 'text/html; charset=utf-8'));
    router.add('GET', '/console/app.js', () => serveFile('app.js', 'application/javascript'));
    router.add('GET', '/console/input_tab.js', () => serveFile('input_tab.js', 'application/javascript'));
    router.add('GET', '/console/storage_tab.js', () => serveFile('storage_tab.js', 'application/javascript'));

    /**
     * Serve the SPA shell for client-side routes so deep links / refreshes
     * work.
     *
     * Registered LAST, so it only sees paths no earlier route -- every
     * `/v2/*` API route, `/`, `/console`, and the console assets -- matched.
     * It serves `index.html` ONLY for a GET to the SPA's own top-level
     * prefixes (an allowlist on the first path segment); every other
     * unmatched path is a normal API 404 in the Apify envelope, so the
     * catch-all never shadows the API surface.
     *
     * It matches all common methods (not just GET) so an unknown path
     * answers a uniform 404 regardless of verb.
     */
    router.add(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], '/*fullPath', async (ctx, { fullPath }) => {
        const first = fullPath.split('/', 1)[0];
        if (ctx.method === 'GET' && SPA_PREFIXES.has(first)) {
            return serveFile('index.html', 'text/html; charset=utf-8');
        }
        return notFound();
    });
}

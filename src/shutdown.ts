/**
 * Graceful shutdown, factored out of `index.ts` so it is directly testable without invoking `main()`'s
 * `process.exit`. See `closeServer`'s doc comment for why closing the two HTTP listeners can't simply be
 * a bare `await new Promise((resolve) => server.close(resolve))`.
 */
import type { Server } from 'node:http';

import { flushAllLogs, stopLogFlusher } from './services/logs.js';
import { releaseAllBuffersForShutdown } from './storage/request-queue/registry.js';
import { shutdownStorage } from './storage/bootstrap.js';

/**
 * Closes an HTTP server without waiting on any response it is still holding open - `GET
 * /v2/logs/:id?stream=true` (`api/routes/logs.ts`) deliberately keeps a chunked response open for the
 * life of a build/run, and Node's `server.close()` callback does not fire while any connection (kept
 * alive by such a response) remains open. `closeAllConnections()` (Node >=18.2, available here on
 * Node 22) forcibly destroys every open socket right after `close()` stops accepting new ones, which is
 * what makes `close()`'s callback - and therefore this promise - resolve promptly regardless of what a
 * client happens to still be streaming.
 */
export function closeServer(server: Server): Promise<void> {
	return new Promise<void>((resolve) => {
		server.close(() => resolve());
		server.closeAllConnections();
	});
}

export interface ShutdownDeps {
	apiServer: Server;
	consoleServer: Server;
	/** Optional so this stays a no-churn addition for every existing caller/test that builds
	 * `ShutdownDeps` without it. MUST be closed - see `gracefulShutdown`'s own doc comment - BEFORE
	 * `closeServer(apiServer)` is awaited, never after: unlike a `?stream=true` log response (an ordinary
	 * HTTP connection `closeServer`'s own `closeAllConnections()` genuinely does forcibly end), an
	 * already-upgraded websocket socket is not something `closeAllConnections()` reaches at all
	 * (`attachEventsWebSocket`'s `EventsWebSocketServer.close()` doc comment has the full evidence) - so a
	 * live events-websocket client left open when `closeServer(apiServer)` is awaited hangs it forever,
	 * not just delays it. */
	eventsWebSocketServer?: { close(): void };
}

/**
 * Flush logs, reclaim outstanding request-queue buffers, close both HTTP listeners (promptly, per
 * `closeServer` above), then tear down storage. `shutdownStorage()` - which flushes every open request
 * queue's native state (`storage/bootstrap.ts`) - must always run on a graceful shutdown; sequencing it
 * behind a listener `close()` that can block indefinitely (the previous bug) meant it never did while a
 * `apify push`/`apify call` log stream was open, which is the common case, not the edge case.
 *
 * `eventsWebSocketServer?.close()` runs BEFORE `closeServer(apiServer)`, deliberately - not after, as an
 * earlier version of this function had it. `closeServer(apiServer)`'s own `server.close()` callback (see
 * its doc comment) waits for every connection the server still holds - including an already-upgraded
 * websocket socket - to actually end; `closeAllConnections()` does not reach those (verified against
 * Node's own source, `EventsWebSocketServer.close()`'s doc comment), so with the old ordering a single
 * still-connected events-websocket client (the ordinary case now that `ACTOR_EVENTS_WEBSOCKET_URL` is set
 * on every run and neither SDK ever disconnects mid-run on its own) hung this function - and therefore the
 * whole shutdown, `shutdownStorage()` included - indefinitely. Terminating those sockets first, before
 * `apiServer`'s own connection count is ever asked to reach zero, is what lets `closeServer(apiServer)`
 * resolve promptly regardless.
 */
export async function gracefulShutdown({
	apiServer,
	consoleServer,
	eventsWebSocketServer,
}: ShutdownDeps): Promise<void> {
	stopLogFlusher();
	await flushAllLogs();
	await releaseAllBuffersForShutdown();
	eventsWebSocketServer?.close();
	await closeServer(apiServer);
	await closeServer(consoleServer);
	await shutdownStorage();
}

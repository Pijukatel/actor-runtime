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
	 * `ShutdownDeps` without it. MUST be closed before `closeServer(apiServer)` is awaited, never after -
	 * see `EventsWebSocketServer.close()`'s own doc comment (`api/events-ws.ts`) for why
	 * `closeAllConnections()` cannot do this itself. */
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
 * earlier version of this function had it - because `closeServer(apiServer)` would otherwise hang
 * indefinitely on any still-connected events-websocket client. See `EventsWebSocketServer.close()`'s own
 * doc comment (`api/events-ws.ts`) for why `closeAllConnections()` cannot do this itself.
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

/**
 * The events websocket: `GET /actor-runtime/events/:runId`, upgraded on the API server directly
 * (Express does not handle `upgrade`). Unauthenticated by decision - cross-run isolation is structural,
 * since the path's `:runId` is the only thing this handler scopes on and there is no broadcast listener.
 * Rejections complete the upgrade and then close `1008`: refusing the handshake would abort a Python
 * Actor at `Actor.init()`.
 */
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';

import { getRunById } from '../services/runs.js';
import { isTerminalJobStatus } from '../services/job-status.js';
import { isEventsTerminal, subscribeEvents } from '../services/events-channel.js';
import { pollUntilTerminal } from './poll-until-terminal.js';

// A trailing slash is a different path, not a second spelling of this one.
const EVENTS_PATH_PATTERN = /^\/actor-runtime\/events\/([^/]+)$/;

/** Mirrors `api/routes/logs.ts`'s poll cadence. */
const TERMINAL_POLL_INTERVAL_MS = 250;

export interface EventsWebSocketServer {
	/**
	 * Stops accepting upgrades and terminates every open connection. Not redundant with
	 * `closeServer(apiServer)`: neither Node's `closeAllConnections()` nor `wss.close()` ends an
	 * already-upgraded socket, so without this a connected Actor hangs graceful shutdown indefinitely.
	 */
	close(): void;
}

function extractRunId(pathname: string): string | undefined {
	return EVENTS_PATH_PATTERN.exec(pathname)?.[1];
}

/**
 * An unknown or already-terminal run is closed `1008`; a live run is subscribed to its own frames and
 * closed `1000` once it ends. A healthy connection is never closed for any other reason.
 */
async function handleConnection(ws: WebSocket, runId: string): Promise<void> {
	// Must come first: an `'error'` with no listener crashes the process, and any client can provoke one
	// on this unauthenticated socket. `ws` still emits `'close'` after it, so teardown below is unaffected.
	ws.on('error', () => undefined);

	const run = await getRunById(runId);
	if (!run) {
		ws.close(1008, `Unknown run id: ${runId}`);
		return;
	}
	if (isTerminalJobStatus(run.status)) {
		ws.close(1008, `Run ${runId} has already ended`);
		return;
	}

	const unsubscribe = subscribeEvents(runId, (frame) => {
		if (ws.readyState === ws.OPEN) ws.send(frame);
	});

	const poller = pollUntilTerminal({
		intervalMs: TERMINAL_POLL_INTERVAL_MS,
		isTerminal: () => isEventsTerminal(runId),
		refetch: () => getRunById(runId),
		onTerminal: () => {
			unsubscribe();
			if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close(1000, `Run ${runId} has ended`);
		},
	});

	ws.on('close', () => {
		poller.stop();
		unsubscribe();
	});
}

/** Registers the upgrade handler on the API server and returns a handle shutdown can close. */
export function attachEventsWebSocket(server: Server): EventsWebSocketServer {
	const wss = new WebSocketServer({ noServer: true });

	server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
		const pathname = req.url ? new URL(req.url, 'http://localhost').pathname : undefined;
		const runId = pathname ? extractRunId(pathname) : undefined;
		if (!runId) {
			// Not this endpoint's path, and this is the server's only 'upgrade' listener.
			socket.destroy();
			return;
		}

		wss.handleUpgrade(req, socket, head, (ws) => {
			// Contains an unexpected rejection to this one connection; unhandled, it would kill the process.
			void handleConnection(ws, runId).catch(() => {
				ws.terminate();
			});
		});
	});

	return {
		close() {
			for (const client of wss.clients) client.terminate();
			wss.close();
		},
	};
}

/**
 * The events websocket: `GET /actor-runtime/events/:runId`, upgraded directly on the API server's own
 * `http.Server` via `server.on('upgrade', ...)` - Express never sees this request at all (Express does
 * not handle the `upgrade` event), so this lives entirely outside the `/v2`/`/actor-runtime` router chain
 * in `api/server.ts` and is reachable at exactly one path, never the `/v2/actor-runtime/*` alias the rest
 * of that namespace also answers on.
 *
 * **No authentication** (human-approved decision, `2-design.md` decision 3): a single-operator local dev
 * tool has no user to protect this endpoint from, and the actual hard requirement - one container must
 * never see another's telemetry - is met structurally, not by a credential. The path's `:runId` is the
 * only thing a connecting container can present, and it is also the only thing this handler scopes on:
 * resolving the run by that id alone and subscribing only to *that run's own* entry in
 * `events-channel.ts`'s per-run map is what makes cross-run isolation structural rather than a permission
 * check - there is no broadcast/all-runs listener anywhere for a mis-scoped subscription to even land in.
 *
 * **Rejections close the socket, they never refuse the handshake.** apify-sdk-python treats a failed
 * first connection *attempt* as fatal (`Actor.init()` raises), so answering an unknown/terminal run id
 * with a non-101 HTTP status would abort the whole Actor before it even starts. Completing the upgrade
 * and closing with `1008` right after leaves the Actor running - one error logged, no further reconnect
 * attempts (`1008`/`POLICY_VIOLATION` is in apify-sdk-python's own non-retryable set).
 */
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';

import { getRunById } from '../services/runs.js';
import { isTerminalJobStatus } from '../services/job-status.js';
import { isEventsTerminal, subscribe } from '../services/events-channel.js';

const EVENTS_PATH_PATTERN = /^\/actor-runtime\/events\/([^/]+)\/?$/;

/** Mirrors `api/routes/logs.ts`'s `serveLog` poll cadence, for the same purpose: noticing a run has gone
 * terminal without needing this connection to be the thing `markTerminal` reaches into directly (see
 * `events-channel.ts`'s doc comment on `markTerminal` - it flips a flag, it never touches a socket). */
const TERMINAL_POLL_INTERVAL_MS = 250;

export interface EventsWebSocketServer {
	/** Stops accepting new upgrades. Deliberately does not touch already-open sockets - `shutdown.ts`'s
	 * `closeServer(apiServer)` (via Node's `closeAllConnections()`, which explicitly also tears down
	 * upgraded connections) is what forcibly drops those on a graceful shutdown, exactly as it already
	 * drops any open `?stream=true` log response (`2-design.md`'s risk note on this). */
	close(): void;
}

function extractRunId(pathname: string): string | undefined {
	return EVENTS_PATH_PATTERN.exec(pathname)?.[1];
}

/**
 * Handles one already-upgraded connection for `runId`: an unknown or already-terminal run gets closed
 * with `1008` and a reason string immediately; a live run is subscribed to that run's own frames and
 * polled (see `TERMINAL_POLL_INTERVAL_MS`) for reaching a terminal state, closing `1000` once it does.
 * Never closes a healthy, still-live connection for any other reason - the only two closes this function
 * ever issues are exactly those two.
 */
async function handleConnection(ws: WebSocket, runId: string): Promise<void> {
	const run = await getRunById(runId);
	if (!run) {
		ws.close(1008, `Unknown run id: ${runId}`);
		return;
	}
	if (isTerminalJobStatus(run.status)) {
		ws.close(1008, `Run ${runId} has already ended`);
		return;
	}

	const unsubscribe = subscribe(runId, (frame) => {
		// A frame published between this connection's own terminal check (below) and the socket actually
		// closing must never be sent to an already-closing/closed socket.
		if (ws.readyState === ws.OPEN) ws.send(frame);
	});

	const finish = (): void => {
		clearInterval(poll);
		unsubscribe();
		if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close(1000, `Run ${runId} has ended`);
	};

	// Guarded against overlapping ticks the same way `serveLog`'s poll is: the persisted-record re-check
	// is async, and a slow read must not let a second tick pile another one on top of it.
	let checkingRecord = false;
	const poll = setInterval(() => {
		if (isEventsTerminal(runId)) {
			finish();
			return;
		}
		if (checkingRecord) return;
		checkingRecord = true;
		getRunById(runId)
			.then((current) => {
				if (!current || isTerminalJobStatus(current.status)) finish();
			})
			.catch(() => undefined)
			.finally(() => {
				checkingRecord = false;
			});
	}, TERMINAL_POLL_INTERVAL_MS);

	ws.on('close', () => {
		clearInterval(poll);
		unsubscribe();
	});
}

/**
 * Registers the upgrade handler on `server` and returns a handle `index.ts`/`shutdown.ts` can close.
 * `noServer: true` because this `WebSocketServer` never listens on its own - it only ever handles the
 * `upgrade` event this function itself subscribes to on the given `http.Server`, the same one
 * `apiApp.listen()` already returned.
 */
export function attachEventsWebSocket(server: Server): EventsWebSocketServer {
	const wss = new WebSocketServer({ noServer: true });

	server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
		const pathname = req.url ? new URL(req.url, 'http://localhost').pathname : undefined;
		const runId = pathname ? extractRunId(pathname) : undefined;
		if (!runId) {
			// Not this endpoint's path at all - there is exactly one 'upgrade' listener on this server, so
			// an unmatched path has nothing else to hand the socket to.
			socket.destroy();
			return;
		}

		wss.handleUpgrade(req, socket, head, (ws) => {
			void handleConnection(ws, runId);
		});
	});

	return {
		close() {
			wss.close();
		},
	};
}

/**
 * The events websocket: `GET /actor-runtime/events/:runId`, upgraded directly on the API server's own
 * `http.Server` via `server.on('upgrade', ...)` - Express never sees this request at all (Express does
 * not handle the `upgrade` event), so this lives entirely outside the `/v2`/`/actor-runtime` router chain
 * in `api/server.ts` and is reachable at exactly one path, never the `/v2/actor-runtime/*` alias the rest
 * of that namespace also answers on.
 *
 * **No authentication** (a deliberate decision, not an oversight - see `requirements/api.md`'s "No
 * authentication at all" note on this endpoint): a single-operator local dev tool has no user to protect
 * this endpoint from, and the actual hard requirement - one container must
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
import { isEventsTerminal, subscribeEvents } from '../services/events-channel.js';
import { pollUntilTerminal } from './poll-until-terminal.js';

// Never matches a trailing-slash spelling (`requirements/api.md`'s "reachable at exactly this one path" -
// taken literally: `/actor-runtime/events/<id>/` is a different path, not a second spelling of this one).
const EVENTS_PATH_PATTERN = /^\/actor-runtime\/events\/([^/]+)$/;

/** Mirrors `api/routes/logs.ts`'s `serveLog` poll cadence, for the same purpose: noticing a run has gone
 * terminal without needing this connection to be the thing `markEventsTerminal` reaches into directly (see
 * `events-channel.ts`'s doc comment on `markEventsTerminal` - it flips a flag, it never touches a socket). */
const TERMINAL_POLL_INTERVAL_MS = 250;

export interface EventsWebSocketServer {
	/**
	 * Stops accepting new upgrades AND forcibly drops every currently-open connection this server is
	 * holding, via `.terminate()` on each of `wss.clients`.
	 *
	 * This is NOT redundant with `shutdown.ts`'s `closeServer(apiServer)` - Node's own
	 * `server.closeAllConnections()` does not reach an already-upgraded websocket socket at all. Verified
	 * against Node 22's actual `http.Server.prototype.closeAllConnections` source and against a live
	 * `ws`/`http` repro: once `wss.handleUpgrade` completes, the socket is handed off to `ws` and is no
	 * longer one `closeAllConnections()` destroys, so it also stays open when `ws`'s own
	 * `WebSocketServer.close()` (in `noServer` mode) is called - that method only waits for `clients.size`
	 * to reach 0, it never forces a client closed either. Left unfixed, a single still-connected
	 * events-websocket client (the ordinary case, since `ACTOR_EVENTS_WEBSOCKET_URL` is now set on every
	 * run and neither SDK ever disconnects on its own mid-run) hangs `closeServer(apiServer)` indefinitely -
	 * its `server.close()` callback waits for every connection the server still holds, upgraded ones
	 * included, to actually end. Calling THIS method - which is what actually ends them - before awaiting
	 * `closeServer(apiServer)` is what makes that promise resolve promptly instead (`shutdown.ts`'s
	 * `gracefulShutdown`).
	 */
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
	// MUST be attached before anything else here (including before the `getRunById`/terminal checks below
	// settle): a protocol-level fault on this unauthenticated, network-reachable socket fires `'error'`
	// synchronously with no listener otherwise attached, which would crash this whole process (verified
	// against the installed `ws` package). `ws` emits `'close'` right after `'error'` regardless
	// (`emitErrorAndClose`, `ws/lib/websocket.js`), so the `'close'` listener below still runs its normal
	// teardown - there is nothing more to do here than swallow the error itself.
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
		// A frame published between this connection's own terminal check (below) and the socket actually
		// closing must never be sent to an already-closing/closed socket.
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
			// `handleConnection` already contains every *expected* failure mode itself (unknown/terminal
			// run both resolve normally, into a `ws.close(1008, ...)`); this `.catch()` is only for a
			// genuinely unexpected rejection (e.g. a transient storage error out of `getRunById`), which
			// would otherwise become an unhandled promise rejection - fatal to the whole process under
			// Node's default `--unhandled-rejections` mode, the same class of process-wide blast radius as
			// the unhandled `'error'`-event case above, just via a different mechanism. `.terminate()`
			// (not `.close()`) because whatever broke here means this connection cannot be trusted to still
			// be in a state where a clean close handshake is possible - it contains the fault to this one
			// connection, never the process.
			void handleConnection(ws, runId).catch(() => {
				ws.terminate();
			});
		});
	});

	return {
		close() {
			// Forcibly drops every client this server is still holding - see this interface's own doc
			// comment on `close()` for why this, not `wss.close()` alone or `shutdown.ts`'s
			// `closeAllConnections()`, is what actually ends an upgraded socket.
			for (const client of wss.clients) client.terminate();
			wss.close();
		},
	};
}

/**
 * The container-URL router (`api.md`'s "Run web server"): forwards a request addressed to a run's
 * `containerUrl` to the HTTP server the Actor runs on `ACTOR_WEB_SERVER_PORT` inside that run's
 * container. Two addressings, both on the API port: `http://<runId>.runs.localhost:3333/<path>` (the
 * platform's host-based shape, where the run owns `/`) and `/actor-runtime/container/<runId>/<path>` (for
 * Actor containers and clients that do not resolve `*.localhost`).
 *
 * Unauthenticated, as the platform's container URLs are: the run id is the only thing it scopes on.
 * Mounted ahead of the API's body parser, so a request body is streamed through untouched.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';

import type { ContainerServerAddress, Driver } from '../driver/types.js';
import { CONTAINER_PATH_PREFIX, findRunByLabel, runLabelFromHost } from '../services/container-url.js';
import { isTerminalJobStatus } from '../services/job-status.js';
import {
	endUpgradeWithError,
	forwardHttpRequest,
	forwardUpgrade,
	sendJsonError,
	trackUpgradedSocket,
} from './http-proxy.js';

/** Seconds a browser showing the "not listening yet" page waits before trying again. */
const RETRY_AFTER_SECS = 3;

function escapeHtml(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

interface ContainerTarget {
	/** The run id as addressed - exact in the path form, lowercased by the client in the host form. */
	label: string;
	/** Path plus query string, as the Actor's server is to see it. */
	forwardPath: string;
}

/** `undefined` for a request not addressed to a run's container URL at all. */
export function containerTargetOf(req: IncomingMessage): ContainerTarget | undefined {
	const url = req.url ?? '/';
	const hostLabel = runLabelFromHost(req.headers.host);
	if (hostLabel) return { label: hostLabel, forwardPath: url.startsWith('/') ? url : `/${url}` };
	if (!url.startsWith(`${CONTAINER_PATH_PREFIX}/`)) return undefined;
	const rest = url.slice(CONTAINER_PATH_PREFIX.length + 1);
	const end = rest.search(/[/?]/);
	const label = decodeURIComponent(end === -1 ? rest : rest.slice(0, end));
	if (!label) return undefined;
	const remainder = end === -1 ? '' : rest.slice(end);
	return { label, forwardPath: remainder.startsWith('/') ? remainder : `/${remainder}` };
}

interface ProxyError {
	status: number;
	type: string;
	message: string;
	/** The condition may clear on its own (the Actor has not started its server yet): a browser retries. */
	transient: boolean;
}

type Resolution = { kind: 'ok'; runId: string; address: ContainerServerAddress } | ({ kind: 'error' } & ProxyError);

async function resolveTarget(driver: Driver, target: ContainerTarget): Promise<Resolution> {
	try {
		const run = await findRunByLabel(target.label);
		if (!run) {
			return {
				kind: 'error',
				status: 404,
				type: 'record-not-found',
				message: `No Actor run is served at container address "${target.label}"`,
				transient: false,
			};
		}
		if (isTerminalJobStatus(run.status)) {
			return {
				kind: 'error',
				status: 410,
				type: 'run-finished',
				message: `Actor run ${run.id} has ended (${run.status}), so its web server is gone.`,
				transient: false,
			};
		}
		const address = await driver.containerServerAddress(run.id);
		if (!address) {
			return {
				kind: 'error',
				status: 503,
				type: 'web-server-not-ready',
				message: `Actor run ${run.id} has no reachable web server yet: its container is still starting.`,
				transient: true,
			};
		}
		return { kind: 'ok', runId: run.id, address };
	} catch (error) {
		console.error('container router: unexpected error', error);
		return {
			kind: 'error',
			status: 500,
			type: 'internal-error',
			message: error instanceof Error ? error.message : 'Internal error',
			transient: false,
		};
	}
}

/** The Actor's server refused or dropped the connection: not listening on its port (yet). */
function unreachableError(runId: string, address: ContainerServerAddress, error: NodeJS.ErrnoException): ProxyError {
	const notListening = error.code === 'ECONNREFUSED' || error.code === 'ECONNRESET';
	return {
		status: notListening ? 503 : 502,
		type: notListening ? 'web-server-not-ready' : 'web-server-bad-gateway',
		message: notListening
			? `Nothing is listening on the web server port of Actor run ${runId} - the Actor has not started an HTTP ` +
				`server on ACTOR_WEB_SERVER_PORT (${address.port}), or not yet.`
			: `The web server of Actor run ${runId} did not answer: ${error.message}`,
		transient: notListening,
	};
}

function acceptsHtml(req: IncomingMessage): boolean {
	const accept = req.headers.accept;
	return typeof accept === 'string' && accept.includes('text/html');
}

/** A browser - the live view's frame, or a tab opened on the URL - gets a page that retries by itself. */
function sendError(req: IncomingMessage, res: ServerResponse, error: ProxyError): void {
	if (!acceptsHtml(req)) {
		if (error.transient && !res.headersSent) res.setHeader('retry-after', String(RETRY_AFTER_SECS));
		sendJsonError(res, error.status, error.type, error.message);
		return;
	}
	if (res.headersSent) {
		res.destroy();
		return;
	}
	const refresh = error.transient ? `<meta http-equiv="refresh" content="${RETRY_AFTER_SECS}">` : '';
	const note = error.transient ? `<p>This page checks again every ${RETRY_AFTER_SECS} seconds.</p>` : '';
	res.writeHead(error.status, {
		'content-type': 'text/html; charset=utf-8',
		...(error.transient ? { 'retry-after': String(RETRY_AFTER_SECS) } : {}),
	});
	res.end(
		`<!doctype html><html lang="en"><head><meta charset="utf-8">${refresh}<title>${escapeHtml(error.type)}</title>` +
			`<style>body{font-family:system-ui,sans-serif;margin:2rem;color:#333}p{max-width:60ch}</style></head>` +
			`<body><p>${escapeHtml(error.message)}</p>${note}</body></html>`,
	);
}

/** Express-compatible middleware; passes everything not addressed to a run's container URL on to `next`. */
export function containerProxy(driver: Driver) {
	return (req: IncomingMessage, res: ServerResponse, next: () => void): void => {
		const target = containerTargetOf(req);
		if (!target) {
			next();
			return;
		}
		// Held until the target is known; nothing is read from the body before then.
		req.pause();
		void resolveTarget(driver, target).then((resolution) => {
			if (resolution.kind === 'error') {
				req.resume();
				sendError(req, res, resolution);
				return;
			}
			const { runId, address } = resolution;
			forwardHttpRequest(req, res, address, target.forwardPath, {
				onError: (error) => sendError(req, res, unreachableError(runId, address, error)),
			});
		});
	};
}

/** The websocket counterpart of `containerProxy`, for the API server's `upgrade` event. Returns `false`
 * for an upgrade not addressed to a run's container URL, leaving it to the next handler. */
export function handleContainerUpgrade(driver: Driver, req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
	const target = containerTargetOf(req);
	if (!target) return false;
	trackUpgradedSocket(socket);
	void resolveTarget(driver, target).then((resolution) => {
		if (resolution.kind === 'error') {
			endUpgradeWithError(socket, resolution.status, resolution.type, resolution.message);
			return;
		}
		const { address } = resolution;
		// A server that is not listening just closes the socket: a websocket client retries on its own.
		forwardUpgrade(req, socket, head, address, target.forwardPath, { onError: () => {}, onClose: () => {} });
	});
	return true;
}

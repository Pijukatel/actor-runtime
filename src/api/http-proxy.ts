/**
 * What the standby router (`standby-proxy.ts`) and the container-URL router (`container-proxy.ts`)
 * share: forwarding one HTTP request, or one upgraded connection, to a server inside a run's container,
 * and the error envelope both answer with when they cannot.
 */
import http, { type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';

import type { ContainerServerAddress } from '../driver/types.js';

/** Hop-by-hop headers (RFC 9110 7.6.1) never cross a proxy. */
export const HOP_BY_HOP_HEADERS = [
	'connection',
	'keep-alive',
	'proxy-connection',
	'proxy-authenticate',
	'proxy-authorization',
	'te',
	'trailer',
	'upgrade',
];

export function forwardedHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
	const forwarded: IncomingHttpHeaders = { ...headers };
	for (const name of HOP_BY_HOP_HEADERS) delete forwarded[name];
	return forwarded;
}

export function sendJsonError(res: ServerResponse, status: number, type: string, message: string): void {
	if (res.headersSent) {
		res.destroy();
		return;
	}
	res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
	res.end(JSON.stringify({ error: { type, message } }));
}

/** The same error, written raw onto a socket whose upgrade was refused. */
export function endUpgradeWithError(socket: Duplex, status: number, type: string, message: string): void {
	const body = JSON.stringify({ error: { type, message } });
	socket.end(
		`HTTP/1.1 ${status} ${http.STATUS_CODES[status] ?? 'Error'}\r\n` +
			`content-type: application/json; charset=utf-8\r\ncontent-length: ${Buffer.byteLength(body)}\r\n` +
			`connection: close\r\n\r\n${body}`,
	);
}

export interface ForwardHooks {
	/** The upstream request failed before a response was underway. */
	onError(error: NodeJS.ErrnoException): void;
	/** The response has been fully delivered, or the client went away. */
	onClose?(): void;
}

/** Streams `req` to `address` and the response back; the caller has `req.pause()`d while resolving. */
export function forwardHttpRequest(
	req: IncomingMessage,
	res: ServerResponse,
	address: ContainerServerAddress,
	forwardPath: string,
	hooks: ForwardHooks,
): void {
	if (hooks.onClose) res.once('close', hooks.onClose);
	const upstream = http.request(
		{
			host: address.host,
			port: address.port,
			method: req.method,
			path: forwardPath,
			headers: forwardedHeaders(req.headers),
		},
		(upstreamRes) => {
			const headers = { ...upstreamRes.headers };
			for (const name of HOP_BY_HOP_HEADERS) delete headers[name];
			res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.statusMessage, headers);
			upstreamRes.pipe(res);
		},
	);
	upstream.on('error', hooks.onError);
	// A client that goes away takes its upstream request with it.
	res.once('close', () => {
		if (!res.writableFinished) upstream.destroy();
	});
	req.pipe(upstream);
	req.resume();
}

/** Upgraded sockets are not HTTP connections any more, so `closeAllConnections()` cannot end them. */
const upgradedSockets = new Set<Duplex>();

/** Ends every proxied upgraded connection; a graceful shutdown would otherwise wait on them indefinitely. */
export function closeProxiedUpgrades(): void {
	for (const socket of upgradedSockets) socket.destroy();
	upgradedSockets.clear();
}

/** Registers an upgraded client socket for `closeProxiedUpgrades`; call before resolving its target. */
export function trackUpgradedSocket(socket: Duplex): void {
	socket.on('error', () => socket.destroy());
	upgradedSockets.add(socket);
	socket.once('close', () => upgradedSockets.delete(socket));
}

export interface UpgradeHooks {
	/** The connection to the container failed. */
	onError(error: NodeJS.ErrnoException): void;
	/** Either side closed; called once. */
	onClose(): void;
}

/** Replays the upgrade request to `address` and splices the two sockets together. */
export function forwardUpgrade(
	req: IncomingMessage,
	socket: Duplex,
	head: Buffer,
	address: ContainerServerAddress,
	forwardPath: string,
	hooks: UpgradeHooks,
): void {
	const upstream = net.connect(address.port, address.host, () => {
		const lines = [`${req.method ?? 'GET'} ${forwardPath} HTTP/1.1`];
		for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
		upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
		if (head.length > 0) upstream.write(head);
		upstream.pipe(socket);
		socket.pipe(upstream);
	});
	let closed = false;
	const close = () => {
		if (!closed) {
			closed = true;
			hooks.onClose();
		}
		upstream.destroy();
		socket.destroy();
	};
	upstream.on('error', (error: NodeJS.ErrnoException) => {
		hooks.onError(error);
		close();
	});
	upstream.on('close', close);
	socket.on('close', close);
}

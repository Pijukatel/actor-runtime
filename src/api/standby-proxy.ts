/**
 * The standby router (`api.md`'s "Actor Standby"): forwards a request addressed to a standby Actor to
 * one of its standby runs, starting runs as `services/standby.ts` decides. Two addressings, both on the
 * API port: `http://<label>.localhost:3333/<path>` (the Actor's `standbyUrl`, the platform's host-based
 * shape, where the Actor owns `/`) and `/actor-runtime/standby/<label>/<path>` (for Actor containers and
 * clients that do not resolve `*.localhost`). `<label>` is the platform's `<username>--<actor-name>`, or
 * the Actor id.
 *
 * Mounted ahead of the API's body parser, so a request body is streamed through untouched.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';

import type { Driver } from '../driver/types.js';
import type { ActorRecord, UserRecord } from '../storage/entities.js';
import { getOrCreateUserForToken } from '../services/users.js';
import { listOwnedActors } from '../services/actors.js';
import { STANDBY_PATH_PREFIX, labelFromHost, standbyLabel } from '../services/standby-config.js';
import { StandbyUnavailableError, acquireStandbyRun, type StandbyLease } from '../services/standby.js';
import {
	endUpgradeWithError,
	forwardHttpRequest,
	forwardUpgrade,
	sendJsonError,
	trackUpgradedSocket,
} from './http-proxy.js';

interface StandbyTarget {
	label: string;
	/** Path plus query string, as the Actor's server is to see it. */
	forwardPath: string;
}

/** `undefined` for a request not addressed to a standby Actor at all. */
export function standbyTargetOf(req: IncomingMessage): StandbyTarget | undefined {
	const url = req.url ?? '/';
	const hostLabel = labelFromHost(req.headers.host);
	if (hostLabel) return { label: hostLabel, forwardPath: url.startsWith('/') ? url : `/${url}` };
	if (!url.startsWith(`${STANDBY_PATH_PREFIX}/`)) return undefined;
	const rest = url.slice(STANDBY_PATH_PREFIX.length + 1);
	const end = rest.search(/[/?]/);
	const label = decodeURIComponent(end === -1 ? rest : rest.slice(0, end));
	if (!label) return undefined;
	const remainder = end === -1 ? '' : rest.slice(end);
	return { label: label.toLowerCase(), forwardPath: remainder.startsWith('/') ? remainder : `/${remainder}` };
}

/** Same token sources as the API (`auth.ts`), plus the platform's standby-specific header. Forwarded
 * to the Actor unchanged: an Actor may use its caller's token itself. */
function tokenOf(req: IncomingMessage): string | undefined {
	for (const header of [req.headers.authorization, req.headers['x-apify-authorization']]) {
		const value = Array.isArray(header) ? header[0] : header;
		if (value?.toLowerCase().startsWith('bearer ')) {
			const token = value.slice('bearer '.length).trim();
			if (token) return token;
		}
	}
	const token = new URL(req.url ?? '/', 'http://localhost').searchParams.get('token');
	return token || undefined;
}

async function resolveStandbyActor(user: UserRecord, label: string): Promise<ActorRecord | undefined> {
	const owned = await listOwnedActors(user.id);
	return owned.find((actor) => actor.id.toLowerCase() === label || standbyLabel(actor, user.username) === label);
}

type Resolution =
	{ kind: 'ok'; lease: StandbyLease } | { kind: 'error'; status: number; type: string; message: string };

async function resolveLease(driver: Driver, req: IncomingMessage, target: StandbyTarget): Promise<Resolution> {
	const token = tokenOf(req);
	if (!token) {
		return {
			kind: 'error',
			status: 401,
			type: 'user-not-authenticated',
			message: 'Authentication token is not provided',
		};
	}
	try {
		const user = await getOrCreateUserForToken(token);
		const actor = await resolveStandbyActor(user, target.label);
		if (!actor) {
			return {
				kind: 'error',
				status: 404,
				type: 'record-not-found',
				message: `No Actor of yours is served at standby address "${target.label}"`,
			};
		}
		return { kind: 'ok', lease: await acquireStandbyRun(driver, actor, user) };
	} catch (error) {
		if (error instanceof StandbyUnavailableError) {
			return { kind: 'error', status: error.status, type: error.type, message: error.message };
		}
		console.error('standby router: unexpected error', error);
		return {
			kind: 'error',
			status: 500,
			type: 'internal-error',
			message: error instanceof Error ? error.message : 'Internal error',
		};
	}
}

/** Express-compatible middleware; passes everything not addressed to a standby Actor on to `next`. */
export function standbyProxy(driver: Driver) {
	return (req: IncomingMessage, res: ServerResponse, next: () => void): void => {
		const target = standbyTargetOf(req);
		if (!target) {
			next();
			return;
		}
		// Held until a run is ready; nothing is read from the body before then.
		req.pause();
		void resolveLease(driver, req, target).then((resolution) => {
			if (resolution.kind === 'error') {
				req.resume();
				sendJsonError(res, resolution.status, resolution.type, resolution.message);
				return;
			}
			const { lease } = resolution;
			forwardHttpRequest(req, res, lease.address, target.forwardPath, {
				// Releasing on close frees the run's slot once the response is done or the client went away.
				onClose: () => lease.release(),
				onError: (error) => {
					if (error.code === 'ECONNREFUSED') lease.markUnreachable();
					sendJsonError(
						res,
						502,
						'standby-bad-gateway',
						`The Actor's standby run ${lease.runId} did not answer: ${error.message}`,
					);
				},
			});
		});
	};
}

/** The websocket counterpart of `standbyProxy`, for the API server's `upgrade` event. Returns `false`
 * for an upgrade not addressed to a standby Actor, leaving it to the next handler. */
export function handleStandbyUpgrade(driver: Driver, req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
	const target = standbyTargetOf(req);
	if (!target) return false;
	trackUpgradedSocket(socket);
	void resolveLease(driver, req, target).then((resolution) => {
		if (resolution.kind === 'error') {
			endUpgradeWithError(socket, resolution.status, resolution.type, resolution.message);
			return;
		}
		const { lease } = resolution;
		forwardUpgrade(req, socket, head, lease.address, target.forwardPath, {
			onError: (error) => {
				if (error.code === 'ECONNREFUSED') lease.markUnreachable();
			},
			onClose: () => lease.release(),
		});
	});
	return true;
}

/**
 * The `/actor-runtime/*` namespace's self-description and its terminal handler - the two halves of
 * "the OpenAPI document is what the namespace *is*" (`api/actor-runtime-spec.ts`).
 *
 * `mountActorRuntimeSpec` serves the document itself and is deliberately registered *before* the
 * namespace router's `auth()` (`server.ts`): the document is static, identical for every caller and
 * carries no user data, so a client can identify a local Actor runtime and enumerate its
 * runtime-specific endpoints before it has a token.
 *
 * `mountActorRuntimeUnmatched` is registered last, after every real route, and answers everything that
 * fell through from the document alone. Without it those requests would reach the app-level catch-all
 * in `server.ts`, which reads the *platform* spec table and can only ever call them plain `404`s.
 */
import type { Router } from 'express';

import { sendData, sendError } from '../envelope.js';
import { h } from '../handler.js';
import {
	ACTOR_RUNTIME_OPENAPI,
	ACTOR_RUNTIME_OPERATIONS,
	actorRuntimeOperationsAtPath,
	matchActorRuntimeOperation,
	routerPathOf,
} from '../actor-runtime-spec.js';

/** Both mounts (`/actor-runtime` and `/v2/actor-runtime`) are the same router, so a request's path
 * within the namespace is all that identifies it - `req.baseUrl` differs between the two and is
 * deliberately not used. */
function namespacePath(routerRelativePath: string): string {
	return `/actor-runtime${routerRelativePath}`;
}

export function mountActorRuntimeSpec(router: Router): void {
	// `{data}`-enveloped, like every other JSON response on this API: `apify api GET /actor-runtime`
	// goes through apify-client-js, which unwraps `data` and would otherwise print `undefined`.
	router.get(
		'/',
		h(async (_req, res) => {
			sendData(res, ACTOR_RUNTIME_OPENAPI);
		}),
	);

	// The same document unenveloped, for OpenAPI tooling pointed straight at the URL - one of the
	// documented exceptions to the envelope rule (`api.md`).
	router.get(
		'/openapi.json',
		h(async (_req, res) => {
			res.status(200).json(ACTOR_RUNTIME_OPENAPI);
		}),
	);

	// Every websocket operation the document declares is served by the HTTP server's `upgrade` event
	// (`events-ws.ts`), never by Express - so a request that reaches Express on one of those paths is a
	// plain request where a handshake was expected. Registered here, from the document itself, rather
	// than in the unmatched handler below, because those operations declare no security: answering a
	// missing token with `401` would contradict the document the same request can read.
	for (const operation of ACTOR_RUNTIME_OPERATIONS) {
		// A websocket handshake is a `GET` by protocol, so that is the only method a websocket operation
		// can be declared under; any other method on the same path falls through to the `405` below.
		if (operation.transport !== 'websocket' || operation.method !== 'GET') continue;
		const path = routerPathOf(operation);
		router.get(
			path,
			h(async (req, res) => {
				sendError(
					res,
					426,
					'upgrade-required',
					`${req.method} ${namespacePath(req.path)} is a websocket endpoint - upgrade required`,
				);
			}),
		);
	}
}

export function mountActorRuntimeUnmatched(router: Router): void {
	router.use((req, res) => {
		const path = namespacePath(req.path);

		if (matchActorRuntimeOperation(req.method, path)) {
			// Documented, yet no route matched it: a wiring bug, not a caller error. Answered the same
			// way the platform surface answers a spec path with nothing behind it, and covered by a test
			// that exercises every documented operation.
			sendError(res, 501, 'not-implemented', `${req.method} ${path} is not implemented by this runtime`);
			return;
		}

		const allowed = actorRuntimeOperationsAtPath(path).map((entry) => entry.method);
		if (allowed.length > 0) {
			res.setHeader('Allow', allowed.join(', '));
			sendError(
				res,
				405,
				'method-not-allowed',
				`${req.method} is not allowed on ${path} - allowed: ${allowed.join(', ')}`,
			);
			return;
		}

		sendError(
			res,
			404,
			'not-found',
			`${req.method} ${path} is not part of the Actor runtime API - GET /actor-runtime lists every endpoint it has`,
		);
	});
}

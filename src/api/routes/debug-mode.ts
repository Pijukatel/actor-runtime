/**
 * `POST /actor-runtime/debug/:actorId` - the local-only debug-mode toggle (`actor-driver.md`'s "Debug
 * mode" section), on the same `/actor-runtime` sub-router `dev-folder.ts` mounts on (shared `auth()`,
 * both mounts - `/actor-runtime` and `/v2/actor-runtime` - see `server.ts`'s own doc comment for why).
 *
 * Canonical body is a strict JSON object: `{"enabled": true}` (defaults `language` to `"auto"`, no port
 * override), `{"enabled": true, "language": "node", "port": 9229}`, or `{"enabled": false}` to clear -
 * every other shape (an unknown field included) is `400 invalid-request` (`api.md`).
 *
 * Ownership-scoped exactly like `dev-folder.ts`: `resolveOwnedActor`, so a caller can only ever toggle
 * debug mode for their own Actor.
 */
import type { Router } from 'express';

import { requireUser } from '../auth.js';
import { sendData } from '../envelope.js';
import { invalidRequest, recordNotFound } from '../errors.js';
import { h, jsonBody } from '../handler.js';
import { debugStatus, setDebugMode } from '../../services/debug-mode.js';
import { resolveOwnedActor } from '../../services/actors.js';

/** Mounts the `/debug/:actorId` route onto `router`, matching every other route module's
 * `mount*(router): void` convention (`mountApiFallback`'s own precedent - this route needs no `Driver`,
 * unlike `mountDevFolder`). */
export function mountDebugMode(router: Router): void {
	router.post(
		'/debug/:actorId',
		h(async (req, res) => {
			const user = requireUser(req);
			const actor = await resolveOwnedActor(user.id, req.params.actorId as string, user.username);
			if (!actor) throw recordNotFound();

			const raw = jsonBody<unknown>(req);
			const result = await setDebugMode(actor, raw);
			if (result.kind !== 'ok') throw invalidRequest(result.message);

			// The response body doubles as the read-back - there is deliberately no separate `GET` for this
			// yet, same as the dev-folder endpoint (`api.md`).
			sendData(res, debugStatus(result.actor));
		}),
	);
}

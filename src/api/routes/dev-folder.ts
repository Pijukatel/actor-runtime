/**
 * `POST /actor-runtime/dev-folder/:actorId` - deliberately outside the emulated `/v2` surface
 * (`api.md`'s `/actor-runtime/*` namespace), so this is mounted directly on the API `app`, not the `v2`
 * router (`server.ts`'s "Auth is per-router, not global" note) - it therefore needs its own `auth()`,
 * applied to a small router of its own below, not inherited from `v2`.
 *
 * Canonical body is a JSON string: `'"/abs/path"'` to set, `'""'` to clear (`api.md`'s `/actor-runtime/*`
 * section - `apify api`'s own `--body` validates with `JSON.parse` and refuses anything that isn't
 * valid JSON, so a bare, unquoted path can never reach this route through the documented CLI invocation
 * at all). A JSON value that parses but isn't a string (a number, an object, ...) is rejected the same
 * way a malformed body is - only a genuine JSON string is ever a valid registration payload.
 *
 * Ownership-scoped like every other Actor write on this API port: `resolveOwnedActor` (not the
 * console's cross-user `getActorById`) so a caller can only ever register a dev folder for their own
 * Actor, and can name it by id, plain name, or `username~name` the same way `POST .../builds` and
 * `POST .../runs` already do.
 */
import express, { type Express } from 'express';

import { auth, requireUser } from '../auth.js';
import { sendData } from '../envelope.js';
import { ApiError, recordNotFound } from '../errors.js';
import { h, jsonBody } from '../handler.js';
import { describeDevFolderError, devFolderStatus, resolveOwnedActor, setDevFolder } from '../../services/actors.js';
import type { ApiServerDeps } from '../server.js';

export function mountDevFolder(app: Express, deps: ApiServerDeps): void {
	const router = express.Router();
	router.use(auth());

	router.post(
		'/dev-folder/:actorId',
		h(async (req, res) => {
			const user = requireUser(req);
			const actor = await resolveOwnedActor(user.id, req.params.actorId as string, user.username);
			if (!actor) throw recordNotFound();

			const raw = jsonBody<unknown>(req);
			if (typeof raw !== 'string') {
				throw new ApiError(
					400,
					'invalid-request',
					'Request body must be a JSON string - e.g. "/abs/path/to/src" to set, or "" to clear',
				);
			}

			const result = await setDevFolder(deps.driver, actor, raw.trim());
			if (result.kind !== 'ok') {
				const info = describeDevFolderError(result);
				throw new ApiError(info.status, info.type, info.message);
			}

			// The response body doubles as the read-back - there is deliberately no separate `GET` for
			// this yet - with the same three fields the console detail page shows.
			sendData(res, devFolderStatus(result.actor));
		}),
	);

	app.use('/actor-runtime', router);
}

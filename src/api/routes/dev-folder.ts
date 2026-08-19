/**
 * `POST /actor-runtime/dev-folder/:actorId` - deliberately outside the emulated `/v2` surface
 * (`api.md`'s `/actor-runtime/*` namespace), so this router is mounted directly on the API `app`
 * (`server.ts`), not nested under the `v2` router - it needs its own `auth()` rather than inheriting
 * `v2`'s.
 *
 * Canonical body is a JSON string: `'"/abs/path"'` to set, `'""'` to clear (`api.md`). A JSON value that
 * parses but isn't a string is rejected the same way a malformed body is.
 *
 * Ownership-scoped like every other Actor write on this API port: `resolveOwnedActor`, so a caller can
 * only ever register a dev folder for their own Actor.
 */
import express, { type Router } from 'express';

import { auth, requireUser } from '../auth.js';
import { sendData } from '../envelope.js';
import { ApiError, invalidRequest, recordNotFound } from '../errors.js';
import { h, jsonBody } from '../handler.js';
import {
	describeDevFolderFailure,
	devFolderStatus,
	setDevFolder,
	type SetDevFolderResult,
} from '../../services/dev-folder.js';
import { resolveOwnedActor } from '../../services/actors.js';
import type { ApiServerDeps } from '../server.js';

/** Maps a non-`ok` `SetDevFolderResult` to the `ApiError` this route throws - the HTTP status and API
 * error `type` are this route's own concern, not the service layer's (`describeDevFolderFailure` only
 * supplies the message text, shared with the console). */
function toApiError(result: Exclude<SetDevFolderResult, { kind: 'ok' }>): ApiError {
	const message = describeDevFolderFailure(result);
	switch (result.kind) {
		case 'invalid-path':
			return invalidRequest(message);
		case 'no-successful-build':
			return new ApiError(400, 'dev-folder-not-buildable', message);
		case 'not-found':
			return new ApiError(400, 'dev-folder-path-not-found', message);
		case 'unreachable':
			return new ApiError(503, 'dev-folder-check-unavailable', message);
		case 'image-missing':
			return new ApiError(500, 'internal-error', message);
		case 'unknown':
			return new ApiError(400, 'dev-folder-check-failed', message);
	}
}

/** Builds the `/actor-runtime/dev-folder` router - `server.ts` mounts it itself
 * (`app.use('/actor-runtime', devFolderRouter(deps))`), matching every other `mount*` route module's
 * convention of owning its route pattern, not the mount path. */
export function devFolderRouter(deps: ApiServerDeps): Router {
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
				throw invalidRequest(
					'Request body must be a JSON string - e.g. "/abs/path/to/src" to set, or "" to clear',
				);
			}

			const result = await setDevFolder(deps.driver, actor, raw);
			if (result.kind !== 'ok') throw toApiError(result);

			// The response body doubles as the read-back - there is deliberately no separate `GET` for
			// this yet - with the same three fields the console detail page shows.
			sendData(res, devFolderStatus(result.actor));
		}),
	);

	return router;
}

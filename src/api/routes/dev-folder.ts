/**
 * `POST /actor-runtime/dev-folder/:actorId` - deliberately outside the emulated `/v2` surface
 * (`api.md`'s `/actor-runtime/*` namespace). `server.ts` creates one shared sub-router (with its own
 * `auth()`, registered once there - not by this module) for the whole `/actor-runtime/*` namespace,
 * calls this and `mountApiFallback` on it, and mounts that same router instance at both
 * `/actor-runtime` (canonical) and `/v2/actor-runtime` (an alias existing solely because `apify api`
 * hardcodes a `/v2`-suffixed base URL - see `server.ts`'s doc comment). Neither mount is nested under
 * the `v2` router, so this namespace needs its own `auth()` rather than inheriting `v2`'s - and since
 * only one of the two mounts ever matches a given request, that `auth()` still runs exactly once per
 * request either way.
 *
 * Canonical body is a JSON string: `'"/abs/path"'` to set, `'""'` to clear (`api.md`). A JSON value that
 * parses but isn't a string is rejected the same way a malformed body is.
 *
 * Ownership-scoped like every other Actor write on this API port: `resolveOwnedActor`, so a caller can
 * only ever register a dev folder for their own Actor.
 */
import type { Router } from 'express';

import { requireUser } from '../auth.js';
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
		case 'not-found':
			return new ApiError(400, 'dev-folder-path-not-found', message);
		case 'not-a-directory':
			return new ApiError(400, 'dev-folder-not-a-directory', message);
		case 'unreachable':
			return new ApiError(503, 'dev-folder-check-unavailable', message);
		case 'image-missing':
			return new ApiError(500, 'internal-error', message);
		case 'unknown':
			return new ApiError(400, 'dev-folder-check-failed', message);
	}
}

/** Mounts the `/dev-folder/:actorId` route onto `router`, matching every other route module's
 * `mount*(router, deps): void` convention - `server.ts` creates the sub-router (with its own shared
 * `auth()`, registered by the caller, not here), calls this on it, and mounts the result at
 * `/actor-runtime` itself (owning the path prefix the same way it owns `/v2`). */
export function mountDevFolder(router: Router, deps: ApiServerDeps): void {
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
			// this yet - with the same field the console detail page shows.
			sendData(res, devFolderStatus(result.actor));
		}),
	);
}

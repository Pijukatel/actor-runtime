/**
 * `GET`/`POST /actor-runtime/live-dev-folder` (`api.md`) - the runtime-wide live dev folder toggle, on the
 * same `auth()`-wrapped `/actor-runtime` sub-router as `api-fallback.ts`, so it is served at both mounts.
 */
import type { Router } from 'express';

import { sendData } from '../envelope.js';
import { invalidRequest } from '../errors.js';
import { h, jsonBody } from '../handler.js';
import { isLiveDevFolderEnabled, setLiveDevFolderEnabled } from '../../services/live-dev-folder.js';

/** Throws `invalid-request` for anything but exactly `{ "enabled": <boolean> }`, so a rejected body never
 * changes the state. */
function parseEnabled(raw: unknown): boolean {
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
		throw invalidRequest('Request body must be a JSON object: {"enabled": true} or {"enabled": false}');
	}
	for (const key of Object.keys(raw)) {
		if (key !== 'enabled') throw invalidRequest(`Unknown field "${key}" - the only allowed field is "enabled".`);
	}
	const { enabled } = raw as { enabled?: unknown };
	if (typeof enabled !== 'boolean') throw invalidRequest('Field "enabled" is required and must be a boolean');
	return enabled;
}

/** Mounts the `/live-dev-folder` routes onto `router`, which already has `auth()` (`server.ts`). */
export function mountLiveDevFolder(router: Router): void {
	router.get(
		'/live-dev-folder',
		h(async (_req, res) => {
			sendData(res, { enabled: isLiveDevFolderEnabled() });
		}),
	);

	router.post(
		'/live-dev-folder',
		h(async (req, res) => {
			setLiveDevFolderEnabled(parseEnabled(jsonBody<unknown>(req)));
			sendData(res, { enabled: isLiveDevFolderEnabled() });
		}),
	);
}

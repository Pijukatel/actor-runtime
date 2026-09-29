import type { Router } from 'express';

import { sendData } from '../envelope.js';
import { invalidRequest } from '../errors.js';
import { h, jsonBody } from '../handler.js';
import { isLiveDevFolderEnabled, setLiveDevFolderEnabled } from '../../services/live-dev-folder.js';

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

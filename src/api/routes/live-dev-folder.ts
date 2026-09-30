/** `POST /actor-runtime/live-dev-folder/:actorId` - same shape and scoping as `browser-view.ts`. */
import type { Router } from 'express';

import { sendData } from '../envelope.js';
import { invalidRequest, recordNotFound } from '../errors.js';
import { h, jsonBody } from '../handler.js';
import { liveDevFolderStatus, setLiveDevFolder } from '../../services/live-dev-folder.js';
import { resolveActorParam } from '../resolve-reference.js';

export function mountLiveDevFolder(router: Router): void {
	router.post(
		'/live-dev-folder/:actorId',
		h(async (req, res) => {
			const actor = await resolveActorParam(req);
			if (!actor) throw recordNotFound();

			const result = await setLiveDevFolder(actor, jsonBody<unknown>(req));
			if (result.kind !== 'ok') throw invalidRequest(result.message);

			sendData(res, liveDevFolderStatus(result.actor));
		}),
	);
}

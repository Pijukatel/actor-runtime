/**
 * `PUT /actor-runtime/source-context/:actorId/:versionNumber` - replaces a version's source with a monorepo
 * build context, sent as one `.tar.gz` body (`services/source-context.ts`). Mounted on the shared `/actor-runtime/*` router, so it is
 * authenticated there and reachable at `/v2/actor-runtime/*` too; owner-scoped through `resolveActorParam`.
 */
import type { Router } from 'express';

import { sendData } from '../envelope.js';
import { invalidRequest, recordNotFound } from '../errors.js';
import { h, queryString, rawBody } from '../handler.js';
import { resolveActorParam } from '../resolve-reference.js';
import { setSourceContext, sourceContextSummary, validateSourceContextUpload } from '../../services/source-context.js';

export function mountSourceContext(router: Router): void {
	router.put(
		'/source-context/:actorId/:versionNumber',
		h(async (req, res) => {
			const actor = await resolveActorParam(req);
			if (!actor) throw recordNotFound();
			const versionNumber = req.params.versionNumber as string;

			const validation = await validateSourceContextUpload(
				{
					actorPath: queryString(req, 'actorPath'),
					gitRemoteUrl: queryString(req, 'gitRemoteUrl'),
					gitBranch: queryString(req, 'gitBranch'),
					gitCommit: queryString(req, 'gitCommit'),
					gitDirty: queryString(req, 'gitDirty'),
				},
				rawBody(req),
			);
			if (validation.kind === 'invalid') throw invalidRequest(validation.message);

			const version = await setSourceContext(actor, versionNumber, validation.upload);
			if (!version?.localSourceContext) throw recordNotFound(`Version "${versionNumber}" was not found`);

			sendData(res, { versionNumber, localSourceContext: sourceContextSummary(version.localSourceContext) });
		}),
	);
}

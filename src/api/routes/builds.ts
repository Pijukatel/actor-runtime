import type { Router } from 'express';

import { requireUser } from '../auth.js';

import { paginate, sendData, sortByTimestamp } from '../envelope.js';
import { deletingUnfinishedBuild, recordNotFound } from '../errors.js';
import { h, paginationParams } from '../handler.js';
import { abortBuild, deleteBuild, getOwnedBuild, listOwnedBuilds } from '../../services/builds.js';
import { isTerminalJobStatus } from '../../services/job-status.js';
import { buildDto } from '../dto/actors.js';
import type { ApiServerDeps } from '../server.js';
import { serveLog } from './logs.js';

export function mountBuilds(router: Router, deps: ApiServerDeps): void {
	router.get(
		'/actor-builds',
		h(async (req, res) => {
			const builds = await listOwnedBuilds(requireUser(req).id);
			const sorted = sortByTimestamp(builds, (build) => build.startedAt);
			const envelope = paginate(sorted, paginationParams(req));
			sendData(res, { ...envelope, items: envelope.items.map(buildDto) });
		}),
	);

	router.get(
		'/actor-builds/:buildId',
		h(async (req, res) => {
			const build = await getOwnedBuild(requireUser(req).id, req.params.buildId as string);
			if (!build) throw recordNotFound();
			sendData(res, buildDto(build));
		}),
	);

	router.delete(
		'/actor-builds/:buildId',
		h(async (req, res) => {
			const build = await getOwnedBuild(requireUser(req).id, req.params.buildId as string);
			if (!build) throw recordNotFound();
			// Matches the real platform: deleting a still-running build is rejected, not
			// aborted-then-deleted - see `deletingUnfinishedBuild`'s doc comment for the apify-core
			// evidence. Rejecting here (rather than deleting the record first) is also what prevents an
			// orphaned in-flight `docker build` from ever losing its one remaining cancellation path
			// (`POST /actor-builds/:buildId/abort`, which needs the record to still resolve).
			if (!isTerminalJobStatus(build.status)) throw deletingUnfinishedBuild();
			await deleteBuild(build.id);
			res.status(204).end();
		}),
	);

	router.post(
		'/actor-builds/:buildId/abort',
		h(async (req, res) => {
			const build = await getOwnedBuild(requireUser(req).id, req.params.buildId as string);
			if (!build) throw recordNotFound();
			const updated = await abortBuild(deps.driver, build);
			sendData(res, buildDto(updated ?? build));
		}),
	);

	router.get(
		'/actor-builds/:buildId/log',
		h(async (req, res) => serveLog(req, res, req.params.buildId as string)),
	);
}

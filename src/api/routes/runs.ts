import type { Router } from 'express';

import { requireUser } from '../auth.js';

import { paginate, sendData, sortByTimestamp } from '../envelope.js';
import { cannotRemoveRunningRun, jobAlreadyFinished, recordNotFound } from '../errors.js';
import { h, paginationParams, queryBoolean } from '../handler.js';
import { abortRun, deleteRun, getOwnedRun, listOwnedRuns } from '../../services/runs.js';
import { rebootRun } from '../../services/migrations.js';
import { isTerminalJobStatus } from '../../services/job-status.js';
import { runDto } from '../dto/actors.js';
import type { ApiServerDeps } from '../server.js';
import { serveLog } from './logs.js';

export function mountRuns(router: Router, deps: ApiServerDeps): void {
	router.get(
		'/actor-runs',
		h(async (req, res) => {
			const runs = await listOwnedRuns(requireUser(req).id);
			const sorted = sortByTimestamp(runs, (run) => run.startedAt);
			const envelope = paginate(sorted, paginationParams(req));
			sendData(res, { ...envelope, items: envelope.items.map(runDto) });
		}),
	);

	router.get(
		'/actor-runs/:runId',
		h(async (req, res) => {
			const run = await getOwnedRun(requireUser(req).id, req.params.runId as string);
			if (!run) throw recordNotFound();
			sendData(res, runDto(run));
		}),
	);

	router.delete(
		'/actor-runs/:runId',
		h(async (req, res) => {
			const run = await getOwnedRun(requireUser(req).id, req.params.runId as string);
			if (!run) throw recordNotFound();
			// Matches the real platform: deleting a still-running run is rejected, not
			// aborted-then-deleted - see `cannotRemoveRunningRun`'s doc comment for the apify-core
			// evidence. Rejecting here (rather than deleting the record first) is also what prevents an
			// orphaned Docker container from ever losing its one remaining stop path
			// (`POST /actor-runs/:runId/abort`, which needs the record to still resolve).
			if (!isTerminalJobStatus(run.status)) throw cannotRemoveRunningRun();
			await deleteRun(run.id);
			res.status(204).end();
		}),
	);

	router.post(
		'/actor-runs/:runId/abort',
		h(async (req, res) => {
			const run = await getOwnedRun(requireUser(req).id, req.params.runId as string);
			if (!run) throw recordNotFound();
			// Mirrors `apify-core`'s own abort route: `parseBooleanParameter(query.gracefully)`, default
			// `false` - omitted or `false` is byte-identical to the pre-existing immediate-abort behavior
			// (`services/runs.ts: abortRun`'s doc comment).
			const gracefully = queryBoolean(req, 'gracefully') ?? false;
			const updated = await abortRun(deps.driver, run, gracefully);
			sendData(res, runDto(updated ?? run));
		}),
	);

	router.post(
		'/actor-runs/:runId/reboot',
		h(async (req, res) => {
			const run = await getOwnedRun(requireUser(req).id, req.params.runId as string);
			if (!run) throw recordNotFound();
			// A finished run is rejected like on the platform; the SDKs call this endpoint from their
			// default `migrating` handler.
			if (isTerminalJobStatus(run.status)) throw jobAlreadyFinished();
			const updated = await rebootRun(deps.driver, run);
			sendData(res, runDto(updated ?? run));
		}),
	);

	router.get(
		'/actor-runs/:runId/log',
		h(async (req, res) => serveLog(req, res, req.params.runId as string)),
	);
}

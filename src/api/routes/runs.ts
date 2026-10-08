import type { Router } from 'express';

import { requireUser } from '../auth.js';

import { paginate, sendData, sortByTimestamp } from '../envelope.js';
import {
	cannotChargeApifyEvent,
	cannotChargeNonPayPerEventActor,
	cannotRemoveRunningRun,
	invalidRequest,
	jobAlreadyFinished,
	recordNotFound,
} from '../errors.js';
import { h, jsonBody, paginationParams, queryBoolean } from '../handler.js';
import { abortRun, deleteRun, getOwnedRun, listOwnedRuns } from '../../services/runs.js';
import { rebootRun } from '../../services/migrations.js';
import { chargeEvent, MAX_CHARGE_COUNT } from '../../services/charging.js';
import { isTerminalJobStatus } from '../../services/job-status.js';
import { runDto } from '../dto/actors.js';
import { standbyUrlAudienceOf } from '../../services/standby-config.js';
import type { ApiServerDeps } from '../server.js';
import { serveLog } from './logs.js';

export function mountRuns(router: Router, deps: ApiServerDeps): void {
	router.get(
		'/actor-runs',
		h(async (req, res) => {
			const runs = await listOwnedRuns(requireUser(req).id);
			const sorted = sortByTimestamp(runs, (run) => run.startedAt);
			const envelope = paginate(sorted, paginationParams(req));
			const audience = standbyUrlAudienceOf(req.headers.host);
			sendData(res, { ...envelope, items: envelope.items.map((run) => runDto(run, audience)) });
		}),
	);

	router.get(
		'/actor-runs/:runId',
		h(async (req, res) => {
			const run = await getOwnedRun(requireUser(req).id, req.params.runId as string);
			if (!run) throw recordNotFound();
			sendData(res, runDto(run, standbyUrlAudienceOf(req.headers.host)));
		}),
	);

	router.delete(
		'/actor-runs/:runId',
		h(async (req, res) => {
			const run = await getOwnedRun(requireUser(req).id, req.params.runId as string);
			if (!run) throw recordNotFound();
			// Matches the real platform: deleting a still-running run is rejected, not
			// aborted-then-deleted - see `cannotRemoveRunningRun`'s doc comment for the public-API
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
			// Mirrors the public abort route: `?gracefully` is a boolean query param defaulting to
			// `false` - omitted or `false` is byte-identical to the pre-existing immediate-abort behavior
			// (`services/runs.ts: abortRun`'s doc comment).
			const gracefully = queryBoolean(req, 'gracefully') ?? false;
			const updated = await abortRun(deps.driver, run, gracefully);
			sendData(res, runDto(updated ?? run, standbyUrlAudienceOf(req.headers.host)));
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
			sendData(res, runDto(updated ?? run, standbyUrlAudienceOf(req.headers.host)));
		}),
	);

	router.get(
		'/actor-runs/:runId/log',
		h(async (req, res) => serveLog(req, res, req.params.runId as string)),
	);

	// Owner-scoped like every other run route. The platform additionally insists on the run's own scoped
	// token, which has no local equivalent - every run here shares its owner's token.
	router.post(
		'/actor-runs/:runId/charge',
		h(async (req, res) => {
			const run = await getOwnedRun(requireUser(req).id, req.params.runId as string);
			if (!run) throw recordNotFound();

			const body = jsonBody<{ eventName?: unknown; count?: unknown }>(req);
			if (typeof body.eventName !== 'string' || body.eventName === '') {
				throw invalidRequest('"eventName" must be a non-empty string');
			}
			const count = body.count ?? 1;
			if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > MAX_CHARGE_COUNT) {
				throw invalidRequest(`"count" must be an integer between 1 and ${MAX_CHARGE_COUNT}`);
			}
			const idempotencyKey = req.header('idempotency-key');
			if (!idempotencyKey) throw invalidRequest('The "idempotency-key" header is required');

			const result = await chargeEvent(deps.driver, run, { eventName: body.eventName, count, idempotencyKey });
			switch (result.kind) {
				case 'apify-event':
					throw cannotChargeApifyEvent(body.eventName);
				case 'not-pay-per-event':
					throw cannotChargeNonPayPerEventActor();
				case 'unknown-event':
					throw recordNotFound(`Pricing for the event ${body.eventName}`);
				case 'charged':
				case 'replayed':
					// A bare `{}`, not the `{ data }` envelope every other route uses (`api.md`).
					res.status(result.status).json({});
			}
		}),
	);
}

import type { Router } from 'express';

import { requireUser } from '../auth.js';

import { paginate, sendData, sortByTimestamp } from '../envelope.js';
import {
	cannotChargeApifyEvent,
	cannotChargeNonPayPerEventActor,
	cannotRemoveRunningRun,
	invalidRequest,
	recordNotFound,
} from '../errors.js';
import { h, jsonBody, paginationParams, queryBoolean } from '../handler.js';
import { abortRun, deleteRun, getOwnedRun, listOwnedRuns } from '../../services/runs.js';
import { chargeRun } from '../../services/charging.js';
import { isTerminalJobStatus } from '../../services/job-status.js';
import { runDto } from '../dto/actors.js';
import type { ApiServerDeps } from '../server.js';
import { serveLog } from './logs.js';

/** `RUN_CHARGE_IDEMPOTENCY_HEADER` in apify-client-js - the one header this route requires. */
const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';

/** Reserved prefix for synthetic, platform-owned charge events (e.g. `apify-actor-start`) - matches
 * `apify-core`'s `APIFY_EVENTS_PREFIX` (`src/api/src/lib/paid_actors_helpers.ts:32`). */
const APIFY_EVENT_PREFIX = 'apify-';

/** apify-core's own upper bound on a single charge's `count`, "to stop some joker from trying to
 * integer overflow" (`run_charge.ts:23`'s comment, verbatim). */
const MAX_CHARGE_COUNT = 10_000_000;

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

	router.get(
		'/actor-runs/:runId/log',
		h(async (req, res) => serveLog(req, res, req.params.runId as string)),
	);

	router.post(
		'/actor-runs/:runId/charge',
		h(async (req, res) => {
			// Same "owned record" check every other `/v2/actor-runs/:runId/*` route uses - a run that
			// doesn't exist, or belongs to someone else, is `404 record-not-found` either way (this
			// runtime hands the container the owner's own token, so there is no separate run-scoped-token
			// check to mirror from apify-core here).
			const run = await getOwnedRun(requireUser(req).id, req.params.runId as string);
			if (!run) throw recordNotFound();

			const idempotencyKey = req.header(IDEMPOTENCY_KEY_HEADER);
			if (!idempotencyKey) throw invalidRequest(`Missing required "${IDEMPOTENCY_KEY_HEADER}" header`);

			const body = jsonBody<{ eventName?: unknown; count?: unknown }>(req);
			if (typeof body.eventName !== 'string' || body.eventName.length === 0) {
				throw invalidRequest('"eventName" must be a non-empty string');
			}
			// `apify-client`'s own default when `count` is omitted (`run.ts: charge()`).
			const count = body.count === undefined ? 1 : body.count;
			// Matches apify-core's `assertInteger(count, { min: 1, max: 10_000_000 })`
			// (`run_charge.ts:23-24`) exactly, rather than this runtime's earlier, looser
			// "any positive finite number" check: a fractional `count` here would write a fractional
			// `chargedEventCounts` entry that the Python `apify_client`'s `dict[str, int]`-typed model
			// then fails to parse on the *next* `run().get()` - permanently breaking `Actor.init()` for
			// that run's Python SDK - and an unbounded `count` has no equivalent server-side cap at all.
			if (
				typeof count !== 'number' ||
				!Number.isFinite(count) ||
				!Number.isInteger(count) ||
				count < 1 ||
				count > MAX_CHARGE_COUNT
			) {
				throw invalidRequest(`"count" must be an integer >= 1 and <= ${MAX_CHARGE_COUNT}`);
			}
			// Matches apify-core exactly: synthetic, platform-owned events (the `apify-` prefix) can
			// never be charged by a client request - only the runtime itself seeds them
			// (`services/runs.ts`'s `apify-actor-start` seeding). Checked here, before `chargeRun` is
			// even called, mirroring `idempotentChargeUserForEvent`'s own guard order (the very first
			// check it makes, ahead of even looking up the run - `run_charging_service.ts:566-569`).
			if (body.eventName.startsWith(APIFY_EVENT_PREFIX)) {
				throw cannotChargeApifyEvent(body.eventName);
			}

			const outcome = await chargeRun(run.id, body.eventName, count, idempotencyKey);
			switch (outcome.kind) {
				case 'not-found':
					throw recordNotFound();
				case 'not-pay-per-event':
					throw cannotChargeNonPayPerEventActor();
				case 'undeclared-event':
					throw recordNotFound(`Event "${body.eventName}" is not declared in this run's pricing`);
				case 'charged':
				case 'replayed':
					// Raw `{}`, never the usual `{data: ...}` envelope - byte-identical to the real
					// platform's charge response (`docs.apify.com/api/v2/post-charge-run`)
					// and to what apify-client-js's `run().charge()` itself expects back.
					res.status(201).json({});
					return;
			}
		}),
	);
}

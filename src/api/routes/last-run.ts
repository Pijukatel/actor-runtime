/**
 * `v2/actors/:actorId/runs/last`, `v2/actor-tasks/:actorTaskId/runs/last` and their sub-paths (`api.md`'s
 * "Last-run shortcuts"). The platform serves these by re-dispatching internally onto the run's own routes
 * (apify-core's `routeToLastRunRoutes`), so this does the same rather than reimplementing each target.
 *
 * The Actor (or task) lookup is the only point at which such a request can still leave the runtime: found
 * locally, it is pinned (`pinRequestToLocal`), because the platform cannot answer about a local run;
 * unknown here, it 404s before anything else is resolved, so the fallback relays the caller's original URL
 * whole.
 */
import type { Request, Response, Router } from 'express';

import { requireUser } from '../auth.js';
import { sendError } from '../envelope.js';
import { endpointNotFound, invalidRequest, recordNotFound } from '../errors.js';
import { h } from '../handler.js';
import { resolveActorParam, resolveTaskParam } from '../resolve-reference.js';
import { pinRequestToLocal } from '../../services/api-fallback.js';
import { findLastOwnedRun, type RunScope } from '../../services/runs.js';
import type { RunRecord } from '../../storage/entities.js';

/** `@apify/consts`'s `ACTOR_JOB_STATUSES`, wider than this runtime's own `JobStatus`: the platform
 * validates the value, not whether such a run could exist. */
const ACTOR_JOB_STATUSES: ReadonlySet<string> = new Set([
	'READY',
	'RUNNING',
	'SUCCEEDED',
	'FAILED',
	'TIMING-OUT',
	'TIMED-OUT',
	'ABORTING',
	'ABORTED',
]);

/** `@apify/consts`'s `META_ORIGINS`; every run this runtime starts is `API`. */
const META_ORIGINS: ReadonlySet<string> = new Set([
	'DEVELOPMENT',
	'WEB',
	'API',
	'SCHEDULER',
	'TEST',
	'WEBHOOK',
	'ACTOR',
	'CLI',
	'STANDBY',
	'CI',
	'MCP',
	'APIFY_AI',
]);

/** Messages are apify-core's `invalidStatusParameter`/`invalidOriginParameter`. A repeated parameter
 * arrives as an array, which is invalid there too. */
function filterParam(req: Request, key: 'status' | 'origin', allowed: ReadonlySet<string>): string | undefined {
	const raw = req.query[key];
	if (raw === undefined) return undefined;
	if (typeof raw !== 'string' || !allowed.has(raw)) {
		throw invalidRequest(
			key === 'status' ? 'Status parameter has an invalid value' : 'Origin parameter has an invalid value',
		);
	}
	return raw;
}

const NO_SUCH_SHORTCUT =
	'There is no last-run endpoint at this URL. The Apify API serves runs/last, runs/last/log, ' +
	'runs/last/dataset/*, runs/last/key-value-store/*, runs/last/request-queue/*, runs/last/abort, ' +
	'runs/last/reboot and runs/last/metamorph.';

/**
 * apify-core's `getRunRoute`: where a `runs/last` request re-dispatches to, given its router-relative URL.
 *
 * Read positionally off the raw URL rather than `req.params`, so the sub-path is forwarded byte for byte
 * (percent-encoding intact) and the route's case-insensitive matching cannot shift the segments.
 */
export function lastRunTargetUrl(method: string, url: string, run: RunRecord): string {
	const queryStart = url.indexOf('?');
	const pathname = queryStart === -1 ? url : url.slice(0, queryStart);
	const search = queryStart === -1 ? '' : url.slice(queryStart);
	const [prefix, ...rest] = pathname.split('/').filter(Boolean).slice(4);
	const tail = rest.length > 0 ? `/${rest.join('/')}` : '';

	switch (prefix) {
		case undefined:
			// The platform's bare form comes from a GET-only route, so it never becomes a shortcut to
			// `DELETE v2/actor-runs/:runId`.
			if (method !== 'GET' && method !== 'HEAD') {
				throw endpointNotFound('runs/last itself is GET-only; there is no last-run endpoint for this method');
			}
			return `/v2/actor-runs/${run.id}${search}`;
		case 'log':
			// Anything after `log` is dropped, like the platform. Unlike the platform, the query string is
			// kept, so `?stream=true` and `?token=` keep working.
			return `/v2/logs/${run.id}${search}`;
		case 'key-value-store':
			return `/v2/key-value-stores/${run.defaultKeyValueStoreId}${tail}${search}`;
		case 'dataset':
			return `/v2/datasets/${run.defaultDatasetId}${tail}${search}`;
		case 'request-queue':
			return `/v2/request-queues/${run.defaultRequestQueueId}${tail}${search}`;
		case 'abort':
		case 'metamorph':
		case 'reboot':
			return `/v2/actor-runs/${run.id}/${prefix}${tail}${search}`;
		default:
			throw endpointNotFound(NO_SUCH_SHORTCUT);
	}
}

/**
 * The re-dispatch, apify-core's `res.app.handle(req, res)`. `req.originalUrl` stays as the caller sent it;
 * `req.baseUrl` is cleared because this handler's `/v2` mount would otherwise be prefixed twice. `auth()`
 * re-runs (a cached token lookup) and the body parser no-ops the second time round.
 */
function redispatch(req: Request, res: Response, url: string): void {
	req.url = url;
	req.baseUrl = '';
	res.app(req, res, (error?: unknown) => {
		// Unreachable: `server.ts` ends the stack with a catch-all and an error middleware that both always
		// respond. Kept so a future wiring change cannot hang the response.
		console.error(`last-run: re-dispatch of ${req.method} ${req.originalUrl} fell through the app`, error);
		if (!res.headersSent) sendError(res, 500, 'internal-error', 'Internal error');
	});
}

/** The run scope a `runs/last` request names: an Actor's, or a task's (`null` when unknown here). */
type ScopeResolver = (req: Request) => Promise<RunScope | null>;

export function mountLastRun(router: Router): void {
	const routes: Array<[string, ScopeResolver]> = [
		[
			'/actors/:actorId/runs/last{/*rest}',
			async (req) => {
				const actor = await resolveActorParam(req);
				return actor && { actorId: actor.id };
			},
		],
		[
			'/actor-tasks/:actorTaskId/runs/last{/*rest}',
			async (req) => {
				const task = await resolveTaskParam(req);
				return task && { actorTaskId: task.id };
			},
		],
	];
	for (const [path, resolveScope] of routes) {
		router.all(
			path,
			h(async (req, res) => {
				const status = filterParam(req, 'status', ACTOR_JOB_STATUSES);
				const origin = filterParam(req, 'origin', META_ORIGINS);

				const scope = await resolveScope(req);
				// The one miss on this route the fallback may act on - see the module doc comment.
				if (!scope) throw recordNotFound();
				pinRequestToLocal(req);

				const run = await findLastOwnedRun(requireUser(req).id, scope, { status, origin });
				if (!run) throw recordNotFound('Actor run was not found');

				redispatch(req, res, lastRunTargetUrl(req.method, req.url, run));
			}),
		);
	}
}

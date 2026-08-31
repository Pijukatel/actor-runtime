import type { Request, Response, Router } from 'express';

import { recordNotFound } from '../errors.js';
import { h, queryBoolean } from '../handler.js';
import { requireUser } from '../auth.js';
import { pollUntilTerminal } from '../poll-until-terminal.js';
import { getFullLog, isLogTerminal, subscribeLog } from '../../services/logs.js';
import { getOwnedBuild } from '../../services/builds.js';
import { getOwnedRun } from '../../services/runs.js';
import { isTerminalJobStatus } from '../../services/job-status.js';
import type { BuildRecord, RunRecord } from '../../storage/entities.js';

/**
 * Resolves `id` to its owning build/run record (whichever it is), for both the ownership check and the
 * terminal-status safety net `serveLog` needs - one lookup serves both purposes.
 */
async function resolveOwnedJob(userId: string, id: string): Promise<BuildRecord | RunRecord | null> {
	const build = await getOwnedBuild(userId, id);
	if (build) return build;
	return getOwnedRun(userId, id);
}

/**
 * Shared by `GET /v2/logs/:id`, `GET /v2/actor-builds/:buildId/log` and `GET /v2/actor-runs/:runId/log`
 * - plain text, never `{data}`-wrapped (apify-client-js's `log().get()` casts the raw response body
 * directly). `?stream=true` holds a chunked response open until the job reaches a terminal status.
 *
 * Termination is decided two ways, deliberately redundant: `isLogTerminal(id)` (in-memory, set by
 * `markLogTerminal` - prompt, but only as reliable as every code path in `builds.ts`/`runs.ts`
 * remembering to call it) and the *persisted* record's `status` (the safety net - some paths reach a
 * terminal record without ever calling `markLogTerminal`, e.g. an abort landing in the `READY` window,
 * or `reconcileOrphanedJobs` finalising a job after a restart with no live in-memory state at all). A
 * stream must close on either signal, not just the first.
 */
export async function serveLog(req: Request, res: Response, id: string): Promise<void> {
	const userId = requireUser(req).id;
	const job = await resolveOwnedJob(userId, id);
	if (!job) throw recordNotFound();

	res.set('Content-Type', 'text/plain; charset=utf-8');

	const stream = queryBoolean(req, 'stream') ?? false;
	const soFar = await getFullLog(id);

	if (!stream || isLogTerminal(id) || isTerminalJobStatus(job.status)) {
		res.status(200).send(soFar);
		return;
	}

	res.status(200);
	// Express (via Node's http) sends a chunked transfer automatically once headers are flushed
	// without a Content-Length, which happens on this first `res.write()`.
	res.write(soFar);

	const unsubscribe = subscribeLog(id, (chunk) => {
		res.write(chunk);
	});

	const poller = pollUntilTerminal({
		intervalMs: 250,
		isTerminal: () => isLogTerminal(id),
		refetch: () => resolveOwnedJob(userId, id),
		onTerminal: () => {
			unsubscribe();
			res.end();
		},
	});

	req.on('close', () => {
		poller.stop();
		unsubscribe();
	});
}

export function mountLogs(router: Router): void {
	router.get(
		'/logs/:buildOrRunId',
		h(async (req, res) => serveLog(req, res, req.params.buildOrRunId as string)),
	);
}

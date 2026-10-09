import type { Request, Router } from 'express';

import { requireUser } from '../auth.js';

import { defaultDatasetNotFound, runFailed, runTimeoutExceeded } from '../errors.js';
import { h, queryString, toNodeBuffer } from '../handler.js';
import { isTerminalJobStatus } from '../../services/job-status.js';
import { waitForRunFinish } from '../../services/runs.js';
import { getOwnedStorage } from '../../services/storages.js';
import { openKeyValueStore } from '../../storage/open.js';
import type { RunRecord } from '../../storage/entities.js';
import type { ApiServerDeps } from '../server.js';
import { startRunFromRequest } from './actors.js';
import { startTaskRunFromRequest } from './tasks.js';
import { sendDatasetItems } from './datasets.js';

/** The platform's `MAX_ACTOR_JOB_SYNC_WAIT_SECS`. */
const DEFAULT_RUN_SYNC_WAIT_SECS = 300;
let runSyncWaitSecs = DEFAULT_RUN_SYNC_WAIT_SECS;

export function setRunSyncWaitSecsForTests(seconds: number | undefined): void {
	runSyncWaitSecs = seconds ?? DEFAULT_RUN_SYNC_WAIT_SECS;
}

type StartRun = (req: Request, deps: ApiServerDeps) => Promise<RunRecord>;

/** Starts a run and waits for it to succeed; a run still going when the wait ends is left running. */
async function runToSuccess(req: Request, deps: ApiServerDeps, start: StartRun): Promise<RunRecord> {
	const waitSecs = runSyncWaitSecs;
	const started = await start(req, deps);
	const run = (await waitForRunFinish(started.id, waitSecs)) ?? started;
	if (!isTerminalJobStatus(run.status)) throw runTimeoutExceeded(waitSecs);
	if (run.status !== 'SUCCEEDED') throw runFailed(run.id, run.status);
	return run;
}

/** `run-sync` and `run-sync-get-dataset-items`, of Actors and of tasks: both answer `201`, and both accept
 * `GET` as well as `POST`. */
export function mountRunSync(router: Router, deps: ApiServerDeps): void {
	const sources: Array<[string, StartRun]> = [
		['/actors/:actorId', startRunFromRequest],
		['/actor-tasks/:actorTaskId', startTaskRunFromRequest],
	];
	for (const [prefix, start] of sources) {
		const runSync = h(async (req, res) => {
			const recordKey = queryString(req, 'outputRecordKey') ?? 'OUTPUT';
			const run = await runToSuccess(req, deps, start);
			const store = await getOwnedStorage(requireUser(req).id, run.defaultKeyValueStoreId, 'keyValueStore');
			const record = store ? await (await openKeyValueStore(store.id)).getRecord(recordKey) : null;
			// A missing output record is an empty body, not an error, matching the platform.
			if (!record) {
				res.status(201).type('text/plain; charset=utf-8').send('');
				return;
			}
			res.status(201)
				.set('Content-Type', record.contentType ?? 'application/octet-stream')
				.send(toNodeBuffer(record.value));
		});
		router.get(`${prefix}/run-sync`, runSync);
		router.post(`${prefix}/run-sync`, runSync);

		const runSyncGetDatasetItems = h(async (req, res) => {
			const run = await runToSuccess(req, deps, start);
			const dataset = await getOwnedStorage(requireUser(req).id, run.defaultDatasetId, 'dataset');
			if (!dataset) throw defaultDatasetNotFound();
			await sendDatasetItems(req, res, dataset, 201);
		});
		router.get(`${prefix}/run-sync-get-dataset-items`, runSyncGetDatasetItems);
		router.post(`${prefix}/run-sync-get-dataset-items`, runSyncGetDatasetItems);
	}
}

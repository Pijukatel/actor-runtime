import { isTerminalJobStatus } from '../services/job-status.js';
import type { JobStatus } from '../storage/entities.js';

/**
 * The poll-and-guard shape shared by `api/routes/logs.ts`'s `?stream=true` handling and
 * `api/events-ws.ts`'s connection handler: both hold a live connection open against a job (a build or a
 * run) and need to notice, without the job's own code reaching back into this connection directly, that
 * it has gone terminal - checked two ways, deliberately redundant (`isTerminal`, a fast in-memory flag set
 * by the job's own lifecycle code, and `refetch`, a fallback re-read of the persisted record for the paths
 * that reach a terminal record without ever flipping that flag, e.g. an abort landing in a pre-container
 * window, or `reconcileOrphanedJobs` finalizing a job after a restart with no live in-memory state at
 * all). `refetch` is only called when the previous call has already settled - an overlapping tick is
 * dropped rather than piling another read on top of a slow one.
 *
 * `onTerminal` runs, and polling stops, the first time either check fires. The returned `stop()` is for
 * the caller's OWN external close signal (`req.on('close')`, `ws.on('close')`) - the connection ending for
 * a reason that has nothing to do with the job reaching a terminal state, so it stops polling without ever
 * running `onTerminal`.
 */
export function pollUntilTerminal(options: {
	intervalMs: number;
	isTerminal: () => boolean;
	refetch: () => Promise<{ status: JobStatus } | null>;
	onTerminal: () => void;
}): { stop(): void } {
	let checkingRecord = false;
	const poll = setInterval(() => {
		if (options.isTerminal()) {
			clearInterval(poll);
			options.onTerminal();
			return;
		}
		if (checkingRecord) return;
		checkingRecord = true;
		options
			.refetch()
			.then((current) => {
				if (!current || isTerminalJobStatus(current.status)) {
					clearInterval(poll);
					options.onTerminal();
				}
			})
			.catch(() => undefined)
			.finally(() => {
				checkingRecord = false;
			});
	}, options.intervalMs);

	return {
		stop() {
			clearInterval(poll);
		},
	};
}

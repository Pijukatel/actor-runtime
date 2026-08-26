import { isTerminalJobStatus } from '../services/job-status.js';
import type { JobStatus } from '../storage/entities.js';

/**
 * Holds a live connection open against a job and stops it once the job goes terminal. Termination is
 * detected two ways: `isTerminal`, an in-memory flag, and `refetch`, a fallback re-read of the record
 * for paths that reach a terminal state without flipping it. `stop()` is for the caller's own close
 * signal and never runs `onTerminal`.
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

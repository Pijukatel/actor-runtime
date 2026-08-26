/**
 * The single gate every build/run status write goes through. Both `BuildRecord` and `RunRecord` share
 * the same `JobStatus` state machine (`entities.ts`): `READY -> RUNNING -> SUCCEEDED | FAILED |
 * TIMED-OUT | ABORTED`, with `RUNNING -> ABORTING -> ABORTED` while a stop is in flight. Centralising
 * the guard here (rather than sprinkling `if (isTerminal) return` checks through `services/builds.ts`
 * and `services/runs.ts`) is what makes the invariant hold regardless of how a background completion
 * handler and an in-flight abort happen to interleave: whichever write reaches a record first, the
 * other is either blocked (record already terminal) or a no-op (the requested transition is not legal
 * from the record's current status), never a silent overwrite.
 */
import type { JobStatus } from '../storage/entities.js';

export const TERMINAL_JOB_STATUSES: ReadonlySet<JobStatus> = new Set(['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT']);

export function isTerminalJobStatus(status: JobStatus): boolean {
	return TERMINAL_JOB_STATUSES.has(status);
}

/**
 * Legal next statuses, keyed by current status. `ABORTED` is reachable two ways: through the normal
 * `RUNNING -> ABORTING -> ABORTED` abort sequence, or directly from `READY`/`RUNNING` for startup
 * reconciliation, which finalises an orphaned non-terminal record in one write with no live abort to
 * sequence behind. Anything not listed here (including every terminal status's empty set) is rejected
 * by `transitionJobStatus`, which returns the record unchanged rather than throwing - the callers are
 * background handlers racing an abort/timeout, not user-facing requests that should surface an error.
 */
const ALLOWED_NEXT: Record<JobStatus, ReadonlySet<JobStatus>> = {
	READY: new Set<JobStatus>(['RUNNING', 'ABORTING', 'ABORTED']),
	RUNNING: new Set<JobStatus>(['SUCCEEDED', 'FAILED', 'TIMED-OUT', 'ABORTING', 'ABORTED']),
	ABORTING: new Set<JobStatus>(['ABORTED']),
	SUCCEEDED: new Set<JobStatus>(),
	FAILED: new Set<JobStatus>(),
	ABORTED: new Set<JobStatus>(),
	'TIMED-OUT': new Set<JobStatus>(),
};

/** The subset of `Registry<T>` that `transitionJobStatus` needs - narrowed so tests can pass a plain
 * in-memory fake instead of a real `Registry` (which has a private constructor/mutex and so cannot be
 * satisfied structurally by a test double). */
export interface StatusRegistry<T> {
	get(id: string): Promise<T | null>;
	update(id: string, mutator: (current: T | null) => T | null): Promise<T | null>;
}

/**
 * Read-modify-write a build/run record's status through the allowed-transition gate above. `patch` is
 * merged onto the record *only* when the transition is accepted, and `status` in `patch` (if present)
 * is always overridden by `next`. Returns the record as it ended up (unchanged if the transition was
 * refused, `null` if the record does not exist), so callers can tell whether their write actually
 * landed by comparing `result.status` to `next`.
 *
 * `onBeforeTransition`, when given, is invoked with the record exactly as read INSIDE this same
 * mutex-serialized read-modify-write (`Registry.update`'s per-id `KeyedMutex`), before the
 * accept/refuse decision is made - the same moment `current.status` is the freshest it can ever be
 * relative to this write. A caller that needs to know the record's status immediately prior to a
 * guarded transition (e.g. "was this run actually RUNNING right before it moved to ABORTING?") should
 * capture it here, never via a separate, unguarded `registry.get(id)` call made before this one - a
 * plain `get` has no ordering relationship with a concurrent `update` on the same id and can read a
 * status that a race has already made stale by the time the transition itself lands.
 */
export async function transitionJobStatus<T extends { status: JobStatus }>(
	registry: StatusRegistry<T>,
	id: string,
	next: JobStatus,
	patch: Partial<T> = {},
	onBeforeTransition?: (current: T | null) => void,
): Promise<T | null> {
	return registry.update(id, (current) => {
		onBeforeTransition?.(current);
		if (!current) return null;
		if (isTerminalJobStatus(current.status)) return current;
		if (!ALLOWED_NEXT[current.status].has(next)) return current;
		return { ...current, ...patch, status: next };
	});
}

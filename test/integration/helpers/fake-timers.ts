/**
 * A tiny helper for tests that fake `setTimeout`/`clearTimeout` (to control `GRACEFUL_ABORT_WINDOW_MS`
 * without a real 30-second wait) while other code in the same test still performs real, `@crawlee/
 * fs-storage`-backed registry I/O (native-addon-backed, genuinely asynchronous - not itself gated by any
 * faked timer). `vi.advanceTimersByTimeAsync` only advances *already-scheduled* fake timers; called
 * before the real registry write that precedes `abortRun`'s `setTimeout` call has actually landed, it
 * finds nothing to advance and returns immediately, leaving that `setTimeout` call to be made moments
 * later with no further advance ever coming - a permanent hang. `waitForPendingTimer` closes that window
 * by polling (with a genuine real-time pause, `realDelay` below) until the timer actually exists before
 * any test advances fake time past it.
 */
import { vi } from 'vitest';

/** A genuine real-wall-clock pause. Deliberately not `setTimeout` (faked by callers of this module) and
 * deliberately not a bare `setImmediate`/microtask spin either - a spin with no minimum delay can execute
 * thousands of iterations within under a millisecond of real time, never actually ceding the CPU long
 * enough for a background OS thread (the native fs-storage addon's own thread-pool work) to complete.
 * `setInterval`/`clearInterval` are never faked by this module's callers, so this genuinely waits `ms` of
 * real time regardless of what else is faked. */
export function realDelay(ms: number): Promise<void> {
	return new Promise((resolve) => {
		const timer = setInterval(() => {
			clearInterval(timer);
			resolve();
		}, ms);
	});
}

/** Polls (via `realDelay`, real time) until at least one fake timer has actually been scheduled - i.e.
 * until whatever real, awaited work precedes the `setTimeout` call under test has genuinely completed.
 * Callers should install fake timers with `toFake: ['setTimeout', 'clearTimeout']` only (never `Date` or
 * `setImmediate`), and never advance fake time before this resolves. */
export async function waitForPendingTimer(timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (vi.getTimerCount() === 0) {
		if (Date.now() > deadline) {
			throw new Error(
				'Timed out waiting for a fake timer to be scheduled - the real work gated behind it never completed in time.',
			);
		}
		await realDelay(2);
	}
}

import { generateId } from '../storage/ids.js';
import type { BuildRecord, JobStatus } from '../storage/entities.js';
import { getRegistries } from '../storage/registries.js';
import type { ActorRecord, ActorVersionRecord } from '../storage/entities.js';
import { recordTaggedBuild, updateActor } from './actors.js';
import type { Driver } from '../driver/types.js';
import { DriverTimedOutError } from '../driver/types.js';
import { appendLog, flushLog, markLogTerminal } from './logs.js';
import { isTerminalJobStatus, transitionJobStatus } from './job-status.js';

/**
 * The runtime does not expose a per-build `timeoutSecs` option (there is no `POST .../builds` query
 * param for it, matching apify-core: builds time out against a fixed platform limit
 * (`ACTOR_LIMITS.BUILD_TIMEOUT_SECS`, applied uniformly to both jobTypes by
 * `killActJob`/`finishDeadJobs` in `actor_jobs/job_controller.server.ts` and
 * `actor_job_controller_daemon.ts`), not a per-run one. This mirrors that: one fixed internal default,
 * not user-configurable. The exact real-platform value was not available to verify in this sandbox
 * (`ACTOR_LIMITS` is not vendored here), so this is a reasonable placeholder, not a matched constant.
 */
const DEFAULT_BUILD_TIMEOUT_SECS = 1800;

export async function listOwnedBuilds(userId: string, actorId?: string): Promise<BuildRecord[]> {
	const all = await getRegistries().builds.list();
	return all.filter((build) => build.userId === userId && (!actorId || build.actorId === actorId));
}

export async function getOwnedBuild(userId: string, id: string): Promise<BuildRecord | null> {
	const record = await getRegistries().builds.get(id);
	if (!record || record.userId !== userId) return null;
	return record;
}

/** Mirrors `deleteActor` (`services/actors.ts`) - the route layer resolves+authorizes the record (via
 * `getOwnedBuild`) and passes only its id down, same split as every other service-layer mutation. */
export async function deleteBuild(id: string): Promise<void> {
	await getRegistries().builds.delete(id);
}

async function nextBuildNumber(actorId: string, versionNumber: string): Promise<string> {
	const existing = await getRegistries().builds.list();
	const count = existing.filter((b) => b.actorId === actorId && b.versionNumber === versionNumber).length;
	return `${versionNumber}.${count}`;
}

export interface StartBuildOptions {
	tag: string;
	useCache: boolean;
}

/** Creates the build record and kicks off the driver build in the background; returns immediately. */
export async function startBuild(
	driver: Driver,
	actor: ActorRecord,
	version: ActorVersionRecord,
	options: StartBuildOptions,
): Promise<BuildRecord> {
	const { builds } = getRegistries();
	const buildNumber = await nextBuildNumber(actor.id, version.versionNumber);
	const record: BuildRecord = {
		id: generateId(),
		userId: actor.userId,
		actorId: actor.id,
		versionNumber: version.versionNumber,
		buildNumber,
		tag: options.tag,
		status: 'READY',
		startedAt: new Date().toISOString(),
	};
	await builds.set(record.id, record);

	void runBuildInBackground(driver, actor, version, record, options).catch(async (error: unknown) => {
		// Every *expected* failure mode inside `runBuildInBackground` is already caught internally and
		// mapped to a terminal status - this is only reached by a genuinely unexpected exception (e.g. a
		// registry/storage failure from the pre-start re-check or `updateActor`). Without a best-effort
		// terminal write here the record would stay stuck non-terminal forever - `waitForBuildFinish`
		// would block until its timeout and every future abort/status check would just see a permanently
		// "running" build.
		console.error(`build ${record.id}: unexpected error escaped runBuildInBackground`, error);
		try {
			await transitionJobStatus(builds, record.id, 'FAILED', {
				finishedAt: new Date().toISOString(),
				statusMessage: `Unexpected internal error: ${error instanceof Error ? error.message : String(error)}`,
			});
		} catch (innerError) {
			console.error(`build ${record.id}: failed to mark FAILED after unexpected error`, innerError);
		}
	});

	return record;
}

/**
 * Exported only for direct testing of the guarded transitions/pre-start abort window (see
 * `test/integration/job-lifecycle.test.ts`) - not part of the service's public surface for callers
 * outside this module, which should only ever go through `startBuild`.
 */
export async function runBuildInBackground(
	driver: Driver,
	actor: ActorRecord,
	version: ActorVersionRecord,
	record: BuildRecord,
	options: StartBuildOptions,
): Promise<void> {
	const { builds } = getRegistries();

	const afterStart = await transitionJobStatus(builds, record.id, 'RUNNING');
	if (!afterStart || afterStart.status !== 'RUNNING') {
		// An abort issued during the READY window already moved (or is moving) the record past RUNNING -
		// finalise it as ABORTED without ever starting the build. `driver.abortBuild` is called
		// defensively even though no build can be in flight yet on this path (harmless no-op if so; a
		// real cancellation if some future change ever lets a build start before this check runs).
		// `afterStart.status` can legitimately be `ABORTED` here too, not just `ABORTING`: `job-status.ts`
		// allows `READY -> ABORTED` directly (used by `reconcileOrphanedJobs`), and `abortBuild` can also
		// complete its whole `ABORTING -> ABORTED` two-write sequence before this function's own `RUNNING`
		// transition attempt above ever runs - there is no ordering guarantee between the two. In that
		// case the record is already terminal and there is genuinely nothing left to finalise, so the bare
		// `return` below is correct. If the record simply vanished, same thing.
		if (afterStart?.status === 'ABORTING') {
			await driver.abortBuild(record.id).catch(() => undefined);
			await transitionJobStatus(builds, record.id, 'ABORTED', { finishedAt: new Date().toISOString() });
		}
		return;
	}

	if (!driver.available) {
		appendLog(record.id, `Docker is not available: ${driver.unavailableReason}\n`);
		await flushLog(record.id);
		markLogTerminal(record.id);
		await transitionJobStatus(builds, record.id, 'FAILED', {
			finishedAt: new Date().toISOString(),
			statusMessage: driver.unavailableReason,
		});
		return;
	}

	// Re-check right before kicking off the actual `docker build`: an abort issued while the two awaits
	// above (log flush aside, the driver-availability check itself is synchronous, but this still closes
	// the window against an abort landing between the RUNNING transition above and this line).
	const preStart = await builds.get(record.id);
	if (!preStart || preStart.status !== 'RUNNING') {
		if (preStart?.status === 'ABORTING') {
			await driver.abortBuild(record.id).catch(() => undefined);
			await transitionJobStatus(builds, record.id, 'ABORTED', { finishedAt: new Date().toISOString() });
		}
		return;
	}

	try {
		const outcome = await driver.startBuild(
			{
				buildId: record.id,
				actorName: actor.name,
				sourceFiles: version.sourceFiles,
				useCache: options.useCache,
				timeoutSecs: DEFAULT_BUILD_TIMEOUT_SECS,
			},
			(chunk) => appendLog(record.id, chunk),
		);
		// Guarded: if an abort raced ahead and already moved the record to ABORTING/ABORTED, this write
		// is refused (`RUNNING` is the only status `SUCCEEDED` is a legal next-state from) rather than
		// clobbering the abort - see `job-status.ts`.
		const succeeded = await transitionJobStatus(builds, record.id, 'SUCCEEDED', {
			finishedAt: new Date().toISOString(),
			imageId: outcome.imageId,
			exitCode: 0,
		});
		// Only tag the build against the actor if the SUCCEEDED write actually landed - if an abort won
		// the race above, `succeeded.status` is `ABORTED` (or the record vanished) and tagging here would
		// clobber `actor.taggedBuilds[<tag>]` with a build that has no image, breaking every future
		// `apify call`/`POST .../runs` against that tag even though the build record itself correctly
		// stayed ABORTED.
		if (succeeded?.status === 'SUCCEEDED') {
			await updateActor(actor.id, (current) =>
				recordTaggedBuild(current, options.tag, record.id, record.buildNumber),
			);
		}
	} catch (error) {
		const status: JobStatus = error instanceof DriverTimedOutError ? 'TIMED-OUT' : 'FAILED';
		// Same guard: an aborted build's driver call also rejects (the destroyed HTTP request surfaces
		// as an error here too), but by the time that rejection is caught, `abortBuild` below has almost
		// certainly already moved the record to ABORTED - and even in the pathological ordering where it
		// hasn't yet, the record is at worst ABORTING, from which only `ABORTED` is a legal next status,
		// so this write is refused either way and the abort always wins.
		await transitionJobStatus(builds, record.id, status, {
			finishedAt: new Date().toISOString(),
			statusMessage: (error as Error).message,
		});
	} finally {
		await flushLog(record.id);
		markLogTerminal(record.id);
	}
}

/**
 * Interrupts the in-flight build for real (destroys its HTTP request to the Docker daemon - see
 * `DockerDriver`'s class doc comment), then reports `ABORTED` back to the caller. The record is moved
 * to `ABORTING` *before* `driver.abortBuild` is even called, which is what makes the result race-proof:
 * from that point on, `runBuildInBackground`'s own eventual completion write - whatever status it
 * computes, whenever it lands - can never overwrite this call's outcome. It is either blocked outright
 * (the record already terminal by the time it runs) or refused (an `ABORTING` record only accepts
 * `ABORTED` as its next status, per `job-status.ts`), regardless of which write actually reaches the
 * record first.
 */
export async function abortBuild(driver: Driver, build: BuildRecord): Promise<BuildRecord | null> {
	if (isTerminalJobStatus(build.status)) return build;
	const { builds } = getRegistries();
	const aborting = await transitionJobStatus(builds, build.id, 'ABORTING');
	if (!aborting || aborting.status !== 'ABORTING') return aborting;
	await driver.abortBuild(build.id);
	return transitionJobStatus(builds, build.id, 'ABORTED', { finishedAt: new Date().toISOString() });
}

/** Poll the build registry until terminal or `seconds` elapse (real API's `waitForFinish` contract). */
export async function waitForBuildFinish(buildId: string, seconds: number): Promise<BuildRecord | null> {
	const deadline = Date.now() + seconds * 1000;
	for (;;) {
		const current = await getRegistries().builds.get(buildId);
		if (!current || isTerminalJobStatus(current.status) || Date.now() >= deadline) return current;
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
}

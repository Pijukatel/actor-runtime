import type { SourceFile } from '../storage/entities.js';

export interface BuildContext {
	buildId: string;
	actorName: string;
	sourceFiles: SourceFile[];
	useCache: boolean;
	timeoutSecs: number;
}

/**
 * Host folder + image working directory, carried together so "both or neither" is enforced by the
 * type itself - there is no way to construct a `RunContext` with one field set and the other missing,
 * matching `actor-driver.md`'s "The mount is conditional, applied only when both fields are present and
 * non-empty". `services/runs.ts` builds this only when the Actor's own
 * `localDevFolder`/`imageWorkingDirectory` are both present and non-empty; `docker-driver.ts`'s
 * `startRun` adds the `HostConfig.Mounts` entries only when this is present at all.
 */
export interface DevFolderMount {
	localDevFolder: string;
	imageWorkingDirectory: string;
}

export interface RunContext {
	runId: string;
	imageId: string;
	env: Record<string, string>;
	memoryMbytes: number;
	timeoutSecs: number;
	devMount?: DevFolderMount;
}

export interface BuildOutcome {
	imageId: string;
	/** `.Config.WorkingDir` of the image `startBuild` just built, captured via
	 * `docker.getImage(imageId).inspect()` - this codebase talks to the host socket through dockerode
	 * only, never a shelled-out `docker inspect` (`actor-driver.md`'s "`imageWorkingDirectory` is
	 * captured by the driver itself" bullet). Unset when the inspect call itself failed
	 * (logged, never fails the build) or when the working directory was empty/`/` (mounting over `/`
	 * would destroy the container). */
	imageWorkingDirectory?: string;
}

/**
 * Why a candidate dev-folder path was rejected by the host-side existence probe (`actor-driver.md`'s
 * "Registration validates the path in two layers" bullet), classified by error shape, most specific
 * first:
 *  - `unreachable`: no HTTP response at all (raw socket error, or the driver already knows Docker is
 *    unavailable) - never asserted as "does not exist".
 *  - `image-missing`: the probe's own image (the Actor's latest successfully-built image) returned 404
 *    - an operational fault, not a bad path.
 *  - `not-found`: the daemon's mount-validation rejection message contained the exact substring
 *    `"bind source path does not exist"` - the one case allowed to say so.
 *  - `unknown`: any other mount-validation-shaped rejection (not a directory, a Docker Desktop
 *    file-sharing denial, a permission error, ...) - reported as "could not verify", never as missing.
 */
export type DevFolderProbeFailureReason = 'unreachable' | 'image-missing' | 'not-found' | 'unknown';

export type DevFolderProbeOutcome = { ok: true } | { ok: false; reason: DevFolderProbeFailureReason };

export interface RunOutcome {
	exitCode: number;
	/**
	 * True when the driver stopped the container itself because `timeoutSecs` elapsed, rather than the
	 * Actor process exiting on its own. `container.wait()` resolves either way with just an exit code,
	 * so the driver is the only place that still knows *why* the container stopped - the caller maps
	 * this to the `TIMED-OUT` status instead of `FAILED`.
	 */
	timedOut: boolean;
}

/**
 * Thrown by `Driver.startBuild` when the driver itself killed the build because `timeoutSecs` elapsed
 * (as opposed to any other build failure, which surfaces as a plain `Error`). The caller maps this to
 * the `TIMED-OUT` status instead of `FAILED`.
 */
export class DriverTimedOutError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'DriverTimedOutError';
	}
}

/**
 * The Docker driver's surface. `available` reflects whether the host Docker socket was reachable at
 * startup - when it is not (this sandbox has none), builds and runs fail fast with a clear status
 * message instead of hanging, and every other endpoint (storages, actors-as-records, console) keeps
 * working.
 */
export interface Driver {
	readonly available: boolean;
	readonly unavailableReason?: string;

	init(): Promise<void>;

	startBuild(ctx: BuildContext, onLog: (chunk: string) => void): Promise<BuildOutcome>;
	abortBuild(buildId: string): Promise<void>;

	startRun(ctx: RunContext, onLog: (chunk: string) => void): Promise<RunOutcome>;
	abortRun(runId: string): Promise<void>;

	/** Startup reconciliation: any run container this process no longer tracks is removed. Build
	 * records have no container of their own to reconcile (see `DockerDriver.reconcileOrphans`'s doc
	 * comment) - orphaned build *records* are still marked `ABORTED` by the caller regardless. */
	reconcileOrphans(runIds: string[]): Promise<void>;

	/**
	 * Host-side existence probe for a candidate dev-folder path (`actor-driver.md`'s "Registration
	 * validates the path in two layers" bullet), used only by `services/actors.ts: setDevFolder` -
	 * never by the build/run lifecycle. Deliberately
	 * **optional**: every pre-existing stub `Driver` throughout the test suite (none of which model a
	 * real dockerode handle - `test/integration/helpers/test-server.ts` and several integration test
	 * files construct `Driver` literals directly) keeps compiling unchanged, since only `DockerDriver`
	 * and drivers built specifically to exercise dev-folder registration need to implement it. A driver
	 * that doesn't implement this is treated by `setDevFolder` as unable to verify the path (the
	 * `unreachable` outcome), which is an accurate description of every such stub - none of them talk to
	 * a real daemon.
	 */
	probeDevFolder?(candidatePath: string, imageId: string): Promise<DevFolderProbeOutcome>;
}

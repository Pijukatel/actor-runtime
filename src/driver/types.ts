import type { SourceFile } from '../storage/entities.js';

export interface BuildContext {
	buildId: string;
	actorName: string;
	sourceFiles: SourceFile[];
	useCache: boolean;
	timeoutSecs: number;
}

/** Host folder + image working directory, carried together so "both or neither" is enforced by the
 * type itself (`actor-driver.md`'s "The mount is applied only when both a registered dev folder and a
 * known working directory exist" rule). */
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
	/** `.Config.WorkingDir` of the image just built (`docker.getImage(imageId).inspect()`, never a
	 * shelled-out `docker inspect`). Unset when the inspect failed or the working directory was empty/`/`
	 * (mounting over `/` would destroy the container). */
	imageWorkingDirectory?: string;
}

/** Why a candidate dev-folder path was rejected by the host-side existence probe, classified by error
 * shape, most specific first (`actor-driver.md`'s "Registration validates the path in two layers"):
 * `unreachable` (no HTTP response at all), `image-missing` (the probe's own image 404s - an operational
 * fault, not a bad path), `not-found` (the daemon's rejection contained the exact substring "bind source
 * path does not exist" - the one case allowed to say so), `not-a-directory` (the daemon's rejection
 * contained the exact substring "not a directory" - the candidate exists but is a regular file, not a
 * directory: registration accepts only directories), `unknown` (any other mount-shaped rejection -
 * reported as "could not verify", never as missing or as "not a directory"). */
export type DevFolderProbeFailureReason = 'unreachable' | 'image-missing' | 'not-found' | 'not-a-directory' | 'unknown';

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

	/** Host-side existence-and-directory probe for a candidate dev-folder path (`actor-driver.md`'s
	 * "Registration validates the path in two layers" bullet), used only by
	 * `services/dev-folder.ts: setDevFolder` - never by the build/run lifecycle. `imageId` is the
	 * runtime's own probe image (`ensureProbeImage` below) - registration never depends on the Actor
	 * having any build of its own. Required on every `Driver`, including test stubs that never exercise
	 * dev-folder registration - keeps this a genuine part of the interface rather than an optional method
	 * with a permanently-dead, permanently-untested fallback for "not implemented". */
	probeDevFolder(candidatePath: string, imageId: string): Promise<DevFolderProbeOutcome>;

	/** Builds (on first call) and returns the id of the runtime's own minimal image used only to give
	 * `probeDevFolder` above something host-present to create its throwaway container against - nothing
	 * about the image's contents matters, only that Docker will accept it. Idempotent: a later call
	 * reuses the same image without rebuilding. Never the Actor's own build - registering a dev folder
	 * must work for an Actor that has never been built at all. */
	ensureProbeImage(): Promise<string>;
}

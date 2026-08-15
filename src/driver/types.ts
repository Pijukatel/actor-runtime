import type { SourceFile } from '../storage/entities.js';

export interface BuildContext {
	buildId: string;
	actorName: string;
	sourceFiles: SourceFile[];
	useCache: boolean;
	timeoutSecs: number;
}

export interface RunContext {
	runId: string;
	imageId: string;
	env: Record<string, string>;
	memoryMbytes: number;
	timeoutSecs: number;
}

export interface BuildOutcome {
	imageId: string;
}

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
}

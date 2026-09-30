import type { SourceFile } from '../storage/entities.js';

export interface BuildContext {
	buildId: string;
	actorName: string;
	sourceFiles: SourceFile[];
	useCache: boolean;
	timeoutSecs: number;
	/** Tar-relative path to the Dockerfile to build, passed as dockerode's `dockerfile` build option. */
	dockerfilePath: string;
	/** Docker build arguments; absent for an ordinary push, so its build logs no unused-argument warning. */
	buildArgs?: Record<string, string>;
}

/** Host folder + image working directory, carried together so "both or neither" is enforced by the
 * type itself (`actor-driver.md`'s "The mount is applied only when both a registered dev folder and a
 * known working directory exist" rule). */
export interface DevFolderMount {
	localDevFolder: string;
	imageWorkingDirectory: string;
}

/** What a debug run's container needs beyond the ordinary `RunContext` shape - resolved language and
 * port to expose-and-publish. Debug env vars (`NODE_OPTIONS`/`PYTHONPATH`) are already merged into
 * `RunContext.env` by this point; `debug` carries only what `startRun` acts on directly (port
 * binding, the attach log line, the debugpy payload upload). */
export interface DebugRunTarget {
	language: 'node' | 'python';
	port: number;
}

export interface RunContext {
	runId: string;
	imageId: string;
	env: Record<string, string>;
	memoryMbytes: number;
	/** `0` means no timeout. */
	timeoutSecs: number;
	/** Set for a standby run: the port its HTTP server listens on, which the runtime must be able to reach. */
	containerServerPort?: number;
	devMount?: DevFolderMount;
	debug?: DebugRunTarget;
	/** Volume from `BrowserViewerHandle`, mounted over the Actor container's `/tmp/.X11-unix`. */
	x11SocketVolume?: string;
}

export interface BrowserViewerTarget {
	runId: string;
	interactive: boolean;
}

/** A started sidecar: its VNC address on `apify-local`, and the X-socket volume the Actor container must mount. */
export interface BrowserViewerHandle {
	vncHost: string;
	vncPort: number;
	x11SocketVolume: string;
}

/** What `Driver.inspectDebugTarget` reads off a run's resolved build image, for
 * `services/debug-mode.ts: resolveDebugPlan`. `cmd` is `Config.Cmd` verbatim (shell-form, unparsed).
 * `entrypoint` is `Config.Entrypoint` normalized to an array. `env` carries only the four vars the
 * language heuristic needs. */
export interface InspectedDebugTarget {
	cmd?: string[];
	entrypoint?: string[];
	env: {
		PYTHONPATH?: string;
		NODE_OPTIONS?: string;
		PYTHON_VERSION?: string;
		NODE_VERSION?: string;
	};
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

/**
 * One CPU/memory measurement of a live run's container, taken by the driver's own per-run sampler
 * (`docker-driver.ts`'s `startResourceSampler`) and handed to `startRun`'s optional `onSample` callback -
 * plain numbers (plus a `Date`), never a `dockerode` type, same as every other value that crosses the
 * `Driver` boundary. Shaping this into the platform's `systemInfo` envelope (percent-of-grant math,
 * running avg/max, `isCpuOverloaded`) is `services/events-channel.ts`'s job, not the driver's - the
 * driver only measures.
 */
export interface RunResourceSample {
	/** CPU usage as percent of one core - `docker stats`' convention, not percent of the run's grant. */
	cpuPercentOfOneCore: number;
	/** Current memory usage in bytes, with the reclaimable page cache subtracted. */
	memoryBytes: number;
	/** The container's configured memory limit in bytes - constant, never an observed peak. */
	memoryLimitBytes: number;
	/** When this sample was taken. */
	at: Date;
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

/** Where this process reaches a run's HTTP server. */
export interface ContainerServerAddress {
	host: string;
	port: number;
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

/** Thrown by `Driver.startRun` when a debug run's host debug port is already bound by something else.
 * Carries only the port; `services/runs.ts` builds the user-facing message via
 * `services/debug-mode.ts: describeDebugPortConflict`. */
export class DebugPortInUseError extends Error {
	readonly port: number;

	constructor(port: number) {
		super(`Debug port ${port} is already in use`);
		this.name = 'DebugPortInUseError';
		this.port = port;
	}
}

/** How hard `Driver.abortRun` stops the run's container. The engine's own default grace is never used:
 * an Actor image's PID 1 is the Actor itself, which installs no handler for the stop signal, so that
 * grace is spent ignoring it before the `SIGKILL` lands anyway. */
export interface AbortRunOptions {
	/** Seconds between the stop signal and `SIGKILL`. `0` (the default) kills outright. */
	graceSecs?: number;
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

	/**
	 * `onSample`, when given, is called roughly once per second for the lifetime of the run with a
	 * `RunResourceSample` measured from the run's own container. Optional so existing `Driver`
	 * implementations keep compiling unchanged.
	 */
	startRun(
		ctx: RunContext,
		onLog: (chunk: string) => void,
		onSample?: (sample: RunResourceSample) => void,
	): Promise<RunOutcome>;
	abortRun(runId: string, options?: AbortRunOptions): Promise<void>;

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

	/** Reads back the image's `Config.Cmd`/`Config.Entrypoint` and env for
	 * `services/debug-mode.ts: resolveDebugPlan`. Called only when the run's Actor has debug mode on. */
	inspectDebugTarget(imageId: string): Promise<InspectedDebugTarget>;

	/** Starts the run's browser-view sidecar (called before the run's own container). Rejects when the
	 * runtime is not running from its own built image (no sidecar payload on disk). */
	startBrowserViewer(target: BrowserViewerTarget): Promise<BrowserViewerHandle>;

	/** Removes the run's sidecar and volume. Idempotent; never rejects. */
	stopBrowserViewer(runId: string): Promise<void>;

	/** Where the run's current container serves `RunContext.containerServerPort`, or `undefined` while
	 * the run has no started container with one. Changes when a migration restarts the container. */
	containerServerAddress(runId: string): Promise<ContainerServerAddress | undefined>;
}

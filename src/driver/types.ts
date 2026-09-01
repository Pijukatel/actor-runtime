import type { SourceFile } from '../storage/entities.js';

export interface BuildContext {
	buildId: string;
	actorName: string;
	sourceFiles: SourceFile[];
	useCache: boolean;
	timeoutSecs: number;
	/** Tar-relative path to the Dockerfile to build, passed as dockerode's `dockerfile` build option. */
	dockerfilePath: string;
}

/** Host folder + image working directory, carried together so "both or neither" is enforced by the
 * type itself (`actor-driver.md`'s "The mount is applied only when both a registered dev folder and a
 * known working directory exist" rule). */
export interface DevFolderMount {
	localDevFolder: string;
	imageWorkingDirectory: string;
}

/** What a debug run's container needs from the driver beyond the ordinary `RunContext` shape - the
 * resolved language (which log line/attach instructions to print, and whether the debugpy payload needs
 * injecting) and the port to expose-and-publish. The env entries a resolved `DebugPlan` adds
 * (`NODE_OPTIONS`/`PYTHONPATH`) are already merged into `RunContext.env` by the time this reaches the
 * driver - `debug` carries only what `docker-driver.ts`'s `startRun` needs to act on directly
 * (`ExposedPorts`/`PortBindings`, the attach log line, the debugpy payload upload). The driver has no
 * concept of the Actor id or of the toggle's HTTP surface: on a port conflict it throws
 * `DebugPortInUseError` (below) with just the port, and `services/runs.ts` - which has the Actor record
 * in hand - turns that into the user-facing remediation via `services/debug-mode.ts:
 * describeDebugPortConflict`. A typed driver error carrying just enough for the service layer, which owns
 * the Actor record and the toggle's HTTP surface, to word the remedy - analogous to `DriverTimedOutError`
 * below as a typed-driver-error precedent, though that one's own caller only maps status and keeps the
 * driver's own message verbatim (`services/builds.ts`), so the wording split here is new. */
export interface DebugRunTarget {
	language: 'node' | 'python';
	port: number;
}

export interface RunContext {
	runId: string;
	imageId: string;
	env: Record<string, string>;
	memoryMbytes: number;
	timeoutSecs: number;
	devMount?: DevFolderMount;
	debug?: DebugRunTarget;
}

/** What `Driver.inspectDebugTarget` reads off a run's resolved build image - just enough for
 * `services/debug-mode.ts: resolveDebugPlan` to resolve a debug plan, never a raw `dockerode` type (same
 * boundary discipline as `DevFolderMount`/`BuildOutcome` above). `cmd` is `Config.Cmd` verbatim - a
 * shell-form Dockerfile `CMD` already arrives here as `['/bin/sh', '-c', '...']`, since that is how the
 * daemon itself stores it; no shell parsing happens anywhere in this codebase. `entrypoint` is
 * `Config.Entrypoint` normalized to an array (the Engine API returns it as either a string or a
 * string array; `docker-driver.ts: inspectDebugTarget` does the one-element-array wrapping for a
 * string-form value before this type ever sees it), never the raw string form. `env` carries only the
 * four vars the language heuristic and the env-merge precedence actually need (`PYTHONPATH`/
 * `NODE_OPTIONS` for prepending, `PYTHON_VERSION`/`NODE_VERSION` as the base-image fingerprint of last
 * resort). */
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
 * Thrown by `Driver.startRun` when a debug run's container fails to start because its configured host
 * debug port is already bound by something else (`docker-driver.ts`'s `isPortInUseError` classifies the
 * daemon's rejection). Carries only the port - the driver has no Actor id and no opinion on the toggle's
 * HTTP surface, so it does not compose the user-facing remediation itself; `services/runs.ts` catches
 * this and hands `port` (plus the Actor it already has in hand) to `services/debug-mode.ts:
 * describeDebugPortConflict` to build that text - a typed driver error so the service layer, which owns
 * the Actor record and the toggle's HTTP surface, can word the remedy. Analogous to `DriverTimedOutError`
 * above as a typed-driver-error precedent, but not the same split: that error's own caller
 * (`services/builds.ts`) only maps it to a status and stores the driver's own message verbatim: the
 * wording split here is new.
 */
export class DebugPortInUseError extends Error {
	readonly port: number;

	constructor(port: number) {
		super(`Debug port ${port} is already in use`);
		this.name = 'DebugPortInUseError';
		this.port = port;
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

	/** Reads back the image's own `Config.Cmd`/`Config.Entrypoint` and the four env vars
	 * `services/debug-mode.ts: resolveDebugPlan` needs - the debug-mode analog of
	 * `inspectWorkingDirectory` (private to `docker-driver.ts`, since only this module's own dev-folder
	 * mount needs it). Called only when the run's Actor has debug mode on (`services/runs.ts`), never for
	 * an ordinary run - unlike `inspectWorkingDirectory`, which runs unconditionally right after every
	 * build. */
	inspectDebugTarget(imageId: string): Promise<InspectedDebugTarget>;
}

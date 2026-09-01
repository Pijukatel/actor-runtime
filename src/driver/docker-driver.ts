/**
 * The Docker driver: build/run Actor images over the host Docker socket via `dockerode`. Every Actor
 * container joins the `apify-local` network so it can resolve the runtime's own container by the
 * fixed DNS alias `apify-api` (`actor-driver.md`). Storage access is HTTP-only; the only filesystem
 * bind mounts this driver ever adds are the optional local-dev-folder mount on a real run
 * (`RunContext.devMount`, see `startRun` below) - conditional, never unconditional, on every Actor's
 * container - and the read-only probe mount `probeDevFolder` creates to validate a candidate dev folder
 * before it is ever registered (see below), whose container is never started.
 *
 * `probeDevFolder`'s container is created against `ensureProbeImage`'s own minimal image, not any
 * Actor's build - registering a dev folder must work for an Actor that has never been built. That image
 * is a one-line `FROM scratch` Dockerfile built the same `buildImage`-plus-in-memory-tar way as an Actor
 * build, so it needs no network access; built lazily on first use and reused after that, never rebuilt
 * per registration.
 *
 * Genuine cancellation: `docker.buildImage()` accepts an `abortSignal` option that dockerode forwards
 * all the way to Node's `http.request({ signal })` (`docker-modem/lib/modem.js`: `optionsf.signal =
 * options.abortSignal`, then `http[...].request(opts, ...)` in `buildRequest`) - aborting it destroys
 * the in-flight HTTP request to the daemon, and `followProgress`'s stream then emits `error`/`close`
 * (`dockerode/lib/buildkit.js`'s `onStreamError`), so `startBuild`'s promise settles instead of hanging
 * or silently ignoring the abort. One `AbortController` is kept per in-flight build, keyed by build id,
 * so `abortBuild` can call `.abort()` on the live one. Runs are cancelled the same way as before -
 * `container.stop()` - since there is no HTTP request to abort there.
 *
 * Unverified in this sandbox: there is no Docker socket here, so `init()` always finds
 * `available: false` and every build/run fails fast with a clear status message instead of hanging.
 * The rest of the runtime (storages, actors-as-records, console) is unaffected.
 */
import { PassThrough } from 'node:stream';
import { readFile } from 'node:fs/promises';
import Docker from 'dockerode';
import * as tar from 'tar-stream';

import { CONTAINER_API_ALIAS, debugpyPayloadTarPath, debugpyVersionFilePath } from '../config.js';
import { CPU_PERIOD_US, cpuQuotaFor, dedicatedCpusFor } from '../resources.js';
import { normalizeEntryName } from './tar-entry-name.js';
import type { SourceFile } from '../storage/entities.js';
import {
	DriverTimedOutError,
	type BuildContext,
	type BuildOutcome,
	type DevFolderMount,
	type DevFolderProbeFailureReason,
	type DevFolderProbeOutcome,
	type Driver,
	type InspectedDebugTarget,
	type RunContext,
	type RunOutcome,
	type RunResourceSample,
} from './types.js';

const NETWORK_NAME = 'apify-local';
const RUN_LABEL = 'actor-runtime.runId';
/** Marks a create-only dev-folder-probe container (`probeDevFolder` below) so `reconcileOrphans` can
 * sweep one that outlived its own removal call. */
const PROBE_LABEL = 'actor-runtime.devFolderProbe';
/** Target path for the probe container's mount - arbitrary, since the probe is never started and
 * nothing ever reads from it. */
const PROBE_MOUNT_TARGET = '/probe';
/** Tag for `ensureProbeImage`'s own minimal image - built and owned by this driver, never an Actor's.
 * An explicit `:probe` suffix, deliberately never `latest` (Docker's own implicit default for an
 * untagged name) - this image has nothing to do with an Actor's `latest`-tagged build, and an untagged
 * name would silently print as `...probe:latest` and invite exactly that confusion. */
const PROBE_IMAGE_TAG = 'actor-runtime/dev-folder-probe:probe';
/**
 * `FROM scratch` with nothing else would build fine but fails every `createContainer` against it with
 * HTTP 400 "no command specified" (moby refuses to create a container for an image with no `Cmd`/
 * `Entrypoint`) - which would look exactly like a bad candidate path if left undiagnosed. `CMD` fixes
 * that; the command itself is never exec'd, since `probeDevFolder`'s container is created but never
 * started. Verified empirically against a real daemon: builds and creates with no network access.
 */
const PROBE_DOCKERFILE = 'FROM scratch\nCMD ["/nonexistent"]\n';
/** The daemon's own fixed error-message substring for a `Mounts`-type bind whose source is missing
 * (moby's `daemon/volume/mounts/validate.go: errBindSourceDoesNotExist`) - the one rejection shape
 * `classifyProbeError` reports as "does not exist" rather than a generic "could not verify". */
const BIND_SOURCE_MISSING_SUBSTRING = 'bind source path does not exist';
/** The daemon's own fixed error-message substring (moby's mount validation, `stat <path>: not a
 * directory`) for a bind source that exists but is a regular file, not a directory - reachable only
 * because the probe below appends `/.` to the candidate path (see `probeDevFolder`'s doc comment): a
 * trailing `/.` on a file path forces the stat that produces exactly this message, discriminating a file
 * from a directory in the same create-only call that already discriminates missing from present. The one
 * rejection shape `classifyProbeError` reports as "not a directory" rather than a generic "could not
 * verify", and never as "does not exist". */
const NOT_A_DIRECTORY_SUBSTRING = 'not a directory';
/** Substrings the Docker daemon's own `container.start()` rejection carries for "the requested host
 * port is already bound by something else" - covers both the classic message and the newer moby
 * wording, so `startRun`'s debug-port-conflict message (`actor-driver.md`) fires on either. */
const PORT_IN_USE_SUBSTRINGS = ['port is already allocated', 'address already in use'];

/** Per-run CPU/memory sampling cadence - decided, not tunable via env in this PR. A single module
 * constant, so it is trivially adjustable later if per-second `stats()` calls against the daemon (up to
 * one per concurrently running Actor, `system.md`'s scale budget) ever prove too much load. */
const SAMPLE_INTERVAL_MS = 1000;
/** Bounds `stop()`'s wait on the in-flight `stats()` call. The daemon client is built without a request
 * timeout, so an unanswered call would otherwise hold a run's finalization open forever; a call that
 * outlives this grace is abandoned, and `stopped` suppresses its result. Mirrors `LOG_DRAIN_GRACE_MS`. */
const SAMPLER_STOP_GRACE_MS = 5000;

/** Host capacity, snapshotted once at `init()`. Absent means "unknown", never "zero". */
interface HostCapacity {
	ncpu: number;
	memTotalBytes: number;
}

/** Narrows an unknown rejection to the shape `docker-modem` attaches to a daemon HTTP-level error
 * response (`Modem.prototype.buildPayload`: `msg.statusCode = res.statusCode`) - present only when the
 * daemon actually answered; a raw transport failure (socket refused/missing) carries no `statusCode` at
 * all, which is exactly the distinction `classifyProbeError`'s first branch depends on. */
function hasStatusCode(error: unknown): error is Error & { statusCode: number } {
	return (
		typeof error === 'object' &&
		error !== null &&
		'statusCode' in error &&
		typeof (error as { statusCode: unknown }).statusCode === 'number'
	);
}

/** Classifies a `createContainer` rejection from `probeDevFolder`, most specific first - see
 * `DevFolderProbeFailureReason`'s doc comment in `driver/types.ts` for what each outcome means and why
 * a permission error/Docker Desktop file-sharing denial must never be asserted as "does not exist" or
 * "not a directory". */
function classifyProbeError(error: unknown): DevFolderProbeFailureReason {
	if (!hasStatusCode(error)) return 'unreachable';
	if (error.statusCode === 404) return 'image-missing';
	if (error.message.includes(BIND_SOURCE_MISSING_SUBSTRING)) return 'not-found';
	if (error.message.includes(NOT_A_DIRECTORY_SUBSTRING)) return 'not-a-directory';
	return 'unknown';
}

/** True when a rejection from `container.start()` looks like "the requested host port is already bound
 * by something else on this host" - `startRun` maps this to a message naming the port and the `port`
 * override (`actor-driver.md`'s "Port publishing" section), rather than the daemon's own generic wording. */
function isPortInUseError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return PORT_IN_USE_SUBSTRINGS.some((substring) => message.includes(substring));
}

function sourceFileToBuffer(file: SourceFile): Buffer {
	return file.format === 'BASE64' ? Buffer.from(file.content, 'base64') : Buffer.from(file.content, 'utf8');
}

function buildTarball(sourceFiles: SourceFile[]): NodeJS.ReadableStream {
	const pack = tar.pack();
	for (const file of sourceFiles) {
		const buffer = sourceFileToBuffer(file);
		pack.entry({ name: normalizeEntryName(file.name) }, buffer);
	}
	pack.finalize();
	return pack;
}

/** An in-memory tar containing only a `Dockerfile` - the same `buildImage`-plus-tar-stream path an Actor
 * build uses (`buildTarball` above), reused here to build `ensureProbeImage`'s own image. */
function dockerfileTarball(contents: string): NodeJS.ReadableStream {
	const pack = tar.pack();
	pack.entry({ name: 'Dockerfile' }, Buffer.from(contents, 'utf8'));
	pack.finalize();
	return pack;
}

/** The `cpu_stats` fields the sampler diffs between two of its own successive samples. */
interface CpuUsageSnapshot {
	totalUsage: number;
	systemUsage: number;
}

/**
 * `memory_stats.usage` minus the reclaimable page cache, the same adjustment `docker stats`' MEM USAGE
 * column makes (cgroup v1 reports it as `total_inactive_file`, v2 as `inactive_file`). Subtracted only
 * when smaller than `usage`, so the result can never go negative. `undefined` when `usage` is missing or
 * non-finite, which makes `takeSample` skip the tick rather than emit a partial frame.
 */
function memoryUsageBytesExcludingCache(stats: Docker.ContainerStats): number | undefined {
	const usage = stats.memory_stats?.usage;
	if (typeof usage !== 'number' || !Number.isFinite(usage)) return undefined;
	const memStats = stats.memory_stats.stats as { total_inactive_file?: number; inactive_file?: number } | undefined;
	const cacheBytes = memStats?.total_inactive_file ?? memStats?.inactive_file;
	return cacheBytes !== undefined && cacheBytes < usage ? usage - cacheBytes : usage;
}

/**
 * Presence-and-finiteness guard for the two `cpu_stats` fields the delta reads. A missing field skips the
 * tick instead of throwing or producing a `NaN`. `online_cpus` is excluded: it has a sane `|| 1` fallback.
 */
function cpuUsageSnapshotOf(stats: Docker.ContainerStats): CpuUsageSnapshot | undefined {
	const totalUsage = stats.cpu_stats?.cpu_usage?.total_usage;
	const systemUsage = stats.cpu_stats?.system_cpu_usage;
	if (typeof totalUsage !== 'number' || !Number.isFinite(totalUsage)) return undefined;
	if (typeof systemUsage !== 'number' || !Number.isFinite(systemUsage)) return undefined;
	return { totalUsage, systemUsage };
}

/**
 * Samples an already-running container once per `SAMPLE_INTERVAL_MS`, reporting CPU as percent of one
 * core. The delta is computed against this sampler's own previous sample rather than the response's
 * `precpu_stats`, which `'one-shot': true` does not reliably populate; an unemitted baseline read seeds
 * it. `stop()` awaits the at-most-one in-flight call, bounded by `SAMPLER_STOP_GRACE_MS`. A tick that
 * finds the previous call still in flight is skipped, keeping "at most one in flight" an invariant.
 */
function startResourceSampler(
	container: Docker.Container,
	memoryLimitBytes: number,
	onSample: (sample: RunResourceSample) => void,
): { stop(): Promise<void> } {
	let stopped = false;
	let previous: CpuUsageSnapshot | undefined;
	let inFlight: Promise<void> | undefined;

	const takeSample = async (emit: boolean): Promise<void> => {
		let stats: Docker.ContainerStats;
		try {
			stats = await container.stats({ stream: false, 'one-shot': true });
		} catch {
			// The container may have already exited (or be mid-removal) by the time this particular tick's
			// round trip lands - not an error condition for the sampler itself, just a skipped sample.
			return;
		}
		if (stopped) return; // `stop()` raced this call to completion - never emit after stop.

		const current = cpuUsageSnapshotOf(stats);
		const memoryBytes = memoryUsageBytesExcludingCache(stats);
		if (!current || memoryBytes === undefined) {
			// This tick's stats blob is missing (or reports non-finite for) a field a complete eight-field
			// `systemInfo` frame needs - skipped exactly like the rejecting-stats case above: no emission,
			// `previous` left untouched. Never emit a partial frame (a frame missing even one field fails
			// Python-SDK-side pydantic validation and is silently dropped there), and never let a
			// `NaN`/`undefined` reach `events-channel.ts`'s running avg/max accumulators, which would poison
			// every later frame of the run, not just this one tick.
			return;
		}

		if (emit && previous) {
			const cpuDelta = current.totalUsage - previous.totalUsage;
			const systemDelta = current.systemUsage - previous.systemUsage;
			const onlineCpus = stats.cpu_stats.online_cpus || 1;
			// `systemDelta` is 0 only in a degenerate case (no host-wide CPU time elapsed between two
			// samples, e.g. two calls landing on the very same daemon tick) - reported as 0% rather than
			// producing NaN/Infinity.
			const cpuPercentOfOneCore = systemDelta > 0 ? (cpuDelta / systemDelta) * onlineCpus * 100 : 0;
			onSample({
				cpuPercentOfOneCore,
				memoryBytes,
				memoryLimitBytes,
				at: new Date(),
			});
		}
		previous = current;
	};

	// The unemitted baseline read (see doc comment above) - kicked off synchronously so `inFlight` is
	// already set before this function returns, exactly like every later tick.
	inFlight = takeSample(false).finally(() => {
		inFlight = undefined;
	});

	const timer = setInterval(() => {
		if (stopped || inFlight) return; // never overlap a still-in-flight call (see doc comment above).
		inFlight = takeSample(true).finally(() => {
			inFlight = undefined;
		});
	}, SAMPLE_INTERVAL_MS);

	return {
		async stop() {
			stopped = true;
			clearInterval(timer);
			if (!inFlight) return;
			// Bounded per `SAMPLER_STOP_GRACE_MS`'s own doc comment - a `stats()` call that never settles must
			// never leave this `await` (and everything waiting on it) unbounded. The grace timer's own handle
			// is captured and cleared once the race settles either way, so the common case (`inFlight` wins
			// well inside the grace window) never leaves an armed timer behind on the event loop.
			let graceTimer: ReturnType<typeof setTimeout> | undefined;
			await Promise.race([
				inFlight,
				new Promise<void>((resolve) => {
					graceTimer = setTimeout(resolve, SAMPLER_STOP_GRACE_MS);
				}),
			]).finally(() => clearTimeout(graceTimer));
		},
	};
}

export class DockerDriver implements Driver {
	private readonly docker: Docker;
	/** One `AbortController` per in-flight `startBuild` call, keyed by build id - `abortBuild` aborts it. */
	private readonly buildControllers = new Map<string, AbortController>();
	/** Build/run ids the driver itself killed via its own `timeoutSecs` timer, consumed exactly once by
	 * the corresponding `startBuild`/`startRun` call to tell a timeout apart from every other way a
	 * build/run can end (`DriverTimedOutError` for builds, `RunOutcome.timedOut` for runs). */
	private readonly timedOutBuilds = new Set<string>();
	private readonly timedOutRuns = new Set<string>();
	private readonly runContainers = new Map<string, Docker.Container>();
	/** The host's own CPU/memory capacity, snapshotted once at `init()` time - `undefined` when
	 * `docker.info()` threw or omitted either field, meaning "capacity unknown" (see
	 * `captureHostCapacity`'s doc comment). */
	private hostCapacity: HostCapacity | undefined;
	/** Set once `ensureProbeImage` has actually built (or found) the probe image - every later call
	 * returns this without touching the daemon again. */
	private probeImageId: string | undefined;
	/** In-flight build, shared by every concurrent `ensureProbeImage` caller so the image is never built
	 * twice at once; cleared on failure so a later call gets to retry rather than replaying the same
	 * rejection forever. */
	private probeImageBuild: Promise<string> | undefined;
	/** The Python debug payload tar + its debugpy version string, read from disk (`config.ts`'s
	 * `debugpyPayloadTarPath`/`debugpyVersionFilePath`) at most once and reused for every later Python
	 * debug run - never re-read per run, and never read at all for a runtime that never runs a Python
	 * debug run in its whole process lifetime. */
	private debugPayload: { tar: Buffer; debugpyVersion: string } | undefined;

	available = false;
	unavailableReason: string | undefined;

	/** `docker` is injectable (defaults to a real `Docker()` socket client) so tests can pass a stub
	 * `dockerode`-shaped object - there is no Docker daemon in this sandbox to test against for real. */
	constructor(docker: Docker = new Docker()) {
		this.docker = docker;
	}

	async init(): Promise<void> {
		try {
			await this.docker.ping();
		} catch (error) {
			this.available = false;
			this.unavailableReason = `Docker socket is not reachable: ${(error as Error).message}`;
			return;
		}

		// A `docker.info()` failure must not make an otherwise-reachable daemon look unavailable.
		await this.captureHostCapacity();

		try {
			await this.ensureNetwork();
			await this.selfAttachToNetwork();
			this.available = true;
		} catch (error) {
			this.available = false;
			this.unavailableReason = `Docker network setup failed: ${(error as Error).message}`;
		}
	}

	/**
	 * Best-effort snapshot of the host's CPU count and total memory. A missing field or a failed call
	 * leaves `hostCapacity` unset - "unknown", which warns about nothing rather than warning on every run.
	 */
	private async captureHostCapacity(): Promise<void> {
		try {
			const info: unknown = await this.docker.info();
			const ncpu = (info as { NCPU?: unknown } | undefined)?.NCPU;
			const memTotalBytes = (info as { MemTotal?: unknown } | undefined)?.MemTotal;
			if (typeof ncpu === 'number' && typeof memTotalBytes === 'number') {
				this.hostCapacity = { ncpu, memTotalBytes };
			}
		} catch {
			// Capacity stays unknown - see the doc comment above.
		}
	}

	/**
	 * A warning naming the requested and host figures for whichever resource is over capacity. The limits
	 * are applied verbatim regardless; `undefined` covers both "in capacity" and "capacity unknown".
	 */
	private buildOverCapacityWarning(ctx: RunContext): string | undefined {
		if (!this.hostCapacity) return undefined;

		const requestedCores = dedicatedCpusFor(ctx.memoryMbytes);
		const hostMemoryMbytes = this.hostCapacity.memTotalBytes / (1024 * 1024);
		const memoryOverCapacity = ctx.memoryMbytes > hostMemoryMbytes;
		const cpuOverCapacity = requestedCores > this.hostCapacity.ncpu;
		if (!memoryOverCapacity && !cpuOverCapacity) return undefined;

		const overCapacityParts: string[] = [];
		if (memoryOverCapacity) {
			overCapacityParts.push(`${ctx.memoryMbytes} MB (host has ${Math.round(hostMemoryMbytes)} MB)`);
		}
		if (cpuOverCapacity) {
			overCapacityParts.push(`${requestedCores.toFixed(2)} CPU cores (host has ${this.hostCapacity.ncpu})`);
		}

		return (
			`Requested ${overCapacityParts.join(' and ')} — applying the requested limits anyway; this ` +
			`container is scheduled against resources the host does not have.\n`
		);
	}

	private async ensureNetwork(): Promise<void> {
		const networks = await this.docker.listNetworks({ filters: JSON.stringify({ name: [NETWORK_NAME] }) });
		if (networks.some((n) => n.Name === NETWORK_NAME)) return;
		await this.docker.createNetwork({ Name: NETWORK_NAME, Driver: 'bridge' });
	}

	private async selfAttachToNetwork(): Promise<void> {
		// Docker sets the container hostname to its own short id by default; this is a best-effort
		// self-identification that only matters when this process itself runs inside a container
		// (the shipped runtime image) - a bare `node dist/index.js` on the host skips it harmlessly.
		const selfId = process.env.HOSTNAME;
		if (!selfId) return;

		const network = this.docker.getNetwork(NETWORK_NAME);
		const info = await network.inspect().catch(() => undefined);
		if (info?.Containers?.[selfId]) return; // already attached

		await network
			.connect({ Container: selfId, EndpointConfig: { Aliases: [CONTAINER_API_ALIAS] } })
			.catch((error: Error) => {
				// Not fatal: most likely we are not actually running inside a container right now
				// (local dev). Actor containers still get the network; only the alias resolution from
				// inside those containers back to us would be affected.

				console.warn(`Could not self-attach to the ${NETWORK_NAME} network: ${error.message}`);
			});
	}

	async startBuild(ctx: BuildContext, onLog: (chunk: string) => void): Promise<BuildOutcome> {
		if (!this.available) {
			throw new Error(this.unavailableReason ?? 'Docker is not available');
		}

		const imageTag = `actor-runtime/${ctx.actorName}:${ctx.buildId}`.toLowerCase();
		const tarball = buildTarball(ctx.sourceFiles);

		const controller = new AbortController();
		this.buildControllers.set(ctx.buildId, controller);
		const timeoutTimer = setTimeout(() => {
			this.timedOutBuilds.add(ctx.buildId);
			controller.abort();
		}, ctx.timeoutSecs * 1000);

		const cleanup = (): void => {
			clearTimeout(timeoutTimer);
			this.buildControllers.delete(ctx.buildId);
		};
		// Consumed exactly once, however the build ends (success, `startBuild`'s own throw below, or the
		// `followProgress` callback) - whichever site notices the flag first wins and reports TIMED-OUT.
		const asTimedOutOrOriginal = (error: Error): Error =>
			this.timedOutBuilds.delete(ctx.buildId)
				? new DriverTimedOutError(`Build exceeded its ${ctx.timeoutSecs}s timeout`)
				: error;

		let stream: NodeJS.ReadableStream;
		try {
			stream = await this.docker.buildImage(tarball, {
				t: imageTag,
				nocache: !ctx.useCache,
				dockerfile: ctx.dockerfilePath,
				abortSignal: controller.signal,
			});
		} catch (error) {
			cleanup();
			throw asTimedOutOrOriginal(error as Error);
		}

		return new Promise<BuildOutcome>((resolve, reject) => {
			this.docker.modem.followProgress(
				stream,
				// Async is fine here: TypeScript allows a `Promise<void>`-returning function where `void` is
				// expected, and `followProgress` (`docker-modem`) only ever invokes this callback once and
				// never awaits its result - `resolve`/`reject` below settle the outer Promise whenever this
				// async function actually gets there.
				async (err: Error | null, res: Array<{ stream?: string; error?: string; aux?: { ID?: string } }>) => {
					cleanup();
					if (this.timedOutBuilds.delete(ctx.buildId)) {
						reject(new DriverTimedOutError(`Build exceeded its ${ctx.timeoutSecs}s timeout`));
						return;
					}
					if (err) {
						reject(err);
						return;
					}
					const errorLine = res.find((line) => line.error);
					if (errorLine) {
						reject(new Error(errorLine.error));
						return;
					}
					const imageWorkingDirectory = await this.inspectWorkingDirectory(imageTag);
					resolve({ imageId: imageTag, imageWorkingDirectory });
				},
				(event: { stream?: string; status?: string; error?: string }) => {
					if (event.stream) onLog(event.stream);
					else if (event.status) onLog(`${event.status}\n`);
					else if (event.error) onLog(`${event.error}\n`);
				},
			);
		});
	}

	/** `.Config.WorkingDir` of the image just built, via `dockerode`, never a shelled-out
	 * `docker inspect`. An inspect failure is logged and tolerated - must never fail an otherwise-
	 * successful build - and an empty or `/` working directory is treated as unknown too: mounting a dev
	 * folder over `/` would destroy the container. */
	private async inspectWorkingDirectory(imageId: string): Promise<string | undefined> {
		try {
			const info = await this.docker.getImage(imageId).inspect();
			const workingDir = info.Config.WorkingDir;
			return workingDir && workingDir !== '/' ? workingDir : undefined;
		} catch (error) {
			console.warn(`Could not inspect image ${imageId} for its working directory: ${(error as Error).message}`);
			return undefined;
		}
	}

	/**
	 * Reads back `Config.Cmd`/`Config.Entrypoint` and the four env vars `resolveDebugPlan` needs
	 * (`services/debug-mode.ts`) - the debug-mode analog of `inspectWorkingDirectory` above, called only
	 * for a run whose Actor has debug mode on (`services/runs.ts`), never unconditionally after a build.
	 * Unlike `inspectWorkingDirectory`, an inspect failure here is NOT tolerated: silently treating an
	 * uninspectable image as "no Cmd, no Entrypoint, no env" would make `resolveDebugPlan` misreport it
	 * as unclassifiable rather than surfacing the real operational fault, so this lets the rejection
	 * propagate - `services/runs.ts`'s existing unexpected-error handling (`startRun`'s outer `.catch`)
	 * already fails the run clearly for any exception escaping this deep in the run-start path.
	 */
	async inspectDebugTarget(imageId: string): Promise<InspectedDebugTarget> {
		const info = await this.docker.getImage(imageId).inspect();
		const envList = info.Config.Env ?? [];
		const envMap: Record<string, string> = {};
		for (const entry of envList) {
			const separatorIndex = entry.indexOf('=');
			if (separatorIndex === -1) continue;
			envMap[entry.slice(0, separatorIndex)] = entry.slice(separatorIndex + 1);
		}
		// `Config.Entrypoint` is typed as `string | string[] | undefined` (the Engine API's older exec-form
		// vs. modern array-form) - normalized to an array here so every downstream consumer only ever
		// deals with one shape, same as `Config.Cmd` already is.
		const entrypointRaw = info.Config.Entrypoint;
		const entrypoint = Array.isArray(entrypointRaw) ? entrypointRaw : entrypointRaw ? [entrypointRaw] : undefined;
		return {
			cmd: info.Config.Cmd ?? undefined,
			entrypoint,
			env: {
				PYTHONPATH: envMap.PYTHONPATH,
				NODE_OPTIONS: envMap.NODE_OPTIONS,
				PYTHON_VERSION: envMap.PYTHON_VERSION,
				NODE_VERSION: envMap.NODE_VERSION,
			},
		};
	}

	/**
	 * Genuinely interrupts the in-flight build: aborts the `AbortController` passed to `buildImage` as
	 * `abortSignal`, which destroys the underlying HTTP request to the Docker daemon (see the class
	 * doc comment). A no-op if the build already finished (its controller was already cleaned up) - the
	 * caller's own terminal-status guard is what makes that safe, not this check.
	 */
	async abortBuild(buildId: string): Promise<void> {
		this.buildControllers.get(buildId)?.abort();
	}

	async startRun(
		ctx: RunContext,
		onLog: (chunk: string) => void,
		onSample?: (sample: RunResourceSample) => void,
	): Promise<RunOutcome> {
		if (!this.available) {
			throw new Error(this.unavailableReason ?? 'Docker is not available');
		}

		const env = Object.entries(ctx.env).map(([key, value]) => `${key}=${value}`);

		// Informational only - the requested limits are applied verbatim either way.
		const overCapacityWarning = this.buildOverCapacityWarning(ctx);
		if (overCapacityWarning) onLog(overCapacityWarning);

		// A secondary diagnostic for the residual risk that a folder verified at registration later
		// vanishes: written before `createContainer` so it lands even if that call is what fails.
		if (ctx.devMount) {
			onLog(
				`Mounting local dev folder ${ctx.devMount.localDevFolder} over the image's working directory ` +
					`${ctx.devMount.imageWorkingDirectory} (node_modules preserved via an anonymous volume).\n`,
			);
		}

		// Both loaded (for Python) and logged BEFORE `createContainer`, exactly like the dev-mount line
		// above: a missing payload must fail the run before any container is even created
		// (`actor-driver.md`'s "never a silent non-debug start"), and the attach line must land in the
		// log even if `createContainer` itself is what fails.
		let debugPayload: { tar: Buffer; debugpyVersion: string } | undefined;
		if (ctx.debug?.language === 'python') {
			debugPayload = await this.loadDebugPayload();
		}
		if (ctx.debug) {
			onLog(this.buildDebugLogLine(ctx.debug, ctx.timeoutSecs, debugPayload?.debugpyVersion));
		}

		const container = await this.docker.createContainer({
			Image: ctx.imageId,
			Env: env,
			Labels: { [RUN_LABEL]: ctx.runId },
			...(ctx.debug ? { ExposedPorts: { [`${ctx.debug.port}/tcp`]: {} } } : {}),
			HostConfig: {
				NetworkMode: NETWORK_NAME,
				Memory: ctx.memoryMbytes * 1024 * 1024,
				// A CFS quota, never `NanoCpus`: the daemon hard-rejects a `NanoCpus` above the host's own
				// CPU count, which would turn "warn, never clamp" into "cannot run at all". `CpuQuota` is
				// validated for range only, so an over-capacity request still starts.
				CpuPeriod: CPU_PERIOD_US,
				CpuQuota: cpuQuotaFor(ctx.memoryMbytes),
				AutoRemove: false,
				...(ctx.devMount ? { Mounts: this.buildDevMounts(ctx.devMount) } : {}),
				// Fixed, `127.0.0.1`-bound publish (`actor-driver.md`'s "Port publishing" section) - the
				// runtime container is created against the *host's* own daemon through the mounted socket, so
				// this binding lands on the developer's own host directly, regardless of whether the runtime
				// process itself is running inside a container.
				...(ctx.debug
					? {
							PortBindings: {
								[`${ctx.debug.port}/tcp`]: [{ HostIp: '127.0.0.1', HostPort: String(ctx.debug.port) }],
							},
						}
					: {}),
			},
			Tty: false,
		});
		this.runContainers.set(ctx.runId, container);

		// Both declared outside the `try` below (so the `finally` can always see them) but only ever
		// assigned inside it - `sampler` stays `undefined` if `container.start()` itself throws, and
		// `timeout` stays `undefined` if anything before its own `setTimeout` call throws; `finally` guards
		// each accordingly.
		let sampler: { stop(): Promise<void> } | undefined;
		let timeout: ReturnType<typeof setTimeout> | undefined;

		try {
			// Between `createContainer` and `start()`, exactly as `2-design.md`'s worked example shows - the
			// payload itself was already loaded (and any missing-payload failure already raised) above,
			// before this container even existed; only the upload against this specific container happens
			// here, inside the `try` so a failed upload still reaches the `finally` below and removes the
			// container it was created against, rather than leaking it.
			if (debugPayload) {
				await container.putArchive(debugPayload.tar, { path: '/' });
			}

			try {
				await container.start();
			} catch (error) {
				if (ctx.debug && isPortInUseError(error)) {
					throw new Error(
						`Cannot start debug run: host port ${ctx.debug.port} is already in use. Stop whatever is ` +
							`using it, or set a different port with \`apify api POST /actor-runtime/debug/<actorId> ` +
							`--body '{"enabled": true, "port": <n>}'\`.`,
					);
				}
				throw error;
			}

			// Only started when someone is actually listening - an unconditional sampler would issue
			// `container.stats()` calls no caller asked for (and against a stub `dockerode` in tests that
			// never mocks `.stats()` at all, a hard failure). Created (and the log stream opened, below)
			// Inside the `try` so a throw here still reaches the `finally` that stops the sampler and
			// removes the container.
			sampler = onSample ? startResourceSampler(container, ctx.memoryMbytes * 1024 * 1024, onSample) : undefined;

			const logStream = (await container.logs({
				follow: true,
				stdout: true,
				stderr: true,
			})) as NodeJS.ReadableStream;
			const stdout = new PassThrough();
			const stderr = new PassThrough();
			stdout.on('data', (chunk: Buffer) => onLog(chunk.toString('utf8')));
			stderr.on('data', (chunk: Buffer) => onLog(chunk.toString('utf8')));
			this.docker.modem.demuxStream(logStream, stdout, stderr);

			// `container.logs({follow:true})` is a separate Docker API connection from `container.wait()` -
			// the two settle independently, with no ordering guarantee between "the container process exited"
			// and "every byte of its stdout/stderr has actually arrived over the logs connection". Without
			// this, `startRun` could resolve (and its caller could write a terminal run status) before the
			// run's trailing log output had even reached `onLog` yet: a client that polls status, sees it turn
			// terminal, and immediately does a non-stream `GET /v2/logs/:id` could read the log before its
			// final chunk landed.
			//
			// "Logs drained" MUST be derived from `logStream` (the SOURCE multiplexed stream) ending, not from
			// `stdout`/`stderr` (the demuxed destinations) ending - `docker-modem`'s `demuxStream` only ever
			// copies frames: it registers exactly `streama.on('data', processData)` on the source
			// (`node_modules/docker-modem/lib/modem.js`, `Modem.prototype.demuxStream`) and never calls
			// `.end()`/`.destroy()` on `stdout`/`stderr` itself. Awaiting the destinations' own `'end'` (the
			// previous fix) therefore never resolves against a real daemon, which never ends them on its own -
			// the run stayed RUNNING until its `timeoutSecs` finalized it as TIMED-OUT, exactly the CI
			// regression this closes. So this driver ends them itself, once the source stream ends.
			let sourceEnded = false;
			const sourceEndedPromise = new Promise<void>((resolve) => {
				const finish = (): void => {
					if (sourceEnded) return;
					sourceEnded = true;
					stdout.end();
					stderr.end();
					resolve();
				};
				logStream.once('end', finish);
				logStream.once('close', finish);
			});

			timeout = setTimeout(() => {
				this.timedOutRuns.add(ctx.runId);
				void container.stop().catch(() => undefined);
			}, ctx.timeoutSecs * 1000);

			const result = (await container.wait()) as { StatusCode: number };
			// `container.wait()` resolves the same way whether the process exited on its own or was
			// stopped by our own timeout timer - the timer having fired is the only signal that
			// distinguishes the two, hence tracking it out-of-band instead of trusting the exit code.
			const timedOut = this.timedOutRuns.delete(ctx.runId);

			// Bounded grace, counted from the container's actual exit: the logs connection *should* close
			// very soon after, but a source stream that never ends (a daemon quirk, a hung proxy - the
			// pathological case this grace guards against) must never again hold the run open past the
			// container's real exit the way awaiting `stdout`/`stderr` directly used to. Race the
			// source-end wait against a few seconds; if it expires, log a warning and finalize anyway -
			// `stdout`/`stderr` are left open so any bytes that do eventually arrive still reach `onLog`,
			// they just no longer block this method from resolving.
			const LOG_DRAIN_GRACE_MS = 5000;
			// The grace timer's own handle is captured and cleared once the race settles either way (the
			// common case: `sourceEndedPromise` wins well inside the grace window) - see
			// `SAMPLER_STOP_GRACE_MS`'s own `stop()` above, which clears its identically-shaped timer for
			// exactly this reason.
			let logDrainGraceTimer: ReturnType<typeof setTimeout> | undefined;
			await Promise.race([
				sourceEndedPromise,
				new Promise<void>((resolve) => {
					logDrainGraceTimer = setTimeout(resolve, LOG_DRAIN_GRACE_MS);
				}),
			]).finally(() => clearTimeout(logDrainGraceTimer));
			if (!sourceEnded) {
				console.warn(
					`Run ${ctx.runId}: log stream did not end within ${LOG_DRAIN_GRACE_MS}ms of the container exiting; finalizing the run without waiting further.`,
				);
			}

			return { exitCode: result.StatusCode, timedOut };
		} finally {
			if (timeout) clearTimeout(timeout);
			// Awaited before `container.remove()` so no `stats()` call is issued against a removed container.
			await sampler?.stop();
			this.timedOutRuns.delete(ctx.runId);
			this.runContainers.delete(ctx.runId);
			// `{ v: true }` also removes the container's anonymous volumes - without it, the anonymous
			// `node_modules` volume `buildDevMounts` adds for a `devMount` run would leak one per run,
			// forever. Harmless for a run with no `devMount`: no anonymous volumes to remove.
			await container.remove({ v: true }).catch(() => undefined);
		}
	}

	/** The two `HostConfig.Mounts` entries for a `devMount` run: a read-write bind for the dev folder
	 * itself (`Mounts`, not `Binds` - a `Mounts`-type bind errors on a missing source instead of silently
	 * auto-creating one), plus an anonymous volume (empty `Source`) over `node_modules` - Docker copies
	 * the image's existing contents into it before mounting, preserving the image's installed
	 * dependencies underneath the bind (a *named* volume would start empty; a plain bind would erase it). */
	private buildDevMounts(devMount: DevFolderMount): Docker.MountSettings[] {
		return [
			{ Type: 'bind', Source: devMount.localDevFolder, Target: devMount.imageWorkingDirectory },
			{ Type: 'volume', Source: '', Target: `${devMount.imageWorkingDirectory}/node_modules` },
		];
	}

	/**
	 * Reads the Python debug payload tar and its debugpy version off disk (`config.ts`'s
	 * `debugpyPayloadTarPath`/`debugpyVersionFilePath`), caching a successful read for the lifetime of
	 * this driver instance - never re-read per run. Outside the runtime's own built image (`pnpm dev`,
	 * unit tests) these files simply don't exist; that rejection propagates as-is up through `startRun`,
	 * which is called before `createContainer` so a missing payload fails the run with a clear message
	 * before any container exists, never as a silent non-debug start (`actor-driver.md`).
	 */
	private async loadDebugPayload(): Promise<{ tar: Buffer; debugpyVersion: string }> {
		if (this.debugPayload) return this.debugPayload;
		let tarBuffer: Buffer;
		let versionText: string;
		try {
			[tarBuffer, versionText] = await Promise.all([
				readFile(debugpyPayloadTarPath()),
				readFile(debugpyVersionFilePath(), 'utf8'),
			]);
		} catch (error) {
			throw new Error(
				`Cannot start a Python debug run: the runtime's debugpy payload is missing (${(error as Error).message}). ` +
					`This runtime only injects debugpy when it is running from its own built image (its Dockerfile ` +
					`bakes this payload in) - debug mode for Python Actors does not work when the runtime itself runs ` +
					`from source (e.g. \`pnpm dev\`).`,
			);
		}
		this.debugPayload = { tar: tarBuffer, debugpyVersion: versionText.trim() };
		return this.debugPayload;
	}

	/**
	 * The run log's one-line "paused, waiting for a debugger" announcement (`actor-driver.md`'s "Debug
	 * mode" section), printed once before `createContainer` - the address, the resolved language, the
	 * attach action for the relevant IDE, and the unmodified-timeout gotcha, all in one place so a run
	 * that dies mid-session (or a breakpoint set too late) is self-explaining from its own log alone.
	 */
	private buildDebugLogLine(
		debug: { language: 'node' | 'python'; port: number },
		timeoutSecs: number,
		debugpyVersion?: string,
	): string {
		const { language, port } = debug;
		const tool =
			language === 'python'
				? `Python (debugpy ${debugpyVersion ?? 'unknown version'}, injected by the runtime)`
				: `Node (its own built-in inspector)`;
		const attach =
			language === 'python'
				? `attach PyCharm's "Attach to DAP" or VS Code's "Python: Remote Attach" there`
				: `attach VS Code's "Attach" or Chrome DevTools' "Open dedicated DevTools for Node" there`;
		return (
			`Debug mode: this run is paused before its first line, waiting for a debugger. ${tool} is listening ` +
			`inside the container on 0.0.0.0:${port}, published on the host at 127.0.0.1:${port} - ${attach}. Set ` +
			`your breakpoints as part of that attach - the runtime does not stop synthetically beyond the initial ` +
			`wait, so code runs to your first breakpoint once the IDE delivers it. The run's ${timeoutSecs}s timeout ` +
			`is already running and is NOT extended for debugging; pass a larger \`apify call --timeout\` when you ` +
			`expect a long session.\n`
		);
	}

	/**
	 * Builds (on first call) and returns the id of this driver's own minimal probe image, reusing it on
	 * every later call - idempotent, verified empirically against a real daemon: re-building when the
	 * image already exists succeeds and needs no network access either time. Concurrent callers share
	 * one in-flight build rather than racing separate `buildImage` calls; a failed build is not cached, so
	 * the next call gets to retry against a daemon that may have recovered.
	 *
	 * `FROM scratch` alone builds fine but leaves the image with no `Cmd`/`Entrypoint`, and moby refuses
	 * to create a container from one at all (`no command specified`) - which `probeDevFolder` below would
	 * otherwise misreport as a bad candidate path. The `CMD` fixes that; it is never executed, since the
	 * probe container this image backs is created but never started.
	 */
	async ensureProbeImage(): Promise<string> {
		if (this.probeImageId) return this.probeImageId;
		if (!this.available) throw new Error(this.unavailableReason ?? 'Docker is not available');

		this.probeImageBuild ??= this.buildProbeImage().catch((error) => {
			this.probeImageBuild = undefined;
			throw error;
		});
		const imageId = await this.probeImageBuild;
		this.probeImageId = imageId;
		return imageId;
	}

	private async buildProbeImage(): Promise<string> {
		const tarball = dockerfileTarball(PROBE_DOCKERFILE);
		const stream = await this.docker.buildImage(tarball, { t: PROBE_IMAGE_TAG });
		await new Promise<void>((resolve, reject) => {
			this.docker.modem.followProgress(stream, (err: Error | null, res: Array<{ error?: string }>) => {
				if (err) {
					reject(err);
					return;
				}
				const errorLine = res.find((line) => line.error);
				if (errorLine) {
					reject(new Error(errorLine.error));
					return;
				}
				resolve();
			});
		});
		return PROBE_IMAGE_TAG;
	}

	/**
	 * Host-side existence-and-directory check for a candidate dev-folder path: a create-only probe
	 * container, never started. `fs.existsSync` would test this process's own filesystem, not the host's;
	 * the only Engine API surface that validates an arbitrary host path is the mount-validation moby runs
	 * inside `POST /containers/create`. `BindOptions.CreateMountpoint` (which would auto-create a missing
	 * source and defeat this check) is never set. `imageId` is always `ensureProbeImage`'s own image
	 * above - never an Actor's build (registration must work for an Actor with no build at all), a
	 * self-inspected runtime image (`HOSTNAME` is unset in bare local dev, per `selfAttachToNetwork`
	 * above), or a pulled one (would break offline-after-first-build).
	 *
	 * The mount `Source` is the candidate path with a literal `/.` appended, never the bare path -
	 * verified empirically against a real daemon (a `FROM scratch` probe image, no network pull needed):
	 * appending `/.` forces the same `stat` moby already performs to also reject a regular file (`invalid
	 * mount config for type "bind": stat <path>/.: not a directory`, classified below as
	 * `not-a-directory`) while leaving every other outcome unchanged - a real directory (or a symlink
	 * resolving to one) still succeeds, and a missing path still rejects with the same
	 * `BIND_SOURCE_MISSING_SUBSTRING` (now trailed by `/.`, which the substring match ignores). Since the
	 * daemon's rejection message and this call's own `Source` therefore always carry the `/.` suffix, the
	 * caller (`services/dev-folder.ts`) never echoes either back to the user - only this function's own
	 * classified `DevFolderProbeFailureReason` crosses that boundary, so the path stored and displayed
	 * anywhere is always exactly what the caller submitted.
	 */
	async probeDevFolder(candidatePath: string, imageId: string): Promise<DevFolderProbeOutcome> {
		if (!this.available) return { ok: false, reason: 'unreachable' };

		let container: Docker.Container;
		try {
			container = await this.docker.createContainer({
				Image: imageId,
				Labels: { [PROBE_LABEL]: 'true' },
				HostConfig: {
					Mounts: [
						{ Type: 'bind', Source: `${candidatePath}/.`, Target: PROBE_MOUNT_TARGET, ReadOnly: true },
					],
				},
			});
		} catch (error) {
			// Creation itself failed, so there is nothing to clean up.
			return { ok: false, reason: classifyProbeError(error) };
		}

		// Creation succeeded, so this container genuinely exists on the daemon now - unlike the rejected
		// path above, a failed removal here would leak a real container. Logged rather than swallowed so
		// the leak is discoverable; `PROBE_LABEL` also lets `reconcileOrphans` sweep it on next startup.
		await container.remove().catch((error: Error) => {
			console.warn(`Could not remove dev-folder probe container ${container.id}: ${error.message}`);
		});
		return { ok: true };
	}

	async abortRun(runId: string): Promise<void> {
		const container = this.runContainers.get(runId);
		if (!container) return;
		await container.stop().catch(() => undefined);
	}

	/**
	 * Cleans up two kinds of leftover containers from a previous process: orphaned *run* containers
	 * (builds never create one of their own - orphaned build *records* are still marked `ABORTED` by
	 * `reconcileOrphanedJobs` in `services/runs.ts`, independent of this method), and any dev-folder
	 * probe container that outlived its own removal call (`probeDevFolder`'s `PROBE_LABEL`) - the latter
	 * swept unconditionally, since a leftover probe is never a container anything still needs.
	 *
	 * Queries once per label *key*, each query carrying exactly one value under `label`, then matches
	 * `runIds` against each container's own label client-side - deliberately not one query with
	 * `{ label: [RUN_LABEL, PROBE_LABEL] } }`. Docker's daemon-side label filter ANDs multiple values
	 * given for the same key (moby's `api/types/filters`: `MatchKVList`), so a single query carrying both
	 * label keys would require one container to match both simultaneously - never true, silently matching
	 * nothing. Issuing one single-value query per key and unioning the results client-side (de-duplicated
	 * by container `Id`, in case a container is ever matched by both queries) avoids depending on that
	 * cross-key semantics at all.
	 */
	async reconcileOrphans(runIds: string[]): Promise<void> {
		if (!this.available) return;
		const runIdSet = new Set(runIds);

		const [runLabelled, probeLabelled] = await Promise.all([
			this.docker.listContainers({ all: true, filters: JSON.stringify({ label: [RUN_LABEL] }) }),
			this.docker.listContainers({ all: true, filters: JSON.stringify({ label: [PROBE_LABEL] }) }),
		]);
		const byId = new Map<string, Docker.ContainerInfo>();
		for (const info of [...runLabelled, ...probeLabelled]) byId.set(info.Id, info);

		for (const info of byId.values()) {
			const isOrphanedRun = runIdSet.has(info.Labels?.[RUN_LABEL] ?? '');
			const isLeftoverProbe = info.Labels?.[PROBE_LABEL] !== undefined;
			if (!isOrphanedRun && !isLeftoverProbe) continue;
			const container = this.docker.getContainer(info.Id);
			// `{ v: true }` alongside `force: true`: an orphaned run's anonymous `node_modules` volume (if
			// it had a `devMount`) must not survive reconciliation either (mirrors `startRun`'s finally
			// block's identical fix).
			await container.remove({ force: true, v: true }).catch(() => undefined);
		}
	}
}

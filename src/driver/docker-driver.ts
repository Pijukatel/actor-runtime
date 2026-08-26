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
import Docker from 'dockerode';
import * as tar from 'tar-stream';

import { CONTAINER_API_ALIAS } from '../config.js';
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
	type RunContext,
	type RunOutcome,
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
	/** Set once `ensureProbeImage` has actually built (or found) the probe image - every later call
	 * returns this without touching the daemon again. */
	private probeImageId: string | undefined;
	/** In-flight build, shared by every concurrent `ensureProbeImage` caller so the image is never built
	 * twice at once; cleared on failure so a later call gets to retry rather than replaying the same
	 * rejection forever. */
	private probeImageBuild: Promise<string> | undefined;

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

		try {
			await this.ensureNetwork();
			await this.selfAttachToNetwork();
			this.available = true;
		} catch (error) {
			this.available = false;
			this.unavailableReason = `Docker network setup failed: ${(error as Error).message}`;
		}
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
	 * Genuinely interrupts the in-flight build: aborts the `AbortController` passed to `buildImage` as
	 * `abortSignal`, which destroys the underlying HTTP request to the Docker daemon (see the class
	 * doc comment). A no-op if the build already finished (its controller was already cleaned up) - the
	 * caller's own terminal-status guard is what makes that safe, not this check.
	 */
	async abortBuild(buildId: string): Promise<void> {
		this.buildControllers.get(buildId)?.abort();
	}

	async startRun(ctx: RunContext, onLog: (chunk: string) => void): Promise<RunOutcome> {
		if (!this.available) {
			throw new Error(this.unavailableReason ?? 'Docker is not available');
		}

		const env = Object.entries(ctx.env).map(([key, value]) => `${key}=${value}`);

		// A secondary diagnostic for the residual risk that a folder verified at registration later
		// vanishes: written before `createContainer` so it is genuinely the first log line even if that
		// call is what ends up failing.
		if (ctx.devMount) {
			onLog(
				`Mounting local dev folder ${ctx.devMount.localDevFolder} over the image's working directory ` +
					`${ctx.devMount.imageWorkingDirectory} (node_modules preserved via an anonymous volume).\n`,
			);
		}

		const container = await this.docker.createContainer({
			Image: ctx.imageId,
			Env: env,
			Labels: { [RUN_LABEL]: ctx.runId },
			HostConfig: {
				NetworkMode: NETWORK_NAME,
				Memory: ctx.memoryMbytes * 1024 * 1024,
				AutoRemove: false,
				...(ctx.devMount ? { Mounts: this.buildDevMounts(ctx.devMount) } : {}),
			},
			Tty: false,
		});
		this.runContainers.set(ctx.runId, container);

		await container.start();

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

		const timeout = setTimeout(() => {
			this.timedOutRuns.add(ctx.runId);
			void container.stop().catch(() => undefined);
		}, ctx.timeoutSecs * 1000);

		try {
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
			await Promise.race([
				sourceEndedPromise,
				new Promise<void>((resolve) => setTimeout(resolve, LOG_DRAIN_GRACE_MS)),
			]);
			if (!sourceEnded) {
				console.warn(
					`Run ${ctx.runId}: log stream did not end within ${LOG_DRAIN_GRACE_MS}ms of the container exiting; finalizing the run without waiting further.`,
				);
			}

			return { exitCode: result.StatusCode, timedOut };
		} finally {
			clearTimeout(timeout);
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

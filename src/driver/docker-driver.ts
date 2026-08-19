/**
 * The Docker driver: build/run Actor images over the host Docker socket via `dockerode`. Every Actor
 * container joins the `apify-local` network so it can resolve the runtime's own container by the
 * fixed DNS alias `apify-api` (`actor-driver.md`). Storage access is HTTP-only; the one filesystem
 * bind mount this driver ever adds is the optional local-dev-folder mount (`RunContext.devMount`, see
 * `startRun` below) - conditional, never unconditional, on every Actor's container.
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
/** Target path for the create-only, never-started existence probe container (`probeDevFolder` below) -
 * arbitrary, since the probe is never started and nothing ever reads from it; moby validates the mount
 * source before the container object is even returned from `POST /containers/create`, so no path is
 * ever read from this target. */
const PROBE_MOUNT_TARGET = '/probe';
/** The daemon's own fixed error-message substring for a `Mounts`-type bind whose source is missing
 * (moby's `daemon/volume/mounts/validate.go: errBindSourceDoesNotExist`) - the one rejection shape
 * `classifyProbeError` reports as "does not exist" rather than a generic "could not verify". */
const BIND_SOURCE_MISSING_SUBSTRING = 'bind source path does not exist';

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
 * a permission error/"not a directory"/Docker Desktop file-sharing denial must never be asserted as
 * "does not exist". */
function classifyProbeError(error: unknown): DevFolderProbeFailureReason {
	if (!hasStatusCode(error)) return 'unreachable';
	if (error.statusCode === 404) return 'image-missing';
	if (error.message.includes(BIND_SOURCE_MISSING_SUBSTRING)) return 'not-found';
	return 'unknown';
}

function sourceFileToBuffer(file: SourceFile): Buffer {
	return file.format === 'BASE64' ? Buffer.from(file.content, 'base64') : Buffer.from(file.content, 'utf8');
}

function buildTarball(sourceFiles: SourceFile[]): NodeJS.ReadableStream {
	const pack = tar.pack();
	for (const file of sourceFiles) {
		const buffer = sourceFileToBuffer(file);
		pack.entry({ name: file.name }, buffer);
	}
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
				abortSignal: controller.signal,
			});
		} catch (error) {
			cleanup();
			throw asTimedOutOrOriginal(error as Error);
		}

		return new Promise<BuildOutcome>((resolve, reject) => {
			this.docker.modem.followProgress(
				stream,
				// Async: fine even though `followProgress`'s own callback type doesn't expect a Promise back
				// (this codebase's `dockerode` types leave `modem` as `any` - see the class doc comment - so
				// nothing type-checks the return value either way) - `followProgress` never awaits this
				// callback's result, it just invokes it once, and `resolve`/`reject` below settle the outer
				// Promise whenever this async function actually gets there.
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

	/**
	 * `.Config.WorkingDir` of the image just built, via `docker.getImage(imageId).inspect()` - this
	 * codebase talks to the host socket through `dockerode` exclusively, never a shelled-out
	 * `docker inspect` (see `actor-driver.md`'s "Bind mount volumes with Actor source code" section, and
	 * this file's own class doc comment above). An inspect failure is logged and tolerated - it
	 * must never fail an otherwise-successful build - and an empty or `/` working directory is treated
	 * the same as "unknown": mounting a dev folder over `/` at run start would destroy the container.
	 */
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

		// Observability of the mount (`actor-driver.md`'s "Observability" bullet): a secondary
		// diagnostic now that existence is verified at registration - if the folder is deleted/moved/made
		// unreadable between registration and this run, the daemon's own rejection below explains why the
		// run failed, but only if the very first log line already named the two paths. Written before
		// `createContainer` so it is genuinely first, even if the daemon call itself is what ends up
		// failing.
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
			// `node_modules` volume `buildDevMounts` adds for a `devMount` run would leak one volume per
			// run, forever (see `actor-driver.md`'s "Every run's container removal passes `{ v: true }`"
			// bullet). Harmless for a run with no `devMount`: such a container has no anonymous volumes to
			// remove in the first place.
			await container.remove({ v: true }).catch(() => undefined);
		}
	}

	/**
	 * The two `HostConfig.Mounts` entries for a `devMount` run (`actor-driver.md`'s "The mount uses
	 * `HostConfig.Mounts`..." bullet) - `Mounts`, not `Binds`, for the same reason `probeDevFolder` uses
	 * `Mounts`: a `Mounts`-type bind errors on a missing source instead of silently auto-creating one
	 * (moby's `daemon/volume/mounts/validate.go`, unlike the legacy `Binds`/`-v` auto-create behavior), so
	 * a folder that vanished between registration and this run start fails the run loudly instead of
	 * masking the image's own working directory with an empty auto-created directory. The bind is
	 * read-write (no `ReadOnly`), matching the requirement's own plain `-v` form. The second entry -
	 * `Type: 'volume'` with an empty `Source` - is the `Mounts`-array equivalent of the anonymous-volume
	 * bare-path `-v` form: Docker copies the image's existing `node_modules` into it before mounting,
	 * which is what preserves the image's installed dependencies underneath a bind that otherwise covers
	 * the whole working directory (a *named* volume would start empty; a plain bind would erase it).
	 */
	private buildDevMounts(devMount: DevFolderMount): Docker.MountSettings[] {
		return [
			{ Type: 'bind', Source: devMount.localDevFolder, Target: devMount.imageWorkingDirectory },
			{ Type: 'volume', Source: '', Target: `${devMount.imageWorkingDirectory}/node_modules` },
		];
	}

	/**
	 * Host-side existence check for a candidate dev-folder path (`actor-driver.md`'s "Registration
	 * validates the path in two layers" bullet): a create-only probe container, never started.
	 * `fs.existsSync` would test this *runtime process's* filesystem, not the host's (this driver always
	 * runs against the host's own Docker socket - see the class doc comment); the only Engine API
	 * surface that validates an arbitrary host path at all is the mount-validation moby runs inside
	 * `POST /containers/create`. `BindOptions.CreateMountpoint` (the option that would auto-create a
	 * missing source and defeat this check entirely) is deliberately never set - `@types/dockerode`'s own
	 * `BindOptions` type doesn't even declare it, so the straightforward, type-safe object literal below
	 * omits it for free. On success the probe is removed immediately without ever being started; on
	 * rejection there is nothing to clean up, since creation itself is what failed.
	 *
	 * `imageId` is always the Actor's own latest successfully-built image (resolved by
	 * `services/actors.ts: setDevFolder`), never a self-inspected runtime image or a pulled one: a
	 * self-inspected runtime image was rejected as the probe/mount image because `HOSTNAME` is unset in
	 * bare local dev, which `selfAttachToNetwork` above already documents - exactly the environment this
	 * feature targets - and a pulled image would break the offline-after-first-build property.
	 */
	async probeDevFolder(candidatePath: string, imageId: string): Promise<DevFolderProbeOutcome> {
		// Known-unavailable short-circuits without ever touching the socket - the same outcome
		// (`unreachable`) a live daemon that dies mid-call would also produce via `classifyProbeError`'s
		// no-`.statusCode` branch, just reached proactively instead of reactively.
		if (!this.available) return { ok: false, reason: 'unreachable' };

		try {
			const container = await this.docker.createContainer({
				Image: imageId,
				HostConfig: {
					Mounts: [
						{
							Type: 'bind',
							Source: candidatePath,
							Target: PROBE_MOUNT_TARGET,
							ReadOnly: true,
						},
					],
				},
			});
			await container.remove().catch(() => undefined);
			return { ok: true };
		} catch (error) {
			return { ok: false, reason: classifyProbeError(error) };
		}
	}

	async abortRun(runId: string): Promise<void> {
		const container = this.runContainers.get(runId);
		if (!container) return;
		await container.stop().catch(() => undefined);
	}

	/**
	 * Cleans up leftover *run* containers from a previous process (builds never create a labelled
	 * container of their own - `startBuild` calls `dockerode`'s `buildImage` directly, so there is no
	 * build-side container to reconcile here; orphaned build *records* are still marked `ABORTED` by
	 * `reconcileOrphanedJobs` in `services/runs.ts`, independent of this method).
	 *
	 * Filters on the label *key*'s presence only (`{ label: ['actor-runtime.runId'] }`), then matches
	 * `runIds` against each returned container's own labels client-side - deliberately not
	 * `{ label: runIds.map(id => \`${RUN_LABEL}=${id}\`) } }`. Docker's daemon-side label filter is a
	 * `key=value` match *per list entry*, and when a filter key is given multiple values the daemon's
	 * list-filtering (`MatchKVList` in moby's `api/types/filters`) requires a container to satisfy
	 * *every* listed `key=value` pair (AND), not any one of them (OR) - the opposite of most other
	 * filter keys (e.g. `id`/`name`/`ancestor`), which OR their values. A container carries exactly one
	 * `actor-runtime.runId` label, so with two or more orphaned run ids in one call the AND'd query would
	 * require a single container to match two different values of the same label simultaneously, which
	 * is never true - the call would silently match zero containers and leak every one of them past a
	 * restart. There is no Docker daemon in this sandbox to execute this against, so this is verified
	 * from documented/known moby filtering semantics, not a live daemon response; filtering on key
	 * presence (a single value, so the AND/OR distinction cannot bite) and matching client-side avoids
	 * depending on that semantics being right at all.
	 */
	async reconcileOrphans(runIds: string[]): Promise<void> {
		if (!this.available || runIds.length === 0) return;
		const runIdSet = new Set(runIds);

		const containers = await this.docker.listContainers({
			all: true,
			filters: JSON.stringify({ label: [RUN_LABEL] }),
		});
		for (const info of containers) {
			if (!runIdSet.has(info.Labels?.[RUN_LABEL] ?? '')) continue;
			const container = this.docker.getContainer(info.Id);
			// `{ v: true }` alongside `force: true` - see `startRun`'s finally block's identical fix for why:
			// an orphaned run's anonymous `node_modules` volume (if it had a `devMount`) must not survive
			// past a restart's reconciliation either.
			await container.remove({ force: true, v: true }).catch(() => undefined);
		}
	}
}

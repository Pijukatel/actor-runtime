/**
 * The Docker driver: build/run Actor images over the host Docker socket via `dockerode`. Every Actor
 * container joins the `apify-local` network so it can resolve the runtime's own container by the
 * fixed DNS alias `apify-api` - no storage bind mount, HTTP-only storage access (`actor-driver.md`).
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
	type Driver,
	type RunContext,
	type RunOutcome,
} from './types.js';

const NETWORK_NAME = 'apify-local';
const RUN_LABEL = 'actor-runtime.runId';

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
				(err: Error | null, res: Array<{ stream?: string; error?: string; aux?: { ID?: string } }>) => {
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
					resolve({ imageId: imageTag });
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
		const container = await this.docker.createContainer({
			Image: ctx.imageId,
			Env: env,
			Labels: { [RUN_LABEL]: ctx.runId },
			HostConfig: {
				NetworkMode: NETWORK_NAME,
				Memory: ctx.memoryMbytes * 1024 * 1024,
				AutoRemove: false,
			},
			Tty: false,
		});
		this.runContainers.set(ctx.runId, container);

		await container.start();

		const logStream = await container.logs({ follow: true, stdout: true, stderr: true });
		const stdout = new PassThrough();
		const stderr = new PassThrough();
		stdout.on('data', (chunk: Buffer) => onLog(chunk.toString('utf8')));
		stderr.on('data', (chunk: Buffer) => onLog(chunk.toString('utf8')));
		this.docker.modem.demuxStream(logStream as NodeJS.ReadableStream, stdout, stderr);

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
			return { exitCode: result.StatusCode, timedOut };
		} finally {
			clearTimeout(timeout);
			this.timedOutRuns.delete(ctx.runId);
			this.runContainers.delete(ctx.runId);
			await container.remove().catch(() => undefined);
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
			await container.remove({ force: true }).catch(() => undefined);
		}
	}
}

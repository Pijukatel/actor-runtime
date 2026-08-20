import { PassThrough } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';
import type Docker from 'dockerode';
import * as tar from 'tar-stream';

import { DockerDriver } from '../../src/driver/docker-driver.js';

/**
 * A stub `dockerode`-shaped object covering only what `reconcileOrphans` calls - there is no Docker
 * daemon in this sandbox to test against for real (see `DockerDriver`'s class doc comment), so
 * `listContainers` here models the one piece of real daemon behaviour this bug hinges on: a label
 * filter only ever returns containers that carry EVERY key given in that single call's `label` array
 * (moby's `MatchKVList`). Because `reconcileOrphans` now issues one single-value-per-key call per
 * label, this stub naturally returns a different subset of `containers` for the `RUN_LABEL` call than
 * for the `PROBE_LABEL` call - exactly the daemon-side semantics a single combined call would get
 * wrong (it would require one container to carry both keys at once, matching nothing).
 */
function stubDocker(containers: Array<{ Id: string; Labels: Record<string, string> }>) {
	const removed: string[] = [];
	const removeCallOptions: Array<Record<string, unknown> | undefined> = [];
	const listContainers = vi.fn(async (options: { all: boolean; filters: string }) => {
		const filters = JSON.parse(options.filters) as { label?: string[] };
		const labelKeys = filters.label ?? [];
		if (labelKeys.length === 0) return containers;
		return containers.filter((c) => labelKeys.every((key) => key in c.Labels));
	});
	const getContainer = vi.fn((id: string) => ({
		remove: vi.fn(async (options?: Record<string, unknown>) => {
			removed.push(id);
			removeCallOptions.push(options);
		}),
	}));
	return {
		docker: { listContainers, getContainer } as unknown as Docker,
		listContainers,
		getContainer,
		removed,
		removeCallOptions,
	};
}

describe('DockerDriver.reconcileOrphans', () => {
	it('never carries more than one value under `label` in a single listContainers call (the daemon ANDs multiple values for one key, so a combined call would match nothing)', async () => {
		const { docker, listContainers } = stubDocker([]);
		const driver = new DockerDriver(docker);
		driver.available = true;

		await driver.reconcileOrphans(['run-a', 'run-b']);

		expect(listContainers.mock.calls.length).toBeGreaterThanOrEqual(2);
		const allLabelValues: string[] = [];
		for (const [options] of listContainers.mock.calls) {
			expect(options.all).toBe(true);
			const filters = JSON.parse(options.filters) as { label?: string[] };
			expect(filters.label?.length ?? 0).toBeLessThanOrEqual(1);
			if (filters.label) allLabelValues.push(...filters.label);
		}
		// Both label keys are still queried, just never together in one call.
		expect(allLabelValues.sort()).toEqual(['actor-runtime.devFolderProbe', 'actor-runtime.runId']);
	});

	it('removes both an orphaned run container and an unrelated leftover probe container from one reconcileOrphans call', async () => {
		const { docker, removed } = stubDocker([
			{ Id: 'run-container', Labels: { 'actor-runtime.runId': 'run-a' } },
			{ Id: 'probe-container', Labels: { 'actor-runtime.devFolderProbe': 'true' } },
		]);
		const driver = new DockerDriver(docker);
		driver.available = true;

		await driver.reconcileOrphans(['run-a']);

		expect(removed.sort()).toEqual(['probe-container', 'run-container']);
	});

	it("matches run ids against each returned container's own label client-side, removing only the orphaned ones", async () => {
		const { docker, getContainer, removed } = stubDocker([
			{ Id: 'container-a', Labels: { 'actor-runtime.runId': 'run-a' } },
			{ Id: 'container-b', Labels: { 'actor-runtime.runId': 'run-b' } },
			{ Id: 'container-c', Labels: { 'actor-runtime.runId': 'run-c' } },
		]);
		const driver = new DockerDriver(docker);
		driver.available = true;

		// Two orphaned run ids, out of three containers actually present - the exact "2+ orphans" shape
		// the review's question raised as at risk under the old AND'd `label=KEY=value` filter.
		await driver.reconcileOrphans(['run-a', 'run-c']);

		expect(getContainer).toHaveBeenCalledTimes(2);
		expect(removed.sort()).toEqual(['container-a', 'container-c']);
	});

	it('removes nothing when no returned container matches any given run id', async () => {
		const { docker, getContainer } = stubDocker([
			{ Id: 'container-x', Labels: { 'actor-runtime.runId': 'run-x' } },
		]);
		const driver = new DockerDriver(docker);
		driver.available = true;

		await driver.reconcileOrphans(['run-a']);

		expect(getContainer).not.toHaveBeenCalled();
	});

	it('does nothing (no daemon call at all) when the driver is unavailable', async () => {
		const { docker, listContainers } = stubDocker([]);
		const driver = new DockerDriver(docker);
		// `driver.available` defaults to false until `init()` succeeds.

		await driver.reconcileOrphans(['run-a']);

		expect(listContainers).not.toHaveBeenCalled();
	});

	it('still lists containers with no orphaned run ids, to sweep any leftover dev-folder probe', async () => {
		const { docker, listContainers } = stubDocker([]);
		const driver = new DockerDriver(docker);
		driver.available = true;

		await driver.reconcileOrphans([]);

		// Unlike the "unavailable" case above, an empty `runIds` list must not short-circuit the daemon
		// calls entirely - a probe container that outlived its own removal (`probeDevFolder`) has no run
		// id at all, so it can only ever be found by actually listing. Two calls now, one per label key.
		expect(listContainers).toHaveBeenCalledTimes(2);
	});

	it('removes a leftover dev-folder probe container even when it matches no orphaned run id', async () => {
		const { docker, getContainer, removed, removeCallOptions } = stubDocker([
			{ Id: 'probe-container', Labels: { 'actor-runtime.devFolderProbe': 'true' } },
		]);
		const driver = new DockerDriver(docker);
		driver.available = true;

		await driver.reconcileOrphans([]);

		expect(getContainer).toHaveBeenCalledTimes(1);
		expect(removed).toEqual(['probe-container']);
		expect(removeCallOptions).toEqual([{ force: true, v: true }]);
	});

	it('removes each matched container with { force: true, v: true } (an orphaned devMount run must not leak its anonymous node_modules volume past a restart)', async () => {
		const { docker, removeCallOptions } = stubDocker([
			{ Id: 'container-a', Labels: { 'actor-runtime.runId': 'run-a' } },
		]);
		const driver = new DockerDriver(docker);
		driver.available = true;

		await driver.reconcileOrphans(['run-a']);

		expect(removeCallOptions).toEqual([{ force: true, v: true }]);
	});
});

/**
 * A stub `dockerode`-shaped object covering only what `startRun` calls, with `container.wait()` and the
 * `container.logs()` stream each independently controllable - mirrors the real Docker daemon's two
 * genuinely separate API connections (the finding this fixes: nothing guarantees the log stream's final
 * chunk has arrived by the time `container.wait()` resolves).
 */
function stubDockerForRun() {
	let resolveWait!: (result: { StatusCode: number }) => void;
	const waitPromise = new Promise<{ StatusCode: number }>((resolve) => {
		resolveWait = resolve;
	});

	// The raw (not-yet-demuxed) combined stdout/stderr stream `container.logs()` would return - a
	// separate Docker API connection from `container.wait()` above.
	const rawLogStream = new PassThrough();

	const container = {
		start: vi.fn(async () => undefined),
		logs: vi.fn(async () => rawLogStream),
		wait: vi.fn(async () => waitPromise),
		remove: vi.fn(async (_options?: Record<string, unknown>) => undefined),
		stop: vi.fn(async () => undefined),
	};

	// Real dockerode demuxing splits stdout/stderr apart by frame header; this stub doesn't need that
	// distinction, it only needs to forward data. Crucially - faithful to the real
	// `docker-modem` `Modem.prototype.demuxStream` (`node_modules/docker-modem/lib/modem.js`) - it must
	// NOT end `stdout`/`stderr` when the source stream ends: the real implementation registers only
	// `streama.on('data', processData)` and never calls `.end()`/`.destroy()` on either destination.
	// `stdout`/`stderr` ending is entirely `DockerDriver.startRun`'s own responsibility (it derives that
	// from the SOURCE stream, i.e. `stream` here, ending) - a demux stub that auto-ends the destinations
	// (as this one previously did) hides exactly the bug that shipped in production.
	const demuxStream = vi.fn((stream: NodeJS.ReadableStream, stdout: PassThrough) => {
		stream.on('data', (chunk: Buffer) => stdout.write(chunk));
	});

	// Typed with the real `dockerode` parameter shape so `mock.calls[0]` is genuinely a
	// `[Docker.ContainerCreateOptions]` tuple below - no unsound cast needed to read it back.
	const createContainer = vi.fn(async (_options: Docker.ContainerCreateOptions) => container);
	const docker = {
		createContainer,
		modem: { demuxStream },
	} as unknown as Docker;

	return {
		docker,
		container,
		createContainer,
		/** Simulates `container.wait()` resolving - the container process has exited. */
		triggerContainerExit(statusCode = 0): void {
			resolveWait({ StatusCode: statusCode });
		},
		/** Simulates a trailing chunk still arriving over the separate Docker logs connection. */
		pushFinalLogChunk(chunk: string): void {
			rawLogStream.write(chunk);
		},
		/** Simulates the logs connection closing - the real daemon does this once the container's full
		 * output has been delivered. */
		endLogStream(): void {
			rawLogStream.end();
		},
	};
}

describe('DockerDriver.startRun - log stream drain ordering (regression: trailing log chunk race)', () => {
	it("does not resolve until the container's log stream has fully drained, even after container.wait() has already resolved", async () => {
		const stub = stubDockerForRun();
		const driver = new DockerDriver(stub.docker);
		driver.available = true;

		const chunks: string[] = [];
		const outcomePromise = driver.startRun(
			{ runId: 'run-1', imageId: 'fake-image', env: {}, memoryMbytes: 128, timeoutSecs: 60 },
			(chunk) => chunks.push(chunk),
		);

		// Let `startRun` run past its setup `await`s, up to (and blocking on) `container.wait()`.
		await new Promise((resolve) => setImmediate(resolve));

		// The container process exits - `container.wait()` resolves - but the separate logs connection
		// has not delivered its trailing chunk yet: exactly the real-world gap this fix closes.
		stub.triggerContainerExit(0);

		let settled = false;
		void outcomePromise.then(() => {
			settled = true;
		});
		// Give the microtask queue several turns to drain - if `startRun` only awaited `container.wait()`
		// (the pre-fix behaviour), it would already have settled by now.
		await new Promise((resolve) => setImmediate(resolve));
		await new Promise((resolve) => setImmediate(resolve));

		expect(settled).toBe(false);
		expect(chunks.join('')).toBe('');

		// The trailing chunk finally arrives over the logs connection, which then closes - only now does
		// `onLog` see it, and only now should `startRun` be allowed to resolve.
		stub.pushFinalLogChunk('final line\n');
		stub.endLogStream();

		const outcome = await outcomePromise;
		expect(outcome).toEqual({ exitCode: 0, timedOut: false });
		expect(chunks.join('')).toBe('final line\n');
	});
});

describe('DockerDriver.startRun - faithful demuxStream stub (regression: dockerode never ends the demuxed destinations)', () => {
	it('finalizes the run as SUCCEEDED promptly once the SOURCE log stream ends, even though demuxStream never calls .end() on stdout/stderr itself', async () => {
		// This is the real dockerode behaviour, verified against `node_modules/docker-modem/lib/modem.js`'s
		// `Modem.prototype.demuxStream`: it registers only `streama.on('data', processData)` on the source
		// stream and never ends the `stdout`/`stderr` destinations it copies into. `stubDockerForRun`'s
		// `demuxStream` mirrors that exactly (see its doc comment) - unlike the version of this stub that
		// shipped alongside the regression, which auto-ended the destinations on the source's 'end' and so
		// never exercised the real gap. Before the fix, `DockerDriver.startRun` awaited `stdout`/`stderr`'s
		// own 'end' directly, which this faithful stub never fires - so against this stub the pre-fix code
		// hangs until the driver's `timeoutSecs` timer stops the container (here, 60s), not resolving
		// "promptly" the way this test requires.
		const stub = stubDockerForRun();
		const driver = new DockerDriver(stub.docker);
		driver.available = true;

		const chunks: string[] = [];
		const startedAt = Date.now();
		const outcomePromise = driver.startRun(
			{ runId: 'run-3', imageId: 'fake-image', env: {}, memoryMbytes: 128, timeoutSecs: 60 },
			(chunk) => chunks.push(chunk),
		);

		await new Promise((resolve) => setImmediate(resolve));

		stub.pushFinalLogChunk('hello from the container\n');
		// The container process exits...
		stub.triggerContainerExit(0);
		// ...and its SOURCE logs connection closes right after, exactly like a real daemon. `demuxStream`
		// itself never ends `stdout`/`stderr` - only `DockerDriver.startRun` deriving "drained" from this
		// source-stream end (the fix) makes that irrelevant.
		stub.endLogStream();

		const outcome = await outcomePromise;
		const elapsedMs = Date.now() - startedAt;

		expect(outcome).toEqual({ exitCode: 0, timedOut: false });
		expect(chunks.join('')).toBe('hello from the container\n');
		// Sub-second, not "eventually, after the 60s timeoutSecs timer fires" - the pre-fix failure mode.
		expect(elapsedMs).toBeLessThan(1000);
	});
});

describe('DockerDriver.startRun - dev-folder mount composition (actor-driver.md: "The Actor image\'s own installed dependencies ... must remain available")', () => {
	it('adds exactly the bind + anonymous-volume Mounts entries when devMount is present, and never a Binds key', async () => {
		const stub = stubDockerForRun();
		const driver = new DockerDriver(stub.docker);
		driver.available = true;

		const outcomePromise = driver.startRun(
			{
				runId: 'run-mount-1',
				imageId: 'fake-image',
				env: {},
				memoryMbytes: 128,
				timeoutSecs: 60,
				devMount: { localDevFolder: '/host/src', imageWorkingDirectory: '/usr/src/app' },
			},
			() => {},
		);
		await new Promise((resolve) => setImmediate(resolve));

		const [options] = stub.createContainer.mock.calls[0]!;
		expect(options.HostConfig?.Mounts).toEqual([
			{ Type: 'bind', Source: '/host/src', Target: '/usr/src/app' },
			{ Type: 'volume', Source: '', Target: '/usr/src/app/node_modules' },
		]);
		expect(options.HostConfig?.Binds).toBeUndefined();

		stub.triggerContainerExit(0);
		stub.endLogStream();
		await outcomePromise;
	});

	it('adds no Mounts key at all when devMount is absent (regression: unregistered Actors unaffected)', async () => {
		const stub = stubDockerForRun();
		const driver = new DockerDriver(stub.docker);
		driver.available = true;

		const outcomePromise = driver.startRun(
			{ runId: 'run-mount-2', imageId: 'fake-image', env: {}, memoryMbytes: 128, timeoutSecs: 60 },
			() => {},
		);
		await new Promise((resolve) => setImmediate(resolve));

		const [options] = stub.createContainer.mock.calls[0]!;
		expect(options.HostConfig?.Mounts).toBeUndefined();
		expect(options.HostConfig?.Binds).toBeUndefined();

		stub.triggerContainerExit(0);
		stub.endLogStream();
		await outcomePromise;
	});

	it('logs an explicit mount line naming both the host and container paths, before the container is even created, when devMount is present', async () => {
		const stub = stubDockerForRun();
		const driver = new DockerDriver(stub.docker);
		driver.available = true;
		const chunks: string[] = [];

		const outcomePromise = driver.startRun(
			{
				runId: 'run-mount-3',
				imageId: 'fake-image',
				env: {},
				memoryMbytes: 128,
				timeoutSecs: 60,
				devMount: { localDevFolder: '/host/src', imageWorkingDirectory: '/usr/src/app' },
			},
			(chunk) => chunks.push(chunk),
		);
		await new Promise((resolve) => setImmediate(resolve));

		expect(chunks.length).toBeGreaterThan(0);
		expect(chunks[0]).toContain('/host/src');
		expect(chunks[0]).toContain('/usr/src/app');

		stub.triggerContainerExit(0);
		stub.endLogStream();
		await outcomePromise;
	});

	it('logs nothing extra when devMount is absent', async () => {
		const stub = stubDockerForRun();
		const driver = new DockerDriver(stub.docker);
		driver.available = true;
		const chunks: string[] = [];

		const outcomePromise = driver.startRun(
			{ runId: 'run-mount-4', imageId: 'fake-image', env: {}, memoryMbytes: 128, timeoutSecs: 60 },
			(chunk) => chunks.push(chunk),
		);
		await new Promise((resolve) => setImmediate(resolve));

		expect(chunks).toEqual([]);

		stub.triggerContainerExit(0);
		stub.endLogStream();
		await outcomePromise;
	});
});

describe('DockerDriver container removal passes { v: true } (actor-driver.md: "container removal passes { v: true }")', () => {
	it("startRun's finally block removes the container with { v: true }, whether or not the run had a devMount", async () => {
		const stub = stubDockerForRun();
		const driver = new DockerDriver(stub.docker);
		driver.available = true;

		const outcomePromise = driver.startRun(
			{ runId: 'run-remove-1', imageId: 'fake-image', env: {}, memoryMbytes: 128, timeoutSecs: 60 },
			() => {},
		);
		await new Promise((resolve) => setImmediate(resolve));
		stub.triggerContainerExit(0);
		stub.endLogStream();
		await outcomePromise;

		expect(stub.container.remove).toHaveBeenCalledWith({ v: true });
	});
});

describe('DockerDriver.startBuild - imageWorkingDirectory capture (actor-driver.md: "imageWorkingDirectory is captured by the driver itself")', () => {
	/** A stub covering only what `startBuild` calls: `buildImage`, `modem.followProgress` (invoking its
	 * `onFinished` callback synchronously, as a successful build with no progress lines), and `getImage`
	 * for the post-build inspect. */
	function stubDockerForBuild(inspect: () => Promise<{ Config: { WorkingDir: string } }>) {
		const followProgress = vi.fn(
			(
				_stream: NodeJS.ReadableStream,
				onFinished: (err: Error | null, res: Array<{ error?: string }>) => void,
			) => {
				onFinished(null, []);
			},
		);
		const getImage = vi.fn(() => ({ inspect }));
		const docker = {
			buildImage: vi.fn(async () => new PassThrough()),
			modem: { followProgress },
			getImage,
		} as unknown as Docker;
		return { docker, getImage };
	}

	it("returns the image's Config.WorkingDir from docker.getImage(imageId).inspect(), never a shelled-out docker inspect", async () => {
		const stub = stubDockerForBuild(async () => ({ Config: { WorkingDir: '/usr/src/app' } }));
		const driver = new DockerDriver(stub.docker);
		driver.available = true;

		const outcome = await driver.startBuild(
			{ buildId: 'build-1', actorName: 'my-actor', sourceFiles: [], useCache: true, timeoutSecs: 60 },
			() => {},
		);

		expect(outcome.imageWorkingDirectory).toBe('/usr/src/app');
		expect(stub.getImage).toHaveBeenCalledWith(outcome.imageId);
	});

	it('tolerates an inspect rejection: the build still succeeds, with imageWorkingDirectory left unset', async () => {
		const stub = stubDockerForBuild(async () => {
			throw new Error('inspect failed');
		});
		const driver = new DockerDriver(stub.docker);
		driver.available = true;
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

		const outcome = await driver.startBuild(
			{ buildId: 'build-2', actorName: 'my-actor', sourceFiles: [], useCache: true, timeoutSecs: 60 },
			() => {},
		);

		expect(outcome.imageId).toBeTruthy();
		expect(outcome.imageWorkingDirectory).toBeUndefined();
		expect(warnSpy).toHaveBeenCalled();

		warnSpy.mockRestore();
	});

	it('leaves imageWorkingDirectory unset when the working directory is "/" (mounting over "/" would destroy the container)', async () => {
		const stub = stubDockerForBuild(async () => ({ Config: { WorkingDir: '/' } }));
		const driver = new DockerDriver(stub.docker);
		driver.available = true;

		const outcome = await driver.startBuild(
			{ buildId: 'build-3', actorName: 'my-actor', sourceFiles: [], useCache: true, timeoutSecs: 60 },
			() => {},
		);

		expect(outcome.imageWorkingDirectory).toBeUndefined();
	});

	it('leaves imageWorkingDirectory unset when the working directory is empty', async () => {
		const stub = stubDockerForBuild(async () => ({ Config: { WorkingDir: '' } }));
		const driver = new DockerDriver(stub.docker);
		driver.available = true;

		const outcome = await driver.startBuild(
			{ buildId: 'build-4', actorName: 'my-actor', sourceFiles: [], useCache: true, timeoutSecs: 60 },
			() => {},
		);

		expect(outcome.imageWorkingDirectory).toBeUndefined();
	});
});

describe('DockerDriver.ensureProbeImage (actor-driver.md: registration needs no build of its own)', () => {
	/** A stub covering only what `ensureProbeImage` calls: `buildImage` and `modem.followProgress`
	 * (invoking its `onFinished` callback synchronously, as a successful build with no progress lines). */
	function stubDockerForProbeImageBuild() {
		const followProgress = vi.fn(
			(
				_stream: NodeJS.ReadableStream,
				onFinished: (err: Error | null, res: Array<{ error?: string }>) => void,
			) => {
				onFinished(null, []);
			},
		);
		const buildImage = vi.fn(async () => new PassThrough());
		const docker = { buildImage, modem: { followProgress } } as unknown as Docker;
		return { docker, buildImage, followProgress };
	}

	it('builds a `FROM scratch` + `CMD` Dockerfile via an in-memory tar, and returns the built image id', async () => {
		const stub = stubDockerForProbeImageBuild();
		const driver = new DockerDriver(stub.docker);
		driver.available = true;

		const imageId = await driver.ensureProbeImage();

		expect(imageId).toBeTruthy();
		expect(stub.buildImage).toHaveBeenCalledTimes(1);
		const [tarball, options] = stub.buildImage.mock.calls[0]!;
		expect(options).toMatchObject({ t: imageId });
		// The tarball is a real Dockerfile-only tar stream, not source files - reading it back confirms
		// both the `FROM scratch` base (no build context/network needed) and the `CMD` that keeps
		// `createContainer` from rejecting the image with "no command specified".
		const extract = tar.extract();
		const entries: Array<{ name: string; content: string }> = [];
		await new Promise<void>((resolve, reject) => {
			extract.on('entry', (header, stream, next) => {
				const chunks: Buffer[] = [];
				stream.on('data', (chunk: Buffer) => chunks.push(chunk));
				stream.on('end', () => {
					entries.push({ name: header.name, content: Buffer.concat(chunks).toString('utf8') });
					next();
				});
				stream.resume();
			});
			extract.on('finish', resolve);
			extract.on('error', reject);
			(tarball as NodeJS.ReadableStream).pipe(extract);
		});
		expect(entries).toEqual([{ name: 'Dockerfile', content: expect.stringContaining('FROM scratch') }]);
		expect(entries[0]?.content).toContain('CMD');
	});

	it('builds only once and reuses the same image id on every later call - idempotent, never rebuilt per registration', async () => {
		const stub = stubDockerForProbeImageBuild();
		const driver = new DockerDriver(stub.docker);
		driver.available = true;

		const first = await driver.ensureProbeImage();
		const second = await driver.ensureProbeImage();
		const third = await driver.ensureProbeImage();

		expect(second).toBe(first);
		expect(third).toBe(first);
		expect(stub.buildImage).toHaveBeenCalledTimes(1);
	});

	it('shares one in-flight build across concurrent callers rather than racing separate buildImage calls', async () => {
		const stub = stubDockerForProbeImageBuild();
		const driver = new DockerDriver(stub.docker);
		driver.available = true;

		const [first, second] = await Promise.all([driver.ensureProbeImage(), driver.ensureProbeImage()]);

		expect(second).toBe(first);
		expect(stub.buildImage).toHaveBeenCalledTimes(1);
	});

	it('throws (never a hang) when the driver already knows Docker is unavailable, and never calls buildImage', async () => {
		const stub = stubDockerForProbeImageBuild();
		const driver = new DockerDriver(stub.docker);
		// driver.available defaults to false - init() never ran.

		await expect(driver.ensureProbeImage()).rejects.toThrow();
		expect(stub.buildImage).not.toHaveBeenCalled();
	});

	it('does not cache a failed build - a later call gets to retry against a daemon that may have recovered', async () => {
		const followProgress = vi.fn(
			(
				_stream: NodeJS.ReadableStream,
				onFinished: (err: Error | null, res: Array<{ error?: string }>) => void,
			) => {
				onFinished(null, [{ error: 'build step failed' }]);
			},
		);
		let callCount = 0;
		const buildImage = vi.fn(async () => {
			callCount += 1;
			return new PassThrough();
		});
		const driver = new DockerDriver({ buildImage, modem: { followProgress } } as unknown as Docker);
		driver.available = true;

		await expect(driver.ensureProbeImage()).rejects.toThrow('build step failed');
		expect(callCount).toBe(1);

		// Retried, not replayed from a cached rejection.
		await expect(driver.ensureProbeImage()).rejects.toThrow('build step failed');
		expect(callCount).toBe(2);
	});
});

describe('DockerDriver.probeDevFolder (actor-driver.md: "A host-side existence-and-directory check")', () => {
	it('returns ok and removes the (never-started) probe container on success, without ever calling .start()', async () => {
		const start = vi.fn();
		const remove = vi.fn(async () => undefined);
		// Typed with the real `dockerode` parameter shape so `mock.calls[0]` is genuinely a
		// `[Docker.ContainerCreateOptions]` tuple below - no unsound cast needed to read it back.
		const createContainer = vi.fn(async (_options: Docker.ContainerCreateOptions) => ({ remove, start }));
		const driver = new DockerDriver({ createContainer } as unknown as Docker);
		driver.available = true;

		const outcome = await driver.probeDevFolder('/abs/path', 'image:tag');

		expect(outcome).toEqual({ ok: true });
		expect(createContainer).toHaveBeenCalledTimes(1);
		const [options] = createContainer.mock.calls[0]!;
		expect(options.Image).toBe('image:tag');
		// `/.` appended to the candidate path (directive: "the probe must accept ONLY directories") - the
		// stored/returned path itself is never affected, only this internal probe `Source`.
		expect(options.HostConfig?.Mounts).toEqual([
			{ Type: 'bind', Source: '/abs/path/.', Target: '/probe', ReadOnly: true },
		]);
		expect(remove).toHaveBeenCalledTimes(1);
		expect(start).not.toHaveBeenCalled();
		expect(options.Labels).toEqual({ 'actor-runtime.devFolderProbe': 'true' });
	});

	it('still reports ok when the probe container was created but its removal fails, and logs the failure instead of swallowing it', async () => {
		const remove = vi.fn(async () => {
			throw new Error('removal failed: container already stopping');
		});
		const createContainer = vi.fn(async () => ({ id: 'probe-id', remove, start: vi.fn() }));
		const driver = new DockerDriver({ createContainer } as unknown as Docker);
		driver.available = true;
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

		const outcome = await driver.probeDevFolder('/abs/path', 'image:tag');

		expect(outcome).toEqual({ ok: true });
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('probe-id'));
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('removal failed'));
		warn.mockRestore();
	});

	it('never even calls createContainer when the driver already knows Docker is unavailable - short-circuits to unreachable', async () => {
		const createContainer = vi.fn(async () => ({ remove: vi.fn() }));
		const driver = new DockerDriver({ createContainer } as unknown as Docker);
		// driver.available defaults to false - init() never ran.

		const outcome = await driver.probeDevFolder('/abs/path', 'image:tag');

		expect(outcome).toEqual({ ok: false, reason: 'unreachable' });
		expect(createContainer).not.toHaveBeenCalled();
	});

	it('classifies a rejection with no .statusCode as unreachable (a raw transport failure), never as "does not exist"', async () => {
		const createContainer = vi.fn(async () => {
			throw new Error('connect ECONNREFUSED /var/run/docker.sock');
		});
		const driver = new DockerDriver({ createContainer } as unknown as Docker);
		driver.available = true;

		const outcome = await driver.probeDevFolder('/abs/path', 'image:tag');

		expect(outcome).toEqual({ ok: false, reason: 'unreachable' });
	});

	it("classifies a 404 rejection as image-missing (the probe's own image is gone, an operational fault)", async () => {
		const createContainer = vi.fn(async () => {
			throw Object.assign(new Error('(HTTP code 404) no such image: image:tag'), { statusCode: 404 });
		});
		const driver = new DockerDriver({ createContainer } as unknown as Docker);
		driver.available = true;

		const outcome = await driver.probeDevFolder('/abs/path', 'image:tag');

		expect(outcome).toEqual({ ok: false, reason: 'image-missing' });
	});

	it('classifies the exact "bind source path does not exist" substring as not-found - the one case allowed to say so', async () => {
		const createContainer = vi.fn(async () => {
			throw Object.assign(
				new Error(
					'(HTTP code 400) client error - invalid mount config for type "bind": bind source path does not exist: /abs/path ',
				),
				{ statusCode: 400 },
			);
		});
		const driver = new DockerDriver({ createContainer } as unknown as Docker);
		driver.available = true;

		const outcome = await driver.probeDevFolder('/abs/path', 'image:tag');

		expect(outcome).toEqual({ ok: false, reason: 'not-found' });
	});

	it('classifies a differently-worded "must be a directory" rejection as unknown, never as not-a-directory - only the exact "not a directory" substring is', async () => {
		const createContainer = vi.fn(async () => {
			throw Object.assign(
				new Error(
					'(HTTP code 400) client error - invalid mount config for type "bind": source path must be a directory',
				),
				{ statusCode: 400 },
			);
		});
		const driver = new DockerDriver({ createContainer } as unknown as Docker);
		driver.available = true;

		const outcome = await driver.probeDevFolder('/abs/path', 'image:tag');

		expect(outcome).toEqual({ ok: false, reason: 'unknown' });
	});

	it('classifies the exact "not a directory" substring as not-a-directory - a regular file candidate, discriminated by the appended "/." (verified empirically against a real daemon)', async () => {
		const createContainer = vi.fn(async () => {
			throw Object.assign(
				new Error(
					'(HTTP code 400) bad parameter - invalid mount config for type "bind": stat /abs/path/.: not a directory',
				),
				{ statusCode: 400 },
			);
		});
		const driver = new DockerDriver({ createContainer } as unknown as Docker);
		driver.available = true;

		const outcome = await driver.probeDevFolder('/abs/path', 'image:tag');

		expect(outcome).toEqual({ ok: false, reason: 'not-a-directory' });
	});

	it('classifies a Docker Desktop file-sharing denial (a real, existing path) as unknown, never as not-found - the false-negative this design deliberately avoids', async () => {
		const createContainer = vi.fn(async () => {
			throw Object.assign(
				new Error(
					'(HTTP code 400) client error - Mounts denied: The path /abs/path is not shared from the host and is not known to Docker.',
				),
				{ statusCode: 400 },
			);
		});
		const driver = new DockerDriver({ createContainer } as unknown as Docker);
		driver.available = true;

		const outcome = await driver.probeDevFolder('/abs/path', 'image:tag');

		expect(outcome).toEqual({ ok: false, reason: 'unknown' });
	});
});

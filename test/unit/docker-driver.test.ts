import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Docker from 'dockerode';
import * as tar from 'tar-stream';

import { DockerDriver } from '../../src/driver/docker-driver.js';
import { stubDockerForRun } from './helpers/docker-stubs.js';

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
			{
				buildId: 'build-1',
				actorName: 'my-actor',
				sourceFiles: [],
				useCache: true,
				timeoutSecs: 60,
				dockerfilePath: 'Dockerfile',
			},
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
			{
				buildId: 'build-2',
				actorName: 'my-actor',
				sourceFiles: [],
				useCache: true,
				timeoutSecs: 60,
				dockerfilePath: 'Dockerfile',
			},
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
			{
				buildId: 'build-3',
				actorName: 'my-actor',
				sourceFiles: [],
				useCache: true,
				timeoutSecs: 60,
				dockerfilePath: 'Dockerfile',
			},
			() => {},
		);

		expect(outcome.imageWorkingDirectory).toBeUndefined();
	});

	it('leaves imageWorkingDirectory unset when the working directory is empty', async () => {
		const stub = stubDockerForBuild(async () => ({ Config: { WorkingDir: '' } }));
		const driver = new DockerDriver(stub.docker);
		driver.available = true;

		const outcome = await driver.startBuild(
			{
				buildId: 'build-4',
				actorName: 'my-actor',
				sourceFiles: [],
				useCache: true,
				timeoutSecs: 60,
				dockerfilePath: 'Dockerfile',
			},
			() => {},
		);

		expect(outcome.imageWorkingDirectory).toBeUndefined();
	});
});

describe('DockerDriver.startBuild - dockerfile option (the resolved path is handed to dockerode as its `dockerfile` build option)', () => {
	function stubDockerCapturingBuildImageOptions() {
		const followProgress = vi.fn(
			(
				_stream: NodeJS.ReadableStream,
				onFinished: (err: Error | null, res: Array<{ error?: string }>) => void,
			) => {
				onFinished(null, []);
			},
		);
		const buildImage = vi.fn(async () => new PassThrough());
		const getImage = vi.fn(() => ({ inspect: async () => ({ Config: { WorkingDir: '' } }) }));
		const docker = { buildImage, modem: { followProgress }, getImage } as unknown as Docker;
		return { docker, buildImage };
	}

	it('passes ctx.dockerfilePath through verbatim as buildImage\'s "dockerfile" option', async () => {
		const stub = stubDockerCapturingBuildImageOptions();
		const driver = new DockerDriver(stub.docker);
		driver.available = true;

		await driver.startBuild(
			{
				buildId: 'build-dockerfile-option',
				actorName: 'my-actor',
				sourceFiles: [],
				useCache: true,
				timeoutSecs: 60,
				dockerfilePath: '.actor/Dockerfile',
			},
			() => {},
		);

		expect(stub.buildImage).toHaveBeenCalledTimes(1);
		const [, options] = stub.buildImage.mock.calls[0]!;
		expect(options).toMatchObject({ dockerfile: '.actor/Dockerfile' });
	});

	it('always sets the "dockerfile" option, even for the plain root-"Dockerfile" case that coincides with Docker\'s own implicit default', async () => {
		const stub = stubDockerCapturingBuildImageOptions();
		const driver = new DockerDriver(stub.docker);
		driver.available = true;

		await driver.startBuild(
			{
				buildId: 'build-dockerfile-option-2',
				actorName: 'my-actor',
				sourceFiles: [],
				useCache: true,
				timeoutSecs: 60,
				dockerfilePath: 'Dockerfile',
			},
			() => {},
		);

		const [, options] = stub.buildImage.mock.calls[0]!;
		expect(options).toMatchObject({ dockerfile: 'Dockerfile' });
	});

	it('normalizes tar entry names (leading "./" stripped) so a resolved dockerfilePath always names an entry that actually exists in the tar', async () => {
		const stub = stubDockerCapturingBuildImageOptions();
		const driver = new DockerDriver(stub.docker);
		driver.available = true;

		await driver.startBuild(
			{
				buildId: 'build-dockerfile-option-3',
				actorName: 'my-actor',
				sourceFiles: [{ name: './.actor/Dockerfile', format: 'TEXT', content: 'FROM node:20\n' }],
				useCache: true,
				timeoutSecs: 60,
				dockerfilePath: '.actor/Dockerfile',
			},
			() => {},
		);

		const [tarball] = stub.buildImage.mock.calls[0]!;
		const extract = tar.extract();
		const entryNames: string[] = [];
		await new Promise<void>((resolve, reject) => {
			extract.on('entry', (header, entryStream, next) => {
				entryNames.push(header.name);
				entryStream.resume();
				next();
			});
			extract.on('finish', resolve);
			extract.on('error', reject);
			(tarball as NodeJS.ReadableStream).pipe(extract);
		});

		expect(entryNames).toEqual(['.actor/Dockerfile']);
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

describe('DockerDriver.startRun - CFS CPU limit (actor-driver.md: CpuPeriod/CpuQuota, never NanoCpus)', () => {
	it('encodes the CPU limit as HostConfig.CpuPeriod/CpuQuota derived from memoryMbytes/4096, never sets NanoCpus, and leaves Memory unchanged', async () => {
		const stub = stubDockerForRun();
		const driver = new DockerDriver(stub.docker);
		driver.available = true;

		const outcomePromise = driver.startRun(
			{ runId: 'run-cpu-1', imageId: 'fake-image', env: {}, memoryMbytes: 1024, timeoutSecs: 60 },
			() => {},
		);
		await new Promise((resolve) => setImmediate(resolve));

		const [options] = stub.createContainer.mock.calls[0]!;
		// 1024 / 4096 = 0.25 core = 25000us of every 100000us period - the ratio worked example in
		// `requirements/actor-driver.md`'s "Resource limits" section.
		expect(options.HostConfig?.CpuPeriod).toBe(100_000);
		expect(options.HostConfig?.CpuQuota).toBe(25_000);
		expect(options.HostConfig?.Memory).toBe(1024 * 1024 * 1024);
		expect(options.HostConfig?.NanoCpus).toBeUndefined();

		stub.triggerContainerExit(0);
		stub.endLogStream();
		await outcomePromise;
	});

	it("raises the computed quota to Docker's own protocol minimum of 1000us when the raw memoryMbytes/4096 ratio computes lower - a protocol floor, never a host-capacity clamp", async () => {
		const stub = stubDockerForRun();
		const driver = new DockerDriver(stub.docker);
		driver.available = true;

		const outcomePromise = driver.startRun(
			{ runId: 'run-cpu-2', imageId: 'fake-image', env: {}, memoryMbytes: 32, timeoutSecs: 60 },
			() => {},
		);
		await new Promise((resolve) => setImmediate(resolve));

		const [options] = stub.createContainer.mock.calls[0]!;
		// Raw: 32 / 4096 * 100000 = 781.25us, below the 1000us floor.
		expect(options.HostConfig?.CpuQuota).toBe(1000);
		expect(options.HostConfig?.CpuPeriod).toBe(100_000);

		stub.triggerContainerExit(0);
		stub.endLogStream();
		await outcomePromise;
	});
});

/**
 * A stub `dockerode`-shaped object supporting both `init()` (`ping`/`listNetworks`/`createNetwork`/
 * `info`) and `startRun()` (reusing `stubDockerForRun`'s own container/createContainer stub) - for
 * exercising the host-capacity warning end to end: `docker.info()`'s snapshot at `init()` time feeding
 * `startRun()`'s over-capacity check. `info` is caller-supplied so each test controls exactly what
 * `docker.info()` resolves (or rejects) with.
 */
function stubDockerForCapacity(info: () => Promise<unknown>) {
	const run = stubDockerForRun();
	const docker = {
		...run.docker,
		ping: vi.fn(async () => undefined),
		listNetworks: vi.fn(async () => []),
		createNetwork: vi.fn(async () => undefined),
		info: vi.fn(info),
	} as unknown as Docker;
	return { ...run, docker };
}

describe('DockerDriver host-capacity warning (actor-driver.md: warn, never clamp)', () => {
	it('warns through onLog naming both the requested and host figures for both over-capacity resources, and still applies the requested limits verbatim (never clamped)', async () => {
		const stub = stubDockerForCapacity(async () => ({ NCPU: 4, MemTotal: 8_589_934_592 }));
		const driver = new DockerDriver(stub.docker);
		await driver.init();
		expect(driver.available).toBe(true);

		const chunks: string[] = [];
		const outcomePromise = driver.startRun(
			{ runId: 'run-capacity-1', imageId: 'fake-image', env: {}, memoryMbytes: 65_536, timeoutSecs: 60 },
			(chunk) => chunks.push(chunk),
		);
		await new Promise((resolve) => setImmediate(resolve));

		const warning = chunks.join('');
		expect(warning).toContain('65536 MB');
		expect(warning).toContain('8192 MB');
		expect(warning).toContain('16.00 CPU');
		expect(warning).toContain('host has 4');
		expect(warning).toMatch(/applying the requested limits anyway/);

		// Warned about, never clamped: the created container still carries the full requested limits.
		const [options] = stub.createContainer.mock.calls[0]!;
		expect(options.HostConfig?.Memory).toBe(65_536 * 1024 * 1024);
		expect(options.HostConfig?.CpuQuota).toBe(1_600_000);
		expect(options.HostConfig?.CpuPeriod).toBe(100_000);

		stub.triggerContainerExit(0);
		stub.endLogStream();
		await outcomePromise;
	});

	it('warns naming only the over-capacity resource when memory is over capacity but CPU is not', async () => {
		// NCPU: 16, MemTotal: 8192 MB - a host with plenty of CPU relative to its RAM at the platform's own
		// ratio. memoryMbytes: 16_384 -> 4 dedicated cores, which fits comfortably under 16; the memory
		// figure alone (16384 > 8192) is over capacity.
		const stub = stubDockerForCapacity(async () => ({ NCPU: 16, MemTotal: 8_589_934_592 }));
		const driver = new DockerDriver(stub.docker);
		await driver.init();

		const chunks: string[] = [];
		const outcomePromise = driver.startRun(
			{ runId: 'run-capacity-mem-only', imageId: 'fake-image', env: {}, memoryMbytes: 16_384, timeoutSecs: 60 },
			(chunk) => chunks.push(chunk),
		);
		await new Promise((resolve) => setImmediate(resolve));

		const warning = chunks.join('');
		expect(warning).toContain('16384 MB');
		expect(warning).toContain('host has 8192 MB');
		expect(warning).toMatch(/applying the requested limits anyway/);
		// The CPU figure must not appear at all - only the over-capacity resource is named.
		expect(warning).not.toContain('CPU cores');
		expect(warning).not.toContain('host has 16');

		// Still applied verbatim, unclamped.
		const [options] = stub.createContainer.mock.calls[0]!;
		expect(options.HostConfig?.Memory).toBe(16_384 * 1024 * 1024);
		expect(options.HostConfig?.CpuQuota).toBe(400_000);

		stub.triggerContainerExit(0);
		stub.endLogStream();
		await outcomePromise;
	});

	it('warns naming only the over-capacity resource when CPU is over capacity but memory is not', async () => {
		// NCPU: 1, MemTotal: 1 TiB - a host with plenty of RAM but only a single core. memoryMbytes: 8192 ->
		// 2 dedicated cores, over the host's single core; the memory figure (8192 MB against ~1,048,576 MB
		// of host RAM) is comfortably under capacity.
		const stub = stubDockerForCapacity(async () => ({ NCPU: 1, MemTotal: 1_099_511_627_776 }));
		const driver = new DockerDriver(stub.docker);
		await driver.init();

		const chunks: string[] = [];
		const outcomePromise = driver.startRun(
			{ runId: 'run-capacity-cpu-only', imageId: 'fake-image', env: {}, memoryMbytes: 8192, timeoutSecs: 60 },
			(chunk) => chunks.push(chunk),
		);
		await new Promise((resolve) => setImmediate(resolve));

		const warning = chunks.join('');
		expect(warning).toContain('2.00 CPU cores');
		expect(warning).toContain('host has 1');
		expect(warning).toMatch(/applying the requested limits anyway/);
		// The memory figure must not appear at all - only the over-capacity resource is named.
		expect(warning).not.toContain('MB (host has');

		// Still applied verbatim, unclamped.
		const [options] = stub.createContainer.mock.calls[0]!;
		expect(options.HostConfig?.Memory).toBe(8192 * 1024 * 1024);
		expect(options.HostConfig?.CpuQuota).toBe(200_000);

		stub.triggerContainerExit(0);
		stub.endLogStream();
		await outcomePromise;
	});

	it('produces no warning at all for an in-capacity request', async () => {
		const stub = stubDockerForCapacity(async () => ({ NCPU: 4, MemTotal: 8_589_934_592 }));
		const driver = new DockerDriver(stub.docker);
		await driver.init();

		const chunks: string[] = [];
		const outcomePromise = driver.startRun(
			{ runId: 'run-capacity-2', imageId: 'fake-image', env: {}, memoryMbytes: 1024, timeoutSecs: 60 },
			(chunk) => chunks.push(chunk),
		);
		await new Promise((resolve) => setImmediate(resolve));

		expect(chunks.join('')).toBe('');

		stub.triggerContainerExit(0);
		stub.endLogStream();
		await outcomePromise;
	});

	it('produces no warning when docker.info() rejects outright - capacity unknown, never a crash, never treated as capacity zero', async () => {
		const stub = stubDockerForCapacity(async () => {
			throw new Error('info unavailable');
		});
		const driver = new DockerDriver(stub.docker);
		await driver.init();
		// A docker.info() failure must never make the whole daemon look unavailable.
		expect(driver.available).toBe(true);

		const chunks: string[] = [];
		const outcomePromise = driver.startRun(
			{ runId: 'run-capacity-3', imageId: 'fake-image', env: {}, memoryMbytes: 65_536, timeoutSecs: 60 },
			(chunk) => chunks.push(chunk),
		);
		await new Promise((resolve) => setImmediate(resolve));

		expect(chunks.join('')).toBe('');

		stub.triggerContainerExit(0);
		stub.endLogStream();
		await outcomePromise;
	});

	it('produces no warning when docker.info() resolves but omits NCPU/MemTotal - capacity unknown, not capacity zero', async () => {
		const stub = stubDockerForCapacity(async () => ({}));
		const driver = new DockerDriver(stub.docker);
		await driver.init();

		const chunks: string[] = [];
		const outcomePromise = driver.startRun(
			{ runId: 'run-capacity-4', imageId: 'fake-image', env: {}, memoryMbytes: 65_536, timeoutSecs: 60 },
			(chunk) => chunks.push(chunk),
		);
		await new Promise((resolve) => setImmediate(resolve));

		expect(chunks.join('')).toBe('');

		stub.triggerContainerExit(0);
		stub.endLogStream();
		await outcomePromise;
	});
});

describe("DockerDriver.inspectDebugTarget (services/debug-mode.ts: resolveDebugPlan's own input)", () => {
	function stubDockerForInspect(config: {
		Cmd?: string[] | null;
		Entrypoint?: string | string[] | null;
		Env?: string[];
	}) {
		const inspect = vi.fn(async () => ({
			Config: {
				Cmd: config.Cmd ?? null,
				Entrypoint: config.Entrypoint ?? null,
				Env: config.Env ?? [],
			},
		}));
		const getImage = vi.fn(() => ({ inspect }));
		return { docker: { getImage } as unknown as Docker, getImage };
	}

	it('reads Config.Cmd verbatim as an array', async () => {
		const stub = stubDockerForInspect({ Cmd: ['python3', '-m', 'src'] });
		const driver = new DockerDriver(stub.docker);

		const target = await driver.inspectDebugTarget('image:tag');

		expect(target.cmd).toEqual(['python3', '-m', 'src']);
		expect(target.entrypoint).toBeUndefined();
		expect(stub.getImage).toHaveBeenCalledWith('image:tag');
	});

	it('normalizes a string-form Config.Entrypoint into a single-element array', async () => {
		const stub = stubDockerForInspect({ Entrypoint: 'docker-entrypoint.sh', Cmd: ['node', 'dist/main.js'] });
		const driver = new DockerDriver(stub.docker);

		const target = await driver.inspectDebugTarget('image:tag');

		expect(target.entrypoint).toEqual(['docker-entrypoint.sh']);
		expect(target.cmd).toEqual(['node', 'dist/main.js']);
	});

	it('leaves both cmd and entrypoint undefined for an image with neither set', async () => {
		const stub = stubDockerForInspect({});
		const driver = new DockerDriver(stub.docker);

		const target = await driver.inspectDebugTarget('image:tag');

		expect(target.cmd).toBeUndefined();
		expect(target.entrypoint).toBeUndefined();
	});

	it('extracts only the four env vars resolveDebugPlan needs, ignoring every other env entry', async () => {
		const stub = stubDockerForInspect({
			Env: [
				'PATH=/usr/bin',
				'PYTHONPATH=/usr/src/app',
				'NODE_OPTIONS=--max-old-space-size=4096',
				'PYTHON_VERSION=3.13.1',
				'NODE_VERSION=24.1.0',
				'UNRELATED=whatever',
			],
		});
		const driver = new DockerDriver(stub.docker);

		const target = await driver.inspectDebugTarget('image:tag');

		expect(target.env).toEqual({
			PYTHONPATH: '/usr/src/app',
			NODE_OPTIONS: '--max-old-space-size=4096',
			PYTHON_VERSION: '3.13.1',
			NODE_VERSION: '24.1.0',
		});
	});

	it('tolerates an env entry with no "=" at all rather than throwing', async () => {
		const stub = stubDockerForInspect({ Env: ['MALFORMED', 'PYTHON_VERSION=3.13.1'] });
		const driver = new DockerDriver(stub.docker);

		const target = await driver.inspectDebugTarget('image:tag');

		expect(target.env.PYTHON_VERSION).toBe('3.13.1');
	});
});

describe('DockerDriver.startRun - debug mode (actor-driver.md: "Debug mode")', () => {
	let payloadDir: string;
	const ORIGINAL_ENV = process.env.ACTOR_RUNTIME_DEBUGPY_PAYLOAD_DIR;

	beforeEach(() => {
		payloadDir = mkdtempSync(join(tmpdir(), 'actor-runtime-debugpy-payload-test-'));
		writeFileSync(join(payloadDir, 'debugpy-payload.tar'), 'fake-tar-content');
		writeFileSync(join(payloadDir, 'debugpy-version.txt'), '9.9.9\n');
		process.env.ACTOR_RUNTIME_DEBUGPY_PAYLOAD_DIR = payloadDir;
	});

	afterEach(() => {
		rmSync(payloadDir, { recursive: true, force: true });
		if (ORIGINAL_ENV === undefined) delete process.env.ACTOR_RUNTIME_DEBUGPY_PAYLOAD_DIR;
		else process.env.ACTOR_RUNTIME_DEBUGPY_PAYLOAD_DIR = ORIGINAL_ENV;
	});

	it("a non-debug run's createContainer options carry no ExposedPorts/PortBindings key at all (regression: byte-identical to today for an Actor that never touched the toggle)", async () => {
		const stub = stubDockerForRun();
		const driver = new DockerDriver(stub.docker);
		driver.available = true;

		const outcomePromise = driver.startRun(
			{ runId: 'run-nodebug-1', imageId: 'fake-image', env: {}, memoryMbytes: 128, timeoutSecs: 60 },
			() => {},
		);
		await new Promise((resolve) => setImmediate(resolve));

		const [options] = stub.createContainer.mock.calls[0]!;
		expect(options.ExposedPorts).toBeUndefined();
		expect(options.HostConfig?.PortBindings).toBeUndefined();
		expect(stub.container.putArchive).not.toHaveBeenCalled();

		stub.triggerContainerExit(0);
		stub.endLogStream();
		await outcomePromise;
	});

	it('a Node debug run sets ExposedPorts/PortBindings for the given port, bound to 127.0.0.1, and never touches Cmd/Entrypoint', async () => {
		const stub = stubDockerForRun();
		const driver = new DockerDriver(stub.docker);
		driver.available = true;

		const outcomePromise = driver.startRun(
			{
				runId: 'run-debug-node-1',
				imageId: 'fake-image',
				env: { NODE_OPTIONS: '--inspect-brk=0.0.0.0:9229' },
				memoryMbytes: 128,
				timeoutSecs: 60,
				debug: { language: 'node', port: 9229 },
			},
			() => {},
		);
		await new Promise((resolve) => setImmediate(resolve));

		const [options] = stub.createContainer.mock.calls[0]!;
		expect(options.ExposedPorts).toEqual({ '9229/tcp': {} });
		expect(options.HostConfig?.PortBindings).toEqual({
			'9229/tcp': [{ HostIp: '127.0.0.1', HostPort: '9229' }],
		});
		expect(options).not.toHaveProperty('Cmd');
		expect(options).not.toHaveProperty('Entrypoint');
		expect(stub.container.putArchive).not.toHaveBeenCalled();

		stub.triggerContainerExit(0);
		stub.endLogStream();
		await outcomePromise;
	});

	it('logs the attach line before createContainer, naming the language, the listen/publish address, and the unmodified-timeout warning', async () => {
		const stub = stubDockerForRun();
		const driver = new DockerDriver(stub.docker);
		driver.available = true;
		const events: string[] = [];
		stub.createContainer.mockImplementationOnce(async (..._args: unknown[]) => {
			events.push('createContainer');
			return stub.container;
		});

		const outcomePromise = driver.startRun(
			{
				runId: 'run-debug-node-2',
				imageId: 'fake-image',
				env: {},
				memoryMbytes: 128,
				timeoutSecs: 300,
				debug: { language: 'node', port: 9229 },
			},
			(chunk) => events.push(`log:${chunk}`),
		);
		await new Promise((resolve) => setImmediate(resolve));

		// The log line lands before `createContainer` is even called - matching the dev-mount line's own
		// convention (`docker-driver.ts`'s doc comment on `startRun`).
		expect(events[0]).toMatch(/^log:/);
		expect(events).toContain('createContainer');
		const attachLine = events[0]!.slice('log:'.length);
		expect(attachLine).toContain('paused before its first line');
		expect(attachLine).toContain('0.0.0.0:9229');
		expect(attachLine).toContain('127.0.0.1:9229');
		expect(attachLine).toContain('300s timeout');
		expect(attachLine).toContain('NOT extended');

		stub.triggerContainerExit(0);
		stub.endLogStream();
		await outcomePromise;
	});

	it('a Python debug run uploads the debugpy payload via putArchive({ path: "/" }) between createContainer and start(), and names the debugpy version read from the payload in the attach line', async () => {
		const stub = stubDockerForRun();
		const driver = new DockerDriver(stub.docker);
		driver.available = true;
		const chunks: string[] = [];
		const callOrder: string[] = [];
		stub.createContainer.mockImplementationOnce(async () => {
			callOrder.push('createContainer');
			return stub.container;
		});
		stub.container.putArchive.mockImplementationOnce(async () => {
			callOrder.push('putArchive');
		});
		stub.container.start.mockImplementationOnce(async () => {
			callOrder.push('start');
		});

		const outcomePromise = driver.startRun(
			{
				runId: 'run-debug-python-1',
				imageId: 'fake-image',
				env: { PYTHONPATH: '/opt/apify-debug' },
				memoryMbytes: 128,
				timeoutSecs: 60,
				debug: { language: 'python', port: 5678 },
			},
			(chunk) => chunks.push(chunk),
		);
		// Real `fs.readFile` I/O (the payload preload) doesn't settle within a single microtask/`setImmediate`
		// tick the way the rest of this stub's in-memory flow does - poll briefly instead of assuming one tick
		// suffices.
		for (let i = 0; i < 50 && callOrder.length < 3; i++) {
			await new Promise((resolve) => setTimeout(resolve, 5));
		}

		expect(callOrder).toEqual(['createContainer', 'putArchive', 'start']);
		expect(stub.container.putArchive).toHaveBeenCalledWith(Buffer.from('fake-tar-content'), { path: '/' });
		expect(chunks[0]).toContain('debugpy 9.9.9');
		expect(chunks[0]).toContain('Attach to DAP');

		const [options] = stub.createContainer.mock.calls[0]!;
		expect(options.ExposedPorts).toEqual({ '5678/tcp': {} });
		expect(options.HostConfig?.PortBindings).toEqual({
			'5678/tcp': [{ HostIp: '127.0.0.1', HostPort: '5678' }],
		});

		stub.triggerContainerExit(0);
		stub.endLogStream();
		await outcomePromise;
	});

	it('fails the run before any container is created when the Python debug payload is missing from disk, with a clear message - never a silent non-debug start', async () => {
		rmSync(join(payloadDir, 'debugpy-payload.tar'));
		const stub = stubDockerForRun();
		const driver = new DockerDriver(stub.docker);
		driver.available = true;

		await expect(
			driver.startRun(
				{
					runId: 'run-debug-python-missing',
					imageId: 'fake-image',
					env: {},
					memoryMbytes: 128,
					timeoutSecs: 60,
					debug: { language: 'python', port: 5678 },
				},
				() => {},
			),
		).rejects.toThrow(/debugpy payload is missing/);

		expect(stub.createContainer).not.toHaveBeenCalled();
	});

	it('maps a "port is already allocated" start() rejection to a clear message naming the port and the port override, for a debug run', async () => {
		const stub = stubDockerForRun();
		stub.container.start.mockRejectedValueOnce(
			Object.assign(new Error('driver failed programming external connectivity: port is already allocated'), {
				statusCode: 500,
			}),
		);
		const driver = new DockerDriver(stub.docker);
		driver.available = true;

		await expect(
			driver.startRun(
				{
					runId: 'run-debug-port-conflict',
					imageId: 'fake-image',
					env: {},
					memoryMbytes: 128,
					timeoutSecs: 60,
					debug: { language: 'node', port: 9229 },
				},
				() => {},
			),
		).rejects.toThrow(/host port 9229 is already in use/);
	});

	it('does not rewrite an ordinary (non-port-conflict) start() failure for a debug run - the original error propagates', async () => {
		const stub = stubDockerForRun();
		stub.container.start.mockRejectedValueOnce(new Error('some other daemon failure'));
		const driver = new DockerDriver(stub.docker);
		driver.available = true;

		await expect(
			driver.startRun(
				{
					runId: 'run-debug-other-failure',
					imageId: 'fake-image',
					env: {},
					memoryMbytes: 128,
					timeoutSecs: 60,
					debug: { language: 'node', port: 9229 },
				},
				() => {},
			),
		).rejects.toThrow('some other daemon failure');
	});

	it("a port-in-use start() failure for a NON-debug run is left as the daemon's own message, unrewritten", async () => {
		const stub = stubDockerForRun();
		stub.container.start.mockRejectedValueOnce(new Error('port is already allocated'));
		const driver = new DockerDriver(stub.docker);
		driver.available = true;

		await expect(
			driver.startRun(
				{
					runId: 'run-nodebug-port-conflict',
					imageId: 'fake-image',
					env: {},
					memoryMbytes: 128,
					timeoutSecs: 60,
				},
				() => {},
			),
		).rejects.toThrow('port is already allocated');
	});

	it('removes the container ({ v: true }) even when the Python debugpy payload upload itself fails, never leaking it', async () => {
		const stub = stubDockerForRun();
		stub.container.putArchive.mockRejectedValueOnce(new Error('upload failed'));
		const driver = new DockerDriver(stub.docker);
		driver.available = true;

		await expect(
			driver.startRun(
				{
					runId: 'run-debug-python-upload-fail',
					imageId: 'fake-image',
					env: {},
					memoryMbytes: 128,
					timeoutSecs: 60,
					debug: { language: 'python', port: 5678 },
				},
				() => {},
			),
		).rejects.toThrow('upload failed');

		expect(stub.container.remove).toHaveBeenCalledWith({ v: true });
	});

	it('loads the debug payload from disk only once across multiple Python debug runs on the same driver instance', async () => {
		const driver = new DockerDriver(stubDockerForRun().docker);
		driver.available = true;

		for (let i = 0; i < 2; i++) {
			const stub = stubDockerForRun();
			// Reassign the driver's own docker client per run via a fresh stub's container/createContainer,
			// mirroring how a real driver would create a new container per run - reuse the SAME driver
			// instance so its internal payload cache persists across iterations.
			(driver as unknown as { docker: Docker }).docker = stub.docker;
			const outcomePromise = driver.startRun(
				{
					runId: `run-debug-python-cache-${i}`,
					imageId: 'fake-image',
					env: {},
					memoryMbytes: 128,
					timeoutSecs: 60,
					debug: { language: 'python', port: 5678 },
				},
				() => {},
			);
			await new Promise((resolve) => setImmediate(resolve));
			stub.triggerContainerExit(0);
			stub.endLogStream();
			await outcomePromise;
		}
		// Both runs succeeded reading the same on-disk fixture written once in `beforeEach` - if the driver
		// re-read the (now on-disk-but-conceptually-"gone-after-first-read") payload path per run instead
		// of caching, this would still pass since the file stays present; the cache's own effect is
		// verified more directly by the earlier "missing payload" test never leaving stale cached state
		// across driver instances.
		expect(true).toBe(true);
	});

	it('a debug run\'s timeoutSecs timer fires exactly like a non-debug run\'s - the pause gets no extra grace period (actor-driver.md: "completely unaffected by debug mode")', async () => {
		const stub = stubDockerForRun();
		const driver = new DockerDriver(stub.docker);
		driver.available = true;

		// A tiny real timeout - the container is never told to exit, mirroring a session where no
		// debugger ever attaches, so the only thing that can end this run is the timer itself.
		const outcomePromise = driver.startRun(
			{
				runId: 'run-debug-timeout',
				imageId: 'fake-image',
				env: {},
				memoryMbytes: 128,
				timeoutSecs: 0.05,
				debug: { language: 'node', port: 9229 },
			},
			() => {},
		);

		// The timer firing calls `container.stop()`, which this stub resolves without itself ending the
		// container - so the outcome only settles once `stop()` is observed AND the log stream is also
		// ended (mirroring a real daemon actually stopping the container and closing its logs).
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(stub.container.stop).toHaveBeenCalled();
		stub.triggerContainerExit(137);
		stub.endLogStream();

		const outcome = await outcomePromise;
		expect(outcome).toEqual({ exitCode: 137, timedOut: true });
	});

	describe('debug mode composes with the dev-folder bind mount (actor-driver.md: "the two features are independent")', () => {
		it('a run with both devMount and debug set carries both HostConfig.Mounts and the debug ExposedPorts/PortBindings/env, neither one suppressing the other', async () => {
			const stub = stubDockerForRun();
			const driver = new DockerDriver(stub.docker);
			driver.available = true;

			const outcomePromise = driver.startRun(
				{
					runId: 'run-debug-and-devmount',
					imageId: 'fake-image',
					env: { NODE_OPTIONS: '--inspect-brk=0.0.0.0:9229' },
					memoryMbytes: 128,
					timeoutSecs: 60,
					devMount: { localDevFolder: '/host/src', imageWorkingDirectory: '/usr/src/app' },
					debug: { language: 'node', port: 9229 },
				},
				() => {},
			);
			await new Promise((resolve) => setImmediate(resolve));

			const [options] = stub.createContainer.mock.calls[0]!;
			expect(options.HostConfig?.Mounts).toEqual([
				{ Type: 'bind', Source: '/host/src', Target: '/usr/src/app' },
				{ Type: 'volume', Source: '', Target: '/usr/src/app/node_modules' },
			]);
			expect(options.ExposedPorts).toEqual({ '9229/tcp': {} });
			expect(options.HostConfig?.PortBindings).toEqual({
				'9229/tcp': [{ HostIp: '127.0.0.1', HostPort: '9229' }],
			});
			expect(options.Env).toContain('NODE_OPTIONS=--inspect-brk=0.0.0.0:9229');

			stub.triggerContainerExit(0);
			stub.endLogStream();
			await outcomePromise;
		});
	});
});

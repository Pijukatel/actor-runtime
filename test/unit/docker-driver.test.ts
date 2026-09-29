import { mkdtemp, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';
import type Docker from 'dockerode';
import * as tar from 'tar-stream';

import {
	chooseDefaultNetworkRoute,
	defaultGatewayFromRouteTable,
	detectResourceLimitSupport,
	DockerDriver,
	hostAddressSeenFromContainers,
	podmanMajorVersion,
} from '../../src/driver/docker-driver.js';
import { stubDockerForRun } from './helpers/docker-stubs.js';
import { RUNTIME_LOG_PREFIX } from '../../src/runtime-log.js';

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
function stubDocker(
	containers: Array<{ Id: string; Labels: Record<string, string> }>,
	volumes: Array<{ Name: string; Labels: Record<string, string> }> = [],
) {
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
	// The browser-view sidecars' labelled X-socket volumes (`startBrowserViewer`) are swept by the same
	// call; modelled with the same per-key label semantics as `listContainers` above.
	const removedVolumes: string[] = [];
	const listVolumes = vi.fn(async (options: { filters: string }) => {
		const filters = JSON.parse(options.filters) as { label?: string[] };
		const labelKeys = filters.label ?? [];
		return { Volumes: volumes.filter((v) => labelKeys.every((key) => key in v.Labels)) };
	});
	const getVolume = vi.fn((name: string) => ({
		remove: vi.fn(async () => {
			removedVolumes.push(name);
		}),
	}));
	return {
		docker: { listContainers, getContainer, listVolumes, getVolume } as unknown as Docker,
		listContainers,
		getContainer,
		removed,
		removeCallOptions,
		removedVolumes,
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
		// All three label keys are still queried, just never together in one call.
		expect(allLabelValues.sort()).toEqual([
			'actor-runtime.browserViewer',
			'actor-runtime.devFolderProbe',
			'actor-runtime.runId',
		]);
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
		// id at all, so it can only ever be found by actually listing. Three calls now, one per label key.
		expect(listContainers).toHaveBeenCalledTimes(3);
	});

	it('sweeps a leftover browser-view sidecar container and its labelled X-socket volume unconditionally, like a probe (actor-driver.md: "Browser view")', async () => {
		const { docker, removed, removedVolumes } = stubDocker(
			[
				{
					Id: 'viewer-container',
					Labels: { 'actor-runtime.runId': 'run-old', 'actor-runtime.browserViewer': 'true' },
				},
			],
			[{ Name: 'actor-runtime-x11-run-old', Labels: { 'actor-runtime.browserViewer': 'true' } }],
		);
		const driver = new DockerDriver(docker);
		driver.available = true;

		// `run-old` is not in the orphan list (its record is already terminal) - the sidecar goes anyway.
		await driver.reconcileOrphans([]);

		expect(removed).toEqual(['viewer-container']);
		expect(removedVolumes).toEqual(['actor-runtime-x11-run-old']);
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

		allowDevMountRecheck(driver);

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
			{
				Type: 'volume',
				Source: expect.stringMatching(/^actor-runtime-node-modules-/),
				Target: '/usr/src/app/node_modules',
			},
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

describe('DockerDriver.abortRun - how hard the container is stopped (actor-driver.md: "aborting a run kills the run\'s container immediately")', () => {
	/** Starts a run so `runContainers` holds the stub container; the returned finisher ends it. */
	async function startTrackedRun(stub: ReturnType<typeof stubDockerForRun>, driver: DockerDriver, runId: string) {
		const outcomePromise = driver.startRun(
			{ runId, imageId: 'fake-image', env: {}, memoryMbytes: 128, timeoutSecs: 60 },
			() => {},
		);
		await new Promise((resolve) => setImmediate(resolve));
		return async () => {
			stub.triggerContainerExit(137);
			stub.endLogStream();
			await outcomePromise;
		};
	}

	it("kills the container outright by default - never container.stop(), whose engine-side default spends 10s on a signal an Actor image's PID 1 ignores", async () => {
		const stub = stubDockerForRun();
		const driver = new DockerDriver(stub.docker);
		driver.available = true;
		const finish = await startTrackedRun(stub, driver, 'run-abort-hard');

		await driver.abortRun('run-abort-hard');

		expect(stub.container.kill).toHaveBeenCalledTimes(1);
		expect(stub.container.stop).not.toHaveBeenCalled();
		await finish();
	});

	it("passes an explicit graceSecs through as stop()'s own `t`, never leaving the wait to the engine default", async () => {
		const stub = stubDockerForRun();
		const driver = new DockerDriver(stub.docker);
		driver.available = true;
		const finish = await startTrackedRun(stub, driver, 'run-abort-grace');

		await driver.abortRun('run-abort-grace', { graceSecs: 3 });

		expect(stub.container.stop).toHaveBeenCalledWith({ t: 3 });
		expect(stub.container.kill).not.toHaveBeenCalled();
		await finish();
	});

	it('is a no-op for a run it holds no container for', async () => {
		const stub = stubDockerForRun();
		const driver = new DockerDriver(stub.docker);
		driver.available = true;

		await driver.abortRun('run-never-started');

		expect(stub.container.kill).not.toHaveBeenCalled();
		expect(stub.container.stop).not.toHaveBeenCalled();
	});

	it('swallows a kill rejection (a container that exited on its own answers 409) rather than failing the abort', async () => {
		const stub = stubDockerForRun();
		const driver = new DockerDriver(stub.docker);
		driver.available = true;
		const finish = await startTrackedRun(stub, driver, 'run-abort-409');
		stub.container.kill.mockRejectedValueOnce(new Error('(HTTP code 409) container is not running'));

		await expect(driver.abortRun('run-abort-409')).resolves.toBeUndefined();
		await finish();
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

	it('hands ctx.buildArgs to buildImage as "buildargs", and omits the option when there are none', async () => {
		const stub = stubDockerCapturingBuildImageOptions();
		const driver = new DockerDriver(stub.docker);
		driver.available = true;
		const ctx = {
			buildId: 'build-args',
			actorName: 'my-actor',
			sourceFiles: [],
			useCache: true,
			timeoutSecs: 60,
			dockerfilePath: 'Dockerfile',
		};

		await driver.startBuild({ ...ctx, buildArgs: { MY_ARG: 'value' } }, () => {});
		await driver.startBuild(ctx, () => {});

		expect(stub.buildImage.mock.calls[0]![1]).toMatchObject({ buildargs: { MY_ARG: 'value' } });
		expect(stub.buildImage.mock.calls[1]![1]).not.toHaveProperty('buildargs');
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

describe('DockerDriver.startBuild - amd64 fallback (a base image published only for linux/amd64 cannot be built on an arm64 host at all)', () => {
	const ARM64_MANIFEST_FAILURE =
		'no matching manifest for linux/arm64/v8 in the manifest list entries: no match for platform in manifest: not found';

	/** A stub whose n-th build fails with `failures[n]` as an `error` line in the build stream (how the
	 * daemon reports a base image it could not pull), and succeeds once the list runs out. */
	function stubDockerForBuildAttempts(failures: Array<string | undefined>) {
		let attempt = 0;
		const followProgress = vi.fn(
			(
				_stream: NodeJS.ReadableStream,
				onFinished: (err: Error | null, res: Array<{ error?: string }>) => void,
			) => {
				const failure = failures[attempt++];
				onFinished(null, failure ? [{ error: failure }] : []);
			},
		);
		const buildImage = vi.fn(async () => new PassThrough());
		const getImage = vi.fn(() => ({ inspect: async () => ({ Config: { WorkingDir: '/usr/src/app' } }) }));
		const docker = { buildImage, modem: { followProgress }, getImage } as unknown as Docker;
		return { docker, buildImage };
	}

	const buildContext = (buildId: string) => ({
		buildId,
		actorName: 'my-playwright-actor-py',
		sourceFiles: [
			{
				name: 'Dockerfile',
				format: 'TEXT' as const,
				content: 'FROM docker.io/apify/actor-python-playwright:3.14-1.61.0\n',
			},
		],
		useCache: true,
		timeoutSecs: 60,
		dockerfilePath: 'Dockerfile',
	});

	it('rebuilds for linux/amd64, the platform the Apify platform builds on, and the build succeeds', async () => {
		const stub = stubDockerForBuildAttempts([ARM64_MANIFEST_FAILURE]);
		const driver = new DockerDriver(stub.docker);
		driver.available = true;
		const logged: string[] = [];

		const outcome = await driver.startBuild(buildContext('build-arm64-fallback'), (chunk) => logged.push(chunk));

		expect(outcome.imageWorkingDirectory).toBe('/usr/src/app');
		expect(stub.buildImage).toHaveBeenCalledTimes(2);
		const [, firstOptions] = stub.buildImage.mock.calls[0]!;
		const [, secondOptions] = stub.buildImage.mock.calls[1]!;
		expect(firstOptions).not.toHaveProperty('platform');
		expect(secondOptions).toMatchObject({ platform: 'linux/amd64', dockerfile: 'Dockerfile' });
		expect(logged.join('')).toContain(RUNTIME_LOG_PREFIX);
		expect(logged.join('')).toContain('Retrying the build for linux/amd64');
	});

	it("builds a fresh tar for the retry - a tar stream is consumed once, so reusing the first attempt's would send an empty context", async () => {
		const stub = stubDockerForBuildAttempts([ARM64_MANIFEST_FAILURE]);
		const driver = new DockerDriver(stub.docker);
		driver.available = true;

		await driver.startBuild(buildContext('build-arm64-fallback-tar'), () => {});

		const [firstTarball] = stub.buildImage.mock.calls[0]!;
		const [secondTarball] = stub.buildImage.mock.calls[1]!;
		expect(secondTarball).not.toBe(firstTarball);
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
			(secondTarball as NodeJS.ReadableStream).pipe(extract);
		});
		expect(entryNames).toEqual(['Dockerfile']);
	});

	it("reports the retry's own failure, never a third attempt, when linux/amd64 fails too (an engine with no emulation available)", async () => {
		const stub = stubDockerForBuildAttempts([ARM64_MANIFEST_FAILURE, 'exec /bin/sh: exec format error']);
		const driver = new DockerDriver(stub.docker);
		driver.available = true;

		await expect(driver.startBuild(buildContext('build-arm64-no-emulation'), () => {})).rejects.toThrow(
			'exec format error',
		);
		expect(stub.buildImage).toHaveBeenCalledTimes(2);
	});

	it('never retries an ordinary build failure', async () => {
		const stub = stubDockerForBuildAttempts(["The command '/bin/sh -c npm ci' returned a non-zero code: 1"]);
		const driver = new DockerDriver(stub.docker);
		driver.available = true;

		await expect(driver.startBuild(buildContext('build-ordinary-failure'), () => {})).rejects.toThrow(
			'returned a non-zero code: 1',
		);
		expect(stub.buildImage).toHaveBeenCalledTimes(1);
	});

	it('never retries after an abort: an aborted build stays aborted rather than starting a second build the caller already cancelled', async () => {
		let finish: ((res: Array<{ error?: string }>) => void) | undefined;
		const followProgress = vi.fn(
			(
				_stream: NodeJS.ReadableStream,
				onFinished: (err: Error | null, res: Array<{ error?: string }>) => void,
			) => {
				finish = (res) => onFinished(null, res);
			},
		);
		const buildImage = vi.fn(async () => new PassThrough());
		const docker = { buildImage, modem: { followProgress } } as unknown as Docker;
		const driver = new DockerDriver(docker);
		driver.available = true;

		const outcome = driver.startBuild(buildContext('build-aborted'), () => {});
		await vi.waitFor(() => expect(finish).toBeDefined());
		await driver.abortBuild('build-aborted');
		// What the destroyed request surfaces as - on an arm64 host, the very error the fallback looks for.
		finish!([{ error: ARM64_MANIFEST_FAILURE }]);

		await expect(outcome).rejects.toThrow(ARM64_MANIFEST_FAILURE);
		expect(buildImage).toHaveBeenCalledTimes(1);
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

/** Go `os.FileMode` type bits as they appear in the stat header's `mode` (`docker-driver.ts`'s
 * `GO_MODE_DIR`/`GO_MODE_SYMLINK`); `0o755`/`0o644` below are the permission bits real daemons add. */
const GO_DIR = 0x80000000 + 0o755;
const GO_FILE = 0o644;
const GO_SYMLINK = 0x08000000 + 0o777;

/** One stat answer per in-container path the probe may ask about: a mode (+ optional Docker-style
 * `linkTarget`), or an Error to reject with. A path with no entry rejects 404 like a real daemon does. */
type ProbeStatTable = Record<string, { mode: number; linkTarget?: string } | Error>;

function statHeader(mode: number, linkTarget = ''): string {
	const stat = { name: 'x', size: 0, mode, mtime: '2026-01-01T00:00:00Z', linkTarget };
	return Buffer.from(JSON.stringify(stat), 'utf8').toString('base64');
}

function http404(message: string): Error {
	return Object.assign(new Error(`(HTTP code 404) no such container - ${message} `), { statusCode: 404 });
}

/**
 * A stub `dockerode`-shaped object covering what `probeDevFolder` calls: `createContainer`, then
 * `container.infoArchive({ path })` (the `HEAD .../archive` stat - answered from `table`, with the
 * header a real daemon sets) and `container.remove()`. `infoArchive` resolves with the raw
 * `http.IncomingMessage`-shaped `{ headers, resume }` dockerode hands back for that `HEAD` call.
 */
function stubDockerForProbe(table: ProbeStatTable, options: { createError?: Error; removeError?: Error } = {}) {
	const start = vi.fn();
	const resume = vi.fn();
	const remove = vi.fn(async () => {
		if (options.removeError) throw options.removeError;
	});
	const infoArchive = vi.fn(async ({ path: containerPath }: { path: string }) => {
		const entry = table[containerPath];
		if (!entry) throw http404(`Could not find the file ${containerPath} in container probe-id`);
		if (entry instanceof Error) throw entry;
		return { headers: { 'x-docker-container-path-stat': statHeader(entry.mode, entry.linkTarget) }, resume };
	});
	const createContainer = vi.fn(async (_options: Docker.ContainerCreateOptions) => {
		if (options.createError) throw options.createError;
		return { id: 'probe-id', remove, start, infoArchive };
	});
	return {
		docker: { createContainer } as unknown as Docker,
		createContainer,
		infoArchive,
		remove,
		start,
		resume,
		statedPaths: () => infoArchive.mock.calls.map(([call]) => call.path),
	};
}

describe('DockerDriver.probeDevFolder (actor-driver.md: "A host-side existence-and-directory check")', () => {
	it('binds the host root read-only at /probe (never the candidate itself - Podman would auto-create a missing one), stats the candidate component by component, and removes the never-started container', async () => {
		const stub = stubDockerForProbe({ '/probe/abs': { mode: GO_DIR }, '/probe/abs/path': { mode: GO_DIR } });
		const driver = new DockerDriver(stub.docker);
		driver.available = true;

		const outcome = await driver.probeDevFolder('/abs/path', 'image:tag');

		expect(outcome).toEqual({ ok: true });
		expect(stub.createContainer).toHaveBeenCalledTimes(1);
		const [options] = stub.createContainer.mock.calls[0]!;
		expect(options.Image).toBe('image:tag');
		expect(options.HostConfig?.Mounts).toEqual([{ Type: 'bind', Source: '/', Target: '/probe', ReadOnly: true }]);
		expect(options.Labels).toEqual({ 'actor-runtime.devFolderProbe': 'true' });
		expect(stub.statedPaths()).toEqual(['/probe/abs', '/probe/abs/path']);
		expect(stub.remove).toHaveBeenCalledTimes(1);
		expect(stub.start).not.toHaveBeenCalled();
		// The bodiless HEAD response is still consumed so its socket is released.
		expect(stub.resume).toHaveBeenCalled();
	});

	it('normalizes a trailing slash and repeated separators away rather than stat-ing empty components', async () => {
		const stub = stubDockerForProbe({ '/probe/abs': { mode: GO_DIR }, '/probe/abs/path': { mode: GO_DIR } });
		const driver = new DockerDriver(stub.docker);
		driver.available = true;

		expect(await driver.probeDevFolder('/abs//path/', 'image:tag')).toEqual({ ok: true });
		expect(stub.statedPaths()).toEqual(['/probe/abs', '/probe/abs/path']);
	});

	it('accepts / itself by stat-ing the mount root', async () => {
		const stub = stubDockerForProbe({ '/probe': { mode: GO_DIR } });
		const driver = new DockerDriver(stub.docker);
		driver.available = true;

		expect(await driver.probeDevFolder('/', 'image:tag')).toEqual({ ok: true });
		expect(stub.statedPaths()).toEqual(['/probe']);
	});

	it('still reports ok when the probe container was created but its removal fails, and logs the failure instead of swallowing it', async () => {
		const stub = stubDockerForProbe(
			{ '/probe/abs': { mode: GO_DIR }, '/probe/abs/path': { mode: GO_DIR } },
			{ removeError: new Error('removal failed: container already stopping') },
		);
		const driver = new DockerDriver(stub.docker);
		driver.available = true;
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

		const outcome = await driver.probeDevFolder('/abs/path', 'image:tag');

		expect(outcome).toEqual({ ok: true });
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('probe-id'));
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('removal failed'));
		warn.mockRestore();
	});

	it('never even calls createContainer when the driver already knows the daemon is unavailable - short-circuits to unreachable', async () => {
		const stub = stubDockerForProbe({});
		const driver = new DockerDriver(stub.docker);
		// driver.available defaults to false - init() never ran.

		expect(await driver.probeDevFolder('/abs/path', 'image:tag')).toEqual({ ok: false, reason: 'unreachable' });
		expect(stub.createContainer).not.toHaveBeenCalled();
	});

	it('classifies a createContainer rejection with no .statusCode as unreachable (a raw transport failure), never as "does not exist"', async () => {
		const stub = stubDockerForProbe({}, { createError: new Error('connect ECONNREFUSED /var/run/docker.sock') });
		const driver = new DockerDriver(stub.docker);
		driver.available = true;

		expect(await driver.probeDevFolder('/abs/path', 'image:tag')).toEqual({ ok: false, reason: 'unreachable' });
	});

	it("classifies a 404 createContainer rejection as image-missing (the probe's own image is gone, an operational fault) - the mount source is always /, so a create rejection is never about the candidate", async () => {
		const stub = stubDockerForProbe({}, { createError: http404('no such image: image:tag') });
		const driver = new DockerDriver(stub.docker);
		driver.available = true;

		expect(await driver.probeDevFolder('/abs/path', 'image:tag')).toEqual({ ok: false, reason: 'image-missing' });
	});

	it('classifies any other answered createContainer rejection as unknown', async () => {
		const stub = stubDockerForProbe(
			{},
			{ createError: Object.assign(new Error('(HTTP code 500) server error - boom'), { statusCode: 500 }) },
		);
		const driver = new DockerDriver(stub.docker);
		driver.available = true;

		expect(await driver.probeDevFolder('/abs/path', 'image:tag')).toEqual({ ok: false, reason: 'unknown' });
	});

	it("classifies the daemon's 404 for the final component as not-found - the one case allowed to say so - and still removes the probe container", async () => {
		const stub = stubDockerForProbe({ '/probe/abs': { mode: GO_DIR } });
		const driver = new DockerDriver(stub.docker);
		driver.available = true;

		expect(await driver.probeDevFolder('/abs/path', 'image:tag')).toEqual({ ok: false, reason: 'not-found' });
		expect(stub.statedPaths()).toEqual(['/probe/abs', '/probe/abs/path']);
		expect(stub.remove).toHaveBeenCalledTimes(1);
	});

	it('stops at the first missing intermediate component, also as not-found', async () => {
		const stub = stubDockerForProbe({});
		const driver = new DockerDriver(stub.docker);
		driver.available = true;

		expect(await driver.probeDevFolder('/abs/path', 'image:tag')).toEqual({ ok: false, reason: 'not-found' });
		expect(stub.statedPaths()).toEqual(['/probe/abs']);
	});

	it('classifies a regular file candidate as not-a-directory, never as not-found', async () => {
		const stub = stubDockerForProbe({ '/probe/abs': { mode: GO_DIR }, '/probe/abs/file.txt': { mode: GO_FILE } });
		const driver = new DockerDriver(stub.docker);
		driver.available = true;

		expect(await driver.probeDevFolder('/abs/file.txt', 'image:tag')).toEqual({
			ok: false,
			reason: 'not-a-directory',
		});
	});

	it('classifies a stat rejection with no .statusCode as unreachable, and any other answered non-404 rejection as unknown - never as "does not exist"', async () => {
		const transport = stubDockerForProbe({ '/probe/abs': new Error('socket hang up') });
		const transportDriver = new DockerDriver(transport.docker);
		transportDriver.available = true;
		expect(await transportDriver.probeDevFolder('/abs/path', 'image:tag')).toEqual({
			ok: false,
			reason: 'unreachable',
		});

		const denied = stubDockerForProbe({
			'/probe/abs': Object.assign(new Error('(HTTP code 500) server error - permission denied'), {
				statusCode: 500,
			}),
		});
		const deniedDriver = new DockerDriver(denied.docker);
		deniedDriver.available = true;
		expect(await deniedDriver.probeDevFolder('/abs/path', 'image:tag')).toEqual({ ok: false, reason: 'unknown' });
	});

	it('classifies a stat response without a parseable X-Docker-Container-Path-Stat header as unknown', async () => {
		const stub = stubDockerForProbe({});
		stub.infoArchive.mockResolvedValueOnce({ headers: {}, resume: vi.fn() });
		const driver = new DockerDriver(stub.docker);
		driver.available = true;

		expect(await driver.probeDevFolder('/abs', 'image:tag')).toEqual({ ok: false, reason: 'unknown' });
	});

	describe('symlinks (Docker reports a symlink component as such, with a container-scoped linkTarget; Podman follows it itself)', () => {
		it('follows a symlink whose target the daemon reports under the probe mount, then keeps walking the remaining components', async () => {
			const stub = stubDockerForProbe({
				'/probe/home': { mode: GO_DIR },
				'/probe/home/link': { mode: GO_SYMLINK, linkTarget: '/probe/data/real' },
				'/probe/data': { mode: GO_DIR },
				'/probe/data/real': { mode: GO_DIR },
				'/probe/data/real/sub': { mode: GO_DIR },
			});
			const driver = new DockerDriver(stub.docker);
			driver.available = true;

			expect(await driver.probeDevFolder('/home/link/sub', 'image:tag')).toEqual({ ok: true });
			expect(stub.statedPaths()).toEqual([
				'/probe/home',
				'/probe/home/link',
				'/probe/data',
				'/probe/data/real',
				'/probe/data/real/sub',
			]);
		});

		it('treats a linkTarget that escaped the probe mount (a host-absolute target, reported verbatim) as a host path and re-stats it under the mount', async () => {
			const stub = stubDockerForProbe({
				'/probe/home': { mode: GO_DIR },
				'/probe/home/link': { mode: GO_SYMLINK, linkTarget: '/data/real' },
				'/probe/data': { mode: GO_DIR },
				'/probe/data/real': { mode: GO_DIR },
			});
			const driver = new DockerDriver(stub.docker);
			driver.available = true;

			expect(await driver.probeDevFolder('/home/link', 'image:tag')).toEqual({ ok: true });
			expect(stub.statedPaths()).toEqual(['/probe/home', '/probe/home/link', '/probe/data', '/probe/data/real']);
		});

		it('a symlink to a regular file is not-a-directory; a dangling symlink is not-found', async () => {
			const toFile = stubDockerForProbe({
				'/probe/link': { mode: GO_SYMLINK, linkTarget: '/probe/file.txt' },
				'/probe/file.txt': { mode: GO_FILE },
			});
			const toFileDriver = new DockerDriver(toFile.docker);
			toFileDriver.available = true;
			expect(await toFileDriver.probeDevFolder('/link', 'image:tag')).toEqual({
				ok: false,
				reason: 'not-a-directory',
			});

			const dangling = stubDockerForProbe({ '/probe/link': { mode: GO_SYMLINK, linkTarget: '/probe/nowhere' } });
			const danglingDriver = new DockerDriver(dangling.docker);
			danglingDriver.available = true;
			expect(await danglingDriver.probeDevFolder('/link', 'image:tag')).toEqual({
				ok: false,
				reason: 'not-found',
			});
		});

		it('gives up on a symlink loop as unknown after a bounded number of hops, never spinning forever', async () => {
			const stub = stubDockerForProbe({ '/probe/loop': { mode: GO_SYMLINK, linkTarget: '/probe/loop' } });
			const driver = new DockerDriver(stub.docker);
			driver.available = true;

			expect(await driver.probeDevFolder('/loop', 'image:tag')).toEqual({ ok: false, reason: 'unknown' });
			expect(stub.infoArchive.mock.calls.length).toBeLessThanOrEqual(20);
			expect(stub.remove).toHaveBeenCalledTimes(1);
		});

		it('a symlink reported with an empty linkTarget is unknown - never followed to /', async () => {
			const stub = stubDockerForProbe({ '/probe/link': { mode: GO_SYMLINK, linkTarget: '' } });
			const driver = new DockerDriver(stub.docker);
			driver.available = true;

			expect(await driver.probeDevFolder('/link', 'image:tag')).toEqual({ ok: false, reason: 'unknown' });
		});
	});
});

describe('DockerDriver.startRun - an image entrypoint the dev-folder mount would hide (actor-driver.md: "stays available to the run")', () => {
	const devMountRun = {
		runId: 'run-entry',
		imageId: 'fake-image',
		env: {},
		memoryMbytes: 128,
		timeoutSecs: 60,
		devMount: { localDevFolder: '/host/src', imageWorkingDirectory: '/usr/src/app' },
	};

	function scriptArchive(name: string, content: string): NodeJS.ReadableStream {
		const pack = tar.pack();
		pack.entry({ name, mode: 0o755 }, content);
		pack.finalize();
		return pack as unknown as NodeJS.ReadableStream;
	}

	async function entryNamesOf(archive: Buffer): Promise<Array<{ name: string; type?: string; content: string }>> {
		const entries: Array<{ name: string; type?: string; content: string }> = [];
		const extract = tar.extract();
		await new Promise<void>((resolve, reject) => {
			extract.on('entry', (header, stream, next) => {
				const chunks: Buffer[] = [];
				stream.on('data', (chunk: Buffer) => chunks.push(chunk));
				stream.on('end', () => {
					entries.push({ name: header.name, type: header.type, content: Buffer.concat(chunks).toString() });
					next();
				});
				stream.resume();
			});
			extract.once('finish', resolve);
			extract.once('error', reject);
			extract.end(archive);
		});
		return entries;
	}

	it('a relative entrypoint inside the working directory that the dev folder lacks: the file comes out of the image, lands in the container before start, and the run starts through that copy - the run log says so', async () => {
		const stub = stubDockerForRun();
		stub.imageInspect.mockResolvedValue({
			Config: {
				Entrypoint: ['./xvfb-entrypoint.sh'],
				Cmd: ['python', '-m', 'my_actor'],
				WorkingDir: '/usr/src/app',
			},
		});
		stub.container.getArchive.mockResolvedValue(scriptArchive('xvfb-entrypoint.sh', '#!/bin/sh\nexec "$@"\n'));
		const driver = new DockerDriver(stub.docker);
		driver.available = true;
		allowDevMountRecheck(driver);
		const hasEntry = vi.spyOn(driver, 'devFolderHasEntry').mockResolvedValue(false);
		const logged: string[] = [];

		const outcomePromise = driver.startRun(devMountRun, (chunk) => logged.push(chunk));
		await new Promise((resolve) => setImmediate(resolve));
		await new Promise((resolve) => setImmediate(resolve));
		stub.triggerContainerExit(0);
		stub.endLogStream();
		await outcomePromise;

		expect(hasEntry).toHaveBeenCalledWith('/host/src', 'xvfb-entrypoint.sh');
		expect(stub.container.getArchive).toHaveBeenCalledWith({ path: '/usr/src/app/xvfb-entrypoint.sh' });
		// Two containers: the throwaway one the file is read from, then the run's own.
		expect(stub.createContainer).toHaveBeenCalledTimes(2);
		const runOptions = stub.createContainer.mock.calls[1]![0];
		expect(runOptions.Entrypoint).toEqual(['/apify-runtime-entrypoint/xvfb-entrypoint.sh']);
		// Restated: an engine drops the image's Cmd from a create request that overrides Entrypoint.
		expect(runOptions.Cmd).toEqual(['python', '-m', 'my_actor']);
		const [archive, putOptions] = stub.container.putArchive.mock.calls[0]!;
		expect(putOptions).toEqual({ path: '/' });
		expect(await entryNamesOf(archive as Buffer)).toEqual([
			{ name: 'apify-runtime-entrypoint', type: 'directory', content: '' },
			{ name: 'apify-runtime-entrypoint/xvfb-entrypoint.sh', type: 'file', content: '#!/bin/sh\nexec "$@"\n' },
		]);
		expect(logged.join('')).toContain('starts through ./xvfb-entrypoint.sh in its working directory');
	});

	// `apify/actor-node-playwright-chrome` spells this one absolute, inside the mount target; treating
	// "absolute" as "out of the mount's reach" left its runs dying with "executable file not found".
	it('an ABSOLUTE entrypoint that points inside the working directory is hidden by the mount just like a relative one, and is preserved the same way', async () => {
		const stub = stubDockerForRun();
		stub.imageInspect.mockResolvedValue({
			Config: {
				Entrypoint: ['/home/myuser/xvfb-entrypoint.sh'],
				Cmd: ['node', 'dist/main.js'],
				WorkingDir: '/home/myuser',
			},
		});
		stub.container.getArchive.mockResolvedValue(scriptArchive('xvfb-entrypoint.sh', '#!/bin/sh\nexec "$@"\n'));
		const driver = new DockerDriver(stub.docker);
		driver.available = true;
		allowDevMountRecheck(driver);
		const hasEntry = vi.spyOn(driver, 'devFolderHasEntry').mockResolvedValue(false);

		const outcomePromise = driver.startRun(
			{ ...devMountRun, devMount: { localDevFolder: '/host/src', imageWorkingDirectory: '/home/myuser' } },
			() => {},
		);
		await new Promise((resolve) => setImmediate(resolve));
		await new Promise((resolve) => setImmediate(resolve));
		stub.triggerContainerExit(0);
		stub.endLogStream();
		await outcomePromise;

		expect(hasEntry).toHaveBeenCalledWith('/host/src', 'xvfb-entrypoint.sh');
		expect(stub.container.getArchive).toHaveBeenCalledWith({ path: '/home/myuser/xvfb-entrypoint.sh' });
		const runOptions = stub.createContainer.mock.calls[1]![0];
		expect(runOptions.Entrypoint).toEqual(['/apify-runtime-entrypoint/xvfb-entrypoint.sh']);
		expect(runOptions.Cmd).toEqual(['node', 'dist/main.js']);
	});

	it('the dev folder providing the file itself, an entrypoint outside the working directory, or a PATH-resolved one: nothing is preserved and the image command stands', async () => {
		for (const { config, workingDirectory, devFolderHasIt } of [
			{
				config: { Entrypoint: ['./xvfb-entrypoint.sh'] },
				workingDirectory: '/usr/src/app',
				devFolderHasIt: true,
			},
			// Hidden, but the dev folder carries its own copy.
			{
				config: { Entrypoint: ['/home/myuser/xvfb-entrypoint.sh'] },
				workingDirectory: '/home/myuser',
				devFolderHasIt: true,
			},
			{
				config: { Entrypoint: ['/usr/local/bin/xvfb-run', 'node', 'main.js'] },
				workingDirectory: '/usr/src/app',
				devFolderHasIt: false,
			},
			// A sibling whose name merely starts with the working directory's - a raw prefix match would
			// wrongly call this hidden.
			{
				config: { Entrypoint: ['/usr/src/app-tools/xvfb-run'] },
				workingDirectory: '/usr/src/app',
				devFolderHasIt: false,
			},
			{ config: { Cmd: ['npm', 'start'] }, workingDirectory: '/usr/src/app', devFolderHasIt: false },
		]) {
			const stub = stubDockerForRun();
			stub.imageInspect.mockResolvedValue({ Config: { ...config, WorkingDir: workingDirectory } });
			const driver = new DockerDriver(stub.docker);
			driver.available = true;
			allowDevMountRecheck(driver);
			vi.spyOn(driver, 'devFolderHasEntry').mockResolvedValue(devFolderHasIt);

			const outcomePromise = driver.startRun(
				{
					...devMountRun,
					devMount: { localDevFolder: '/host/src', imageWorkingDirectory: workingDirectory },
				},
				() => {},
			);
			await new Promise((resolve) => setImmediate(resolve));
			await new Promise((resolve) => setImmediate(resolve));
			stub.triggerContainerExit(0);
			stub.endLogStream();
			await outcomePromise;

			expect(stub.container.getArchive).not.toHaveBeenCalled();
			expect(stub.createContainer).toHaveBeenCalledTimes(1);
			expect(stub.createContainer.mock.calls[0]![0].Entrypoint).toBeUndefined();
			expect(stub.container.putArchive).not.toHaveBeenCalled();
		}
	});
});

/** Lets a `startRun` test with a `devMount` get past the run-start dev-folder re-check
 * (`assertDevFolderStillPresent`) when that check is not what the test is about. */
function allowDevMountRecheck(driver: DockerDriver): void {
	vi.spyOn(driver, 'ensureProbeImage').mockResolvedValue('probe:image');
	vi.spyOn(driver, 'probeDevFolder').mockResolvedValue({ ok: true });
}

describe('DockerDriver.startRun - run-start dev-folder re-check (actor-driver.md: "If the registered folder has since been deleted ... the run must fail visibly - never silently mount an empty directory")', () => {
	const devMountRun = {
		runId: 'run-recheck',
		imageId: 'fake-image',
		env: {},
		memoryMbytes: 128,
		timeoutSecs: 60,
		devMount: { localDevFolder: '/host/src', imageWorkingDirectory: '/usr/src/app' },
	};

	it('re-probes the registered folder with the same probe registration used, before creating any container', async () => {
		const stub = stubDockerForRun();
		const driver = new DockerDriver(stub.docker);
		driver.available = true;
		const ensureProbeImage = vi.spyOn(driver, 'ensureProbeImage').mockResolvedValue('probe:image');
		const probeDevFolder = vi.spyOn(driver, 'probeDevFolder').mockResolvedValue({ ok: true });

		const outcomePromise = driver.startRun(devMountRun, () => {});
		await new Promise((resolve) => setImmediate(resolve));

		expect(ensureProbeImage).toHaveBeenCalledTimes(1);
		expect(probeDevFolder).toHaveBeenCalledWith('/host/src', 'probe:image');
		expect(probeDevFolder.mock.invocationCallOrder[0]).toBeLessThan(
			stub.createContainer.mock.invocationCallOrder[0]!,
		);

		stub.triggerContainerExit(0);
		stub.endLogStream();
		await outcomePromise;
	});

	it('fails the run before any container exists when the folder is gone, naming the folder, the reason, and how to clear the registration', async () => {
		const stub = stubDockerForRun();
		const driver = new DockerDriver(stub.docker);
		driver.available = true;
		vi.spyOn(driver, 'ensureProbeImage').mockResolvedValue('probe:image');
		vi.spyOn(driver, 'probeDevFolder').mockResolvedValue({ ok: false, reason: 'not-found' });

		await expect(driver.startRun(devMountRun, () => {})).rejects.toThrow(
			/registered local dev folder \/host\/src no longer exists on the host.*run was not started.*\/actor-runtime\/dev-folder\//,
		);
		expect(stub.createContainer).not.toHaveBeenCalled();
	});

	it('fails the same way for a folder that became a file, and for one the daemon could not verify at all - never starting against whatever the daemon would mount instead', async () => {
		for (const [reason, phrase] of [
			['not-a-directory', 'is no longer a directory'],
			['unreachable', 'could not be verified on the host (unreachable)'],
			['unknown', 'could not be verified on the host (unknown)'],
		] as const) {
			const stub = stubDockerForRun();
			const driver = new DockerDriver(stub.docker);
			driver.available = true;
			vi.spyOn(driver, 'ensureProbeImage').mockResolvedValue('probe:image');
			vi.spyOn(driver, 'probeDevFolder').mockResolvedValue({ ok: false, reason });

			await expect(driver.startRun(devMountRun, () => {})).rejects.toThrow(phrase);
			expect(stub.createContainer).not.toHaveBeenCalled();
		}
	});

	it('does not touch the probe at all for a run with no devMount', async () => {
		const stub = stubDockerForRun();
		const driver = new DockerDriver(stub.docker);
		driver.available = true;
		const ensureProbeImage = vi.spyOn(driver, 'ensureProbeImage');
		const probeDevFolder = vi.spyOn(driver, 'probeDevFolder');

		const outcomePromise = driver.startRun({ ...devMountRun, devMount: undefined }, () => {});
		await new Promise((resolve) => setImmediate(resolve));
		stub.triggerContainerExit(0);
		stub.endLogStream();
		await outcomePromise;

		expect(ensureProbeImage).not.toHaveBeenCalled();
		expect(probeDevFolder).not.toHaveBeenCalled();
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

/**
 * `init()` + `startRun()` stub with a controllable `getNetwork()` (`inspect`/`connect`), for
 * `selfAttachToNetwork`'s three outcomes and the `ExtraHosts` fallback `startRun` derives from them.
 */
function stubDockerForNetwork(
	network: { inspect: () => Promise<unknown>; connect: () => Promise<unknown> },
	selfInspect: () => Promise<unknown> = async () => ({}),
) {
	const run = stubDockerForRun();
	const getNetwork = vi.fn(() => network);
	const getContainer = vi.fn(() => ({ inspect: selfInspect }));
	const docker = {
		...run.docker,
		ping: vi.fn(async () => undefined),
		listNetworks: vi.fn(async () => []),
		createNetwork: vi.fn(async () => undefined),
		info: vi.fn(async () => ({})),
		getNetwork,
		getContainer,
	} as unknown as Docker;
	return { ...run, docker, getNetwork, getContainer };
}

const SELF_FULL_ID = 'abc123def456789000000000000000000000000000000000000000000000000000';
/** A hosts file with no engine-provided host entry - the Docker Engine case, where `host-gateway` is the route. */
const NO_HOSTS_FILE = '/nonexistent/hosts';

function attachedNetwork() {
	return {
		inspect: vi.fn(async () => ({ Containers: { [SELF_FULL_ID]: {} } })),
		connect: vi.fn(async () => undefined),
	};
}

function selfOnNetwork(endpoint: { Aliases?: string[]; IPAddress?: string }) {
	return async () => ({ NetworkSettings: { Networks: { 'apify-local': endpoint } } });
}

describe('DockerDriver - how Actor containers reach the API (network alias, or the host-gateway fallback)', () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	async function extraHostsOfOneRun(stub: ReturnType<typeof stubDockerForNetwork>, driver: DockerDriver) {
		const outcomePromise = driver.startRun(
			{ runId: 'run-reach', imageId: 'fake-image', env: {}, memoryMbytes: 128, timeoutSecs: 60 },
			() => {},
		);
		await new Promise((resolve) => setImmediate(resolve));
		stub.triggerContainerExit(0);
		stub.endLogStream();
		await outcomePromise;
		const [options] = stub.createContainer.mock.calls[0]!;
		return options.HostConfig?.ExtraHosts;
	}

	it('with no HOSTNAME (the runtime running on the host, not in a container) warns once and gives every run container an apify-api -> host-gateway extra host', async () => {
		vi.stubEnv('HOSTNAME', '');
		const network = { inspect: vi.fn(async () => ({ Containers: {} })), connect: vi.fn(async () => undefined) };
		const stub = stubDockerForNetwork(network);
		const driver = new DockerDriver(stub.docker, { hostsFile: NO_HOSTS_FILE });
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

		await driver.init();

		expect(driver.available).toBe(true);
		expect(stub.getNetwork).not.toHaveBeenCalled();
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('host-gateway'));
		expect(await extraHostsOfOneRun(stub, driver)).toEqual(['apify-api:host-gateway']);
		warn.mockRestore();
	});

	it('when the connect succeeds, run containers get no ExtraHosts at all - the network alias is the route, and a hosts-file entry would override it', async () => {
		vi.stubEnv('HOSTNAME', 'abc123def456');
		const network = { inspect: vi.fn(async () => ({ Containers: {} })), connect: vi.fn(async () => undefined) };
		const stub = stubDockerForNetwork(network);
		const driver = new DockerDriver(stub.docker, { hostsFile: NO_HOSTS_FILE });

		await driver.init();

		expect(network.connect).toHaveBeenCalledWith({
			Container: 'abc123def456',
			EndpointConfig: { Aliases: ['apify-api'] },
		});
		expect(await extraHostsOfOneRun(stub, driver)).toBeUndefined();
	});

	it('recognises its own container as already attached by full-id prefix (HOSTNAME is the short id) with the alias registered - no connect, no warning, no ExtraHosts', async () => {
		vi.stubEnv('HOSTNAME', 'abc123def456');
		const network = attachedNetwork();
		const stub = stubDockerForNetwork(
			network,
			selfOnNetwork({ Aliases: ['abc123def456', 'apify-api'], IPAddress: '10.89.0.2' }),
		);
		const driver = new DockerDriver(stub.docker, { hostsFile: NO_HOSTS_FILE });
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

		await driver.init();

		expect(network.connect).not.toHaveBeenCalled();
		expect(stub.getContainer).toHaveBeenCalledWith('abc123def456');
		expect(warn).not.toHaveBeenCalled();
		expect(await extraHostsOfOneRun(stub, driver)).toBeUndefined();
		warn.mockRestore();
	});

	it("started on the network without the alias (`--network apify-local`, no `--network-alias`): run containers get apify-api -> this container's own address, no connect, no warning", async () => {
		vi.stubEnv('HOSTNAME', 'abc123def456');
		const network = attachedNetwork();
		const stub = stubDockerForNetwork(
			network,
			selfOnNetwork({ Aliases: ['abc123def456'], IPAddress: '10.89.0.2' }),
		);
		const driver = new DockerDriver(stub.docker, { hostsFile: NO_HOSTS_FILE });
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

		await driver.init();

		expect(network.connect).not.toHaveBeenCalled();
		expect(warn).not.toHaveBeenCalled();
		expect(await extraHostsOfOneRun(stub, driver)).toEqual(['apify-api:10.89.0.2']);
		warn.mockRestore();
	});

	it('on the network but with its own address unreadable: warns and falls back to the host-gateway extra host', async () => {
		vi.stubEnv('HOSTNAME', 'abc123def456');
		const network = attachedNetwork();
		const stub = stubDockerForNetwork(network, async () => {
			throw new Error('inspect failed');
		});
		const driver = new DockerDriver(stub.docker, { hostsFile: NO_HOSTS_FILE });
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

		await driver.init();

		expect(driver.available).toBe(true);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('host-gateway'));
		expect(await extraHostsOfOneRun(stub, driver)).toEqual(['apify-api:host-gateway']);
		warn.mockRestore();
	});

	it('when the engine refuses the attach (rootless Podman: the runtime container runs under slirp4netns), stays available, warns naming the fallback and the --network fix, and gives run containers the host-gateway extra host', async () => {
		vi.stubEnv('HOSTNAME', 'abc123def456');
		const network = {
			inspect: vi.fn(async () => ({ Containers: {} })),
			connect: vi.fn(async () => {
				throw Object.assign(
					new Error('(HTTP code 500) server error - "slirp4netns" is not supported: invalid network mode '),
					{ statusCode: 500 },
				);
			}),
		};
		const stub = stubDockerForNetwork(network);
		const driver = new DockerDriver(stub.docker, { hostsFile: NO_HOSTS_FILE });
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

		await driver.init();

		expect(driver.available).toBe(true);
		const message = warn.mock.calls.map((call) => String(call[0])).join('\n');
		expect(message).toContain('slirp4netns');
		expect(message).toContain('host-gateway');
		expect(message).toContain('--network apify-local');
		expect(await extraHostsOfOneRun(stub, driver)).toEqual(['apify-api:host-gateway']);
		warn.mockRestore();
	});

	it('off the network, routes Actors to the host at the address the engine itself gave this container (host.containers.internal), not host-gateway - Podman before 4.1 rejects the keyword', async () => {
		vi.stubEnv('HOSTNAME', '');
		const hostsFile = path.join(await mkdtemp(path.join(os.tmpdir(), 'hosts-')), 'hosts');
		await writeFile(
			hostsFile,
			'127.0.0.1 localhost\n10.88.0.1\thost.containers.internal host.docker.internal\n10.88.0.7\tabc123 name\n',
		);
		const network = { inspect: vi.fn(async () => ({ Containers: {} })), connect: vi.fn(async () => undefined) };
		const stub = stubDockerForNetwork(network);
		const driver = new DockerDriver(stub.docker, { hostsFile });
		vi.spyOn(console, 'warn').mockImplementation(() => undefined);

		await driver.init();

		expect(await extraHostsOfOneRun(stub, driver)).toEqual(['apify-api:10.88.0.1']);
		vi.restoreAllMocks();
	});
});

describe("chooseDefaultNetworkRoute (Actors on the engine's default network, `actor-driver.md` Networking)", () => {
	it("rootless Podman 3.x under slirp4netns: the engine's host entry is the slirp gateway, which only reaches the host with allow_host_loopback", () => {
		expect(
			chooseDefaultNetworkRoute({
				hostAddress: '10.0.2.2',
				gateway: '10.0.2.2',
				own: { address: '10.0.2.100', iface: 'tap0' },
			}),
		).toEqual({ extraHost: 'apify-api:10.0.2.2', networkMode: 'slirp4netns:allow_host_loopback=true' });
	});

	it("rootful bridge: the host entry is the bridge gateway, so this container's own address on that bridge is the direct route", () => {
		expect(
			chooseDefaultNetworkRoute({
				hostAddress: '10.88.0.1',
				gateway: '10.88.0.1',
				own: { address: '10.88.0.5', iface: 'eth0' },
			}),
		).toEqual({ extraHost: 'apify-api:10.88.0.5' });
	});

	it("otherwise the engine's host entry is the route (rootless Podman 4+: a real host address), or host-gateway without one (Docker Engine)", () => {
		expect(
			chooseDefaultNetworkRoute({
				hostAddress: '192.168.1.20',
				gateway: '10.0.2.2',
				own: { address: '10.0.2.100', iface: 'tap0' },
			}),
		).toEqual({ extraHost: 'apify-api:192.168.1.20' });
		expect(
			chooseDefaultNetworkRoute({
				hostAddress: undefined,
				gateway: '172.17.0.1',
				own: { address: '172.17.0.2', iface: 'eth0' },
			}),
		).toEqual({
			extraHost: 'apify-api:host-gateway',
		});
		expect(chooseDefaultNetworkRoute({ hostAddress: undefined, gateway: undefined, own: undefined })).toEqual({
			extraHost: 'apify-api:host-gateway',
		});
	});
});

describe('defaultGatewayFromRouteTable', () => {
	it('decodes the little-endian default gateway of /proc/net/route, and returns undefined without a default route', () => {
		const table =
			'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\n' +
			'tap0\t00000000\t0202000A\t0003\t0\t0\t0\t00000000\t0\t0\t0\n' +
			'tap0\t0002000A\t00000000\t0001\t0\t0\t0\t00FFFFFF\t0\t0\t0\n';
		expect(defaultGatewayFromRouteTable(table)).toBe('10.0.2.2');
		expect(defaultGatewayFromRouteTable('Iface\tDestination\tGateway\neth0\t0002000A\t00000000\n')).toBeUndefined();
		expect(defaultGatewayFromRouteTable('')).toBeUndefined();
	});
});

describe('Podman 3.x: no user-defined network at all', () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it('never creates or joins apify-local; run containers go straight to the default network with the chosen route, and one startup line says so', async () => {
		vi.stubEnv('HOSTNAME', 'abc123def456');
		const dir = await mkdtemp(path.join(os.tmpdir(), 'pm3-'));
		const hostsFile = path.join(dir, 'hosts');
		await writeFile(hostsFile, '10.0.2.2 host.containers.internal\n');
		const routeFile = path.join(dir, 'route');
		await writeFile(routeFile, 'Iface\tDestination\tGateway\ntap0\t00000000\t0202000A\n');
		const network = { inspect: vi.fn(async () => ({ Containers: {} })), connect: vi.fn(async () => undefined) };
		const stub = stubDockerForNetwork(network);
		(stub.docker as unknown as { version: unknown }).version = vi.fn(async () => ({
			Components: [{ Name: 'Podman Engine', Version: '3.4.4' }],
		}));
		(stub.docker.modem as unknown as { dial: unknown }).dial = vi.fn(
			(_o: unknown, cb: (e: Error | null, d: unknown) => void) =>
				cb(null, { host: { cgroupControllers: ['cpu', 'memory', 'pids'] } }),
		);
		const driver = new DockerDriver(stub.docker, {
			hostsFile,
			routeFile,
			networkInterfaces: () => ({
				tap0: [{ address: '10.0.2.100', family: 'IPv4', internal: false } as os.NetworkInterfaceInfo],
			}),
		});
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

		await driver.init();

		expect(driver.available).toBe(true);
		expect(
			(stub.docker as unknown as { createNetwork: ReturnType<typeof vi.fn> }).createNetwork,
		).not.toHaveBeenCalled();
		expect(stub.getNetwork).not.toHaveBeenCalled();
		expect(warn.mock.calls.map((c) => String(c[0])).filter((m) => m.startsWith('Podman 3.x'))).toHaveLength(1);

		const outcomePromise = driver.startRun(
			{ runId: 'run-pm3', imageId: 'fake-image', env: {}, memoryMbytes: 128, timeoutSecs: 60 },
			() => {},
		);
		await new Promise((resolve) => setImmediate(resolve));
		stub.triggerContainerExit(0);
		stub.endLogStream();
		await outcomePromise;

		expect(stub.createContainer).toHaveBeenCalledTimes(1);
		const hostConfig = stub.createContainer.mock.calls[0]![0].HostConfig!;
		expect(hostConfig.NetworkMode).toBe('slirp4netns:allow_host_loopback=true');
		expect(hostConfig.ExtraHosts).toEqual(['apify-api:10.0.2.2']);
		warn.mockRestore();
	});

	it('podmanMajorVersion reads the Podman component and is undefined for Docker or an unreachable engine', async () => {
		await expect(
			podmanMajorVersion({
				version: async () => ({ Components: [{ Name: 'Podman Engine', Version: '4.9.3' }] }),
			} as unknown as Docker),
		).resolves.toBe(4);
		await expect(
			podmanMajorVersion({
				version: async () => ({ Components: [{ Name: 'Engine', Version: '29.3.1' }] }),
			} as unknown as Docker),
		).resolves.toBeUndefined();
		await expect(
			podmanMajorVersion({
				version: async () => {
					throw new Error('down');
				},
			} as unknown as Docker),
		).resolves.toBeUndefined();
	});
});

describe('resource limits the engine cannot apply are left out (rootless Podman without a delegated cgroup controller)', () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	function stubWithEngine(components: string[], cgroupControllers: unknown) {
		vi.stubEnv('HOSTNAME', '');
		const network = { inspect: vi.fn(async () => ({ Containers: {} })), connect: vi.fn(async () => undefined) };
		const stub = stubDockerForNetwork(network);
		(stub.docker as unknown as { version: unknown }).version = vi.fn(async () => ({
			Components: components.map((Name) => ({ Name })),
		}));
		(stub.docker.modem as unknown as { dial: unknown }).dial = vi.fn(
			(_options: unknown, callback: (error: Error | null, data: unknown) => void) =>
				callback(null, { host: { cgroupControllers } }),
		);
		return stub;
	}

	async function hostConfigOfOneRun(stub: ReturnType<typeof stubDockerForNetwork>, driver: DockerDriver) {
		const outcomePromise = driver.startRun(
			{ runId: 'run-limits', imageId: 'fake-image', env: {}, memoryMbytes: 1024, timeoutSecs: 60 },
			() => {},
		);
		await new Promise((resolve) => setImmediate(resolve));
		stub.triggerContainerExit(0);
		stub.endLogStream();
		await outcomePromise;
		return stub.createContainer.mock.calls[0]![0].HostConfig!;
	}

	it("Podman reporting only memory and pids controllers: the run gets its memory limit but no CPU quota, and init warns once naming 'cpu'", async () => {
		const stub = stubWithEngine(['Podman Engine', 'Conmon'], ['memory', 'pids']);
		const driver = new DockerDriver(stub.docker, { hostsFile: NO_HOSTS_FILE });
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		await driver.init();

		expect(
			warn.mock.calls.map((call) => String(call[0])).filter((m) => m.includes("'cpu' cgroup controller")),
		).toHaveLength(1);
		const hostConfig = await hostConfigOfOneRun(stub, driver);
		expect(hostConfig.Memory).toBe(1024 * 1024 * 1024);
		expect(hostConfig.CpuQuota).toBeUndefined();
		expect(hostConfig.CpuPeriod).toBeUndefined();
		warn.mockRestore();
	});

	it('Podman reporting cpu and memory, or Docker (whose /version has no Podman component): every limit is applied, no warning', async () => {
		for (const [components, controllers] of [
			[['Podman Engine'], ['cpu', 'memory', 'pids']],
			[['Engine', 'containerd'], undefined],
		] as Array<[string[], unknown]>) {
			const stub = stubWithEngine(components, controllers);
			const driver = new DockerDriver(stub.docker, { hostsFile: NO_HOSTS_FILE });
			const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
			await driver.init();
			expect(warn.mock.calls.map((call) => String(call[0])).some((m) => m.includes('cgroup controller'))).toBe(
				false,
			);
			const hostConfig = await hostConfigOfOneRun(stub, driver);
			expect(hostConfig.Memory).toBe(1024 * 1024 * 1024);
			expect(hostConfig.CpuQuota).toBeGreaterThan(0);
			warn.mockRestore();
		}
	});

	it('detectResourceLimitSupport keeps every limit when the engine cannot be asked', async () => {
		await expect(
			detectResourceLimitSupport({
				version: async () => {
					throw new Error('no');
				},
			} as unknown as Docker),
		).resolves.toEqual({
			cpu: true,
			memory: true,
		});
	});
});

describe('hostAddressSeenFromContainers', () => {
	it('returns the address of the engine-provided host entry, ignoring comments and other lines, and host-gateway when there is none', async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), 'hosts-'));
		const podman = path.join(dir, 'podman');
		await writeFile(
			podman,
			'# comment\n127.0.0.1 localhost\n192.0.2.2\thost.containers.internal host.docker.internal # engine\n',
		);
		const docker = path.join(dir, 'docker');
		await writeFile(docker, '127.0.0.1\tlocalhost\n172.17.0.2\tb276929e2817\n');
		await expect(hostAddressSeenFromContainers(podman)).resolves.toBe('192.0.2.2');
		await expect(hostAddressSeenFromContainers(docker)).resolves.toBe('host-gateway');
		await expect(hostAddressSeenFromContainers(NO_HOSTS_FILE)).resolves.toBe('host-gateway');
	});
});

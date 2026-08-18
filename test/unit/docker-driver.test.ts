import { PassThrough } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';
import type Docker from 'dockerode';

import { DockerDriver } from '../../src/driver/docker-driver.js';

/**
 * A stub `dockerode`-shaped object covering only what `reconcileOrphans` calls - there is no Docker
 * daemon in this sandbox to test against for real (see `DockerDriver`'s class doc comment), so this
 * exercises the filter construction and client-side matching in isolation.
 */
function stubDocker(containers: Array<{ Id: string; Labels: Record<string, string> }>) {
	const removed: string[] = [];
	const listContainers = vi.fn().mockResolvedValue(containers);
	const getContainer = vi.fn((id: string) => ({
		remove: vi.fn(async () => {
			removed.push(id);
		}),
	}));
	return {
		docker: { listContainers, getContainer } as unknown as Docker,
		listContainers,
		getContainer,
		removed,
	};
}

describe('DockerDriver.reconcileOrphans', () => {
	it("filters on the label KEY's presence only, never multiple key=value pairs in one call", async () => {
		const { docker, listContainers } = stubDocker([]);
		const driver = new DockerDriver(docker);
		driver.available = true;

		await driver.reconcileOrphans(['run-a', 'run-b']);

		expect(listContainers).toHaveBeenCalledTimes(1);
		const [options] = listContainers.mock.calls[0] as [{ all: boolean; filters: string }];
		expect(options.all).toBe(true);
		const filters = JSON.parse(options.filters) as { label: string[] };
		// Exactly one label filter entry - the bare key, never `key=value` - so two or more orphaned run
		// ids can never be AND'd together by the daemon's per-key label matching (a single container can
		// never satisfy two different values of the same label at once - see the doc comment on
		// `reconcileOrphans` for the moby `MatchKVList` semantics this sidesteps entirely).
		expect(filters.label).toEqual(['actor-runtime.runId']);
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

	it('does nothing when there are no orphaned run ids, even if available', async () => {
		const { docker, listContainers } = stubDocker([]);
		const driver = new DockerDriver(docker);
		driver.available = true;

		await driver.reconcileOrphans([]);

		expect(listContainers).not.toHaveBeenCalled();
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
		remove: vi.fn(async () => undefined),
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

	const docker = {
		createContainer: vi.fn(async () => container),
		modem: { demuxStream },
	} as unknown as Docker;

	return {
		docker,
		container,
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

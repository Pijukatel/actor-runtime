/**
 * `DockerDriver.startRun`'s per-run CPU/memory sampler (`docker-driver.ts`'s `startResourceSampler`,
 * exercised only through `startRun`'s optional third `onSample` parameter - there is no separate exported
 * surface for it). Covers `3-success-criteria.md` §5's sampling-lifetime criteria (#12) and the
 * stop-before-remove ordering `2-design.md`'s "Proposed solution" section calls out as the thing to
 * review hardest.
 */
import { PassThrough } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Docker from 'dockerode';

import { DockerDriver } from '../../src/driver/docker-driver.js';
import type { RunResourceSample } from '../../src/driver/types.js';

/**
 * A stub `dockerode`-shaped object covering only what `startRun` calls when a sampler is actually
 * running: `container.stats({stream:false,'one-shot':true})`, controllable per-call either via a queue of
 * canned `ContainerStats`-shaped results, or left pending indefinitely (until the test resolves it itself
 * via `resolvePendingStats`) once the queue is exhausted - the shape `2-design.md` explicitly calls for
 * the "stats() never resolves [until the test says so]" sampler-lifetime test to use. The rest of
 * `startRun`'s own lifecycle (`start`/`logs`/`wait`/`remove`) mirrors `docker-driver.test.ts`'s
 * `stubDockerForRun`.
 */
function stubDockerForSampler() {
	let resolveWait!: (result: { StatusCode: number }) => void;
	const waitPromise = new Promise<{ StatusCode: number }>((resolve) => {
		resolveWait = resolve;
	});
	const rawLogStream = new PassThrough();

	const statsResponses: unknown[] = [];
	let nextStatsIndex = 0;
	const pendingStatsCalls: Array<(value: unknown) => void> = [];

	const stats = vi.fn(async () => {
		if (nextStatsIndex < statsResponses.length) {
			return statsResponses[nextStatsIndex++];
		}
		// The queue is exhausted - this call hangs until `resolvePendingStats` below is called for it.
		return new Promise((resolve) => {
			pendingStatsCalls.push(resolve);
		});
	});

	const container = {
		start: vi.fn(async () => undefined),
		logs: vi.fn(async () => rawLogStream),
		wait: vi.fn(async () => waitPromise),
		remove: vi.fn(async (_options?: Record<string, unknown>) => undefined),
		stop: vi.fn(async () => undefined),
		stats,
	};

	// Faithful to the real `docker-modem` `demuxStream` (see `docker-driver.test.ts`'s own stub doc
	// comment): forwards data, never ends the destinations itself.
	const demuxStream = vi.fn((stream: NodeJS.ReadableStream, stdout: PassThrough) => {
		stream.on('data', (chunk: Buffer) => stdout.write(chunk));
	});
	const createContainer = vi.fn(async (_options: Docker.ContainerCreateOptions) => container);
	const docker = { createContainer, modem: { demuxStream } } as unknown as Docker;

	return {
		docker,
		container,
		stats,
		queueStatsResponse(response: unknown): void {
			statsResponses.push(response);
		},
		/** Resolves the OLDEST still-pending `stats()` call that had no canned response queued for it. */
		resolvePendingStats(response: unknown): void {
			const resolve = pendingStatsCalls.shift();
			if (!resolve) throw new Error('no pending stats() call to resolve');
			resolve(response);
		},
		triggerContainerExit(statusCode = 0): void {
			resolveWait({ StatusCode: statusCode });
		},
		endLogStream(): void {
			rawLogStream.end();
		},
	};
}

/** A minimal, valid `dockerode` `ContainerStats`-shaped object with just the fields the sampler reads. */
function containerStats(totalUsage: number, systemUsage: number, memoryUsage: number, onlineCpus = 1) {
	return {
		cpu_stats: { cpu_usage: { total_usage: totalUsage }, system_cpu_usage: systemUsage, online_cpus: onlineCpus },
		memory_stats: { usage: memoryUsage },
	};
}

describe('DockerDriver.startRun - per-run resource sampler (onSample)', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("samples exactly once per simulated 1000ms tick - not more, not less - computing cpuPercentOfOneCore from the delta against its own previous sample, never the response's own precpu_stats", async () => {
		const stub = stubDockerForSampler();
		const driver = new DockerDriver(stub.docker);
		driver.available = true;

		// An unemitted baseline read, then three ticks - 20%, 40%, 0% of one core, matching `2-design.md`'s
		// own worked example convention (percent of ONE core, not percent of the grant).
		stub.queueStatsResponse(containerStats(0, 0, 100));
		stub.queueStatsResponse(containerStats(200, 1000, 150));
		stub.queueStatsResponse(containerStats(600, 2000, 180));
		stub.queueStatsResponse(containerStats(600, 3000, 200));

		const samples: RunResourceSample[] = [];
		const outcomePromise = driver.startRun(
			{ runId: 'run-sampler-1', imageId: 'fake-image', env: {}, memoryMbytes: 1024, timeoutSecs: 60 },
			() => {},
			(sample) => samples.push(sample),
		);

		await vi.advanceTimersByTimeAsync(1000);
		await vi.advanceTimersByTimeAsync(1000);
		await vi.advanceTimersByTimeAsync(1000);

		expect(samples).toHaveLength(3);
		expect(samples[0]?.cpuPercentOfOneCore).toBeCloseTo(20);
		expect(samples[0]?.memoryBytes).toBe(150);
		expect(samples[0]?.memoryLimitBytes).toBe(1024 * 1024 * 1024);
		expect(samples[1]?.cpuPercentOfOneCore).toBeCloseTo(40);
		expect(samples[1]?.memoryBytes).toBe(180);
		expect(samples[2]?.cpuPercentOfOneCore).toBeCloseTo(0);
		expect(samples[2]?.memoryBytes).toBe(200);
		// The configured LIMIT, constant across every sample - never a growing observed peak.
		expect(samples.map((s) => s.memoryLimitBytes)).toEqual([
			1024 * 1024 * 1024,
			1024 * 1024 * 1024,
			1024 * 1024 * 1024,
		]);

		stub.triggerContainerExit(0);
		stub.endLogStream();
		await outcomePromise;
	});

	it('scales cpuPercentOfOneCore by online_cpus (the docker stats convention), not just the raw usage-time ratio', async () => {
		const stub = stubDockerForSampler();
		const driver = new DockerDriver(stub.docker);
		driver.available = true;

		stub.queueStatsResponse(containerStats(0, 0, 100, 4));
		// cpuDelta=1000, systemDelta=4000 -> ratio 0.25, * 4 online cpus * 100 = 100% of one core.
		stub.queueStatsResponse(containerStats(1000, 4000, 100, 4));

		const samples: RunResourceSample[] = [];
		const outcomePromise = driver.startRun(
			{ runId: 'run-sampler-2', imageId: 'fake-image', env: {}, memoryMbytes: 1024, timeoutSecs: 60 },
			() => {},
			(sample) => samples.push(sample),
		);

		await vi.advanceTimersByTimeAsync(1000);

		expect(samples).toHaveLength(1);
		expect(samples[0]?.cpuPercentOfOneCore).toBeCloseTo(100);

		stub.triggerContainerExit(0);
		stub.endLogStream();
		await outcomePromise;
	});

	it('reports 0% (never NaN/Infinity) for the degenerate case of a zero system-time delta between two samples', async () => {
		const stub = stubDockerForSampler();
		const driver = new DockerDriver(stub.docker);
		driver.available = true;

		stub.queueStatsResponse(containerStats(0, 1000, 100));
		stub.queueStatsResponse(containerStats(0, 1000, 100)); // identical - zero delta on both axes

		const samples: RunResourceSample[] = [];
		const outcomePromise = driver.startRun(
			{ runId: 'run-sampler-3', imageId: 'fake-image', env: {}, memoryMbytes: 1024, timeoutSecs: 60 },
			() => {},
			(sample) => samples.push(sample),
		);

		await vi.advanceTimersByTimeAsync(1000);

		expect(samples).toHaveLength(1);
		expect(samples[0]?.cpuPercentOfOneCore).toBe(0);

		stub.triggerContainerExit(0);
		stub.endLogStream();
		await outcomePromise;
	});

	it('never starts a sampler at all when no onSample callback is given - no stats() call, ever', async () => {
		const stub = stubDockerForSampler();
		const driver = new DockerDriver(stub.docker);
		driver.available = true;

		const outcomePromise = driver.startRun(
			{ runId: 'run-sampler-4', imageId: 'fake-image', env: {}, memoryMbytes: 1024, timeoutSecs: 60 },
			() => {},
		);
		await vi.advanceTimersByTimeAsync(3000);

		expect(stub.stats).not.toHaveBeenCalled();

		stub.triggerContainerExit(0);
		stub.endLogStream();
		await outcomePromise;
	});

	it('stops sampling for good once the run ends - no further stats() call after startRun resolves, even as more simulated 1000ms boundaries elapse', async () => {
		const stub = stubDockerForSampler();
		const driver = new DockerDriver(stub.docker);
		driver.available = true;

		stub.queueStatsResponse(containerStats(0, 0, 100));
		stub.queueStatsResponse(containerStats(200, 1000, 150));

		const outcomePromise = driver.startRun(
			{ runId: 'run-sampler-5', imageId: 'fake-image', env: {}, memoryMbytes: 1024, timeoutSecs: 60 },
			() => {},
			() => {},
		);
		await vi.advanceTimersByTimeAsync(1000);
		expect(stub.stats).toHaveBeenCalledTimes(2); // the unemitted baseline read, plus tick 1

		stub.triggerContainerExit(0);
		stub.endLogStream();
		await outcomePromise;

		const callCountAtEnd = stub.stats.mock.calls.length;
		await vi.advanceTimersByTimeAsync(5000);
		// Proves the interval was actually cleared, not merely "hasn't fired yet" - five more simulated
		// seconds produce zero further calls.
		expect(stub.stats.mock.calls.length).toBe(callCountAtEnd);
	});

	it("awaits the one in-flight stats() call before startRun proceeds to container.remove(), and issues no stats() call after stop() - the log-drain bug's shape must not recur on this third Docker connection", async () => {
		// Real timers here: nothing queued at all, so every stats() call (the baseline included) stays
		// pending until this test explicitly resolves it - no simulated time needs to elapse.
		vi.useRealTimers();
		const stub = stubDockerForSampler();
		const driver = new DockerDriver(stub.docker);
		driver.available = true;

		const outcomePromise = driver.startRun(
			{ runId: 'run-sampler-stop-1', imageId: 'fake-image', env: {}, memoryMbytes: 1024, timeoutSecs: 60 },
			() => {},
			() => {},
		);

		// Let `startRun` run past its own setup, far enough that the sampler's baseline `stats()` call has
		// actually been issued.
		await new Promise((resolve) => setImmediate(resolve));
		expect(stub.stats).toHaveBeenCalledTimes(1);

		// The container exits and its log stream drains - `startRun`'s `finally` block is reached and calls
		// `sampler.stop()` - but the one in-flight `stats()` call is still pending, so `container.remove()`
		// must not have happened yet.
		stub.triggerContainerExit(0);
		stub.endLogStream();
		await new Promise((resolve) => setImmediate(resolve));
		await new Promise((resolve) => setImmediate(resolve));
		await new Promise((resolve) => setImmediate(resolve));

		expect(stub.container.remove).not.toHaveBeenCalled();

		// Only once the in-flight call resolves can `stop()` complete, and only then is `remove()` called.
		stub.resolvePendingStats(containerStats(0, 0, 100));
		const outcome = await outcomePromise;

		expect(outcome).toEqual({ exitCode: 0, timedOut: false });
		expect(stub.container.remove).toHaveBeenCalledTimes(1);
		// No timer tick ever fired (well under 1000ms of real elapsed time throughout this test) and the
		// baseline read is unemitted either way - exactly one `stats()` call total, none after `stop()`.
		expect(stub.stats).toHaveBeenCalledTimes(1);
	});
});

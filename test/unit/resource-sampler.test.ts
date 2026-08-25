/**
 * `DockerDriver.startRun`'s per-run CPU/memory sampler (`docker-driver.ts`'s `startResourceSampler`,
 * exercised only through `startRun`'s optional third `onSample` parameter - there is no separate exported
 * surface for it). Covers the sampling-lifetime contract documented in `requirements/actor-driver.md`'s
 * "Run resource telemetry" section: cadence, all-eight-fields shape, and the stop-before-remove ordering
 * that keeps a stats call from ever racing container removal.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DockerDriver } from '../../src/driver/docker-driver.js';
import type { RunResourceSample } from '../../src/driver/types.js';
import { publishSystemInfo, resetEventsChannelForTests, subscribeEvents } from '../../src/services/events-channel.js';
import { stubDockerForRun } from './helpers/docker-stubs.js';

/**
 * Extends `helpers/docker-stubs.ts`'s shared `stubDockerForRun` (also used directly by
 * `docker-driver.test.ts`) with a `container.stats()` mock, controllable per-call either via a queue of
 * canned `ContainerStats`-shaped results, or left pending indefinitely (until the test resolves it itself
 * via `resolvePendingStats`) once the queue is exhausted - the shape a "stats() never resolves until the
 * test says so" sampler-lifetime test needs, to prove `stop()` bounds its own wait for an in-flight call
 * rather than either abandoning it instantly or hanging on it forever. Mutating the SAME `container`
 * object `stubDockerForRun` already hands to `createContainer`'s resolved value - rather than
 * reimplementing `start`/`logs`/`wait`/`remove`/`stop` a second time here - is the same extend-in-place
 * pattern `docker-driver.test.ts`'s own `stubDockerForCapacity` already uses for `init()`'s extra surface.
 * Imported from that neutral helper file, never from `docker-driver.test.ts` directly: a `.test.ts` file
 * re-runs its own top-level `describe`/`it` registrations as a side effect of being imported by another
 * test file, which would silently double-execute every one of `docker-driver.test.ts`'s own tests.
 */
function stubDockerForSampler() {
	const run = stubDockerForRun();

	const statsResponses: unknown[] = [];
	let nextStatsIndex = 0;
	const pendingStatsCalls: Array<(value: unknown) => void> = [];

	const stats = vi.fn(async () => {
		if (nextStatsIndex < statsResponses.length) {
			const response = statsResponses[nextStatsIndex++];
			if (response instanceof Error) throw response;
			return response;
		}
		// The queue is exhausted - this call hangs until `resolvePendingStats` below is called for it.
		return new Promise((resolve) => {
			pendingStatsCalls.push(resolve);
		});
	});
	Object.assign(run.container, { stats });

	return {
		...run,
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
	};
}

/** A minimal, valid `dockerode` `ContainerStats`-shaped object with just the fields the sampler reads. */
function containerStats(totalUsage: number, systemUsage: number, memoryUsage: number, onlineCpus = 1) {
	return {
		cpu_stats: { cpu_usage: { total_usage: totalUsage }, system_cpu_usage: systemUsage, online_cpus: onlineCpus },
		memory_stats: { usage: memoryUsage },
	};
}

/** A `containerStats` variant that also carries the reclaimable-page-cache field
 * `memoryUsageBytesExcludingCache` (`docker-driver.ts`) subtracts from `usage` - `cacheField` picks which
 * of the two real cgroup shapes this sample mimics. */
function containerStatsWithCache(
	totalUsage: number,
	systemUsage: number,
	memoryUsage: number,
	cacheField: 'total_inactive_file' | 'inactive_file',
	cacheBytes: number,
) {
	return {
		...containerStats(totalUsage, systemUsage, memoryUsage),
		memory_stats: { usage: memoryUsage, stats: { [cacheField]: cacheBytes } },
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

		// An unemitted baseline read, then three ticks - 20%, 40%, 0% of one core, matching the
		// percent-of-ONE-core convention `requirements/actor-driver.md` documents (never percent of the
		// grant).
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

	it('treats a reported online_cpus of 0 as 1 - `@types/dockerode` declares the field non-optional, but this defends against a daemon that reports it as 0 anyway', async () => {
		const stub = stubDockerForSampler();
		const driver = new DockerDriver(stub.docker);
		driver.available = true;

		stub.queueStatsResponse(containerStats(0, 0, 100, 0));
		// cpuDelta=200, systemDelta=1000 -> ratio 0.2. With the online_cpus=0 -> 1 fallback that's 20%;
		// without it (multiplying by the raw 0 instead), it would be 0%.
		stub.queueStatsResponse(containerStats(200, 1000, 150, 0));

		const samples: RunResourceSample[] = [];
		const outcomePromise = driver.startRun(
			{ runId: 'run-sampler-online-cpus-0', imageId: 'fake-image', env: {}, memoryMbytes: 1024, timeoutSecs: 60 },
			() => {},
			(sample) => samples.push(sample),
		);

		await vi.advanceTimersByTimeAsync(1000);

		expect(samples).toHaveLength(1);
		expect(samples[0]?.cpuPercentOfOneCore).toBeCloseTo(20);

		stub.triggerContainerExit(0);
		stub.endLogStream();
		await outcomePromise;
	});

	it("subtracts cgroup v1's total_inactive_file from memory_stats.usage - the same adjustment docker stats' own MEM USAGE column makes", async () => {
		const stub = stubDockerForSampler();
		const driver = new DockerDriver(stub.docker);
		driver.available = true;

		stub.queueStatsResponse(containerStats(0, 0, 100));
		stub.queueStatsResponse(containerStatsWithCache(200, 1000, 150_000_000, 'total_inactive_file', 50_000_000));

		const samples: RunResourceSample[] = [];
		const outcomePromise = driver.startRun(
			{ runId: 'run-sampler-cache-v1', imageId: 'fake-image', env: {}, memoryMbytes: 1024, timeoutSecs: 60 },
			() => {},
			(sample) => samples.push(sample),
		);

		await vi.advanceTimersByTimeAsync(1000);

		expect(samples).toHaveLength(1);
		expect(samples[0]?.memoryBytes).toBe(100_000_000); // 150M reported usage minus 50M cache

		stub.triggerContainerExit(0);
		stub.endLogStream();
		await outcomePromise;
	});

	it("subtracts cgroup v2's inactive_file when total_inactive_file is absent (cgroup v1 has no such field)", async () => {
		const stub = stubDockerForSampler();
		const driver = new DockerDriver(stub.docker);
		driver.available = true;

		stub.queueStatsResponse(containerStats(0, 0, 100));
		stub.queueStatsResponse(containerStatsWithCache(200, 1000, 150_000_000, 'inactive_file', 60_000_000));

		const samples: RunResourceSample[] = [];
		const outcomePromise = driver.startRun(
			{ runId: 'run-sampler-cache-v2', imageId: 'fake-image', env: {}, memoryMbytes: 1024, timeoutSecs: 60 },
			() => {},
			(sample) => samples.push(sample),
		);

		await vi.advanceTimersByTimeAsync(1000);

		expect(samples).toHaveLength(1);
		expect(samples[0]?.memoryBytes).toBe(90_000_000); // 150M reported usage minus 60M cache

		stub.triggerContainerExit(0);
		stub.endLogStream();
		await outcomePromise;
	});

	it('never subtracts a cache figure that is not smaller than the reported usage - falls back to the raw usage rather than going to zero or negative', async () => {
		const stub = stubDockerForSampler();
		const driver = new DockerDriver(stub.docker);
		driver.available = true;

		stub.queueStatsResponse(containerStats(0, 0, 100));
		stub.queueStatsResponse(containerStatsWithCache(200, 1000, 100, 'inactive_file', 100));

		const samples: RunResourceSample[] = [];
		const outcomePromise = driver.startRun(
			{
				runId: 'run-sampler-cache-not-smaller',
				imageId: 'fake-image',
				env: {},
				memoryMbytes: 1024,
				timeoutSecs: 60,
			},
			() => {},
			(sample) => samples.push(sample),
		);

		await vi.advanceTimersByTimeAsync(1000);

		expect(samples).toHaveLength(1);
		expect(samples[0]?.memoryBytes).toBe(100);

		stub.triggerContainerExit(0);
		stub.endLogStream();
		await outcomePromise;
	});

	it('skips a tick outright - no throw, no emission, and the previous sample is left untouched - when stats() rejects (the container may have already exited, or be mid-removal)', async () => {
		const stub = stubDockerForSampler();
		const driver = new DockerDriver(stub.docker);
		driver.available = true;

		stub.queueStatsResponse(containerStats(0, 0, 100)); // baseline
		stub.queueStatsResponse(new Error('stats() failed: container is being removed'));
		stub.queueStatsResponse(containerStats(200, 1000, 150)); // recovers on the next tick

		const samples: RunResourceSample[] = [];
		const outcomePromise = driver.startRun(
			{ runId: 'run-sampler-stats-reject', imageId: 'fake-image', env: {}, memoryMbytes: 1024, timeoutSecs: 60 },
			() => {},
			(sample) => samples.push(sample),
		);

		await vi.advanceTimersByTimeAsync(1000); // tick 1: stats() rejects - skipped, not thrown
		expect(samples).toHaveLength(0);

		// Tick 2 succeeds again, diffed against the BASELINE (the rejected tick returned before ever
		// updating `previous`, so this is not diffed against anything from the failed tick).
		await vi.advanceTimersByTimeAsync(1000);
		expect(samples).toHaveLength(1);
		expect(samples[0]?.cpuPercentOfOneCore).toBeCloseTo(20);

		stub.triggerContainerExit(0);
		stub.endLogStream();
		await outcomePromise;
	});

	it('skips a tick outright - no frame, accumulators untouched - when memory_stats.usage is missing, and the NEXT good sample emits a full, correct eight-field frame with sane avg/max', async () => {
		// Drives the real sample-to-envelope path exactly as `services/runs.ts` wires it in production
		// (`onSample` -> `publishSystemInfo`), reproducing the pre-fix poisoning end-to-end rather than only
		// at the `RunResourceSample` boundary: pre-fix, this tick's stats blob (`memory_stats: {}`, no
		// `usage`) produced a 7-key `systemInfo` frame and then a permanent `NaN` (`null` once
		// JSON-serialized) `memAvgBytes` for every later frame of the run, since `state.memoryUsageSum` had
		// already summed in a `NaN`. Post-fix, the bad tick never reaches `onSample`/`publishSystemInfo` at all.
		resetEventsChannelForTests();
		const runId = 'run-sampler-missing-usage';
		const frames: Array<{ name: string; data: Record<string, unknown> }> = [];
		subscribeEvents(runId, (frame) => frames.push(JSON.parse(frame)));

		const stub = stubDockerForSampler();
		const driver = new DockerDriver(stub.docker);
		driver.available = true;

		stub.queueStatsResponse(containerStats(0, 0, 100)); // baseline
		// BAD: memory_stats present but with no `usage` field at all - the shape that used to slip past the
		// guard and reach `onSample` as a partial (7-key) frame.
		stub.queueStatsResponse({
			cpu_stats: { cpu_usage: { total_usage: 50 }, system_cpu_usage: 500, online_cpus: 1 },
			memory_stats: {},
		});
		stub.queueStatsResponse(containerStats(250, 1500, 150)); // recovers on the next tick

		const samples: RunResourceSample[] = [];
		const outcomePromise = driver.startRun(
			{ runId, imageId: 'fake-image', env: {}, memoryMbytes: 1024, timeoutSecs: 60 },
			() => {},
			(sample) => {
				samples.push(sample);
				publishSystemInfo(runId, sample, { memoryMbytes: 1024 });
			},
		);

		await vi.advanceTimersByTimeAsync(1000); // tick 1: missing usage - skipped, not a partial frame
		expect(samples).toHaveLength(0);
		expect(frames).toHaveLength(0);

		// Tick 2 is diffed against the BASELINE (the skipped tick never updated `previous`), and its frame
		// is the FIRST one this run has ever published - proving the accumulator was never seeded with the
		// bad tick's NaN in the first place.
		await vi.advanceTimersByTimeAsync(1000);
		expect(samples).toHaveLength(1);
		expect(samples[0]?.memoryBytes).toBe(150);
		expect(samples[0]?.cpuPercentOfOneCore).toBeCloseTo(((250 - 0) / (1500 - 0)) * 100);

		expect(frames).toHaveLength(1);
		const data = frames[0]!.data;
		expect(Object.keys(data).sort()).toEqual(
			[
				'cpuAvgUsage',
				'cpuCurrentUsage',
				'cpuMaxUsage',
				'createdAt',
				'isCpuOverloaded',
				'memAvgBytes',
				'memCurrentBytes',
				'memMaxBytes',
			].sort(),
		);
		expect(data.memCurrentBytes).toBe(150);
		expect(data.memAvgBytes).toBe(150); // averaged over exactly one (good) sample, never poisoned by the skipped tick
		expect(Number.isFinite(data.memAvgBytes as number)).toBe(true);
		expect(Number.isFinite(data.cpuAvgUsage as number)).toBe(true);

		stub.triggerContainerExit(0);
		stub.endLogStream();
		await outcomePromise;
	});

	it('skips a tick outright when memory_stats.usage is present but not a finite number (e.g. NaN) - the same guard as a missing field, not just an absent one', async () => {
		const stub = stubDockerForSampler();
		const driver = new DockerDriver(stub.docker);
		driver.available = true;

		stub.queueStatsResponse(containerStats(0, 0, 100)); // baseline
		stub.queueStatsResponse({
			cpu_stats: { cpu_usage: { total_usage: 50 }, system_cpu_usage: 500, online_cpus: 1 },
			memory_stats: { usage: Number.NaN },
		});
		stub.queueStatsResponse(containerStats(250, 1500, 150)); // recovers on the next tick

		const samples: RunResourceSample[] = [];
		const outcomePromise = driver.startRun(
			{ runId: 'run-sampler-nan-usage', imageId: 'fake-image', env: {}, memoryMbytes: 1024, timeoutSecs: 60 },
			() => {},
			(sample) => samples.push(sample),
		);

		await vi.advanceTimersByTimeAsync(1000);
		expect(samples).toHaveLength(0);

		await vi.advanceTimersByTimeAsync(1000);
		expect(samples).toHaveLength(1);
		expect(samples[0]?.memoryBytes).toBe(150);

		stub.triggerContainerExit(0);
		stub.endLogStream();
		await outcomePromise;
	});

	it('skips a tick outright when cpu_stats.cpu_usage.total_usage is missing - the CPU-side counterpart of the memory guard above', async () => {
		const stub = stubDockerForSampler();
		const driver = new DockerDriver(stub.docker);
		driver.available = true;

		stub.queueStatsResponse(containerStats(0, 0, 100)); // baseline
		// BAD: cpu_usage present but with no total_usage field.
		stub.queueStatsResponse({
			cpu_stats: { cpu_usage: {}, system_cpu_usage: 1000, online_cpus: 1 },
			memory_stats: { usage: 150 },
		});
		stub.queueStatsResponse(containerStats(200, 1000, 180)); // recovers on the next tick

		const samples: RunResourceSample[] = [];
		const outcomePromise = driver.startRun(
			{
				runId: 'run-sampler-missing-total-usage',
				imageId: 'fake-image',
				env: {},
				memoryMbytes: 1024,
				timeoutSecs: 60,
			},
			() => {},
			(sample) => samples.push(sample),
		);

		await vi.advanceTimersByTimeAsync(1000); // tick 1: missing total_usage - skipped
		expect(samples).toHaveLength(0);

		// Tick 2 is diffed against the BASELINE, not the skipped tick.
		await vi.advanceTimersByTimeAsync(1000);
		expect(samples).toHaveLength(1);
		expect(samples[0]?.cpuPercentOfOneCore).toBeCloseTo(20);
		expect(samples[0]?.memoryBytes).toBe(180);

		stub.triggerContainerExit(0);
		stub.endLogStream();
		await outcomePromise;
	});

	it("skips a tick outright when cpu_stats.system_cpu_usage is missing while total_usage is present and valid - the cgroup v2 rootless daemon shape the guard's second clause exists for", async () => {
		const stub = stubDockerForSampler();
		const driver = new DockerDriver(stub.docker);
		driver.available = true;

		stub.queueStatsResponse(containerStats(0, 0, 100)); // baseline
		// BAD: total_usage present and finite, but system_cpu_usage is absent entirely - the shape a
		// cgroup-v2 rootless daemon reports (it never populates system_cpu_usage in that mode), distinct
		// from - and never reaching the same code path as - the already-tested "total_usage missing" case
		// above, which returns before system_cpu_usage is even read.
		stub.queueStatsResponse({
			cpu_stats: { cpu_usage: { total_usage: 250 }, online_cpus: 1 },
			memory_stats: { usage: 150 },
		});
		stub.queueStatsResponse(containerStats(200, 1000, 180)); // recovers on the next tick

		const samples: RunResourceSample[] = [];
		const outcomePromise = driver.startRun(
			{
				runId: 'run-sampler-missing-system-usage',
				imageId: 'fake-image',
				env: {},
				memoryMbytes: 1024,
				timeoutSecs: 60,
			},
			() => {},
			(sample) => samples.push(sample),
		);

		await vi.advanceTimersByTimeAsync(1000); // tick 1: missing system_cpu_usage - skipped
		expect(samples).toHaveLength(0);

		// Tick 2 is diffed against the BASELINE, not the skipped tick - proves `previous` was left untouched.
		await vi.advanceTimersByTimeAsync(1000);
		expect(samples).toHaveLength(1);
		expect(samples[0]?.cpuPercentOfOneCore).toBeCloseTo(20);
		expect(samples[0]?.memoryBytes).toBe(180);

		stub.triggerContainerExit(0);
		stub.endLogStream();
		await outcomePromise;
	});

	it('skips a tick outright when cpu_stats.system_cpu_usage is present but not a finite number (e.g. NaN) - the same guard as a missing field, not just an absent one', async () => {
		const stub = stubDockerForSampler();
		const driver = new DockerDriver(stub.docker);
		driver.available = true;

		stub.queueStatsResponse(containerStats(0, 0, 100)); // baseline
		stub.queueStatsResponse({
			cpu_stats: { cpu_usage: { total_usage: 250 }, system_cpu_usage: Number.NaN, online_cpus: 1 },
			memory_stats: { usage: 150 },
		});
		stub.queueStatsResponse(containerStats(200, 1000, 180)); // recovers on the next tick

		const samples: RunResourceSample[] = [];
		const outcomePromise = driver.startRun(
			{
				runId: 'run-sampler-nan-system-usage',
				imageId: 'fake-image',
				env: {},
				memoryMbytes: 1024,
				timeoutSecs: 60,
			},
			() => {},
			(sample) => samples.push(sample),
		);

		await vi.advanceTimersByTimeAsync(1000);
		expect(samples).toHaveLength(0);

		await vi.advanceTimersByTimeAsync(1000);
		expect(samples).toHaveLength(1);
		expect(samples[0]?.cpuPercentOfOneCore).toBeCloseTo(20);
		expect(samples[0]?.memoryBytes).toBe(180);

		stub.triggerContainerExit(0);
		stub.endLogStream();
		await outcomePromise;
	});

	it('skips a tick outright, without throwing or producing an unhandled rejection, when cpu_stats is absent from the stats blob entirely', async () => {
		// Pre-fix, `stats.cpu_stats.cpu_usage.total_usage` on a blob with no `cpu_stats` at all throws a
		// synchronous TypeError inside `takeSample` - and since the interval callback never attaches a
		// `.catch()` to the resulting rejected promise, that becomes an unhandled rejection rather than a
		// clean skip. This test proves the optional-chaining guard closes that off too.
		const uncaughtErrors: unknown[] = [];
		const onUnhandledRejection = (error: unknown): void => {
			uncaughtErrors.push(error);
		};
		process.on('unhandledRejection', onUnhandledRejection);

		try {
			const stub = stubDockerForSampler();
			const driver = new DockerDriver(stub.docker);
			driver.available = true;

			stub.queueStatsResponse(containerStats(0, 0, 100)); // baseline
			stub.queueStatsResponse({ memory_stats: { usage: 150 } }); // BAD: no cpu_stats at all
			stub.queueStatsResponse(containerStats(200, 1000, 180)); // recovers on the next tick

			const samples: RunResourceSample[] = [];
			const outcomePromise = driver.startRun(
				{
					runId: 'run-sampler-no-cpu-stats',
					imageId: 'fake-image',
					env: {},
					memoryMbytes: 1024,
					timeoutSecs: 60,
				},
				() => {},
				(sample) => samples.push(sample),
			);

			await vi.advanceTimersByTimeAsync(1000);
			expect(samples).toHaveLength(0);

			await vi.advanceTimersByTimeAsync(1000);
			expect(samples).toHaveLength(1);
			expect(samples[0]?.cpuPercentOfOneCore).toBeCloseTo(20);

			stub.triggerContainerExit(0);
			stub.endLogStream();
			await outcomePromise;

			// Give any (pre-fix) unhandled rejection a moment to actually surface before asserting on it -
			// fake timers are active in this suite (`beforeEach`), so this advances virtual time rather than
			// waiting on a real one.
			await vi.advanceTimersByTimeAsync(0);
			expect(uncaughtErrors).toEqual([]);
		} finally {
			process.removeListener('unhandledRejection', onUnhandledRejection);
		}
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

	it('awaits the one in-flight stats() call before startRun proceeds to container.remove() when it settles quickly, and issues no further stats() call after stop()', async () => {
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

		// Once the in-flight call resolves (well inside `SAMPLER_STOP_GRACE_MS`), `stop()` completes and
		// `remove()` is called.
		stub.resolvePendingStats(containerStats(0, 0, 100));
		const outcome = await outcomePromise;

		expect(outcome).toEqual({ exitCode: 0, timedOut: false });
		expect(stub.container.remove).toHaveBeenCalledTimes(1);
		// No timer tick ever fired (well under 1000ms of real elapsed time throughout this test) and the
		// baseline read is unemitted either way - exactly one `stats()` call total, none after `stop()`.
		expect(stub.stats).toHaveBeenCalledTimes(1);
	});

	it("bounds stop()'s wait by SAMPLER_STOP_GRACE_MS instead of hanging forever when stats() never resolves - startRun still reaches container.remove(), and the abandoned call resolving later issues no further stats() call and is never emitted", async () => {
		// `stop()` deliberately bounds its wait: with no client-side Docker timeout configured anywhere in
		// this codebase, an unbounded await on the in-flight `stats()` call would leave `startRun`'s own
		// `finally` - and therefore the whole run's finalization - stuck forever against a daemon that
		// never answers. This test is the red->green proof that the hang is now bounded: `stats()` is
		// never resolved at all here, yet `startRun` still completes.
		const stub = stubDockerForSampler();
		const driver = new DockerDriver(stub.docker);
		driver.available = true;

		const samples: RunResourceSample[] = [];
		const outcomePromise = driver.startRun(
			{ runId: 'run-sampler-stop-2', imageId: 'fake-image', env: {}, memoryMbytes: 1024, timeoutSecs: 60 },
			() => {},
			(sample) => samples.push(sample),
		);

		// Let `startRun` run past its own setup, far enough that the sampler's baseline `stats()` call has
		// actually been issued - it is never resolved for the rest of this test.
		await vi.advanceTimersByTimeAsync(0);
		expect(stub.stats).toHaveBeenCalledTimes(1);

		stub.triggerContainerExit(0);
		stub.endLogStream();

		// `startRun`'s `finally` reaches `sampler.stop()`. Just under the grace, `container.remove()` must
		// not have fired yet - `stop()` is still (bounded-ly) waiting on the never-resolving call.
		await vi.advanceTimersByTimeAsync(4999);
		expect(stub.container.remove).not.toHaveBeenCalled();

		// At/after the grace, `stop()` gives up on the still-pending call and `startRun` proceeds to
		// `container.remove()` and resolves - the hang is bounded, not eliminated by some other means.
		await vi.advanceTimersByTimeAsync(1);
		const outcome = await outcomePromise;

		expect(outcome).toEqual({ exitCode: 0, timedOut: false });
		expect(stub.container.remove).toHaveBeenCalledTimes(1);

		// The abandoned call resolving even later must never be emitted (`stopped` suppresses it, per
		// `takeSample`'s own doc comment) and must never trigger a further `stats()` call - `stop()` already
		// cleared the interval before starting its bounded wait.
		stub.resolvePendingStats(containerStats(999, 999, 999));
		await vi.advanceTimersByTimeAsync(5000);
		expect(stub.stats).toHaveBeenCalledTimes(1);
		expect(samples).toEqual([]);
	});

	it('a container.logs() rejection between container.start() and container.wait() still stops the sampler and removes the container', async () => {
		// Real timers, same reason as the test above: nothing queued, so the sampler's own baseline
		// `stats()` call stays pending until this test resolves it - no simulated time needs to elapse.
		vi.useRealTimers();
		const stub = stubDockerForSampler();
		stub.container.logs = vi.fn(async () => {
			throw new Error('container.logs failed');
		});
		const driver = new DockerDriver(stub.docker);
		driver.available = true;

		const outcomePromise = driver.startRun(
			{ runId: 'run-sampler-leak-1', imageId: 'fake-image', env: {}, memoryMbytes: 1024, timeoutSecs: 60 },
			() => {},
			() => {},
		);

		// Let `startRun` run far enough that the sampler's own baseline `stats()` call has actually been
		// issued - proof a sampler genuinely existed at the moment `container.logs()` rejects, not just
		// that nothing crashed.
		await new Promise((resolve) => setImmediate(resolve));
		expect(stub.stats).toHaveBeenCalledTimes(1);

		// Resolve that one in-flight baseline read so `sampler.stop()` - awaited inside the now-widened
		// `finally` - can actually complete once `container.logs()`'s rejection unwinds `startRun` into it.
		stub.resolvePendingStats(containerStats(0, 0, 100));

		await expect(outcomePromise).rejects.toThrow('container.logs failed');

		// The container is never leaked, on this path either - `container.remove()` still runs, even though
		// `container.start()` succeeded but everything after it (the sampler, the log stream) never got to
		// `container.wait()` at all.
		expect(stub.container.remove).toHaveBeenCalledTimes(1);

		// The sampler was genuinely stopped, not merely abandoned mid-flight: no further `stats()` call
		// ever arrives.
		const statsCallsAtRejection = stub.stats.mock.calls.length;
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(stub.stats.mock.calls.length).toBe(statsCallsAtRejection);
	});
});

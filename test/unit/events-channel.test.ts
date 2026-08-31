/**
 * `services/events-channel.ts`'s envelope shaping for `systemInfo`/`aborting` - the sample-in,
 * platform-JSON-frame-out mapping documented in `requirements/actor-driver.md`'s "Run resource
 * telemetry" section: percent-of-one-core (never percent-of-grant), `memMaxBytes` as the configured
 * LIMIT (never a genuine peak), the ratio-only, strict-`>`-0.95 `isCpuOverloaded` test, running avg/max,
 * and the all-eight-fields contract apify-sdk-python's pydantic model requires on every frame.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import {
	getSubscriberCount,
	isEventsTerminal,
	markEventsTerminal,
	publishAborting,
	publishSystemInfo,
	resetEventsChannelForTests,
	subscribeEvents,
} from '../../src/services/events-channel.js';
import type { RunResourceSample } from '../../src/driver/types.js';

function sample(overrides: Partial<RunResourceSample> = {}): RunResourceSample {
	return {
		cpuPercentOfOneCore: 20,
		memoryBytes: 402_653_184,
		memoryLimitBytes: 1024 * 1024 * 1024,
		at: new Date('2026-08-25T09:12:03.481Z'),
		...overrides,
	};
}

/** Subscribes to `runId` and returns every frame published to it so far, parsed. */
function captureFrames(runId: string): { frames: Array<{ name: string; data: unknown }>; unsubscribe: () => void } {
	const frames: Array<{ name: string; data: unknown }> = [];
	const unsubscribe = subscribeEvents(runId, (frame) => frames.push(JSON.parse(frame)));
	return { frames, unsubscribe };
}

describe('events-channel: publishSystemInfo', () => {
	beforeEach(() => {
		resetEventsChannelForTests();
	});

	it('emits a single "systemInfo" frame with all eight fields present, matching the payload shape in requirements/actor-driver.md verbatim', () => {
		const runId = 'run-1';
		const { frames } = captureFrames(runId);

		publishSystemInfo(runId, sample({ cpuPercentOfOneCore: 20, memoryBytes: 402_653_184 }), { memoryMbytes: 1024 });

		expect(frames).toHaveLength(1);
		expect(frames[0]).toEqual({
			name: 'systemInfo',
			data: {
				memAvgBytes: 402_653_184,
				memCurrentBytes: 402_653_184,
				memMaxBytes: 1024 * 1024 * 1024,
				cpuAvgUsage: 20,
				cpuMaxUsage: 20,
				cpuCurrentUsage: 20,
				isCpuOverloaded: false,
				createdAt: '2026-08-25T09:12:03.481Z',
			},
		});
	});

	it('cpuCurrentUsage is percent of ONE core, verbatim from the sample - never percent of the grant', () => {
		const runId = 'run-2';
		const { frames } = captureFrames(runId);

		// A run granted 0.25 core, observed at 20% of one core (0.8 of its own grant) - the figures
		// requirements/actor-driver.md uses to distinguish the two conventions (percent-of-one-core vs
		// percent-of-grant).
		publishSystemInfo(runId, sample({ cpuPercentOfOneCore: 20 }), { memoryMbytes: 1024 });

		const data = frames[0]!.data as Record<string, unknown>;
		expect(data.cpuCurrentUsage).toBe(20);
		expect(data.cpuCurrentUsage).not.toBe(80);
	});

	it('memMaxBytes is the configured memory LIMIT and stays constant across samples with different observed usage - never a growing peak', () => {
		const runId = 'run-3';
		const { frames } = captureFrames(runId);
		const grant = { memoryMbytes: 1024 };

		publishSystemInfo(runId, sample({ memoryBytes: 50_000_000 }), grant);
		publishSystemInfo(runId, sample({ memoryBytes: 900_000_000 }), grant);

		const limits = frames.map((f) => (f.data as Record<string, unknown>).memMaxBytes);
		expect(limits).toEqual([1024 * 1024 * 1024, 1024 * 1024 * 1024]);
	});

	it.each([
		{ label: 'clearly below 0.95', cpuPercentOfOneCore: 20, expected: false }, // usedCores 0.2 / 0.25 = 0.8
		{ label: 'exactly 0.95 (strict >, not >=)', cpuPercentOfOneCore: 23.75, expected: false }, // 0.2375/0.25 = 0.95
		{ label: 'clearly above 0.95', cpuPercentOfOneCore: 24.9, expected: true }, // 0.249/0.25 = 0.996
	])('isCpuOverloaded: $label -> $expected', ({ cpuPercentOfOneCore, expected }) => {
		const runId = 'run-overload';
		const { frames } = captureFrames(runId);

		publishSystemInfo(runId, sample({ cpuPercentOfOneCore }), { memoryMbytes: 1024 });

		expect((frames[0]!.data as Record<string, unknown>).isCpuOverloaded).toBe(expected);
	});

	it('isCpuOverloaded is false when grantedCores is 0 (memoryMbytes: 0), never a division producing Infinity/NaN', () => {
		const runId = 'run-zero-grant';
		const { frames } = captureFrames(runId);

		// grantedCores = dedicatedCpusFor(0) = 0 - the `grantedCores > 0 &&` guard must short-circuit before
		// any `usedCores / grantedCores` division ever happens.
		publishSystemInfo(runId, sample({ cpuPercentOfOneCore: 20 }), { memoryMbytes: 0 });

		expect((frames[0]!.data as Record<string, unknown>).isCpuOverloaded).toBe(false);
	});

	it('memAvgBytes/cpuAvgUsage/cpuMaxUsage are running figures across every sample published so far for that run, cpuCurrentUsage/memCurrentBytes are just the latest', () => {
		const runId = 'run-avg';
		const { frames } = captureFrames(runId);
		const grant = { memoryMbytes: 1024 };

		publishSystemInfo(runId, sample({ cpuPercentOfOneCore: 10, memoryBytes: 100 }), grant);
		publishSystemInfo(runId, sample({ cpuPercentOfOneCore: 30, memoryBytes: 300 }), grant);
		publishSystemInfo(runId, sample({ cpuPercentOfOneCore: 20, memoryBytes: 200 }), grant);

		const last = frames[2]!.data as Record<string, unknown>;
		expect(last.cpuCurrentUsage).toBe(20);
		expect(last.memCurrentBytes).toBe(200);
		expect(last.cpuAvgUsage).toBeCloseTo((10 + 30 + 20) / 3);
		expect(last.memAvgBytes).toBeCloseTo((100 + 300 + 200) / 3);
		expect(last.cpuMaxUsage).toBe(30);
	});

	it('two different runs accumulate their own independent avg/max state - one run publishing never affects the other', () => {
		const { frames: framesA } = captureFrames('run-a');
		const { frames: framesB } = captureFrames('run-b');

		publishSystemInfo('run-a', sample({ cpuPercentOfOneCore: 90 }), { memoryMbytes: 1024 });
		publishSystemInfo('run-b', sample({ cpuPercentOfOneCore: 5 }), { memoryMbytes: 1024 });
		publishSystemInfo('run-a', sample({ cpuPercentOfOneCore: 10 }), { memoryMbytes: 1024 });

		expect((framesA[1]!.data as Record<string, unknown>).cpuMaxUsage).toBe(90);
		expect(framesB).toHaveLength(1);
		expect((framesB[0]!.data as Record<string, unknown>).cpuMaxUsage).toBe(5);
	});

	it('is a no-op (no throw) when nobody is subscribed to the run yet', () => {
		expect(() => publishSystemInfo('run-nobody-listening', sample(), { memoryMbytes: 1024 })).not.toThrow();
	});
});

describe('events-channel: publishAborting', () => {
	beforeEach(() => {
		resetEventsChannelForTests();
	});

	it('emits exactly {"name":"aborting","data":{}} - a literal empty object, no keys', () => {
		const runId = 'run-abort-1';
		const { frames } = captureFrames(runId);

		publishAborting(runId);

		expect(frames).toEqual([{ name: 'aborting', data: {} }]);
	});

	it('is a no-op (no throw) when nobody is subscribed', () => {
		expect(() => publishAborting('run-abort-nobody-listening')).not.toThrow();
	});

	it('interleaves with systemInfo frames on the same subscriber, in publish order', () => {
		const runId = 'run-abort-interleave';
		const { frames } = captureFrames(runId);
		const grant = { memoryMbytes: 1024 };

		publishSystemInfo(runId, sample(), grant);
		publishAborting(runId);
		publishSystemInfo(runId, sample(), grant);

		expect(frames.map((f) => f.name)).toEqual(['systemInfo', 'aborting', 'systemInfo']);
	});
});

describe('events-channel: subscribeEvents/markEventsTerminal/getSubscriberCount', () => {
	beforeEach(() => {
		resetEventsChannelForTests();
	});

	it('subscribeEvents returns an unsubscribe function that stops further frames from reaching that callback', () => {
		const runId = 'run-unsub';
		const received: string[] = [];
		const unsubscribe = subscribeEvents(runId, (frame) => received.push(frame));

		publishAborting(runId);
		unsubscribe();
		publishAborting(runId);

		expect(received).toHaveLength(1);
	});

	it('getSubscriberCount reflects additions and removals, per run, independent of other runs', () => {
		expect(getSubscriberCount('run-count-1')).toBe(0);
		const unsubscribeA1 = subscribeEvents('run-count-1', () => {});
		const unsubscribeA2 = subscribeEvents('run-count-1', () => {});
		subscribeEvents('run-count-2', () => {});

		expect(getSubscriberCount('run-count-1')).toBe(2);
		expect(getSubscriberCount('run-count-2')).toBe(1);

		unsubscribeA1();
		expect(getSubscriberCount('run-count-1')).toBe(1);
		unsubscribeA2();
		expect(getSubscriberCount('run-count-1')).toBe(0);
	});

	it('isEventsTerminal is false until markEventsTerminal is called for that run, and never affects an unrelated run', () => {
		expect(isEventsTerminal('run-terminal-1')).toBe(false);

		markEventsTerminal('run-terminal-1');

		expect(isEventsTerminal('run-terminal-1')).toBe(true);
		expect(isEventsTerminal('run-terminal-2')).toBe(false);
	});
});

/**
 * Pure-math coverage for `src/pricing.ts` - the arithmetic, not the clock: every `computeUnitsFor`
 * assertion below uses fixed ISO strings, never `Date.now()`/fake timers - `pricing.ts` itself takes no
 * injectable clock, so a still-`RUNNING` run's figure is meant to grow simply because `finishedAt ??
 * Date.now()` grows between two reads (see `computeUnitsFor`'s own doc comment).
 */
import { describe, expect, it } from 'vitest';

import {
	CHARGEABLE_SERVICE_PRICING,
	actorStartEventCount,
	computeRunStats,
	computeUnitsFor,
	durationMillisFor,
	initialChargedEventCounts,
	projectUsage,
	type PricingInfo,
} from '../../src/pricing.js';

describe('computeUnitsFor', () => {
	it("matches requirements/api.md's worked example: 4096 MB for 90s = 0.1 CU", () => {
		const cu = computeUnitsFor(4096, '2026-01-01T12:00:00.000Z', '2026-01-01T12:01:30.000Z');
		expect(cu).toBeCloseTo(0.1, 10);
	});

	it('apify-core docs worked example: 1024 MB for 1 hour = 1 CU', () => {
		const cu = computeUnitsFor(1024, '2026-01-01T00:00:00.000Z', '2026-01-01T01:00:00.000Z');
		expect(cu).toBeCloseTo(1, 10);
	});

	it('is linear in duration for a fixed memory grant', () => {
		const short = computeUnitsFor(2048, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:30.000Z');
		const long = computeUnitsFor(2048, '2026-01-01T00:00:00.000Z', '2026-01-01T00:01:00.000Z');
		// Double the duration -> double the compute units, same ratio.
		expect(long / short).toBeCloseTo(2, 10);
	});

	it('is linear in memory for a fixed duration', () => {
		const small = computeUnitsFor(1024, '2026-01-01T00:00:00.000Z', '2026-01-01T01:00:00.000Z');
		const big = computeUnitsFor(4096, '2026-01-01T00:00:00.000Z', '2026-01-01T01:00:00.000Z');
		expect(big / small).toBeCloseTo(4, 10);
	});

	it('zero-duration run reports 0 CU, never negative', () => {
		expect(computeUnitsFor(4096, '2026-01-01T12:00:00.000Z', '2026-01-01T12:00:00.000Z')).toBe(0);
	});

	it('an undefined finishedAt uses "now" - a later call (further in real time) reports a larger figure', () => {
		const startedAt = new Date(Date.now() - 5000).toISOString();
		const first = computeUnitsFor(4096, startedAt, undefined);
		const second = computeUnitsFor(4096, startedAt, undefined);
		expect(second).toBeGreaterThanOrEqual(first);
	});
});

describe('durationMillisFor', () => {
	it('computes the exact millisecond delta between two fixed ISO strings', () => {
		expect(durationMillisFor('2026-01-01T12:00:00.000Z', '2026-01-01T12:01:30.000Z')).toBe(90_000);
	});

	it('never goes negative even if finishedAt somehow precedes startedAt', () => {
		expect(durationMillisFor('2026-01-01T12:00:10.000Z', '2026-01-01T12:00:00.000Z')).toBe(0);
	});
});

describe('actorStartEventCount', () => {
	it('512 MB -> 1 (minimum, per apify-core: Math.max(1, floor(mem/1024)))', () => {
		expect(actorStartEventCount(512)).toBe(1);
	});
	it('1024 MB -> 1 (exactly one GB)', () => {
		expect(actorStartEventCount(1024)).toBe(1);
	});
	it('4096 MB -> 4', () => {
		expect(actorStartEventCount(4096)).toBe(4);
	});
});

const SAMPLE_PRICING_INFO: PricingInfo = {
	pricingModel: 'PAY_PER_EVENT',
	createdAt: '2026-01-01T00:00:00.000Z',
	startedAt: '2026-01-01T00:00:00.000Z',
	apifyMarginPercentage: 0.2,
	pricingPerEvent: {
		actorChargeEvents: {
			'apify-actor-start': {
				eventTitle: 'Actor start',
				eventDescription: 'Charged per GB of memory at start',
				eventPriceUsd: 0.005,
			},
			'page-scraped': { eventTitle: 'Page scraped', eventDescription: 'One page scraped', eventPriceUsd: 0.001 },
		},
	},
};

describe('initialChargedEventCounts', () => {
	it('seeds every declared event at 0, except the synthetic apify-actor-start', () => {
		expect(initialChargedEventCounts(SAMPLE_PRICING_INFO, 4096)).toEqual({
			'apify-actor-start': 4,
			'page-scraped': 0,
		});
	});

	it('omits apify-actor-start entirely when it was not itself declared', () => {
		const pricingInfo: PricingInfo = {
			pricingModel: 'PAY_PER_EVENT',
			createdAt: '2026-01-01T00:00:00.000Z',
			startedAt: '2026-01-01T00:00:00.000Z',
			apifyMarginPercentage: 0.2,
			pricingPerEvent: {
				actorChargeEvents: {
					'page-scraped': {
						eventTitle: 'Page scraped',
						eventDescription: 'One page scraped',
						eventPriceUsd: 0.001,
					},
				},
			},
		};
		expect(initialChargedEventCounts(pricingInfo, 4096)).toEqual({ 'page-scraped': 0 });
	});
});

describe('computeRunStats', () => {
	it('emits every ActorJobPublishedStats key, zeroing every field this runtime never measures', () => {
		const stats = computeRunStats(4096, '2026-01-01T12:00:00.000Z', '2026-01-01T12:01:30.000Z', undefined);
		expect(Object.keys(stats).sort()).toEqual(
			[
				'inputBodyLen',
				'migrationCount',
				'rebootCount',
				'restartCount',
				'resurrectCount',
				'durationMillis',
				'runTimeSecs',
				'metamorph',
				'computeUnits',
				'memAvgBytes',
				'memMaxBytes',
				'memCurrentBytes',
				'cpuAvgUsage',
				'cpuMaxUsage',
				'cpuCurrentUsage',
				'netRxBytes',
				'netTxBytes',
				'imageSizeBytes',
			].sort(),
		);
		expect(stats.durationMillis).toBe(90_000);
		expect(stats.runTimeSecs).toBe(90);
		expect(stats.computeUnits).toBeCloseTo(0.1, 10);
		expect(stats.memMaxBytes).toBe(4096 * 1024 * 1024);
		// Never measured / never snapshotted for this run - zeroed, not omitted.
		expect(stats.inputBodyLen).toBe(0);
		expect(stats.migrationCount).toBe(0);
		expect(stats.rebootCount).toBe(0);
		expect(stats.restartCount).toBe(0);
		expect(stats.resurrectCount).toBe(0);
		expect(stats.metamorph).toBe(0);
		expect(stats.netRxBytes).toBe(0);
		expect(stats.netTxBytes).toBe(0);
		expect(stats.imageSizeBytes).toBe(0);
		expect(stats.memCurrentBytes).toBe(0);
		expect(stats.cpuCurrentUsage).toBe(0);
		// No snapshot given -> the three sampler-derived aggregates default to 0, not undefined.
		expect(stats.memAvgBytes).toBe(0);
		expect(stats.cpuAvgUsage).toBe(0);
		expect(stats.cpuMaxUsage).toBe(0);
	});

	it('carries a given resourceStats snapshot through untouched', () => {
		const stats = computeRunStats(1024, '2026-01-01T12:00:00.000Z', '2026-01-01T12:00:10.000Z', {
			memAvgBytes: 903_086_080,
			cpuAvgUsage: 41.2,
			cpuMaxUsage: 98.7,
		});
		expect(stats.memAvgBytes).toBe(903_086_080);
		expect(stats.cpuAvgUsage).toBe(41.2);
		expect(stats.cpuMaxUsage).toBe(98.7);
	});
});

describe('projectUsage', () => {
	it('ACTOR_COMPUTE_UNITS is always present and usageUsd = usage x 0.2', () => {
		const { usage, usageUsd } = projectUsage(0.5, undefined, undefined);
		expect(usage.ACTOR_COMPUTE_UNITS).toBe(0.5);
		expect(usageUsd.ACTOR_COMPUTE_UNITS).toBeCloseTo(0.5 * CHARGEABLE_SERVICE_PRICING.ACTOR_COMPUTE_UNITS, 10);
		expect(CHARGEABLE_SERVICE_PRICING.ACTOR_COMPUTE_UNITS).toBe(0.2);
	});

	it('a non-PPE run (no pricingInfo) omits PAID_ACTORS_PER_EVENT and eventUsage entirely - never zeroed', () => {
		const projection = projectUsage(0.1, undefined, undefined);
		expect('PAID_ACTORS_PER_EVENT' in projection.usage).toBe(false);
		expect('PAID_ACTORS_PER_EVENT' in projection.usageUsd).toBe(false);
		expect(projection.eventUsage).toBeUndefined();
		// Total falls back to just the compute-units cost.
		expect(projection.usageTotalUsd).toBeCloseTo(projection.usageUsd.ACTOR_COMPUTE_UNITS ?? -1, 10);
	});

	it('never emits a PROXY_* key, zeroed or otherwise', () => {
		const projection = projectUsage(0.1, SAMPLE_PRICING_INFO, { 'apify-actor-start': 4, 'page-scraped': 137 });
		for (const key of Object.keys(projection.usage)) expect(key).not.toMatch(/^PROXY_/);
		for (const key of Object.keys(projection.usageUsd)) expect(key).not.toMatch(/^PROXY_/);
	});

	it('a PPE run: usage/usageUsd/eventUsage/usageTotalUsd all match hand-computed values', () => {
		const chargedEventCounts = { 'apify-actor-start': 4, 'page-scraped': 137 };
		const computeUnits = 0.1;
		const projection = projectUsage(computeUnits, SAMPLE_PRICING_INFO, chargedEventCounts);

		const expectedPpeUsd = 4 * 0.005 + 137 * 0.001; // 0.02 + 0.137 = 0.157
		expect(projection.usage.PAID_ACTORS_PER_EVENT).toBeCloseTo(expectedPpeUsd, 10);
		// apify-core's $1-per-USD-unit convention: usage and usageUsd are numerically identical for PPE.
		expect(projection.usageUsd.PAID_ACTORS_PER_EVENT).toBeCloseTo(expectedPpeUsd, 10);

		expect(projection.eventUsage).toBeDefined();
		expect(projection.eventUsage?.['apify-actor-start']).toEqual({
			eventTitle: 'Actor start',
			eventTotalUsd: 4 * 0.005,
		});
		expect(projection.eventUsage?.['page-scraped']).toEqual({
			eventTitle: 'Page scraped',
			eventTotalUsd: 137 * 0.001,
		});

		const expectedCuUsd = computeUnits * CHARGEABLE_SERVICE_PRICING.ACTOR_COMPUTE_UNITS;
		expect(projection.usageTotalUsd).toBeCloseTo(expectedCuUsd + expectedPpeUsd, 10);
	});

	it('ignores a charged-event-counts entry for an event no longer in pricingInfo (defensive, not otherwise reachable)', () => {
		const projection = projectUsage(0, SAMPLE_PRICING_INFO, { 'apify-actor-start': 4, 'unknown-event': 9 });
		expect(projection.eventUsage?.['unknown-event']).toBeUndefined();
		expect(projection.usage.PAID_ACTORS_PER_EVENT).toBeCloseTo(4 * 0.005, 10);
	});
});

/**
 * `services/run-usage.ts`: the cost estimate's arithmetic (`actor-driver.md`'s "Run usage estimate") -
 * compute units from memory times wall-clock time, priced at the Starter plan's per-unit price, the
 * per-event totals of a pay-per-event run, live-vs-persisted telemetry, and what counts against the cap.
 */
import { describe, expect, it } from 'vitest';

import {
	computeRunUsage,
	computeUnitsFor,
	runDurationMillis,
	STARTER_PLAN_COMPUTE_UNIT_PRICE_USD,
} from '../../src/services/run-usage.js';
import type { RunRecord } from '../../src/storage/entities.js';

const STARTED_AT = '2026-09-21T10:00:00.000Z';

function run(overrides: Partial<RunRecord> = {}): RunRecord {
	return {
		id: 'run',
		userId: 'u',
		actorId: 'a',
		buildId: 'b',
		buildNumber: '0.0.1',
		status: 'RUNNING',
		startedAt: STARTED_AT,
		defaultDatasetId: 'd',
		defaultKeyValueStoreId: 'k',
		defaultRequestQueueId: 'r',
		options: { memoryMbytes: 1024, timeoutSecs: 300 },
		meta: { origin: 'API' },
		...overrides,
	};
}

const HOUR_LATER = new Date('2026-09-21T11:00:00.000Z');

const ppeRun = (chargedEventCounts: Record<string, number>, extra: Partial<RunRecord> = {}) =>
	run({
		pricingInfo: {
			pricingModel: 'PAY_PER_EVENT',
			createdAt: STARTED_AT,
			startedAt: STARTED_AT,
			apifyMarginPercentage: 0,
			pricingPerEvent: {
				actorChargeEvents: {
					'page-scraped': { eventTitle: 'Page scraped', eventDescription: '', eventPriceUsd: 0.002 },
					'apify-actor-start': { eventTitle: 'Start', eventDescription: '', eventPriceUsd: 0.01 },
				},
			},
		},
		chargedEventCounts,
		...extra,
	});

describe('compute units', () => {
	it('1 GB for one hour is one compute unit; scales linearly with memory and time', () => {
		expect(computeUnitsFor(1024, 60 * 60 * 1000)).toBe(1);
		expect(computeUnitsFor(4096, 15 * 60 * 1000)).toBe(1);
		expect(computeUnitsFor(256, 60 * 60 * 1000)).toBe(0.25);
	});

	it('duration runs from creation to finishedAt, or to now while live; a READY run has none', () => {
		expect(runDurationMillis(run(), HOUR_LATER)).toBe(60 * 60 * 1000);
		expect(
			runDurationMillis(run({ status: 'SUCCEEDED', finishedAt: '2026-09-21T10:30:00.000Z' }), HOUR_LATER),
		).toBe(30 * 60 * 1000);
		expect(runDurationMillis(run({ status: 'READY' }), HOUR_LATER)).toBe(0);
	});

	it('a resurrected run counts from its resurrection on top of what it ran before, never the time in between', () => {
		const resurrected = run({
			resurrectedAt: '2026-09-21T10:50:00.000Z',
			stats: { durationMillisBeforeResurrect: 5 * 60 * 1000 },
		});
		// 5 min before, 10 min since the resurrection; the 45 min it spent finished are not run time.
		expect(runDurationMillis(resurrected, HOUR_LATER)).toBe(15 * 60 * 1000);
		expect(runDurationMillis({ ...resurrected, status: 'READY' }, HOUR_LATER)).toBe(5 * 60 * 1000);
		expect(
			runDurationMillis(
				{ ...resurrected, status: 'SUCCEEDED', finishedAt: '2026-09-21T10:52:00.000Z' },
				HOUR_LATER,
			),
		).toBe(7 * 60 * 1000);
	});
});

describe('computeRunUsage', () => {
	it('prices compute units at the Starter plan price and reports the platform stats fields', () => {
		const usage = computeRunUsage(run(), undefined, HOUR_LATER);
		expect(STARTER_PLAN_COMPUTE_UNIT_PRICE_USD).toBe(0.2);
		expect(usage.usage).toEqual({ ACTOR_COMPUTE_UNITS: 1 });
		expect(usage.usageUsd).toEqual({ ACTOR_COMPUTE_UNITS: 0.2 });
		expect(usage.usageTotalUsd).toBe(0.2);
		expect(usage.platformUsageUsd).toBe(0.2);
		expect(usage.eventsUsd).toBe(0);
		expect(usage.eventUsage).toBeUndefined();
		expect(usage.stats).toEqual({
			inputBodyLen: 0,
			migrationCount: 0,
			rebootCount: 0,
			restartCount: 0,
			resurrectCount: 0,
			durationMillis: 3_600_000,
			runTimeSecs: 3600,
			metamorph: 0,
			computeUnits: 1,
		});
	});

	it('uses the live telemetry snapshot when given, else the figures persisted on the record', () => {
		const live = computeRunUsage(
			run({ stats: { memAvgBytes: 1 } }),
			{
				memAvgBytes: 10,
				memMaxBytes: 20,
				memCurrentBytes: 15,
				cpuAvgUsage: 5,
				cpuMaxUsage: 9,
				cpuCurrentUsage: 7,
			},
			HOUR_LATER,
		);
		expect(live.stats.memAvgBytes).toBe(10);
		expect(live.stats.cpuMaxUsage).toBe(9);

		const persisted = computeRunUsage(
			run({
				status: 'SUCCEEDED',
				finishedAt: HOUR_LATER.toISOString(),
				stats: { memAvgBytes: 1, cpuAvgUsage: 2, inputBodyLen: 42 },
			}),
			undefined,
			HOUR_LATER,
		);
		expect(persisted.stats.memAvgBytes).toBe(1);
		expect(persisted.stats.cpuAvgUsage).toBe(2);
		expect(persisted.stats.inputBodyLen).toBe(42);
		expect(persisted.stats).not.toHaveProperty('memMaxBytes');
	});

	it('adds per-event totals and their sum on a pay-per-event run; an unpriced charged event is skipped', () => {
		const usage = computeRunUsage(
			ppeRun({ 'page-scraped': 150, 'apify-actor-start': 1, 'no-longer-priced': 7 }),
			undefined,
			HOUR_LATER,
		);
		expect(usage.eventUsage).toEqual({
			'page-scraped': { eventTitle: 'Page scraped', eventTotalUsd: 0.3 },
			'apify-actor-start': { eventTitle: 'Start', eventTotalUsd: 0.01 },
		});
		expect(usage.eventsUsd).toBe(0.31);
		expect(usage.usageTotalUsd).toBe(0.51);
	});

	it('avoids floating-point noise in the USD figures', () => {
		const usage = computeRunUsage(ppeRun({ 'page-scraped': 3, 'apify-actor-start': 0 }), undefined, HOUR_LATER);
		expect(usage.eventUsage?.['page-scraped']?.eventTotalUsd).toBe(0.006);
		expect(usage.eventsUsd).toBe(0.006);
	});
});

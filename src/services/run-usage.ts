/**
 * The run's cost estimate (`actor-driver.md`'s "Run usage estimate"). Only compute units are metered:
 * storage operations, data transfer and proxy usage are not measurable here, and reporting them as zero
 * would read as "free" rather than "unknown".
 */
import type { RunRecord } from '../storage/entities.js';
import type { RunTelemetrySnapshot } from './events-channel.js';
import { isPayPerEvent } from './pricing.js';

/** The platform's definition: 1 GB of memory for one hour. */
export const COMPUTE_UNIT_MBYTES = 1024;
export const COMPUTE_UNIT_MILLIS = 60 * 60 * 1000;

/** https://apify.com/pricing, Starter plan. The free plan lists the same figure. */
export const STARTER_PLAN_COMPUTE_UNIT_PRICE_USD = 0.2;

export const ACTOR_COMPUTE_UNITS = 'ACTOR_COMPUTE_UNITS';

/** What the platform rounds USD to in billing, and enough to keep sub-cent event prices exact. */
const USD_DECIMALS = 6;

export function roundUsd(value: number): number {
	return Number(value.toFixed(USD_DECIMALS));
}

export interface RunUsageStats {
	inputBodyLen: number;
	migrationCount: number;
	rebootCount: number;
	restartCount: number;
	resurrectCount: number;
	durationMillis: number;
	runTimeSecs: number;
	metamorph: number;
	computeUnits: number;
	memAvgBytes?: number;
	memMaxBytes?: number;
	memCurrentBytes?: number;
	cpuAvgUsage?: number;
	cpuMaxUsage?: number;
	cpuCurrentUsage?: number;
}

export interface RunEventUsage {
	[eventName: string]: { eventTitle: string; eventTotalUsd: number };
}

export interface RunUsage {
	stats: RunUsageStats;
	usage: { [ACTOR_COMPUTE_UNITS]: number };
	usageUsd: { [ACTOR_COMPUTE_UNITS]: number };
	/** Per-event totals; present only on a pay-per-event run. */
	eventUsage?: RunEventUsage;
	/** Platform usage USD plus event USD - everything the runtime can price for this run. */
	usageTotalUsd: number;
	/** The two components of `usageTotalUsd`, for the console's breakdown. */
	platformUsageUsd: number;
	eventsUsd: number;
}

/** A `READY` run has no container yet, so it has consumed nothing. A resurrected run's current
 * incarnation counts from `resurrectedAt`, on top of what the run consumed before - the time it spent
 * finished in between is not run time. */
export function runDurationMillis(
	run: Pick<RunRecord, 'status' | 'startedAt' | 'finishedAt' | 'resurrectedAt' | 'stats'>,
	now: Date,
): number {
	const before = run.stats?.durationMillisBeforeResurrect ?? 0;
	if (run.status === 'READY') return before;
	const endMillis = run.finishedAt ? Date.parse(run.finishedAt) : now.getTime();
	return before + Math.max(0, endMillis - Date.parse(run.resurrectedAt ?? run.startedAt));
}

export function computeUnitsFor(memoryMbytes: number, durationMillis: number): number {
	return (memoryMbytes / COMPUTE_UNIT_MBYTES) * (durationMillis / COMPUTE_UNIT_MILLIS);
}

/** An event charged but no longer priced is left out, as on the platform. */
export function eventUsageFor(run: Pick<RunRecord, 'pricingInfo' | 'chargedEventCounts'>): RunEventUsage | undefined {
	if (!isPayPerEvent(run.pricingInfo)) return undefined;
	const usage: RunEventUsage = {};
	for (const [eventName, event] of Object.entries(run.pricingInfo.pricingPerEvent.actorChargeEvents)) {
		const count = run.chargedEventCounts?.[eventName] ?? 0;
		usage[eventName] = { eventTitle: event.eventTitle, eventTotalUsd: roundUsd(count * event.eventPriceUsd) };
	}
	return usage;
}

export function sumEventUsageUsd(eventUsage: RunEventUsage | undefined): number {
	let total = 0;
	for (const { eventTotalUsd } of Object.values(eventUsage ?? {})) total += eventTotalUsd;
	return roundUsd(total);
}

/** `telemetry` is a live run's current figures; a finished run passes `undefined` and uses its own. */
export function computeRunUsage(
	run: RunRecord,
	telemetry: RunTelemetrySnapshot | undefined,
	now = new Date(),
): RunUsage {
	const durationMillis = runDurationMillis(run, now);
	const computeUnits = computeUnitsFor(run.options.memoryMbytes, durationMillis);
	const persisted = run.stats ?? {};
	const measured: Partial<RunTelemetrySnapshot> = telemetry ?? {
		memAvgBytes: persisted.memAvgBytes,
		memMaxBytes: persisted.memMaxBytes,
		memCurrentBytes: persisted.memCurrentBytes,
		cpuAvgUsage: persisted.cpuAvgUsage,
		cpuMaxUsage: persisted.cpuMaxUsage,
		cpuCurrentUsage: persisted.cpuCurrentUsage,
	};

	const stats: RunUsageStats = {
		inputBodyLen: persisted.inputBodyLen ?? 0,
		migrationCount: persisted.migrationCount ?? 0,
		rebootCount: persisted.rebootCount ?? 0,
		restartCount: persisted.restartCount ?? 0,
		resurrectCount: persisted.resurrectCount ?? 0,
		durationMillis,
		runTimeSecs: durationMillis / 1000,
		metamorph: 0,
		computeUnits,
	};
	for (const key of [
		'memAvgBytes',
		'memMaxBytes',
		'memCurrentBytes',
		'cpuAvgUsage',
		'cpuMaxUsage',
		'cpuCurrentUsage',
	] as const) {
		if (measured[key] !== undefined) stats[key] = measured[key];
	}

	const platformUsageUsd = roundUsd(computeUnits * STARTER_PLAN_COMPUTE_UNIT_PRICE_USD);
	const eventUsage = eventUsageFor(run);
	const eventsUsd = sumEventUsageUsd(eventUsage);

	return {
		stats,
		usage: { [ACTOR_COMPUTE_UNITS]: computeUnits },
		usageUsd: { [ACTOR_COMPUTE_UNITS]: platformUsageUsd },
		...(eventUsage ? { eventUsage } : {}),
		usageTotalUsd: roundUsd(platformUsageUsd + eventsUsd),
		platformUsageUsd,
		eventsUsd,
	};
}

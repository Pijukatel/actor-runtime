/**
 * Pure cost-estimation math - constants and functions only, nothing persisted, no I/O. Shaped like
 * `resources.ts`. Deliberately takes only primitives (never `RunRecord`/`ActorRecord`) so this module
 * can never import the storage or API layers - see `.shepherd/2-design.md`'s "Proposed solution".
 *
 * Compute units are *derived*, not accumulated: apify-core sums a per-worker-tick `computeUnits` into
 * `run.stats.computeUnits`, but that is provably identical, for a run whose `memoryMbytes` never
 * changes mid-run (no migration/resurrect here), to `(memoryMbytes/1024) * (durationMs/3600000)`
 * computed once from the run's own `startedAt`/`finishedAt` - see the design doc's worked example. This
 * is why there is no injectable clock here: a running run's figure is meant to grow simply because
 * `finishedAt ?? Date.now()` grows between two reads, exactly as apify-core's own would.
 */

/** apify-core's `CHARGEABLE_SERVICE_PRICING` (`src/packages/finances/src/pricing.ts`), copied for the
 * two services this runtime supports (fact ledger claim 4/9): `ACTOR_COMPUTE_UNITS.baseUnitPriceUsd`
 * is USD per compute unit; `PAID_ACTORS_PER_EVENT` follows apify-core's $1-per-USD-denominated-unit
 * convention, so a PPE dollar amount and its "usage unit" count are numerically identical. Proxy/
 * storage services are deliberately absent - out of scope (design section "Decisions").
 */
export const CHARGEABLE_SERVICE_PRICING = {
	ACTOR_COMPUTE_UNITS: 0.2,
	PAID_ACTORS_PER_EVENT: 1,
} as const;

/** The synthetic per-run charge event the real platform charges automatically at run start - the SDK
 * never POSTs `apify-`-prefixed events itself (fact ledger claim 5/6), so this runtime applies it
 * server-side, the same as apify-core's `getInitialChargedEventCounts`. */
export const SYNTHETIC_ACTOR_START_EVENT = 'apify-actor-start';

const MS_PER_HOUR = 3_600_000;
const MB_PER_GB = 1024;
const BYTES_PER_MB = 1024 * 1024;

export interface ChargeEventDefinition {
	eventTitle: string;
	eventDescription?: string;
	eventPriceUsd: number;
}

/** Matches apify-client's `PricePerEventActorPricingInfo` shape exactly (only the `PAY_PER_EVENT`
 * model is supported here - `FREE`/`FLAT_PRICE_PER_MONTH`/`PRICE_PER_DATASET_ITEM` are out of scope). */
export interface PricingInfo {
	pricingModel: 'PAY_PER_EVENT';
	pricingPerEvent: {
		actorChargeEvents: Record<string, ChargeEventDefinition>;
	};
}

/** The three sampler-derived aggregates that cannot be re-derived after the fact from `startedAt`/
 * `finishedAt` alone - snapshotted from `events-channel.ts`'s in-memory accumulator into `RunRecord` in
 * the same terminal-transition write that sets `finishedAt` (design section 1). */
export interface ResourceStatsSnapshot {
	memAvgBytes: number;
	cpuAvgUsage: number;
	cpuMaxUsage: number;
}

/** Exactly apify-core's `ActorJobPublishedStats` allow-list (fact ledger claim 8) - every key is always
 * present, with fields this runtime never measures set to `0` rather than omitted (`storage.md`'s own
 * zeroed-`stats` convention). */
export interface RunStats {
	inputBodyLen: number;
	migrationCount: number;
	rebootCount: number;
	restartCount: number;
	resurrectCount: number;
	durationMillis: number;
	runTimeSecs: number;
	metamorph: number;
	computeUnits: number;
	memAvgBytes: number;
	memMaxBytes: number;
	memCurrentBytes: number;
	cpuAvgUsage: number;
	cpuMaxUsage: number;
	cpuCurrentUsage: number;
	netRxBytes: number;
	netTxBytes: number;
	imageSizeBytes: number;
}

export interface EventUsageEntry {
	eventTitle: string;
	eventTotalUsd: number;
}

export type UsageKey = 'ACTOR_COMPUTE_UNITS' | 'PAID_ACTORS_PER_EVENT';

export interface UsageProjection {
	usage: Partial<Record<UsageKey, number>>;
	usageUsd: Partial<Record<UsageKey, number>>;
	/** Only present at all for a PPE run - never an empty object for a non-PPE one (design section 2 /
	 * success criterion 44). */
	eventUsage?: Record<string, EventUsageEntry>;
	usageTotalUsd: number;
}

/** Wall-clock duration in ms, floored at `0`. Uses `finishedAt ?? Date.now()` for a still-running run -
 * deliberately not injectable (see this module's doc comment). */
export function durationMillisFor(startedAt: string, finishedAt?: string): number {
	const start = Date.parse(startedAt);
	const end = finishedAt ? Date.parse(finishedAt) : Date.now();
	return Math.max(0, end - start);
}

/** apify-core's own formula (fact ledger claim 4, `docs.apify.com`): granted memory (GB) x wall-clock
 * duration (hours). Unrounded, matching apify-core's own unrounded persistence. */
export function computeUnitsFor(memoryMbytes: number, startedAt: string, finishedAt?: string): number {
	const durationHours = durationMillisFor(startedAt, finishedAt) / MS_PER_HOUR;
	return (memoryMbytes / MB_PER_GB) * durationHours;
}

/** apify-core's `getInitialChargedEventCounts` synthetic-start-event count: one event per full GB of
 * memory, minimum 1 (fact ledger claim 5). */
export function actorStartEventCount(memoryMbytes: number): number {
	return Math.max(1, Math.floor(memoryMbytes / MB_PER_GB));
}

/** Every event declared in `pricingInfo` seeded at `0`, except `apify-actor-start` (when declared),
 * which is seeded at `actorStartEventCount(memoryMbytes)` - design section 3's worked example. */
export function initialChargedEventCounts(pricingInfo: PricingInfo, memoryMbytes: number): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const eventName of Object.keys(pricingInfo.pricingPerEvent.actorChargeEvents)) {
		counts[eventName] = eventName === SYNTHETIC_ACTOR_START_EVENT ? actorStartEventCount(memoryMbytes) : 0;
	}
	return counts;
}

/** The `stats` object `runDto` returns - see this module's doc comment for which fields are derived
 * vs. genuinely unmeasured. `resourceStats` is the run's own snapshot (undefined for a run that never
 * received a sample, e.g. one that failed before its container started - treated as all-zero). */
export function computeRunStats(
	memoryMbytes: number,
	startedAt: string,
	finishedAt: string | undefined,
	resourceStats: ResourceStatsSnapshot | undefined,
): RunStats {
	const durationMillis = durationMillisFor(startedAt, finishedAt);
	return {
		inputBodyLen: 0,
		migrationCount: 0,
		rebootCount: 0,
		restartCount: 0,
		resurrectCount: 0,
		durationMillis,
		runTimeSecs: durationMillis / 1000,
		metamorph: 0,
		computeUnits: computeUnitsFor(memoryMbytes, startedAt, finishedAt),
		memAvgBytes: resourceStats?.memAvgBytes ?? 0,
		memMaxBytes: memoryMbytes * BYTES_PER_MB,
		memCurrentBytes: 0,
		cpuAvgUsage: resourceStats?.cpuAvgUsage ?? 0,
		cpuMaxUsage: resourceStats?.cpuMaxUsage ?? 0,
		cpuCurrentUsage: 0,
		netRxBytes: 0,
		netTxBytes: 0,
		imageSizeBytes: 0,
	};
}

/**
 * `usage`/`usageUsd`/`eventUsage`/`usageTotalUsd` - computed at read time from persisted counters,
 * never stored (design section 2). `ACTOR_COMPUTE_UNITS` is always present for any run this is called
 * for; `PAID_ACTORS_PER_EVENT`/`eventUsage` only appear when `pricingInfo`/`chargedEventCounts` are
 * both given (a PPE run) - omitted entirely otherwise, never zeroed (success criterion 44). Unlike
 * apify-core, PPE cost is never zeroed for the Actor's own owner (design section 2's deliberate
 * deviation) - every declared, charged event counts here regardless of who owns the Actor.
 */
export function projectUsage(
	computeUnits: number,
	pricingInfo: PricingInfo | undefined,
	chargedEventCounts: Record<string, number> | undefined,
): UsageProjection {
	const computeUnitsUsd = computeUnits * CHARGEABLE_SERVICE_PRICING.ACTOR_COMPUTE_UNITS;
	const usage: Partial<Record<UsageKey, number>> = { ACTOR_COMPUTE_UNITS: computeUnits };
	const usageUsd: Partial<Record<UsageKey, number>> = { ACTOR_COMPUTE_UNITS: computeUnitsUsd };
	let eventUsage: Record<string, EventUsageEntry> | undefined;

	if (pricingInfo && chargedEventCounts) {
		eventUsage = {};
		let paidActorsPerEventUsd = 0;
		for (const [eventName, count] of Object.entries(chargedEventCounts)) {
			const definition = pricingInfo.pricingPerEvent.actorChargeEvents[eventName];
			if (!definition) continue;
			const eventTotalUsd = count * definition.eventPriceUsd;
			paidActorsPerEventUsd += eventTotalUsd;
			eventUsage[eventName] = { eventTitle: definition.eventTitle, eventTotalUsd };
		}
		usage.PAID_ACTORS_PER_EVENT = paidActorsPerEventUsd;
		usageUsd.PAID_ACTORS_PER_EVENT = paidActorsPerEventUsd * CHARGEABLE_SERVICE_PRICING.PAID_ACTORS_PER_EVENT;
	}

	const usageTotalUsd = (usageUsd.ACTOR_COMPUTE_UNITS ?? 0) + (usageUsd.PAID_ACTORS_PER_EVENT ?? 0);
	return { usage, usageUsd, eventUsage, usageTotalUsd };
}

/**
 * Pure cost-estimation math - constants and functions only, nothing persisted, no I/O. Shaped like
 * `resources.ts`. Deliberately takes only primitives (never `RunRecord`/`ActorRecord`) so this module
 * can never import the storage or API layers.
 *
 * Compute units are *derived*, not accumulated: apify-core sums a per-worker-tick `computeUnits` into
 * `run.stats.computeUnits`, but that is provably identical, for a run whose `memoryMbytes` never
 * changes mid-run (no migration/resurrect here), to `(memoryMbytes/1024) * (durationMs/3600000)`
 * computed once from the run's own `startedAt`/`finishedAt` - see `requirements/api.md`'s "Run cost
 * estimation and PPE charging" section for the worked example. This is why there is no injectable clock
 * here: a running run's figure is meant to grow simply because `finishedAt ?? Date.now()` grows between
 * two reads, exactly as apify-core's own would.
 */

/** apify-core's `CHARGEABLE_SERVICE_PRICING` (`src/packages/finances/src/pricing.ts`), copied for the two
 * services this runtime supports: `ACTOR_COMPUTE_UNITS.baseUnitPriceUsd` is USD per compute unit;
 * `PAID_ACTORS_PER_EVENT` follows apify-core's $1-per-USD-denominated-unit convention, so a PPE dollar
 * amount and its "usage unit" count are numerically identical. Proxy/storage services are deliberately
 * absent - out of scope.
 */
export const CHARGEABLE_SERVICE_PRICING = {
	ACTOR_COMPUTE_UNITS: 0.2,
	PAID_ACTORS_PER_EVENT: 1,
} as const;

/** The synthetic per-run charge event the real platform charges automatically at run start - the SDK
 * never POSTs `apify-`-prefixed events itself, so this runtime applies it
 * server-side, the same as apify-core's `getInitialChargedEventCounts`. */
export const SYNTHETIC_ACTOR_START_EVENT = 'apify-actor-start';

const MS_PER_HOUR = 3_600_000;
const MB_PER_GB = 1024;
const BYTES_PER_MB = 1024 * 1024;

export interface ChargeEventDefinition {
	eventTitle: string;
	/** Required, not optional - apify-core's own `ActorChargeDefinitionCommon`
	 * (`apify-core/src/packages/types/src/paid_actors.ts`) declares this as a plain `string`, and the
	 * Python SDK's pydantic model (`apify_client._models.ActorChargeEvent.event_description: str`, no
	 * default) enforces that at parse time - `apify_client`'s `run().get()` calls
	 * `RunResponse.model_validate(...)` on every response, so a run whose `pricingInfo` omits this field
	 * fails `Actor.init()` with a `ValidationError` before the Actor even starts. apify-client-js's own
	 * TS type marks it optional, but that client does no runtime schema validation - being the strict
	 * superset satisfies both. */
	eventDescription: string;
	eventPriceUsd: number;
}

/** apify-core's real default `apifyMarginPercentage` for `PAY_PER_EVENT` Actors
 * (`APIFY_MARGIN_PERCENTAGE[ACTOR_PRICING_MODEL.PAY_PER_EVENT]`,
 * `apify-core/src/packages/actor/src/paid_actors/paid_actors_common.ts`) - the platform's standard 20%
 * take for this pricing model. Fixed here, not settable through the declaration endpoint: this runtime
 * has no billing-plan/admin-override machinery (`priceOverride`, admin-immediate-effect pricing) to vary
 * it per Actor, and every locally-declared Actor is equally "just a developer's own Actor", so one fixed
 * value mirrors the real default without inventing a new knob. */
export const APIFY_MARGIN_PERCENTAGE_PAY_PER_EVENT = 0.2;

/**
 * Mirrors apify-core's real `PricePerEventActorResolvedPricingInfo` shape
 * (`apify-core/src/packages/types/src/paid_actors.ts`'s `CommonActorPricingInfo` +
 * `PricePerEventActorResolvedPricingInfo`; only the `PAY_PER_EVENT` model is supported here -
 * `FREE`/`FLAT_PRICE_PER_MONTH`/`PRICE_PER_DATASET_ITEM` are out of scope). `createdAt`/`startedAt` are
 * ISO strings, not `Date` - every other timestamp this runtime persists/serializes is already an ISO
 * string (`RunRecord.startedAt`/`finishedAt`, `ActorRecord.modifiedAt`, ...), and pydantic's
 * `AwareDatetime` (the Python SDK's `CommonActorPricingInfo.created_at`/`started_at` type) parses a
 * `Z`-suffixed ISO string into a timezone-aware `datetime` directly, so no conversion is needed on either
 * side. `apifyMarginPercentage`/`createdAt`/`startedAt` are required at this top level in both apify-core
 * and apify-client-js's own `CommonActorPricingInfo` TS type - this was the actual gap: they were entirely
 * absent here, which is why a real `apify_client.run().get()` call failed `RunResponse.model_validate(...)`
 * with three `Field required` errors before this fix. */
export interface PricingInfo {
	pricingModel: 'PAY_PER_EVENT';
	/** When this pricing info record was declared - stamped server-side, never client-supplied
	 * (`services/pricing-declaration.ts: setActorPricing`). */
	createdAt: string;
	/** Since when this pricing info record is effective for the Actor. This runtime has no future-dated/
	 * delayed-effect declaration (apify-core's `EFFECTIVE_DELAY_FOR_SETTING_MONETIZATION_WEEKS`), so a
	 * declaration takes effect immediately - always equal to `createdAt` for the same declaration. */
	startedAt: string;
	apifyMarginPercentage: number;
	pricingPerEvent: {
		actorChargeEvents: Record<string, ChargeEventDefinition>;
	};
}

/** The three sampler-derived aggregates that cannot be re-derived after the fact from `startedAt`/
 * `finishedAt` alone - snapshotted from `events-channel.ts`'s in-memory accumulator into `RunRecord` in
 * the same terminal-transition write that sets `finishedAt`. */
export interface ResourceStatsSnapshot {
	memAvgBytes: number;
	cpuAvgUsage: number;
	cpuMaxUsage: number;
}

/** Exactly apify-core's `ActorJobPublishedStats` allow-list - every key is always
 * present, with fields this runtime never measures set to `0` rather than omitted (`requirements/storage.md`'s own
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
	/** Only present at all for a PPE run - never an empty object for a non-PPE one. */
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

/** apify-core's own formula (`docs.apify.com`): granted memory (GB) x wall-clock
 * duration (hours). Unrounded, matching apify-core's own unrounded persistence. */
export function computeUnitsFor(memoryMbytes: number, startedAt: string, finishedAt?: string): number {
	const durationHours = durationMillisFor(startedAt, finishedAt) / MS_PER_HOUR;
	return (memoryMbytes / MB_PER_GB) * durationHours;
}

/** apify-core's `getInitialChargedEventCounts` synthetic-start-event count: one event per full GB of
 * memory, minimum 1. */
export function actorStartEventCount(memoryMbytes: number): number {
	return Math.max(1, Math.floor(memoryMbytes / MB_PER_GB));
}

/** Every event declared in `pricingInfo` seeded at `0`, except `apify-actor-start` (when declared),
 * which is seeded at `actorStartEventCount(memoryMbytes)`. */
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
 * never stored. `ACTOR_COMPUTE_UNITS` is always present for any run this is called
 * for; `PAID_ACTORS_PER_EVENT`/`eventUsage` only appear when `pricingInfo`/`chargedEventCounts` are
 * both given (a PPE run) - omitted entirely otherwise, never zeroed. Unlike
 * apify-core, PPE cost is never zeroed for the Actor's own owner - this is a deliberate deviation:
 * every declared, charged event counts here regardless of who owns the Actor.
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

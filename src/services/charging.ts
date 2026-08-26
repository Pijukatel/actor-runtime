/**
 * `POST /v2/actor-runs/:runId/charge`'s dedupe + increment (`requirements/api.md`). The dedupe
 * check and the increment happen inside one `runs.update()` mutator, so `storage/mutex.ts`'s
 * `KeyedMutex` (already used by every `Registry.update()`) serialises concurrent charges for the same
 * run - no second lock, no Redis, nothing else to add.
 */
import type { ChargeLogEntry } from '../storage/entities.js';
import { getRegistries } from '../storage/registries.js';

/** Capped, oldest evicted first - a replay of an evicted key would double-charge, which is still
 * stricter than apify-core's own 180-second Redis idempotency window. Never exposed on `/v2` -
 * `dto/actors.ts: runDto` never reads `chargeLog`. */
const MAX_CHARGE_LOG_ENTRIES = 1000;

/** No variant carries a payload - the caller (`api/routes/runs.ts`) only ever branches on which of
 * these happened, never reads the run record back out of the outcome. */
export type ChargeOutcome = 'charged' | 'replayed' | 'not-found' | 'not-pay-per-event' | 'undeclared-event';

/**
 * `runId` must already be resolved+owned by the caller (`api/routes/runs.ts`'s `getOwnedRun`, the same
 * check every other run route uses). `count` is added as-is (the caller validates it is a positive
 * number); `maxTotalChargeUsd` is never consulted here - deliberately not enforced server-side, matching
 * apify-core where the cap is enforced client-side by the SDK.
 */
export async function chargeRun(
	runId: string,
	eventName: string,
	count: number,
	idempotencyKey: string,
): Promise<ChargeOutcome> {
	const { runs } = getRegistries();
	// The mutator assigns the outcome as it goes, so the caller just returns whatever it last set - no
	// recombining `runs.update()`'s own return value with a separately tracked outcome afterwards.
	let outcome: ChargeOutcome = 'not-found';

	await runs.update(runId, (current) => {
		if (!current) {
			outcome = 'not-found';
			return current;
		}
		if (!current.pricingInfo || current.pricingInfo.pricingModel !== 'PAY_PER_EVENT') {
			outcome = 'not-pay-per-event';
			return current;
		}
		if (!current.pricingInfo.pricingPerEvent.actorChargeEvents[eventName]) {
			outcome = 'undeclared-event';
			return current;
		}
		// Idempotency: a replay of the exact same key is a no-op (same status, no second increment,
		// `chargeLog` unchanged) - this file-backed log is what makes the dedupe survive a restart,
		// unlike apify-core's 180s Redis TTL.
		if (current.chargeLog?.some((entry) => entry.idempotencyKey === idempotencyKey)) {
			outcome = 'replayed';
			return current;
		}

		const chargedEventCounts = {
			...current.chargedEventCounts,
			[eventName]: (current.chargedEventCounts?.[eventName] ?? 0) + count,
		};
		const entry: ChargeLogEntry = { idempotencyKey, eventName, count, chargedAt: new Date().toISOString() };
		const chargeLog = [...(current.chargeLog ?? []), entry].slice(-MAX_CHARGE_LOG_ENTRIES);

		outcome = 'charged';
		return { ...current, chargedEventCounts, chargeLog };
	});

	return outcome;
}

/**
 * `POST /v2/actor-runs/:runId/charge`'s dedupe + increment (`api.md`, design section 4). The dedupe
 * check and the increment happen inside one `runs.update()` mutator, so `storage/mutex.ts`'s
 * `KeyedMutex` (already used by every `Registry.update()`) serialises concurrent charges for the same
 * run - no second lock, no Redis, nothing else to add.
 */
import type { ChargeLogEntry, RunRecord } from '../storage/entities.js';
import { getRegistries } from '../storage/registries.js';

/** Capped, oldest evicted first - a replay of an evicted key would double-charge, which is still
 * stricter than apify-core's own 180-second Redis idempotency window (fact ledger claim 5). Never
 * exposed on `/v2` - `dto/actors.ts: runDto` never reads `chargeLog`. */
const MAX_CHARGE_LOG_ENTRIES = 1000;

export type ChargeOutcome =
	| { kind: 'charged'; run: RunRecord }
	| { kind: 'replayed'; run: RunRecord }
	| { kind: 'not-found' }
	| { kind: 'not-pay-per-event' }
	| { kind: 'undeclared-event' };

/**
 * `runId` must already be resolved+owned by the caller (`api/routes/runs.ts`'s `getOwnedRun`, the same
 * check every other run route uses - design section 4's "Authorization" note). `count` is added as-is
 * (the caller validates it is a positive number); `maxTotalChargeUsd` is never consulted here -
 * deliberately not enforced server-side (design section 4 / success criterion 30).
 */
export async function chargeRun(
	runId: string,
	eventName: string,
	count: number,
	idempotencyKey: string,
): Promise<ChargeOutcome> {
	const { runs } = getRegistries();
	// A plain object (rather than a re-assigned `let`) so the mutator's writes are read back reliably -
	// `outcome.kind` is never narrowed by the closure's own control flow the way a captured `let` would
	// be.
	const outcome: { kind: ChargeOutcome['kind'] } = { kind: 'not-found' };

	const updated = await runs.update(runId, (current) => {
		if (!current) {
			outcome.kind = 'not-found';
			return current;
		}
		if (!current.pricingInfo || current.pricingInfo.pricingModel !== 'PAY_PER_EVENT') {
			outcome.kind = 'not-pay-per-event';
			return current;
		}
		if (!current.pricingInfo.pricingPerEvent.actorChargeEvents[eventName]) {
			outcome.kind = 'undeclared-event';
			return current;
		}
		// Idempotency: a replay of the exact same key is a no-op (same status, no second increment,
		// `chargeLog` unchanged) - this file-backed log is what makes the dedupe survive a restart,
		// unlike apify-core's 180s Redis TTL (fact ledger claim 5, success criterion 16).
		if (current.chargeLog?.some((entry) => entry.idempotencyKey === idempotencyKey)) {
			outcome.kind = 'replayed';
			return current;
		}

		const chargedEventCounts = {
			...current.chargedEventCounts,
			[eventName]: (current.chargedEventCounts?.[eventName] ?? 0) + count,
		};
		const entry: ChargeLogEntry = { idempotencyKey, eventName, count, chargedAt: new Date().toISOString() };
		const chargeLog = [...(current.chargeLog ?? []), entry].slice(-MAX_CHARGE_LOG_ENTRIES);

		outcome.kind = 'charged';
		return { ...current, chargedEventCounts, chargeLog };
	});

	if ((outcome.kind === 'charged' || outcome.kind === 'replayed') && updated) {
		return { kind: outcome.kind, run: updated };
	}
	switch (outcome.kind) {
		case 'not-found':
		case 'not-pay-per-event':
		case 'undeclared-event':
			return { kind: outcome.kind };
		default:
			// Unreachable: `updated` is only falsy when `current` was `null`, which only ever sets
			// `outcome.kind` to `'not-found'` above.
			return { kind: 'not-found' };
	}
}

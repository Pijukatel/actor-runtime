/**
 * PPE pricing declaration (`requirements/api.md`'s `/actor-runtime/*` section): one
 * validate-and-persist entry point, `setActorPricing`, mirrored by `api/routes/pricing.ts`'s
 * `POST /actor-runtime/pricing/:actorId` exactly the way `services/dev-folder.ts`'s `setDevFolder`
 * is mirrored by its own route - same "canonical body is a JSON value; the literal empty string
 * clears" convention (`CLAUDE.MD`).
 *
 * This is the *only* way an Actor's PPE pricing is ever set in this runtime - there is no
 * `.actor/pay_per_event.json` (or any other Actor-source file) reading or fallback anywhere in this
 * module or its caller.
 */
import type { ActorRecord } from '../storage/entities.js';
import type { ChargeEventDefinition, PricingInfo } from '../pricing.js';
import { getRegistries } from '../storage/registries.js';

export type SetPricingResult = { kind: 'ok'; actor: ActorRecord } | { kind: 'invalid-request'; message: string };

function isChargeEventDefinition(value: unknown): value is ChargeEventDefinition {
	if (typeof value !== 'object' || value === null) return false;
	const definition = value as Record<string, unknown>;
	if (typeof definition.eventTitle !== 'string' || definition.eventTitle.length === 0) return false;
	if (
		typeof definition.eventPriceUsd !== 'number' ||
		!Number.isFinite(definition.eventPriceUsd) ||
		definition.eventPriceUsd < 0
	) {
		return false;
	}
	if (definition.eventDescription !== undefined && typeof definition.eventDescription !== 'string') return false;
	return true;
}

/** `null` for a shape-valid `PricingInfo`, or a human-readable rejection reason - same convention as
 * `dev-folder.ts`'s `validateDevFolderPathShape`. */
export function validatePricingInfoShape(value: unknown): string | null {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return 'Request body must be a JSON object with pricingModel "PAY_PER_EVENT", or the JSON string "" to clear';
	}
	const candidate = value as Record<string, unknown>;
	if (candidate.pricingModel !== 'PAY_PER_EVENT') {
		return 'pricingModel must be "PAY_PER_EVENT" - this runtime only supports pay-per-event pricing';
	}
	const pricingPerEvent = candidate.pricingPerEvent as Record<string, unknown> | undefined;
	const actorChargeEvents = pricingPerEvent?.actorChargeEvents;
	if (typeof actorChargeEvents !== 'object' || actorChargeEvents === null || Array.isArray(actorChargeEvents)) {
		return 'pricingPerEvent.actorChargeEvents must be an object mapping event names to their pricing';
	}
	for (const [eventName, definition] of Object.entries(actorChargeEvents as Record<string, unknown>)) {
		if (eventName.length === 0) return 'Event names must be non-empty';
		if (!isChargeEventDefinition(definition)) {
			return `pricingPerEvent.actorChargeEvents["${eventName}"] must have a non-empty "eventTitle" and a non-negative numeric "eventPriceUsd"`;
		}
	}
	return null;
}

async function writePricingInfo(actorId: string, pricingInfo: PricingInfo | undefined): Promise<ActorRecord | null> {
	return getRegistries().actors.update(actorId, (current) => (current ? { ...current, pricingInfo } : current));
}

/**
 * Only the literal empty string clears - matching `dev-folder.ts`'s `setDevFolder` convention exactly.
 * A clear is a no-op (no registry write) when the Actor has no pricing declared already. Anything else
 * must be a well-shaped `PricingInfo` object or this rejects with `invalid-request`, writing nothing -
 * a previously-declared pricing survives untouched across a later failed attempt.
 */
export async function setActorPricing(actor: ActorRecord, rawBody: unknown): Promise<SetPricingResult> {
	if (rawBody === '') {
		if (!actor.pricingInfo) return { kind: 'ok', actor };
		const updated = await writePricingInfo(actor.id, undefined);
		return { kind: 'ok', actor: updated ?? { ...actor, pricingInfo: undefined } };
	}

	const shapeError = validatePricingInfoShape(rawBody);
	if (shapeError) return { kind: 'invalid-request', message: shapeError };

	const pricingInfo = rawBody as PricingInfo;
	const updated = await writePricingInfo(actor.id, pricingInfo);
	return { kind: 'ok', actor: updated ?? { ...actor, pricingInfo } };
}

export interface PricingDeclarationStatus {
	/** `null` when nothing is declared for this Actor - same "absent-as-null in the response body"
	 * convention as `dev-folder.ts: DevFolderStatus`. */
	pricingInfo: PricingInfo | null;
}

export function pricingDeclarationStatus(actor: ActorRecord): PricingDeclarationStatus {
	return { pricingInfo: actor.pricingInfo ?? null };
}

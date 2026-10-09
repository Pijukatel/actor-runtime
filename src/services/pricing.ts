/**
 * Actor pricing (`actor-driver.md`'s "Pay-per-event pricing"): validation for the API and the console's
 * form, and per-run resolution. Rental and pay-per-result are rejected rather than stored, since nothing
 * downstream would act on them (`unsupported.md`).
 */
import { isDeepStrictEqual } from 'node:util';

import type {
	ActorChargeEventRecord,
	ActorPricingInfoRecord,
	ActorPricingModel,
	RunPricingInfoRecord,
} from '../storage/entities.js';

/** Charged by the runtime itself; both SDKs deliberately never post these to the charge endpoint. */
export const APIFY_EVENTS_PREFIX = 'apify-';
export const ACTOR_START_EVENT_NAME = 'apify-actor-start';
export const DEFAULT_DATASET_ITEM_EVENT_NAME = 'apify-default-dataset-item';

/** The lowest paid subscription tier (Starter), which every price this runtime reports is taken at. */
export const RESOLVED_PRICING_TIER = 'BRONZE';

const SUPPORTED_PRICING_MODELS: readonly ActorPricingModel[] = ['FREE', 'PAY_PER_EVENT'];
const KNOWN_PRICING_MODELS: readonly ActorPricingModel[] = [
	'FREE',
	'FLAT_PRICE_PER_MONTH',
	'PRICE_PER_DATASET_ITEM',
	'PAY_PER_EVENT',
];

const PRICING_INFO_FIELDS = [
	'pricingModel',
	'createdAt',
	'startedAt',
	'apifyMarginPercentage',
	'reasonForChange',
	'pricingPerEvent',
] as const;

const CHARGE_EVENT_FIELDS = [
	'eventTitle',
	'eventDescription',
	'eventPriceUsd',
	'eventTieredPricingUsd',
	'isOneTimeEvent',
	'isPrimaryEvent',
] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * `message` is shown verbatim by both the API's error and the console's inline error. `type` is the
 * platform's own error type for the rules it also enforces; a plain `invalid-request` otherwise.
 */
export type InvalidPricingInfos = { kind: 'invalid'; message: string; type?: string };
export type ValidatedPricingInfos = { kind: 'ok'; pricingInfos: ActorPricingInfoRecord[] } | InvalidPricingInfos;

function invalid(message: string, type?: string): InvalidPricingInfos {
	return { kind: 'invalid', message, ...(type ? { type } : {}) };
}

function parseTimestamp(value: unknown): string | undefined {
	if (typeof value !== 'string' && !(value instanceof Date)) return undefined;
	const millis = value instanceof Date ? value.getTime() : Date.parse(value);
	return Number.isFinite(millis) ? new Date(millis).toISOString() : undefined;
}

function validateChargeEvent(
	eventName: string,
	raw: unknown,
	where: string,
): { kind: 'ok'; event: ActorChargeEventRecord } | InvalidPricingInfos {
	if (!isPlainObject(raw)) return invalid(`${where}: event "${eventName}" must be a JSON object`);
	const unknownKey = Object.keys(raw).find((key) => !(CHARGE_EVENT_FIELDS as readonly string[]).includes(key));
	if (unknownKey) {
		return invalid(
			`${where}: event "${eventName}" has an unknown field "${unknownKey}" - allowed fields are ` +
				CHARGE_EVENT_FIELDS.map((field) => `"${field}"`).join(', ') +
				'.',
		);
	}
	if (typeof raw.eventTitle !== 'string' || raw.eventTitle.trim() === '') {
		return invalid(`${where}: event "${eventName}" needs a non-empty "eventTitle"`);
	}
	if (raw.eventDescription !== undefined && typeof raw.eventDescription !== 'string') {
		return invalid(`${where}: event "${eventName}": "eventDescription" must be a string`);
	}
	const flags: { isOneTimeEvent?: boolean; isPrimaryEvent?: boolean } = {};
	for (const flag of ['isOneTimeEvent', 'isPrimaryEvent'] as const) {
		const value = raw[flag];
		if (value === undefined) continue;
		if (typeof value !== 'boolean') return invalid(`${where}: event "${eventName}": "${flag}" must be a boolean`);
		flags[flag] = value;
	}

	const hasFlat = raw.eventPriceUsd !== undefined;
	const hasTiered = raw.eventTieredPricingUsd !== undefined;
	if (hasFlat === hasTiered) {
		return invalid(
			`${where}: event "${eventName}" needs exactly one of "eventPriceUsd" or "eventTieredPricingUsd"`,
		);
	}

	const event: ActorChargeEventRecord = {
		eventTitle: raw.eventTitle,
		eventDescription: typeof raw.eventDescription === 'string' ? raw.eventDescription : '',
		...flags,
	};

	if (hasFlat) {
		if (!isNonNegativeNumber(raw.eventPriceUsd)) {
			return invalid(`${where}: event "${eventName}": "eventPriceUsd" must be a number >= 0`);
		}
		event.eventPriceUsd = raw.eventPriceUsd;
		return { kind: 'ok', event };
	}

	if (!isPlainObject(raw.eventTieredPricingUsd)) {
		return invalid(`${where}: event "${eventName}": "eventTieredPricingUsd" must be an object keyed by tier`);
	}
	const tiers: Record<string, { tieredEventPriceUsd: number }> = {};
	for (const [tier, tierRaw] of Object.entries(raw.eventTieredPricingUsd)) {
		if (!isPlainObject(tierRaw) || !isNonNegativeNumber(tierRaw.tieredEventPriceUsd)) {
			return invalid(`${where}: event "${eventName}": tier "${tier}" needs a "tieredEventPriceUsd" number >= 0`);
		}
		tiers[tier] = { tieredEventPriceUsd: tierRaw.tieredEventPriceUsd };
	}
	if (!tiers[RESOLVED_PRICING_TIER]) {
		return invalid(
			`${where}: event "${eventName}": "eventTieredPricingUsd" must include the "${RESOLVED_PRICING_TIER}" tier - ` +
				'the tier this runtime prices runs at',
		);
	}
	event.eventTieredPricingUsd = tiers;
	return { kind: 'ok', event };
}

function validatePricingInfo(raw: unknown, index: number, now: Date): ValidatedPricingInfos {
	const where = `pricingInfos[${index}]`;
	if (!isPlainObject(raw)) return invalid(`${where} must be a JSON object`);

	const unknownKey = Object.keys(raw).find((key) => !(PRICING_INFO_FIELDS as readonly string[]).includes(key));
	if (unknownKey) {
		return invalid(
			`${where} has an unknown field "${unknownKey}" - allowed fields are ` +
				PRICING_INFO_FIELDS.map((field) => `"${field}"`).join(', ') +
				'.',
		);
	}

	const model = raw.pricingModel;
	if (typeof model !== 'string' || !(KNOWN_PRICING_MODELS as readonly string[]).includes(model)) {
		return invalid(
			`${where}: "pricingModel" must be one of ${KNOWN_PRICING_MODELS.map((m) => `"${m}"`).join(', ')}`,
		);
	}
	if (!(SUPPORTED_PRICING_MODELS as readonly string[]).includes(model)) {
		return invalid(
			`${where}: pricing model "${model}" is not emulated by this runtime - only "FREE" and "PAY_PER_EVENT" are`,
		);
	}
	const pricingModel = model as ActorPricingModel;

	for (const field of ['createdAt', 'startedAt'] as const) {
		if (raw[field] !== undefined && parseTimestamp(raw[field]) === undefined) {
			return invalid(`${where}: "${field}" must be an ISO-8601 timestamp`);
		}
	}
	if (raw.apifyMarginPercentage !== undefined) {
		const margin = raw.apifyMarginPercentage;
		if (typeof margin !== 'number' || !Number.isFinite(margin) || margin < 0 || margin > 1) {
			return invalid(`${where}: "apifyMarginPercentage" must be a number between 0 and 1`);
		}
	}
	if (raw.reasonForChange !== undefined && typeof raw.reasonForChange !== 'string') {
		return invalid(`${where}: "reasonForChange" must be a string`);
	}

	const startedAt = parseTimestamp(raw.startedAt) ?? now.toISOString();
	const info: ActorPricingInfoRecord = {
		pricingModel,
		createdAt: parseTimestamp(raw.createdAt) ?? startedAt,
		startedAt,
		apifyMarginPercentage: typeof raw.apifyMarginPercentage === 'number' ? raw.apifyMarginPercentage : 0,
		...(typeof raw.reasonForChange === 'string' ? { reasonForChange: raw.reasonForChange } : {}),
	};

	if (pricingModel === 'FREE') {
		if (raw.pricingPerEvent !== undefined) {
			return invalid(`${where}: "pricingPerEvent" is only valid with "pricingModel": "PAY_PER_EVENT"`);
		}
		return { kind: 'ok', pricingInfos: [info] };
	}

	if (!isPlainObject(raw.pricingPerEvent) || !isPlainObject(raw.pricingPerEvent.actorChargeEvents)) {
		return invalid(`${where}: a PAY_PER_EVENT pricing needs "pricingPerEvent": { "actorChargeEvents": { ... } }`);
	}
	const extraKey = Object.keys(raw.pricingPerEvent).find((key) => key !== 'actorChargeEvents');
	if (extraKey) return invalid(`${where}: "pricingPerEvent" has an unknown field "${extraKey}"`);

	const events: Record<string, ActorChargeEventRecord> = {};
	for (const [eventName, eventRaw] of Object.entries(raw.pricingPerEvent.actorChargeEvents)) {
		if (eventName.trim() === '') return invalid(`${where}: an event name must not be empty`);
		const result = validateChargeEvent(eventName, eventRaw, where);
		if (result.kind === 'invalid') return result;
		events[eventName] = result.event;
	}
	if (Object.keys(events).length === 0) {
		return invalid(`${where}: "actorChargeEvents" must define at least one event`);
	}
	info.pricingPerEvent = { actorChargeEvents: events };
	return { kind: 'ok', pricingInfos: [info] };
}

/**
 * Every entry comes out with `createdAt`, `startedAt` and `apifyMarginPercentage` filled in: the public
 * API and the SDKs' models mark all three required, so a stored entry must carry them to go back out.
 * An empty array is valid and means no pricing.
 */
export function validatePricingInfos(raw: unknown, now = new Date()): ValidatedPricingInfos {
	if (!Array.isArray(raw)) return invalid('"pricingInfos" must be a JSON array');
	const pricingInfos: ActorPricingInfoRecord[] = [];
	for (const [index, entry] of raw.entries()) {
		const result = validatePricingInfo(entry, index, now);
		if (result.kind === 'invalid') return result;
		pricingInfos.push(...result.pricingInfos);
	}
	return { kind: 'ok', pricingInfos };
}

/**
 * The platform's append-only rule: an update carries the Actor's existing entries unchanged and may add
 * one more, so a price a run was charged at can always be read back. Making an Actor free is appending a
 * `FREE` entry, never dropping the history.
 */
export function validatePricingInfosUpdate(
	raw: unknown,
	existing: readonly ActorPricingInfoRecord[] | undefined,
	now = new Date(),
): ValidatedPricingInfos {
	const validated = validatePricingInfos(raw, now);
	if (validated.kind === 'invalid') return validated;

	const current = existing ?? [];
	const submitted = validated.pricingInfos;
	if (submitted.length < current.length) {
		return invalid(
			'You cannot remove pricing info. To make the Actor free, submit the current pricing infos and ' +
				'add one with the FREE pricing model.',
			'cannot-remove-pricing-info',
		);
	}
	if (submitted.length - current.length > 1) {
		return invalid('You cannot add multiple pricing infos at once.', 'cannot-add-multiple-pricing-infos');
	}
	for (const [index, entry] of current.entries()) {
		if (!isDeepStrictEqual(submitted[index], entry)) {
			return invalid(
				`pricingInfos[${index}] differs from the Actor's existing pricing info ${describeDifference(submitted[index], entry)} - ` +
					'an update must start with the existing entries unchanged and may only append one more.',
				'incorrect-pricing-modifier-prefix',
			);
		}
	}
	if (submitted.length === current.length) return validated;

	const added = submitted[submitted.length - 1]!;
	const addedAt = Date.parse(added.startedAt);
	if (current.some((entry) => addedAt <= Date.parse(entry.startedAt))) {
		return invalid(
			'The pricing info you are adding must start after all existing ones.',
			'cannot-add-pricing-info-that-alters-past',
		);
	}
	if (addedAt > now.getTime() && current.some((entry) => Date.parse(entry.startedAt) > now.getTime())) {
		return invalid(
			'There is already a pricing info starting in the future. You cannot add another one.',
			'cannot-add-second-future-pricing-info',
		);
	}
	return validated;
}

/**
 * The first field the submitted entry gets wrong, named as a path. Worth the code: the usual cause is an
 * entry rebuilt from a file rather than from what the Actor already has, and the difference is then a
 * timestamp nobody thinks to look at.
 */
function describeDifference(submitted: unknown, stored: unknown, path = ''): string {
	if (isPlainObject(submitted) && isPlainObject(stored)) {
		for (const key of new Set([...Object.keys(stored), ...Object.keys(submitted)])) {
			const where = path === '' ? key : `${path}.${key}`;
			if (!isDeepStrictEqual(submitted[key], stored[key]))
				return describeDifference(submitted[key], stored[key], where);
		}
	}
	const at = path === '' ? '' : `at "${path}" `;
	return `${at}(sent ${describeValue(submitted)}, stored ${describeValue(stored)})`;
}

function describeValue(value: unknown): string {
	if (value === undefined) return 'nothing';
	const json = JSON.stringify(value) ?? String(value);
	return json.length > 60 ? `${json.slice(0, 57)}...` : json;
}

/** The entry with the latest `startedAt` not after `date`, the platform's own rule. */
export function effectivePricingInfo(
	pricingInfos: readonly ActorPricingInfoRecord[] | undefined,
	date = new Date(),
): ActorPricingInfoRecord | undefined {
	let effective: ActorPricingInfoRecord | undefined;
	for (const info of pricingInfos ?? []) {
		const startedAt = Date.parse(info.startedAt);
		if (startedAt > date.getTime()) continue;
		if (!effective || startedAt > Date.parse(effective.startedAt)) effective = info;
	}
	return effective;
}

/** Tiered event prices are collapsed here, so nothing downstream has to know tiers exist. */
export function resolveRunPricingInfo(
	pricingInfos: readonly ActorPricingInfoRecord[] | undefined,
	date = new Date(),
): RunPricingInfoRecord | undefined {
	const effective = effectivePricingInfo(pricingInfos, date);
	if (!effective) return undefined;
	const resolved: RunPricingInfoRecord = {
		pricingModel: effective.pricingModel,
		createdAt: effective.createdAt,
		startedAt: effective.startedAt,
		apifyMarginPercentage: effective.apifyMarginPercentage,
	};
	if (effective.pricingModel !== 'PAY_PER_EVENT' || !effective.pricingPerEvent) return resolved;

	const actorChargeEvents: NonNullable<RunPricingInfoRecord['pricingPerEvent']>['actorChargeEvents'] = {};
	for (const [eventName, event] of Object.entries(effective.pricingPerEvent.actorChargeEvents)) {
		const eventPriceUsd =
			event.eventPriceUsd ?? event.eventTieredPricingUsd?.[RESOLVED_PRICING_TIER]?.tieredEventPriceUsd ?? 0;
		actorChargeEvents[eventName] = {
			eventTitle: event.eventTitle,
			eventDescription: event.eventDescription,
			eventPriceUsd,
			...(event.isOneTimeEvent !== undefined ? { isOneTimeEvent: event.isOneTimeEvent } : {}),
			...(event.isPrimaryEvent !== undefined ? { isPrimaryEvent: event.isPrimaryEvent } : {}),
		};
	}
	resolved.pricingPerEvent = { actorChargeEvents };
	return resolved;
}

export function isPayPerEvent(pricingInfo: RunPricingInfoRecord | undefined): pricingInfo is RunPricingInfoRecord & {
	pricingPerEvent: NonNullable<RunPricingInfoRecord['pricingPerEvent']>;
} {
	return pricingInfo?.pricingModel === 'PAY_PER_EVENT' && pricingInfo.pricingPerEvent !== undefined;
}

/** The platform pre-charges `apify-actor-start` once per whole gigabyte of the run's memory. */
export function initialChargedEventCounts(
	pricingInfo: RunPricingInfoRecord | undefined,
	memoryMbytes: number,
): Record<string, number> | undefined {
	if (!isPayPerEvent(pricingInfo)) return undefined;
	const counts: Record<string, number> = {};
	for (const eventName of Object.keys(pricingInfo.pricingPerEvent.actorChargeEvents)) counts[eventName] = 0;
	if (ACTOR_START_EVENT_NAME in counts) counts[ACTOR_START_EVENT_NAME] = actorStartEventCount(memoryMbytes);
	return counts;
}

/** One start event per whole gigabyte of the run's memory, at least one - charged at every start,
 * a resurrection included. */
export function actorStartEventCount(memoryMbytes: number): number {
	return Math.max(1, Math.floor(memoryMbytes / 1024));
}

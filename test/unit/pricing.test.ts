/**
 * `services/pricing.ts`: validation/normalization of an Actor's `pricingInfos`, which pricing is in
 * effect at a date, per-run resolution (tiered prices collapsed to the BRONZE tier), and the initial
 * `chargedEventCounts` with the synthetic start event (`actor-driver.md`'s "Pay-per-event pricing").
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
	ACTOR_START_EVENT_NAME,
	DEFAULT_DATASET_ITEM_EVENT_NAME,
	effectivePricingInfo,
	initialChargedEventCounts,
	isPayPerEvent,
	resolveRunPricingInfo,
	validatePricingInfos,
	validatePricingInfosUpdate,
} from '../../src/services/pricing.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const NOW = new Date('2026-09-21T10:00:00.000Z');

const ppe = (events: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
	pricingModel: 'PAY_PER_EVENT',
	pricingPerEvent: { actorChargeEvents: events },
	...extra,
});

function ok(raw: unknown) {
	const result = validatePricingInfos(raw, NOW);
	if (result.kind !== 'ok') throw new Error(`expected ok, got: ${result.message}`);
	return result.pricingInfos;
}

function invalidMessage(raw: unknown): string {
	const result = validatePricingInfos(raw, NOW);
	if (result.kind !== 'invalid') throw new Error('expected the input to be rejected');
	return result.message;
}

describe('validatePricingInfos', () => {
	it('accepts an empty array (no pricing - a free Actor)', () => {
		expect(ok([])).toEqual([]);
	});

	it('normalizes a minimal PAY_PER_EVENT pricing: timestamps default to now, margin to 0, description to ""', () => {
		const [info] = ok([ppe({ 'page-scraped': { eventTitle: 'Page scraped', eventPriceUsd: 0.002 } })]);
		expect(info).toEqual({
			pricingModel: 'PAY_PER_EVENT',
			createdAt: NOW.toISOString(),
			startedAt: NOW.toISOString(),
			apifyMarginPercentage: 0,
			pricingPerEvent: {
				actorChargeEvents: {
					'page-scraped': { eventTitle: 'Page scraped', eventDescription: '', eventPriceUsd: 0.002 },
				},
			},
		});
	});

	it('keeps every optional field it accepts, and normalizes the timestamps it is given', () => {
		const [info] = ok([
			ppe(
				{
					result: {
						eventTitle: 'Result',
						eventDescription: 'One result',
						eventPriceUsd: 0.01,
						isPrimaryEvent: true,
					},
					[ACTOR_START_EVENT_NAME]: { eventTitle: 'Start', eventPriceUsd: 0.005, isOneTimeEvent: true },
				},
				{
					createdAt: '2026-01-01T00:00:00Z',
					startedAt: '2026-02-01T00:00:00.000Z',
					apifyMarginPercentage: 0.2,
					reasonForChange: 'launch',
				},
			),
		]);
		expect(info.createdAt).toBe('2026-01-01T00:00:00.000Z');
		expect(info.startedAt).toBe('2026-02-01T00:00:00.000Z');
		expect(info.apifyMarginPercentage).toBe(0.2);
		expect(info.reasonForChange).toBe('launch');
		expect(info.pricingPerEvent?.actorChargeEvents.result?.isPrimaryEvent).toBe(true);
		expect(info.pricingPerEvent?.actorChargeEvents[ACTOR_START_EVENT_NAME]?.isOneTimeEvent).toBe(true);
	});

	it('accepts a tiered event price as long as the BRONZE tier is present', () => {
		const [info] = ok([
			ppe({
				result: {
					eventTitle: 'Result',
					eventTieredPricingUsd: {
						BRONZE: { tieredEventPriceUsd: 0.01 },
						GOLD: { tieredEventPriceUsd: 0.008 },
					},
				},
			}),
		]);
		expect(info.pricingPerEvent?.actorChargeEvents.result?.eventTieredPricingUsd).toEqual({
			BRONZE: { tieredEventPriceUsd: 0.01 },
			GOLD: { tieredEventPriceUsd: 0.008 },
		});
		expect(
			invalidMessage([
				ppe({ result: { eventTitle: 'R', eventTieredPricingUsd: { GOLD: { tieredEventPriceUsd: 1 } } } }),
			]),
		).toMatch(/BRONZE/);
	});

	it('accepts a FREE pricing and rejects PPE-only fields on it', () => {
		expect(ok([{ pricingModel: 'FREE' }])[0]?.pricingModel).toBe('FREE');
		expect(invalidMessage([{ pricingModel: 'FREE', pricingPerEvent: { actorChargeEvents: {} } }])).toMatch(
			/only valid with/,
		);
	});

	it('rejects the pricing models this runtime does not emulate, and unknown ones', () => {
		expect(invalidMessage([{ pricingModel: 'PRICE_PER_DATASET_ITEM' }])).toMatch(/not emulated/);
		expect(invalidMessage([{ pricingModel: 'FLAT_PRICE_PER_MONTH' }])).toMatch(/not emulated/);
		expect(invalidMessage([{ pricingModel: 'RENTAL' }])).toMatch(/must be one of/);
	});

	it('rejects a non-array, a non-object entry, unknown fields, and malformed values with a message naming the spot', () => {
		expect(invalidMessage({ pricingModel: 'FREE' })).toMatch(/must be a JSON array/);
		expect(invalidMessage([null])).toMatch(/pricingInfos\[0\] must be a JSON object/);
		expect(invalidMessage([{ pricingModel: 'FREE', foo: 1 }])).toMatch(/unknown field "foo"/);
		expect(invalidMessage([{ pricingModel: 'FREE', startedAt: 'yesterday' }])).toMatch(/ISO-8601/);
		expect(invalidMessage([{ pricingModel: 'FREE', apifyMarginPercentage: 2 }])).toMatch(/between 0 and 1/);
		expect(invalidMessage([{ pricingModel: 'PAY_PER_EVENT' }])).toMatch(/pricingPerEvent/);
		expect(invalidMessage([ppe({})])).toMatch(/at least one event/);
		expect(invalidMessage([ppe({ x: { eventPriceUsd: 1 } })])).toMatch(/"eventTitle"/);
		expect(invalidMessage([ppe({ x: { eventTitle: 'X' } })])).toMatch(/exactly one of/);
		expect(invalidMessage([ppe({ x: { eventTitle: 'X', eventPriceUsd: -1 } })])).toMatch(/>= 0/);
		expect(invalidMessage([ppe({ x: { eventTitle: 'X', eventPriceUsd: 1, price: 2 } })])).toMatch(
			/unknown field "price"/,
		);
		expect(invalidMessage([ppe({ x: { eventTitle: 'X', eventPriceUsd: 1, isOneTimeEvent: 'yes' } })])).toMatch(
			/must be a boolean/,
		);
	});
});

describe('effectivePricingInfo / resolveRunPricingInfo', () => {
	const older = ok([ppe({ a: { eventTitle: 'A', eventPriceUsd: 1 } }, { startedAt: '2026-01-01T00:00:00Z' })])[0]!;
	const newer = ok([ppe({ b: { eventTitle: 'B', eventPriceUsd: 2 } }, { startedAt: '2026-06-01T00:00:00Z' })])[0]!;
	const future = ok([{ pricingModel: 'FREE', startedAt: '2027-01-01T00:00:00Z' }])[0]!;

	it('picks the entry with the latest startedAt not after the date, ignoring a future one, regardless of array order', () => {
		expect(effectivePricingInfo([future, older, newer], NOW)).toBe(newer);
		expect(effectivePricingInfo([newer, older], new Date('2026-03-01T00:00:00Z'))).toBe(older);
		expect(effectivePricingInfo([future], NOW)).toBeUndefined();
		expect(effectivePricingInfo(undefined, NOW)).toBeUndefined();
		expect(effectivePricingInfo([], NOW)).toBeUndefined();
	});

	it('resolves tiered event prices to the BRONZE tier and copies flat ones through', () => {
		const [info] = ok([
			ppe({
				flat: { eventTitle: 'Flat', eventPriceUsd: 0.5, isOneTimeEvent: true },
				tiered: {
					eventTitle: 'Tiered',
					eventTieredPricingUsd: {
						BRONZE: { tieredEventPriceUsd: 0.3 },
						SILVER: { tieredEventPriceUsd: 0.2 },
					},
				},
			}),
		]);
		const resolved = resolveRunPricingInfo([info!], NOW);
		expect(isPayPerEvent(resolved)).toBe(true);
		expect(resolved?.pricingPerEvent?.actorChargeEvents).toEqual({
			flat: { eventTitle: 'Flat', eventDescription: '', eventPriceUsd: 0.5, isOneTimeEvent: true },
			tiered: { eventTitle: 'Tiered', eventDescription: '', eventPriceUsd: 0.3 },
		});
		expect(resolved).not.toHaveProperty('pricingPerEvent.actorChargeEvents.tiered.eventTieredPricingUsd');
	});

	it('a FREE pricing resolves without pricingPerEvent and is not pay-per-event', () => {
		const resolved = resolveRunPricingInfo([ok([{ pricingModel: 'FREE' }])[0]!], NOW);
		expect(resolved?.pricingModel).toBe('FREE');
		expect(resolved).not.toHaveProperty('pricingPerEvent');
		expect(isPayPerEvent(resolved)).toBe(false);
	});
});

describe('initialChargedEventCounts', () => {
	it('is undefined for a free run, zeros for every priced event of a PPE run', () => {
		expect(initialChargedEventCounts(undefined, 1024)).toBeUndefined();
		const resolved = resolveRunPricingInfo(
			ok([ppe({ a: { eventTitle: 'A', eventPriceUsd: 1 }, b: { eventTitle: 'B', eventPriceUsd: 1 } })]),
			NOW,
		);
		expect(initialChargedEventCounts(resolved, 1024)).toEqual({ a: 0, b: 0 });
	});

	it('pre-charges the synthetic start event once per whole GB of memory, at least once', () => {
		const resolved = resolveRunPricingInfo(
			ok([
				ppe({
					[ACTOR_START_EVENT_NAME]: { eventTitle: 'Start', eventPriceUsd: 0.01 },
					a: { eventTitle: 'A', eventPriceUsd: 1 },
				}),
			]),
			NOW,
		);
		expect(initialChargedEventCounts(resolved, 512)).toEqual({ [ACTOR_START_EVENT_NAME]: 1, a: 0 });
		expect(initialChargedEventCounts(resolved, 4096)).toEqual({ [ACTOR_START_EVENT_NAME]: 4, a: 0 });
		expect(initialChargedEventCounts(resolved, 4095)).toEqual({ [ACTOR_START_EVENT_NAME]: 3, a: 0 });
	});
});

describe('validatePricingInfosUpdate (the append-only history)', () => {
	const existing = ok([
		ppe({ result: { eventTitle: 'Result', eventPriceUsd: 0.01 } }, { startedAt: '2026-01-01T00:00:00.000Z' }),
	]);

	function update(raw: unknown, current = existing) {
		return validatePricingInfosUpdate(raw, current, NOW);
	}

	function rejection(raw: unknown, current = existing): { type?: string; message: string } {
		const result = update(raw, current);
		if (result.kind !== 'invalid') throw new Error('expected the update to be rejected');
		return { type: result.type, message: result.message };
	}

	it('accepts resending the existing entries unchanged, and appending one that starts later', () => {
		expect(update(existing).kind).toBe('ok');
		const appended = update([...existing, { pricingModel: 'FREE', startedAt: '2026-06-01T00:00:00.000Z' }]);
		if (appended.kind !== 'ok') throw new Error(appended.message);
		expect(appended.pricingInfos).toHaveLength(2);
		expect(appended.pricingInfos[1]?.pricingModel).toBe('FREE');
	});

	it('refuses to drop an entry, so a price a run was charged at stays readable', () => {
		expect(rejection([])).toEqual({
			type: 'cannot-remove-pricing-info',
			message: expect.stringContaining('FREE'),
		});
	});

	it('refuses more than one new entry at a time', () => {
		expect(
			rejection([
				...existing,
				{ pricingModel: 'FREE', startedAt: '2026-06-01T00:00:00.000Z' },
				{ pricingModel: 'FREE', startedAt: '2026-07-01T00:00:00.000Z' },
			]).type,
		).toBe('cannot-add-multiple-pricing-infos');
	});

	it('refuses an edit to an entry already stored, whichever field it touches', () => {
		const edited = [
			{
				...existing[0]!,
				pricingPerEvent: { actorChargeEvents: { result: { eventTitle: 'Result', eventPriceUsd: 0.02 } } },
			},
		];
		expect(rejection(edited).type).toBe('incorrect-pricing-modifier-prefix');
		expect(rejection([{ ...existing[0]!, startedAt: '2026-01-02T00:00:00.000Z' }]).type).toBe(
			'incorrect-pricing-modifier-prefix',
		);
	});

	it('names the field that differs, so the usual "rebuilt from a file" mistake is visible', () => {
		expect(rejection([{ ...existing[0]!, startedAt: '2026-01-02T00:00:00.000Z' }]).message).toContain(
			'at "startedAt" (sent "2026-01-02T00:00:00.000Z", stored "2026-01-01T00:00:00.000Z")',
		);
		// An entry sent without the timestamps the stored one carries: they are stamped with the time of
		// the request, so `createdAt` is the first thing that cannot match.
		expect(rejection([ppe({ result: { eventTitle: 'Result', eventPriceUsd: 0.01 } })]).message).toContain(
			'at "createdAt"',
		);
		expect(
			rejection([
				{
					...existing[0]!,
					pricingPerEvent: { actorChargeEvents: { result: { eventTitle: 'Result', eventPriceUsd: 0.02 } } },
				},
			]).message,
		).toContain('at "pricingPerEvent.actorChargeEvents.result.eventPriceUsd" (sent 0.02, stored 0.01)');
	});

	it('refuses a new entry that starts at or before one already stored', () => {
		expect(rejection([...existing, { pricingModel: 'FREE', startedAt: '2025-12-01T00:00:00.000Z' }]).type).toBe(
			'cannot-add-pricing-info-that-alters-past',
		);
		expect(rejection([...existing, { pricingModel: 'FREE', startedAt: existing[0]!.startedAt }]).type).toBe(
			'cannot-add-pricing-info-that-alters-past',
		);
	});

	it('allows one entry starting in the future, never a second', () => {
		const future = update([...existing, { pricingModel: 'FREE', startedAt: '2027-01-01T00:00:00.000Z' }]);
		if (future.kind !== 'ok') throw new Error(future.message);
		expect(
			rejection(
				[...future.pricingInfos, { pricingModel: 'FREE', startedAt: '2027-02-01T00:00:00.000Z' }],
				future.pricingInfos,
			).type,
		).toBe('cannot-add-second-future-pricing-info');
	});

	it('is the plain validation for an Actor that has no pricing yet', () => {
		expect(update([], []).kind).toBe('ok');
		expect(update([ppe({ result: { eventTitle: 'Result', eventPriceUsd: 0.01 } })], []).kind).toBe('ok');
	});
});

describe('the pricing the bundled samples ship', () => {
	// The README tells a developer to PUT these files at the Actor verbatim, so what the runtime would
	// answer to that is worth knowing here rather than from a 400 at the terminal.
	it.each(['samples/actor_ts', 'samples/actor_py'])(
		'%s/pricing.json is accepted and prices both synthetic events',
		(sample) => {
			const { pricingInfos } = JSON.parse(readFileSync(join(REPO_ROOT, sample, 'pricing.json'), 'utf8')) as {
				pricingInfos: unknown;
			};

			const resolved = resolveRunPricingInfo(ok(pricingInfos), NOW);
			if (!isPayPerEvent(resolved)) throw new Error('expected the sample to be priced per event');
			expect(Object.keys(resolved.pricingPerEvent.actorChargeEvents).sort()).toEqual([
				ACTOR_START_EVENT_NAME,
				DEFAULT_DATASET_ITEM_EVENT_NAME,
				'crawl-finished',
				'page-scraped',
			]);

			// Neither synthetic event is ever charged by the sample's own code: the start event is
			// pre-charged per whole GB, the item event by the dataset route on every push.
			expect(initialChargedEventCounts(resolved, 2048)?.[ACTOR_START_EVENT_NAME]).toBe(2);
		},
	);
});

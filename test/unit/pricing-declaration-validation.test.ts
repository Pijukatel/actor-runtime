/**
 * Pure-function coverage for `validatePricingInfoShape` (`services/pricing-declaration.ts`) - the same
 * "one arm per test" convention `test/unit/dev-folder-validation.test.ts` uses for its sibling validator.
 * `test/integration/pricing-and-charging.test.ts`'s "rejects a malformed pricing declaration" and
 * "rejects a pricing declaration with a negative eventPriceUsd" tests already cover the
 * missing-`pricingModel` and missing/negative-`eventPriceUsd` arms end to end through the HTTP route;
 * this file fills in every rejection arm those two tests don't reach.
 */
import { describe, expect, it } from 'vitest';

import { validatePricingInfoShape } from '../../src/services/pricing-declaration.js';

const VALID_BODY = {
	pricingModel: 'PAY_PER_EVENT',
	pricingPerEvent: {
		actorChargeEvents: {
			'page-scraped': { eventTitle: 'Page scraped', eventDescription: 'One page scraped', eventPriceUsd: 0.001 },
		},
	},
};

describe('validatePricingInfoShape', () => {
	it('accepts a well-shaped PAY_PER_EVENT body', () => {
		expect(validatePricingInfoShape(VALID_BODY)).toBeNull();
	});

	// `eventDescription` is required, not optional - it mirrors apify-core's real
	// `ActorChargeDefinitionCommon` and the Python SDK's pydantic model, both of which require it
	// (`ChargeEventDefinition`'s own doc comment in `src/pricing.ts`).
	it('rejects an event definition missing eventDescription', () => {
		expect(
			validatePricingInfoShape({
				pricingModel: 'PAY_PER_EVENT',
				pricingPerEvent: { actorChargeEvents: { x: { eventTitle: 'X', eventPriceUsd: 0 } } },
			}),
		).toMatch(/actorChargeEvents/);
	});

	it('rejects an empty-string eventDescription', () => {
		expect(
			validatePricingInfoShape({
				pricingModel: 'PAY_PER_EVENT',
				pricingPerEvent: {
					actorChargeEvents: { x: { eventTitle: 'X', eventPriceUsd: 0, eventDescription: '' } },
				},
			}),
		).toMatch(/actorChargeEvents/);
	});

	it('rejects a non-object body (a plain string)', () => {
		expect(validatePricingInfoShape('not an object')).toMatch(/object/i);
	});

	it('rejects a null body', () => {
		expect(validatePricingInfoShape(null)).toMatch(/object/i);
	});

	it('rejects an array body', () => {
		expect(validatePricingInfoShape([VALID_BODY])).toMatch(/object/i);
	});

	it('rejects a wrong-but-present pricingModel (e.g. "FREE")', () => {
		expect(validatePricingInfoShape({ ...VALID_BODY, pricingModel: 'FREE' })).toMatch(/pricingModel/i);
	});

	it('rejects pricingPerEvent.actorChargeEvents being an array rather than an object', () => {
		expect(
			validatePricingInfoShape({
				pricingModel: 'PAY_PER_EVENT',
				pricingPerEvent: { actorChargeEvents: [{ eventTitle: 'X', eventPriceUsd: 0 }] },
			}),
		).toMatch(/actorChargeEvents/);
	});

	it('rejects pricingPerEvent.actorChargeEvents being a non-object (a string)', () => {
		expect(
			validatePricingInfoShape({ pricingModel: 'PAY_PER_EVENT', pricingPerEvent: { actorChargeEvents: 'nope' } }),
		).toMatch(/actorChargeEvents/);
	});

	it('rejects pricingPerEvent.actorChargeEvents being entirely absent', () => {
		expect(validatePricingInfoShape({ pricingModel: 'PAY_PER_EVENT', pricingPerEvent: {} })).toMatch(
			/actorChargeEvents/,
		);
	});

	it('rejects an empty event name', () => {
		expect(
			validatePricingInfoShape({
				pricingModel: 'PAY_PER_EVENT',
				pricingPerEvent: { actorChargeEvents: { '': { eventTitle: 'X', eventPriceUsd: 0 } } },
			}),
		).toMatch(/event name/i);
	});

	it('rejects a non-string eventDescription', () => {
		expect(
			validatePricingInfoShape({
				pricingModel: 'PAY_PER_EVENT',
				pricingPerEvent: {
					actorChargeEvents: { x: { eventTitle: 'X', eventPriceUsd: 0, eventDescription: 42 } },
				},
			}),
		).toMatch(/actorChargeEvents/);
	});
});

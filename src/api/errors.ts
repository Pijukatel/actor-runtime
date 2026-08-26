/** The `{ "error": { "type", "message" } }` shape apify-client-js expects, keyed by `type`. */
export class ApiError extends Error {
	constructor(
		public readonly status: number,
		public readonly type: string,
		message: string,
	) {
		super(message);
	}
}

/**
 * apify-client-js keys its "return `undefined` instead of throwing" behaviour off this exact type -
 * `apify push`'s "does this Actor exist" probe depends on it.
 */
export function recordNotFound(message = 'Record was not found'): ApiError {
	return new ApiError(404, 'record-not-found', message);
}

export function invalidRequest(message: string): ApiError {
	return new ApiError(400, 'invalid-request', message);
}

/**
 * Matches the real Apify platform exactly: `DELETE /v2/actor-runs/:runId` on a non-terminal run is
 * rejected rather than aborted-then-deleted (`apify-core`'s `errors.runs.cannotRemoveRunningRun()`,
 * `src/packages/errors/src/errors/runs.ts:10-15` - `newMeteorishError('cannot-remove-running-run', ...,
 * 400)`), so this runtime does the same instead of silently leaking the run's container.
 */
export function cannotRemoveRunningRun(): ApiError {
	return new ApiError(
		400,
		'cannot-remove-running-run',
		'It is not possible to delete a run that has not finished yet.',
	);
}

/**
 * Matches the real Apify platform exactly: `DELETE /v2/actor-builds/:buildId` on a non-terminal build
 * is rejected rather than aborted-then-deleted (`apify-core`'s `errors.api.deletingUnfinishedBuild()`,
 * `src/packages/errors/src/errors/api.ts:217-218` - `newMeteorishError('deleting-unfinished-build', ...,
 * 400)`).
 */
export function deletingUnfinishedBuild(): ApiError {
	return new ApiError(400, 'deleting-unfinished-build', 'Deleting unfinished build while running is not allowed');
}

/**
 * Matches the real Apify platform exactly: `POST /v2/actor-runs/:runId/charge` on a run whose Actor has
 * no `PAY_PER_EVENT` pricing declared (`apify-core`'s `ensurePricingInfoCanBeCharged`,
 * `src/api/src/lib/paid_actors_helpers.ts:89-101` - `errors.paidActors.cannotChargeNonPayPerEventActor()`).
 * A charge naming an event that *is* declared just not in this pricing (or in no
 * pricing at all) still gets this type; an event name that isn't a key in an otherwise-PPE run's
 * declared events is `recordNotFound()` instead (`api.md`).
 */
export function cannotChargeNonPayPerEventActor(): ApiError {
	return new ApiError(
		405,
		'cannot-charge-non-pay-per-event-actor',
		'This Actor run does not have pay-per-event pricing, so it cannot be charged.',
	);
}

/**
 * Matches the real Apify platform exactly: `POST /v2/actor-runs/:runId/charge` with an `eventName`
 * starting with `"apify-"` (the reserved prefix for synthetic, platform-owned events such as
 * `apify-actor-start`) is rejected outright - checked before the run is even looked up
 * (`apify-core`'s `idempotentChargeUserForEvent`, `src/api/src/lib/run_charging_service.ts:566-569` -
 * `errors.paidActors.cannotChargeApifyEvent(eventName)`, itself
 * `src/packages/errors/src/errors/paid_actors.ts:152-153` - `newMeteorishError('cannot-charge-apify-event',
 * ..., 405)`). An SDK never sends this - only the platform (or a hand-crafted request) would.
 */
export function cannotChargeApifyEvent(eventName: string): ApiError {
	return new ApiError(
		405,
		'cannot-charge-apify-event',
		`Event "${eventName}" is system event and cannot be charged.`,
	);
}

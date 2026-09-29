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
 * The catch-all's own `404` `not-found`, for a route that matches a whole path family and has to reject an
 * off-spec sub-path itself (`routes/last-run.ts`). Not `record-not-found`: nothing was looked up, and the
 * two types are gated by different fallback toggles.
 */
export function endpointNotFound(message: string): ApiError {
	return new ApiError(404, 'not-found', message);
}

/** Matches the real platform's rejection of an input its Actor's input schema does not accept
 * (`@apify-packages/errors`'s `actor.inputNotValid` and its neighbours), message included. */
export function invalidInput(message: string): ApiError {
	return new ApiError(400, 'invalid-input', message);
}

/** Matches the real platform's `actor.invalidInputSchema`. */
export function invalidInputSchema(message: string): ApiError {
	return new ApiError(400, 'invalid-input-schema', message);
}

/**
 * Matches the real Apify platform exactly: `DELETE /v2/actor-runs/:runId` on a non-terminal run is
 * rejected rather than aborted-then-deleted (the public API answers 400 `cannot-remove-running-run`),
 * so this runtime does the same instead of silently leaking the run's container.
 */
export function cannotRemoveRunningRun(): ApiError {
	return new ApiError(
		400,
		'cannot-remove-running-run',
		'It is not possible to delete a run that has not finished yet.',
	);
}

/** Matches the real platform's rejection of reboot/migrate on a finished run (the public API answers
 * 403 `job-finished`). */
export function jobAlreadyFinished(): ApiError {
	return new ApiError(403, 'job-finished', 'Actor job is already finished.');
}

/**
 * Matches the real Apify platform exactly: `DELETE /v2/actor-builds/:buildId` on a non-terminal build
 * is rejected rather than aborted-then-deleted (the public API answers 400 `deleting-unfinished-build`).
 */
export function deletingUnfinishedBuild(): ApiError {
	return new ApiError(400, 'deleting-unfinished-build', 'Deleting unfinished build while running is not allowed');
}

export function cannotChargeNonPayPerEventActor(): ApiError {
	return new ApiError(
		405,
		'cannot-charge-non-pay-per-event-actor',
		'You cannot charge events for an Actor that is not paid per event.',
	);
}

/**
 * Matches the platform: pricing is never part of creating an Actor (the public API answers 403
 * `operation-not-allowed`), only of updating one that already exists.
 */
export function cannotSetPricingOnCreate(): ApiError {
	return new ApiError(
		403,
		'operation-not-allowed',
		'Pricing cannot be set while creating an Actor - set it with PUT /v2/actors/:actorId afterwards.',
	);
}

/** The `apify-` prefixed events are charged by the runtime itself, never through the charge endpoint. */
export function cannotChargeApifyEvent(eventName: string): ApiError {
	return new ApiError(
		405,
		'cannot-charge-apify-event',
		`Event "${eventName}" is system event and cannot be charged.`,
	);
}

/** Matches the real platform's `tools.schemaValidationUserFriendlyError`, e.g. for a malformed env var. */
export function schemaValidation(message: string): ApiError {
	return new ApiError(400, 'schema-validation', message);
}

/** Matches the real platform's `actor.envVarAlreadyExists`. */
export function envVarAlreadyExists(): ApiError {
	return new ApiError(403, 'env-var-already-exists', 'Environment variable with this name already exists');
}

/** Matches the real platform's `actor.cannotRenameEnvVar`. */
export function cannotRenameEnvVar(): ApiError {
	return new ApiError(
		403,
		'cannot-rename-env-var',
		'Environment variable cannot be renamed. An environment variable with the given new name already exists.',
	);
}

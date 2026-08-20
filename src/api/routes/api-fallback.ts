/**
 * `GET`/`POST /actor-runtime/api-fallback` (`api.md`'s "Upstream fallback" section) - mounted on the
 * same `/actor-runtime` sub-router `dev-folder.ts` already registers on, so it shares that router's
 * single `auth()` registration (`server.ts`) rather than adding its own, and is served at both mounts
 * (`/actor-runtime/api-fallback` and `/v2/actor-runtime/api-fallback`) the same way the dev-folder route
 * is.
 *
 * `GET` reads the current toggle state; `POST` accepts a **partial** body - either
 * `fallbackUnimplementedEnabled`, `fallbackNotFoundEnabled`, or both - and merges it into the existing
 * state via `setApiFallbackState`, leaving any field the body didn't mention untouched. `upstreamBaseUrl`
 * is reported on every response but is never itself a settable field.
 */
import type { Router } from 'express';

import { sendData } from '../envelope.js';
import { invalidRequest } from '../errors.js';
import { h, jsonBody } from '../handler.js';
import { getApiFallbackState, setApiFallbackState, type ApiFallbackState } from '../../services/api-fallback.js';
import { upstreamApiBaseUrl } from '../../services/identity-resolution.js';

const SETTABLE_FIELDS = new Set<keyof ApiFallbackState>(['fallbackUnimplementedEnabled', 'fallbackNotFoundEnabled']);

function respondWithState(): ApiFallbackState & { upstreamBaseUrl: string } {
	return { ...getApiFallbackState(), upstreamBaseUrl: upstreamApiBaseUrl() };
}

/** Parses and validates a `POST` body into a `setApiFallbackState` patch, throwing `invalid-request` for
 * every malformed shape the spec names: not a JSON object (array, string, number, `null`), present but
 * empty (`{}`), an unknown key, or a present key whose value isn't a boolean. Never partially applies a
 * rejected body - the caller only ever sees the merged state after every field in the body has passed
 * this check. */
function parsePatch(raw: unknown): Partial<ApiFallbackState> {
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
		throw invalidRequest(
			'Request body must be a JSON object with fallbackUnimplementedEnabled and/or fallbackNotFoundEnabled',
		);
	}

	const entries = Object.entries(raw as Record<string, unknown>);
	if (entries.length === 0) {
		throw invalidRequest(
			'Request body must set at least one of fallbackUnimplementedEnabled or fallbackNotFoundEnabled',
		);
	}

	const patch: Partial<ApiFallbackState> = {};
	for (const [key, value] of entries) {
		if (!SETTABLE_FIELDS.has(key as keyof ApiFallbackState)) {
			throw invalidRequest(`Unknown field "${key}"`);
		}
		if (typeof value !== 'boolean') {
			throw invalidRequest(`Field "${key}" must be a boolean`);
		}
		patch[key as keyof ApiFallbackState] = value;
	}
	return patch;
}

/** Mounts the `/api-fallback` routes onto `router`, matching every other route module's
 * `mount*(router, ...): void` convention. `router` is expected to already have `auth()` registered on
 * it by the caller (`server.ts`), same as `mountDevFolder`. */
export function mountApiFallback(router: Router): void {
	router.get(
		'/api-fallback',
		h(async (_req, res) => {
			sendData(res, respondWithState());
		}),
	);

	router.post(
		'/api-fallback',
		h(async (req, res) => {
			const patch = parsePatch(jsonBody<unknown>(req));
			setApiFallbackState(patch);
			sendData(res, respondWithState());
		}),
	);
}

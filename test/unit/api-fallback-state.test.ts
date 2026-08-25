/**
 * Pure-function/state coverage for `services/api-fallback.ts` that needs no HTTP server at all: the
 * default state, the merge-in setter's partiality, and the test-reset helper. `upstreamApiBaseUrl()`'s
 * env-var override and trailing-slash trim are covered here too, even though the function itself lives
 * in `services/identity-resolution.ts` (the fallback module reuses it rather than defining its own) -
 * this is the fallback-relevant behavior (`<upstreamApiBaseUrl()><req.originalUrl>` never doubling a
 * `//`), so it stays exercised alongside the rest of this module's state. The eligibility mapping and
 * replay/relay behaviour (`attemptFallback`) need a running server and a stub upstream - covered by
 * `test/integration/api-fallback.test.ts`.
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
	getApiFallbackState,
	resetApiFallbackStateForTests,
	setApiFallbackState,
} from '../../src/services/api-fallback.js';
import { upstreamApiBaseUrl } from '../../src/services/identity-resolution.js';

describe('api-fallback state', () => {
	afterEach(() => {
		resetApiFallbackStateForTests();
		delete process.env.APIFY_UPSTREAM_API_BASE_URL;
	});

	it('both toggles default to false', () => {
		expect(getApiFallbackState()).toEqual({
			fallbackUnimplementedEnabled: false,
			fallbackNotFoundEnabled: false,
		});
	});

	it('setApiFallbackState merges a partial patch, leaving the other field untouched', () => {
		setApiFallbackState({ fallbackUnimplementedEnabled: true });
		expect(getApiFallbackState()).toEqual({
			fallbackUnimplementedEnabled: true,
			fallbackNotFoundEnabled: false,
		});

		setApiFallbackState({ fallbackNotFoundEnabled: true });
		expect(getApiFallbackState()).toEqual({
			fallbackUnimplementedEnabled: true,
			fallbackNotFoundEnabled: true,
		});

		setApiFallbackState({ fallbackUnimplementedEnabled: false });
		expect(getApiFallbackState()).toEqual({
			fallbackUnimplementedEnabled: false,
			fallbackNotFoundEnabled: true,
		});
	});

	it('setApiFallbackState returns the merged state', () => {
		const result = setApiFallbackState({ fallbackUnimplementedEnabled: true });
		expect(result).toEqual({ fallbackUnimplementedEnabled: true, fallbackNotFoundEnabled: false });
	});

	it('getApiFallbackState returns a fresh copy each call, not a live reference', () => {
		const first = getApiFallbackState();
		first.fallbackUnimplementedEnabled = true;
		expect(getApiFallbackState().fallbackUnimplementedEnabled).toBe(false);
	});

	it('resetApiFallbackStateForTests restores both toggles to false regardless of how they were set', () => {
		setApiFallbackState({ fallbackUnimplementedEnabled: true, fallbackNotFoundEnabled: true });
		resetApiFallbackStateForTests();
		expect(getApiFallbackState()).toEqual({
			fallbackUnimplementedEnabled: false,
			fallbackNotFoundEnabled: false,
		});
	});

	it('upstreamApiBaseUrl defaults to the real Apify platform when no env var is set', () => {
		delete process.env.APIFY_UPSTREAM_API_BASE_URL;
		expect(upstreamApiBaseUrl()).toBe('https://api.apify.com');
	});

	it('upstreamApiBaseUrl reflects APIFY_UPSTREAM_API_BASE_URL when set', () => {
		process.env.APIFY_UPSTREAM_API_BASE_URL = 'http://127.0.0.1:9999';
		expect(upstreamApiBaseUrl()).toBe('http://127.0.0.1:9999');
	});

	it('upstreamApiBaseUrl trims a trailing slash (or several) so replay never doubles it', () => {
		process.env.APIFY_UPSTREAM_API_BASE_URL = 'http://127.0.0.1:9999/';
		expect(upstreamApiBaseUrl()).toBe('http://127.0.0.1:9999');

		process.env.APIFY_UPSTREAM_API_BASE_URL = 'http://127.0.0.1:9999///';
		expect(upstreamApiBaseUrl()).toBe('http://127.0.0.1:9999');
	});
});

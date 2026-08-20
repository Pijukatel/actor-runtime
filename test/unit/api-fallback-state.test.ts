/**
 * Pure-function/state coverage for `services/api-fallback.ts` that needs no HTTP server at all: the
 * default state, the merge-in setter's partiality, the test-reset helper, and `upstreamBaseUrl()`'s
 * env-var override and trailing-slash trim. The eligibility mapping and replay/relay behaviour
 * (`attemptFallback`) need a running server and a stub upstream - covered by
 * `test/integration/api-fallback.test.ts`.
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
	getApiFallbackState,
	resetApiFallbackStateForTests,
	setApiFallbackState,
	upstreamBaseUrl,
} from '../../src/services/api-fallback.js';

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

	it('upstreamBaseUrl defaults to the real Apify platform when no env var is set', () => {
		delete process.env.APIFY_UPSTREAM_API_BASE_URL;
		expect(upstreamBaseUrl()).toBe('https://api.apify.com');
	});

	it('upstreamBaseUrl reflects APIFY_UPSTREAM_API_BASE_URL when set', () => {
		process.env.APIFY_UPSTREAM_API_BASE_URL = 'http://127.0.0.1:9999';
		expect(upstreamBaseUrl()).toBe('http://127.0.0.1:9999');
	});

	it('upstreamBaseUrl trims a trailing slash (or several) so replay never doubles it', () => {
		process.env.APIFY_UPSTREAM_API_BASE_URL = 'http://127.0.0.1:9999/';
		expect(upstreamBaseUrl()).toBe('http://127.0.0.1:9999');

		process.env.APIFY_UPSTREAM_API_BASE_URL = 'http://127.0.0.1:9999///';
		expect(upstreamBaseUrl()).toBe('http://127.0.0.1:9999');
	});
});

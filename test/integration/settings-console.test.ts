/**
 * Console-side coverage for the upstream API fallback (`console.md`'s "Settings page" section): the
 * `/settings` page itself, its two-checkbox form, and the state indicator that every other console page
 * shows in its header nav. API-side coverage (the toggle endpoint, eligibility, relay, fail-closed) lives
 * in `test/integration/api-fallback.test.ts`.
 */
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import axios from 'axios';

import { createConsoleServer } from '../../src/console/server.js';
import { setApiFallbackState } from '../../src/services/api-fallback.js';
import { startTestServer, type TestServerHandle } from './helpers/test-server.js';

describe('console: /settings page and the fallback nav indicator', () => {
	let server: TestServerHandle;
	let consoleServer: Server;
	let consoleBaseUrl: string;

	beforeEach(async () => {
		server = await startTestServer();
		const app = createConsoleServer({ driver: server.driver });
		consoleServer = await new Promise((resolve) => {
			const s = app.listen(0, () => resolve(s));
		});
		consoleBaseUrl = `http://127.0.0.1:${(consoleServer.address() as AddressInfo).port}`;

		// Several assertions below expect the reported `upstreamBaseUrl` to read as the real,
		// unconfigured default (`https://api.apify.com`), so this file never points
		// `APIFY_UPSTREAM_API_BASE_URL` anywhere. But the tests below still authenticate against the API
		// server with `server.token`, which runs that token's one-time identity probe against whichever
		// upstream is configured *at the moment it runs* - warm it up now, against a guaranteed-dead
		// address, and restore the (absent) env var immediately afterward, so the probe fails and caches
		// instantly with zero real egress.
		const savedUpstreamUrl = process.env.APIFY_UPSTREAM_API_BASE_URL;
		process.env.APIFY_UPSTREAM_API_BASE_URL = 'http://127.0.0.1:1';
		await axios.get(`${server.baseUrl}/v2/users/me`, {
			headers: { Authorization: `Bearer ${server.token}` },
			validateStatus: () => true,
		});
		if (savedUpstreamUrl === undefined) delete process.env.APIFY_UPSTREAM_API_BASE_URL;
		else process.env.APIFY_UPSTREAM_API_BASE_URL = savedUpstreamUrl;
	});

	afterEach(async () => {
		await new Promise<void>((resolve) => consoleServer.close(() => resolve()));
		// `server.close()` itself resets the toggle state (`helpers/test-server.ts`) - nothing to do here.
		await server.close();
	});

	it('GET /settings renders both toggles and upstreamBaseUrl, matching the API state, plus the warning line', async () => {
		const res = await axios.get(`${consoleBaseUrl}/settings`);
		expect(res.status).toBe(200);
		expect(res.data).toContain('fallbackUnimplementedEnabled');
		expect(res.data).toContain('fallbackNotFoundEnabled');
		expect(res.data).toContain('upstreamBaseUrl');
		expect(res.data).toContain('https://api.apify.com');
		expect(res.data).toMatch(/forwards.*(Apify )?token/i);
	});

	it('flipping a toggle via the API and reloading /settings updates the rendered values with no restart', async () => {
		const before = await axios.get(`${consoleBaseUrl}/settings`);
		expect(before.data).toMatch(/<dt>fallbackUnimplementedEnabled<\/dt>\s*<dd>false<\/dd>/);

		setApiFallbackState({ fallbackUnimplementedEnabled: true });

		const after = await axios.get(`${consoleBaseUrl}/settings`);
		expect(after.data).toMatch(/<dt>fallbackUnimplementedEnabled<\/dt>\s*<dd>true<\/dd>/);
	});

	it('renders one form with two checkboxes and a single submit', async () => {
		const res = await axios.get(`${consoleBaseUrl}/settings`);
		expect(res.data).toContain('<form method="post" action="/settings">');
		expect(res.data).toContain('name="fallbackUnimplementedEnabled"');
		expect(res.data).toContain('name="fallbackNotFoundEnabled"');
		expect((res.data.match(/<form/g) ?? []).length).toBe(1);
		expect((res.data.match(/<button type="submit">/g) ?? []).length).toBe(1);
	});

	it('unchecking only one checkbox and submitting turns that one off while leaving the other on - an absent box is read as false, not "unchanged"', async () => {
		setApiFallbackState({ fallbackUnimplementedEnabled: true, fallbackNotFoundEnabled: true });

		// Submits only `fallbackNotFoundEnabled=on` - the unimplemented checkbox is unchecked, so a real
		// browser would simply omit it from the body.
		const submit = await axios.post(`${consoleBaseUrl}/settings`, 'fallbackNotFoundEnabled=on', {
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			maxRedirects: 0,
			validateStatus: () => true,
		});
		expect(submit.status).toBeGreaterThanOrEqual(300);
		expect(submit.status).toBeLessThan(400);
		expect(submit.headers.location).toBe('/settings');

		const stateRes = await axios.get(`${server.baseUrl}/actor-runtime/api-fallback`, {
			headers: { Authorization: `Bearer ${server.token}` },
		});
		expect(stateRes.data.data).toEqual({
			fallbackUnimplementedEnabled: false,
			fallbackNotFoundEnabled: true,
			upstreamBaseUrl: 'https://api.apify.com',
		});
	});

	it('rejects a cross-site form submission (Sec-Fetch-Site: cross-site) with 403, and never changes the toggle state', async () => {
		const before = await axios.get(`${server.baseUrl}/actor-runtime/api-fallback`, {
			headers: { Authorization: `Bearer ${server.token}` },
		});

		const submit = await axios.post(
			`${consoleBaseUrl}/settings`,
			'fallbackUnimplementedEnabled=on&fallbackNotFoundEnabled=on',
			{
				headers: {
					'Content-Type': 'application/x-www-form-urlencoded',
					'Sec-Fetch-Site': 'cross-site',
				},
				maxRedirects: 0,
				validateStatus: () => true,
			},
		);
		expect(submit.status).toBe(403);

		const after = await axios.get(`${server.baseUrl}/actor-runtime/api-fallback`, {
			headers: { Authorization: `Bearer ${server.token}` },
		});
		expect(after.data).toEqual(before.data);
	});

	it("still accepts the submission when Sec-Fetch-Site is same-origin (the real shape a browser sends for this page's own form) or absent entirely (older browsers, non-browser callers)", async () => {
		for (const site of ['same-origin', 'none', undefined]) {
			setApiFallbackState({ fallbackUnimplementedEnabled: false, fallbackNotFoundEnabled: false });
			const submit = await axios.post(`${consoleBaseUrl}/settings`, 'fallbackUnimplementedEnabled=on', {
				headers: {
					'Content-Type': 'application/x-www-form-urlencoded',
					...(site ? { 'Sec-Fetch-Site': site } : {}),
				},
				maxRedirects: 0,
				validateStatus: () => true,
			});
			expect(submit.status).toBe(302);

			const stateRes = await axios.get(`${server.baseUrl}/actor-runtime/api-fallback`, {
				headers: { Authorization: `Bearer ${server.token}` },
			});
			expect(stateRes.data.data.fallbackUnimplementedEnabled).toBe(true);
		}
	});

	it('submitting both checkboxes checked turns both on, landing on the shared toggle state (not a console-local copy)', async () => {
		const submit = await axios.post(
			`${consoleBaseUrl}/settings`,
			'fallbackUnimplementedEnabled=on&fallbackNotFoundEnabled=on',
			{
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				maxRedirects: 0,
				validateStatus: () => true,
			},
		);
		expect(submit.headers.location).toBe('/settings');

		const stateRes = await axios.get(`${server.baseUrl}/v2/actor-runtime/api-fallback`, {
			headers: { Authorization: `Bearer ${server.token}` },
		});
		expect(stateRes.data.data.fallbackUnimplementedEnabled).toBe(true);
		expect(stateRes.data.data.fallbackNotFoundEnabled).toBe(true);
	});

	it('submitting with neither checkbox present turns both off', async () => {
		setApiFallbackState({ fallbackUnimplementedEnabled: true, fallbackNotFoundEnabled: true });

		const submit = await axios.post(`${consoleBaseUrl}/settings`, '', {
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			maxRedirects: 0,
			validateStatus: () => true,
		});
		expect(submit.headers.location).toBe('/settings');

		const stateRes = await axios.get(`${server.baseUrl}/actor-runtime/api-fallback`, {
			headers: { Authorization: `Bearer ${server.token}` },
		});
		expect(stateRes.data.data).toEqual({
			fallbackUnimplementedEnabled: false,
			fallbackNotFoundEnabled: false,
			upstreamBaseUrl: 'https://api.apify.com',
		});
	});

	describe('the nav indicator, on every page, for all four toggle combinations', () => {
		const combinations: Array<[boolean, boolean]> = [
			[false, false],
			[true, false],
			[false, true],
			[true, true],
		];

		const pages = ['/actors', '/datasets', '/settings'];

		for (const [unimplementedEnabled, notFoundEnabled] of combinations) {
			it(`renders "unimplemented: ${unimplementedEnabled ? 'on' : 'off'}, not-found: ${notFoundEnabled ? 'on' : 'off'}" on ${pages.join(', ')}`, async () => {
				setApiFallbackState({
					fallbackUnimplementedEnabled: unimplementedEnabled,
					fallbackNotFoundEnabled: notFoundEnabled,
				});
				const expected = `Settings — fallback (unimplemented: ${unimplementedEnabled ? 'on' : 'off'}, not-found: ${notFoundEnabled ? 'on' : 'off'})`;

				for (const page of pages) {
					const res = await axios.get(`${consoleBaseUrl}${page}`);
					expect(res.status).toBe(200);
					expect(res.data).toContain(expected);
				}
			});
		}

		it('the mixed states render distinctly from both-on and both-off (no collapse to a single on/off word)', async () => {
			setApiFallbackState({ fallbackUnimplementedEnabled: true, fallbackNotFoundEnabled: false });
			const mixedA = (await axios.get(`${consoleBaseUrl}/actors`)).data as string;

			setApiFallbackState({ fallbackUnimplementedEnabled: false, fallbackNotFoundEnabled: true });
			const mixedB = (await axios.get(`${consoleBaseUrl}/actors`)).data as string;

			setApiFallbackState({ fallbackUnimplementedEnabled: true, fallbackNotFoundEnabled: true });
			const bothOn = (await axios.get(`${consoleBaseUrl}/actors`)).data as string;

			setApiFallbackState({ fallbackUnimplementedEnabled: false, fallbackNotFoundEnabled: false });
			const bothOff = (await axios.get(`${consoleBaseUrl}/actors`)).data as string;

			expect(mixedA).toContain('Settings — fallback (unimplemented: on, not-found: off)');
			expect(mixedB).toContain('Settings — fallback (unimplemented: off, not-found: on)');
			expect(bothOn).toContain('Settings — fallback (unimplemented: on, not-found: on)');
			expect(bothOff).toContain('Settings — fallback (unimplemented: off, not-found: off)');

			const distinct = new Set([mixedA, mixedB, bothOn, bothOff]);
			expect(distinct.size).toBe(4);
		});

		it('the trailing parenthesized segment is a link to /settings', async () => {
			setApiFallbackState({ fallbackUnimplementedEnabled: true, fallbackNotFoundEnabled: true });
			const res = await axios.get(`${consoleBaseUrl}/actors`);
			expect(res.data).toContain(
				'<a href="/settings">Settings — fallback (unimplemented: on, not-found: on)</a>',
			);
		});

		it('toggling and reloading each page updates the indicator on all of them, with no restart', async () => {
			setApiFallbackState({ fallbackUnimplementedEnabled: false, fallbackNotFoundEnabled: false });
			for (const page of pages) {
				const res = await axios.get(`${consoleBaseUrl}${page}`);
				expect(res.data).toContain('Settings — fallback (unimplemented: off, not-found: off)');
			}

			setApiFallbackState({ fallbackUnimplementedEnabled: true, fallbackNotFoundEnabled: true });
			for (const page of pages) {
				const res = await axios.get(`${consoleBaseUrl}${page}`);
				expect(res.data).toContain('Settings — fallback (unimplemented: on, not-found: on)');
			}
		});
	});
});

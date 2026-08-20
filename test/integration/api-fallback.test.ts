/**
 * Covers the upstream API fallback (`api.md`'s "Upstream fallback" section, `services/api-fallback.ts`):
 * the `GET`/`POST /actor-runtime/api-fallback` toggle-state endpoint, the eligibility mapping (both
 * toggles, in isolation and together), the fail-closed guarantee, own-token-only forwarding, and the two
 * marker headers - against a stubbed upstream, exactly the pattern
 * `test/integration/identity-resolution.test.ts` established for the identity probe. Never real egress
 * to `api.apify.com`.
 *
 * Console-side coverage (the `/settings` page, its form, and the nav indicator on every page) lives in
 * `test/integration/settings-console.test.ts`.
 */
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';

import { startTestServer, type TestServerHandle } from './helpers/test-server.js';
import { resetApiFallbackStateForTests, setApiFallbackState } from '../../src/services/api-fallback.js';
import { getRegistries } from '../../src/storage/registries.js';
import { generateId } from '../../src/storage/ids.js';
import type { RunRecord } from '../../src/storage/entities.js';
import type { Driver, DevFolderProbeOutcome } from '../../src/driver/types.js';

interface CapturedRequest {
	method: string;
	url: string;
	headers: Record<string, string | string[] | undefined>;
	body: Buffer;
}

interface StubUpstream {
	baseUrl: string;
	hitCount: () => number;
	requests: () => CapturedRequest[];
	close: () => Promise<void>;
}

/** Stands in for `https://api.apify.com`, generically: `respond` decides the status/body/headers for
 * every request; passing `'hang'` never calls back at all (simulating a stalled upstream past any
 * timeout). Every hit is recorded (method/url/headers/body), so a test can assert what the runtime
 * actually sent upstream, not just what it got back. */
function startStubUpstream(
	respond: (req: CapturedRequest) => { status: number; body?: unknown; headers?: Record<string, string> } | 'hang',
): Promise<StubUpstream> {
	const requests: CapturedRequest[] = [];
	return new Promise((resolveServer) => {
		const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
			const chunks: Buffer[] = [];
			req.on('data', (chunk: Buffer) => chunks.push(chunk));
			req.on('end', () => {
				const captured: CapturedRequest = {
					method: req.method ?? '',
					url: req.url ?? '',
					headers: req.headers,
					body: Buffer.concat(chunks),
				};
				requests.push(captured);
				const outcome = respond(captured);
				if (outcome === 'hang') return; // never respond - the client's own timeout must fire
				res.writeHead(outcome.status, { 'content-type': 'application/json', ...outcome.headers });
				res.end(outcome.body === undefined ? '' : JSON.stringify(outcome.body));
			});
		});
		server.listen(0, () => {
			const { port } = server.address() as AddressInfo;
			resolveServer({
				baseUrl: `http://127.0.0.1:${port}`,
				hitCount: () => requests.length,
				requests: () => requests,
				close: () => new Promise<void>((resolve) => server.close(() => resolve())),
			});
		});
	});
}

/** Makes one authenticated request so `services/users.ts: getOrCreateUserForToken()`'s one-time
 * identity probe for `token` runs and gets cached *now*, against whatever upstream is currently
 * configured - before a test points `APIFY_UPSTREAM_API_BASE_URL` at its own fallback stub. Without
 * this, the identity probe for a never-before-seen token would itself be the first request to reach
 * that stub. */
async function warmUpIdentity(baseUrl: string, token: string): Promise<void> {
	await axios.get(`${baseUrl}/v2/users/me`, {
		headers: { Authorization: `Bearer ${token}` },
		validateStatus: () => true,
	});
}

/** A fixed `2xx` JSON response with a distinguishing header, the "the caller receives exactly this"
 * shape criteria 11-15 check for every successful-relay case. */
function fixedOkResponse(distinguishingValue: string) {
	return () => ({
		status: 200,
		body: { fromUpstream: true, marker: distinguishingValue },
		headers: { 'x-stub-marker': distinguishingValue },
	});
}

describe('api-fallback: toggle-state endpoint', () => {
	let server: TestServerHandle;

	beforeEach(async () => {
		server = await startTestServer();
	});

	afterEach(async () => {
		resetApiFallbackStateForTests();
		await server.close();
	});

	async function get(path: string, token: string | null = server.token) {
		return axios.get(`${server.baseUrl}${path}`, {
			headers: token ? { Authorization: `Bearer ${token}` } : {},
			validateStatus: () => true,
		});
	}

	async function post(path: string, body: unknown, token: string | null = server.token) {
		return axios.post(`${server.baseUrl}${path}`, body, {
			headers: {
				'Content-Type': 'application/json',
				...(token ? { Authorization: `Bearer ${token}` } : {}),
			},
			validateStatus: () => true,
		});
	}

	it('both toggles are off by default, upstreamBaseUrl reported', async () => {
		const res = await get('/actor-runtime/api-fallback');
		expect(res.status).toBe(200);
		expect(res.data).toEqual({
			data: {
				fallbackUnimplementedEnabled: false,
				fallbackNotFoundEnabled: false,
				upstreamBaseUrl: 'https://api.apify.com',
			},
		});
	});

	it('a restart (simulated: the in-memory state is reset) brings both toggles back to false regardless of how they were set', async () => {
		await post('/actor-runtime/api-fallback', {
			fallbackUnimplementedEnabled: true,
			fallbackNotFoundEnabled: true,
		});
		let res = await get('/actor-runtime/api-fallback');
		expect(res.data.data.fallbackUnimplementedEnabled).toBe(true);
		expect(res.data.data.fallbackNotFoundEnabled).toBe(true);

		resetApiFallbackStateForTests();

		res = await get('/actor-runtime/api-fallback');
		expect(res.data.data).toEqual({
			fallbackUnimplementedEnabled: false,
			fallbackNotFoundEnabled: false,
			upstreamBaseUrl: 'https://api.apify.com',
		});

		// Also true starting from only one toggle on.
		await post('/actor-runtime/api-fallback', { fallbackNotFoundEnabled: true });
		resetApiFallbackStateForTests();
		res = await get('/actor-runtime/api-fallback');
		expect(res.data.data.fallbackNotFoundEnabled).toBe(false);
	});

	it('GET is reachable both at /actor-runtime/api-fallback and /v2/actor-runtime/api-fallback, identically', async () => {
		const bothOff = await get('/actor-runtime/api-fallback');
		const bothOffAlias = await get('/v2/actor-runtime/api-fallback');
		expect(bothOffAlias.status).toBe(bothOff.status);
		expect(bothOffAlias.data).toEqual(bothOff.data);

		await post('/actor-runtime/api-fallback', {
			fallbackUnimplementedEnabled: true,
			fallbackNotFoundEnabled: true,
		});
		const bothOn = await get('/actor-runtime/api-fallback');
		const bothOnAlias = await get('/v2/actor-runtime/api-fallback');
		expect(bothOnAlias.status).toBe(bothOn.status);
		expect(bothOnAlias.data).toEqual(bothOn.data);
	});

	it('a partial POST flips only the field it mentions, leaving the other untouched - matching the spec worked example verbatim', async () => {
		const first = await post('/actor-runtime/api-fallback', { fallbackUnimplementedEnabled: true });
		expect(first.status).toBe(200);
		expect(first.data).toEqual({
			data: {
				fallbackUnimplementedEnabled: true,
				fallbackNotFoundEnabled: false,
				upstreamBaseUrl: 'https://api.apify.com',
			},
		});

		const second = await post('/actor-runtime/api-fallback', { fallbackNotFoundEnabled: true });
		expect(second.data.data).toEqual({
			fallbackUnimplementedEnabled: true,
			fallbackNotFoundEnabled: true,
			upstreamBaseUrl: 'https://api.apify.com',
		});

		const third = await post('/actor-runtime/api-fallback', { fallbackUnimplementedEnabled: false });
		expect(third.data.data).toEqual({
			fallbackUnimplementedEnabled: false,
			fallbackNotFoundEnabled: true,
			upstreamBaseUrl: 'https://api.apify.com',
		});

		const confirmed = await get('/actor-runtime/api-fallback');
		expect(confirmed.data.data).toEqual(third.data.data);
	});

	it('POST with no token is 401 user-not-authenticated and does not change state; also true through the /v2 alias', async () => {
		const before = await get('/actor-runtime/api-fallback');

		const res = await post('/actor-runtime/api-fallback', { fallbackUnimplementedEnabled: true }, null);
		expect(res.status).toBe(401);
		expect(res.data.error.type).toBe('user-not-authenticated');

		const resAlias = await post('/v2/actor-runtime/api-fallback', { fallbackUnimplementedEnabled: true }, null);
		expect(resAlias.status).toBe(401);
		expect(resAlias.data.error.type).toBe('user-not-authenticated');

		const after = await get('/actor-runtime/api-fallback');
		expect(after.data).toEqual(before.data);
	});

	const malformedBodies: Array<[string, unknown, boolean]> = [
		['a non-JSON body', '{not json', false],
		['a JSON array', [true], true],
		['a JSON scalar (string)', 'true', true],
		['a JSON scalar (number)', 42, true],
		['a JSON null', null, true],
		['an empty object', {}, true],
		['an unknown key', { fallbackUnimplementedEnabled: true, typo: true }, true],
		['a non-boolean value (string)', { fallbackUnimplementedEnabled: 'true' }, true],
		['a non-boolean value (number)', { fallbackNotFoundEnabled: 1 }, true],
		['a non-boolean value (null)', { fallbackUnimplementedEnabled: null }, true],
	];

	for (const [label, body, isJson] of malformedBodies) {
		it(`rejects ${label} as 400 invalid-request, with no state change`, async () => {
			const before = await get('/actor-runtime/api-fallback');

			const res = isJson
				? await post('/actor-runtime/api-fallback', body)
				: await axios.post(`${server.baseUrl}/actor-runtime/api-fallback`, body as string, {
						headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${server.token}` },
						validateStatus: () => true,
					});
			expect(res.status).toBe(400);
			expect(res.data.error.type).toBe('invalid-request');

			const after = await get('/actor-runtime/api-fallback');
			expect(after.data).toEqual(before.data);
		});
	}

	it('upstreamBaseUrl is read-only: an attacker-supplied value in the POST body never becomes the reported upstream', async () => {
		const res = await post('/actor-runtime/api-fallback', {
			fallbackUnimplementedEnabled: true,
			upstreamBaseUrl: 'https://evil.example',
		});
		// Either shape is acceptable per the spec (rejected as an unknown key, or ignored) - either way
		// the reported upstreamBaseUrl must never be the attacker-supplied one.
		if (res.status === 200) {
			expect(res.data.data.upstreamBaseUrl).toBe('https://api.apify.com');
		} else {
			expect(res.status).toBe(400);
		}

		const after = await get('/actor-runtime/api-fallback');
		expect(after.data.data.upstreamBaseUrl).toBe('https://api.apify.com');
	});
});

describe('api-fallback: eligibility, relay, and fail-closed behaviour', () => {
	let server: TestServerHandle;
	let previousUpstreamUrl: string | undefined;

	beforeEach(async () => {
		server = await startTestServer();
		previousUpstreamUrl = process.env.APIFY_UPSTREAM_API_BASE_URL;
		// Force the one-time identity probe (`services/identity-resolution.ts`) to happen now, against
		// whichever upstream is configured *before* any test below points `APIFY_UPSTREAM_API_BASE_URL`
		// at its own stub - otherwise that very probe would be the first request to land on a per-test
		// stub, inflating its hit count and logging its own "using local identity" line into a spy meant
		// to observe only `attemptFallback`'s own logging.
		await warmUpIdentity(server.baseUrl, server.token);
	});

	afterEach(async () => {
		resetApiFallbackStateForTests();
		if (previousUpstreamUrl === undefined) delete process.env.APIFY_UPSTREAM_API_BASE_URL;
		else process.env.APIFY_UPSTREAM_API_BASE_URL = previousUpstreamUrl;
		await server.close();
	});

	async function call(
		method: 'get' | 'post' | 'put' | 'delete',
		path: string,
		options: { body?: unknown; token?: string } = {},
	) {
		return axios.request({
			method,
			url: `${server.baseUrl}${path}`,
			data: options.body,
			headers: { Authorization: `Bearer ${options.token ?? server.token}` },
			validateStatus: () => true,
		});
	}

	/** Seeds and returns a non-terminal (`RUNNING`) run owned by the test's default token, so
	 * `DELETE /v2/actor-runs/:runId` throws `cannot-remove-running-run` - one of the "never forwards"
	 * conflict-style error types (criterion 18). */
	async function seedRunningRun(): Promise<string> {
		const actor = await server.client.actors().create({ name: `fallback-conflict-actor-${generateId()}` });
		const actorRecord = (await getRegistries().actors.get(actor.id))!;
		const run: RunRecord = {
			id: generateId(),
			userId: actorRecord.userId,
			actorId: actor.id,
			buildId: generateId(),
			buildNumber: '0.0.1',
			status: 'RUNNING',
			startedAt: new Date().toISOString(),
			defaultDatasetId: generateId(),
			defaultKeyValueStoreId: generateId(),
			defaultRequestQueueId: generateId(),
			options: { memoryMbytes: 1024, timeoutSecs: 300 },
			meta: { origin: 'API' },
		};
		await getRegistries().runs.set(run.id, run);
		return run.id;
	}

	describe('both toggles off: no behavior change, zero outbound traffic', () => {
		it('an off-spec path, a spec-known 501 path, and a record-not-found id all answer exactly as before, and the stub is never hit', async () => {
			const stub = await startStubUpstream(fixedOkResponse('should-never-be-seen'));
			process.env.APIFY_UPSTREAM_API_BASE_URL = stub.baseUrl;
			try {
				const offSpec = await call('get', '/v2/totally-made-up-path');
				expect(offSpec.status).toBe(404);
				expect(offSpec.data.error.type).toBe('not-found');
				expect(offSpec.headers['x-actor-runtime-fallback']).toBeUndefined();

				const notImplemented = await call('get', '/v2/schedules');
				expect(notImplemented.status).toBe(501);
				expect(notImplemented.data.error.type).toBe('not-implemented');

				const notFound = await call('get', '/v2/datasets/does-not-exist-at-all');
				expect(notFound.status).toBe(404);
				expect(notFound.data.error.type).toBe('record-not-found');

				expect(stub.hitCount()).toBe(0);
			} finally {
				await stub.close();
			}
		});
	});

	describe('fallbackUnimplementedEnabled alone (fallbackNotFoundEnabled off)', () => {
		beforeEach(() => {
			setApiFallbackState({ fallbackUnimplementedEnabled: true, fallbackNotFoundEnabled: false });
		});

		it('relays an off-spec path, with the trigger header "unimplemented"', async () => {
			const stub = await startStubUpstream(fixedOkResponse('off-spec-marker'));
			process.env.APIFY_UPSTREAM_API_BASE_URL = stub.baseUrl;
			try {
				const res = await call('get', '/v2/totally-made-up-path');
				expect(res.status).toBe(200);
				expect(res.data).toEqual({ fromUpstream: true, marker: 'off-spec-marker' });
				expect(res.headers['x-stub-marker']).toBe('off-spec-marker');
				expect(res.headers['x-actor-runtime-fallback']).toBe(stub.baseUrl);
				expect(res.headers['x-actor-runtime-fallback-trigger']).toBe('unimplemented');
				expect(stub.hitCount()).toBe(1);
			} finally {
				await stub.close();
			}
		});

		it('relays a spec-known 501 path, with the trigger header "unimplemented"', async () => {
			const stub = await startStubUpstream(fixedOkResponse('schedules-marker'));
			process.env.APIFY_UPSTREAM_API_BASE_URL = stub.baseUrl;
			try {
				const res = await call('get', '/v2/schedules');
				expect(res.status).toBe(200);
				expect(res.data).toEqual({ fromUpstream: true, marker: 'schedules-marker' });
				expect(res.headers['x-actor-runtime-fallback-trigger']).toBe('unimplemented');
				expect(stub.hitCount()).toBe(1);
			} finally {
				await stub.close();
			}
		});

		it('does NOT relay a record-not-found case - the other toggle is off', async () => {
			const stub = await startStubUpstream(fixedOkResponse('should-not-be-hit'));
			process.env.APIFY_UPSTREAM_API_BASE_URL = stub.baseUrl;
			try {
				const res = await call('get', '/v2/datasets/does-not-exist-at-all');
				expect(res.status).toBe(404);
				expect(res.data.error.type).toBe('record-not-found');
				expect(res.headers['x-actor-runtime-fallback']).toBeUndefined();
				expect(stub.hitCount()).toBe(0);
			} finally {
				await stub.close();
			}
		});

		it('relays a write method (POST) against an unbuilt endpoint family', async () => {
			const stub = await startStubUpstream(fixedOkResponse('actor-tasks-post-marker'));
			process.env.APIFY_UPSTREAM_API_BASE_URL = stub.baseUrl;
			try {
				const res = await call('post', '/v2/actor-tasks', { body: { name: 'whatever' } });
				expect(res.status).toBe(200);
				expect(res.headers['x-actor-runtime-fallback-trigger']).toBe('unimplemented');
				expect(stub.hitCount()).toBe(1);
				expect(stub.requests()[0]?.method).toBe('POST');
			} finally {
				await stub.close();
			}
		});
	});

	describe('fallbackNotFoundEnabled alone (fallbackUnimplementedEnabled off)', () => {
		beforeEach(() => {
			setApiFallbackState({ fallbackUnimplementedEnabled: false, fallbackNotFoundEnabled: true });
		});

		it('relays a record-not-found case, with the trigger header "record-not-found"', async () => {
			const stub = await startStubUpstream(fixedOkResponse('record-not-found-marker'));
			process.env.APIFY_UPSTREAM_API_BASE_URL = stub.baseUrl;
			try {
				const res = await call('get', '/v2/datasets/does-not-exist-at-all');
				expect(res.status).toBe(200);
				expect(res.data).toEqual({ fromUpstream: true, marker: 'record-not-found-marker' });
				expect(res.headers['x-actor-runtime-fallback-trigger']).toBe('record-not-found');
				expect(stub.hitCount()).toBe(1);
			} finally {
				await stub.close();
			}
		});

		it('does NOT relay an off-spec path or a spec-known 501 path - the other toggle is off', async () => {
			const stub = await startStubUpstream(fixedOkResponse('should-not-be-hit'));
			process.env.APIFY_UPSTREAM_API_BASE_URL = stub.baseUrl;
			try {
				const offSpec = await call('get', '/v2/totally-made-up-path');
				expect(offSpec.status).toBe(404);
				expect(offSpec.data.error.type).toBe('not-found');

				const notImplemented = await call('get', '/v2/schedules');
				expect(notImplemented.status).toBe(501);

				expect(stub.hitCount()).toBe(0);
			} finally {
				await stub.close();
			}
		});

		it('relays a write method (DELETE) against a missing record', async () => {
			const stub = await startStubUpstream(fixedOkResponse('delete-marker'));
			process.env.APIFY_UPSTREAM_API_BASE_URL = stub.baseUrl;
			try {
				const res = await call('delete', '/v2/datasets/does-not-exist-for-delete');
				expect(res.status).toBe(200);
				expect(res.headers['x-actor-runtime-fallback-trigger']).toBe('record-not-found');
				expect(stub.hitCount()).toBe(1);
				expect(stub.requests()[0]?.method).toBe('DELETE');
			} finally {
				await stub.close();
			}
		});
	});

	describe('both toggles on', () => {
		beforeEach(() => {
			setApiFallbackState({ fallbackUnimplementedEnabled: true, fallbackNotFoundEnabled: true });
		});

		it('relays both trigger kinds in the same run, each with its own correct trigger header', async () => {
			const stub = await startStubUpstream((req) => ({
				status: 200,
				body: { sawUrl: req.url },
				headers: { 'x-stub-marker': 'both-on' },
			}));
			process.env.APIFY_UPSTREAM_API_BASE_URL = stub.baseUrl;
			try {
				const unimplemented = await call('get', '/v2/schedules');
				expect(unimplemented.status).toBe(200);
				expect(unimplemented.headers['x-actor-runtime-fallback-trigger']).toBe('unimplemented');

				const notFound = await call('get', '/v2/datasets/does-not-exist-at-all');
				expect(notFound.status).toBe(200);
				expect(notFound.headers['x-actor-runtime-fallback-trigger']).toBe('record-not-found');

				expect(stub.hitCount()).toBe(2);
			} finally {
				await stub.close();
			}
		});

		it('replays the byte-exact original URL (path + query, percent-encoding intact) to the upstream', async () => {
			const stub = await startStubUpstream(fixedOkResponse('url-check'));
			process.env.APIFY_UPSTREAM_API_BASE_URL = stub.baseUrl;
			try {
				await call('get', '/v2/totally-made-up-path?q=a%23b%3Fc');
				expect(stub.requests()[0]?.url).toBe('/v2/totally-made-up-path?q=a%23b%3Fc');
			} finally {
				await stub.close();
			}
		});
	});

	describe('fail-closed: upstream trouble never surfaces upstream detail', () => {
		async function localBothOffResponse(method: 'get' | 'delete', path: string) {
			setApiFallbackState({ fallbackUnimplementedEnabled: false, fallbackNotFoundEnabled: false });
			const res = await call(method, path);
			setApiFallbackState({ fallbackUnimplementedEnabled: true, fallbackNotFoundEnabled: true });
			return res;
		}

		it('upstream 404 -> original local error, unchanged, no marker headers', async () => {
			const stub = await startStubUpstream(() => ({ status: 404, body: { error: 'upstream 404' } }));
			process.env.APIFY_UPSTREAM_API_BASE_URL = stub.baseUrl;
			try {
				const baseline = await localBothOffResponse('get', '/v2/totally-made-up-path');
				const res = await call('get', '/v2/totally-made-up-path');
				expect(res.status).toBe(baseline.status);
				expect(res.data).toEqual(baseline.data);
				expect(res.headers['x-actor-runtime-fallback']).toBeUndefined();
				expect(res.headers['x-actor-runtime-fallback-trigger']).toBeUndefined();
				expect(stub.hitCount()).toBe(1);
			} finally {
				await stub.close();
			}
		});

		it('upstream 500 -> original local error, unchanged', async () => {
			const stub = await startStubUpstream(() => ({ status: 500, body: { error: 'upstream 500' } }));
			process.env.APIFY_UPSTREAM_API_BASE_URL = stub.baseUrl;
			try {
				const baseline = await localBothOffResponse('get', '/v2/schedules');
				const res = await call('get', '/v2/schedules');
				expect(res.status).toBe(baseline.status);
				expect(res.data).toEqual(baseline.data);
				expect(res.headers['x-actor-runtime-fallback']).toBeUndefined();
			} finally {
				await stub.close();
			}
		});

		it('upstream non-not-found 4xx (401) -> original local error, unchanged', async () => {
			const stub = await startStubUpstream(() => ({ status: 401, body: { error: 'upstream 401' } }));
			process.env.APIFY_UPSTREAM_API_BASE_URL = stub.baseUrl;
			try {
				const baseline = await localBothOffResponse('get', '/v2/datasets/does-not-exist-at-all');
				const res = await call('get', '/v2/datasets/does-not-exist-at-all');
				expect(res.status).toBe(baseline.status);
				expect(res.data).toEqual(baseline.data);
				expect(res.headers['x-actor-runtime-fallback']).toBeUndefined();
			} finally {
				await stub.close();
			}
		});

		it('upstream non-not-found 4xx (409) -> original local error, unchanged', async () => {
			const stub = await startStubUpstream(() => ({ status: 409, body: { error: 'upstream 409' } }));
			process.env.APIFY_UPSTREAM_API_BASE_URL = stub.baseUrl;
			try {
				const baseline = await localBothOffResponse('get', '/v2/datasets/does-not-exist-at-all');
				const res = await call('get', '/v2/datasets/does-not-exist-at-all');
				expect(res.status).toBe(baseline.status);
				expect(res.data).toEqual(baseline.data);
			} finally {
				await stub.close();
			}
		});

		it('upstream unreachable (connection refused) -> original local error, unchanged', async () => {
			process.env.APIFY_UPSTREAM_API_BASE_URL = 'http://127.0.0.1:1'; // nothing listens here
			const baseline = await localBothOffResponse('get', '/v2/totally-made-up-path');
			const res = await call('get', '/v2/totally-made-up-path');
			expect(res.status).toBe(baseline.status);
			expect(res.data).toEqual(baseline.data);
			expect(res.headers['x-actor-runtime-fallback']).toBeUndefined();
		});

		it('upstream hangs past the timeout -> original local error, unchanged (slow: waits out the real timeout)', async () => {
			const stub = await startStubUpstream(() => 'hang');
			process.env.APIFY_UPSTREAM_API_BASE_URL = stub.baseUrl;
			try {
				const baseline = await localBothOffResponse('get', '/v2/totally-made-up-path');
				const res = await call('get', '/v2/totally-made-up-path');
				expect(res.status).toBe(baseline.status);
				expect(res.data).toEqual(baseline.data);
				expect(res.headers['x-actor-runtime-fallback']).toBeUndefined();
			} finally {
				await stub.close();
			}
		}, 35_000);
	});

	describe('never forwards a token the caller did not present', () => {
		beforeEach(() => {
			setApiFallbackState({ fallbackUnimplementedEnabled: true, fallbackNotFoundEnabled: true });
		});

		it('the upstream sees exactly the caller-presented token, never a different one', async () => {
			// Warm this distinct token's identity first (see `warmUpIdentity`'s doc comment) - otherwise
			// its own one-time identity probe would be the first request the stub below sees.
			await warmUpIdentity(server.baseUrl, 'the-exact-caller-token');

			const stub = await startStubUpstream(fixedOkResponse('token-check'));
			process.env.APIFY_UPSTREAM_API_BASE_URL = stub.baseUrl;
			try {
				await call('get', '/v2/totally-made-up-path', { token: 'the-exact-caller-token' });
				expect(stub.hitCount()).toBe(1);
				const auth = stub.requests()[0]?.headers.authorization;
				expect(auth).toBe('Bearer the-exact-caller-token');
			} finally {
				await stub.close();
			}
		});

		it('a request with no token at all never reaches the stub (rejected by auth() first)', async () => {
			const stub = await startStubUpstream(fixedOkResponse('no-token-check'));
			process.env.APIFY_UPSTREAM_API_BASE_URL = stub.baseUrl;
			try {
				const res = await axios.get(`${server.baseUrl}/v2/totally-made-up-path`, {
					validateStatus: () => true,
				});
				expect(res.status).toBe(401);
				expect(res.data.error.type).toBe('user-not-authenticated');
				expect(stub.hitCount()).toBe(0);
			} finally {
				await stub.close();
			}
		});
	});

	describe('local list endpoints never gain platform objects', () => {
		beforeEach(() => {
			setApiFallbackState({ fallbackUnimplementedEnabled: true, fallbackNotFoundEnabled: true });
		});

		it('GET /v2/datasets (a collection route) never hits the stub and never gains upstream items', async () => {
			const stub = await startStubUpstream(() => ({
				status: 200,
				body: { data: { items: [{ id: 'platform-only-dataset' }], total: 1, count: 1, offset: 0, limit: 20 } },
			}));
			process.env.APIFY_UPSTREAM_API_BASE_URL = stub.baseUrl;
			try {
				const res = await call('get', '/v2/datasets');
				expect(res.status).toBe(200);
				expect(JSON.stringify(res.data)).not.toContain('platform-only-dataset');
				expect(stub.hitCount()).toBe(0);
			} finally {
				await stub.close();
			}
		});

		it('GET /v2/actors (a collection route) never hits the stub either', async () => {
			const stub = await startStubUpstream(() => ({ status: 200, body: { data: { items: [] } } }));
			process.env.APIFY_UPSTREAM_API_BASE_URL = stub.baseUrl;
			try {
				const res = await call('get', '/v2/actors');
				expect(res.status).toBe(200);
				expect(stub.hitCount()).toBe(0);
			} finally {
				await stub.close();
			}
		});
	});

	describe('every other local error type never forwards, under any toggle combination', () => {
		beforeEach(() => {
			setApiFallbackState({ fallbackUnimplementedEnabled: true, fallbackNotFoundEnabled: true });
		});

		it('400 invalid-request never forwards', async () => {
			const stub = await startStubUpstream(fixedOkResponse('should-not-be-hit'));
			process.env.APIFY_UPSTREAM_API_BASE_URL = stub.baseUrl;
			try {
				const res = await axios.post(`${server.baseUrl}/v2/actors`, '{not valid json', {
					headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${server.token}` },
					validateStatus: () => true,
				});
				expect(res.status).toBe(400);
				expect(res.data.error.type).toBe('invalid-request');
				expect(stub.hitCount()).toBe(0);
			} finally {
				await stub.close();
			}
		});

		it('401 user-not-authenticated never forwards', async () => {
			const stub = await startStubUpstream(fixedOkResponse('should-not-be-hit'));
			process.env.APIFY_UPSTREAM_API_BASE_URL = stub.baseUrl;
			try {
				const res = await axios.get(`${server.baseUrl}/v2/actors`, { validateStatus: () => true });
				expect(res.status).toBe(401);
				expect(stub.hitCount()).toBe(0);
			} finally {
				await stub.close();
			}
		});

		it('a conflict-style error (cannot-remove-running-run) never forwards', async () => {
			const stub = await startStubUpstream(fixedOkResponse('should-not-be-hit'));
			process.env.APIFY_UPSTREAM_API_BASE_URL = stub.baseUrl;
			try {
				const runId = await seedRunningRun();
				const res = await call('delete', `/v2/actor-runs/${runId}`);
				expect(res.status).toBe(400);
				expect(res.data.error.type).toBe('cannot-remove-running-run');
				expect(stub.hitCount()).toBe(0);
			} finally {
				await stub.close();
			}
		});

		// dev-folder-* errors and internal-error are covered by the standalone describe block below
		// (`api-fallback: dev-folder-* and internal-error types never forward`) - that test needs its own
		// `startTestServer()` with a custom probing driver, which cannot coexist with this block's own
		// `server` (the storage bootstrap is a process-wide singleton - only one `TestServerHandle` can be
		// open at a time, see `storage/bootstrap.ts`).
	});

	describe('log lines: one console.log per relay, one console.warn per abandon', () => {
		it('a relayed request logs exactly one console.log line and no console.warn', async () => {
			setApiFallbackState({ fallbackUnimplementedEnabled: true, fallbackNotFoundEnabled: false });
			const stub = await startStubUpstream(fixedOkResponse('log-check'));
			process.env.APIFY_UPSTREAM_API_BASE_URL = stub.baseUrl;
			const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
			const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
			try {
				await call('get', '/v2/totally-made-up-path');
				expect(logSpy).toHaveBeenCalledTimes(1);
				expect(warnSpy).not.toHaveBeenCalled();
			} finally {
				logSpy.mockRestore();
				warnSpy.mockRestore();
				await stub.close();
			}
		});

		it('an abandoned request (upstream 500) logs exactly one console.warn line and no console.log, for the record-not-found trigger too', async () => {
			setApiFallbackState({ fallbackUnimplementedEnabled: false, fallbackNotFoundEnabled: true });
			const stub = await startStubUpstream(() => ({ status: 500 }));
			process.env.APIFY_UPSTREAM_API_BASE_URL = stub.baseUrl;
			const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
			const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
			try {
				await call('get', '/v2/datasets/does-not-exist-at-all');
				expect(warnSpy).toHaveBeenCalledTimes(1);
				expect(String(warnSpy.mock.calls[0]?.[0])).toContain('500');
				expect(logSpy).not.toHaveBeenCalled();
			} finally {
				logSpy.mockRestore();
				warnSpy.mockRestore();
				await stub.close();
			}
		});

		it('neither line appears while the relevant toggle is off', async () => {
			setApiFallbackState({ fallbackUnimplementedEnabled: false, fallbackNotFoundEnabled: false });
			const stub = await startStubUpstream(fixedOkResponse('should-not-be-hit'));
			process.env.APIFY_UPSTREAM_API_BASE_URL = stub.baseUrl;
			const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
			const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
			try {
				await call('get', '/v2/totally-made-up-path');
				expect(logSpy).not.toHaveBeenCalled();
				expect(warnSpy).not.toHaveBeenCalled();
			} finally {
				logSpy.mockRestore();
				warnSpy.mockRestore();
				await stub.close();
			}
		});
	});
});

describe('api-fallback: dev-folder-* and internal-error types never forward', () => {
	// A standalone describe block (its own `TestServerHandle`, not the shared `server` from the block
	// above) because it needs a driver whose `probeDevFolder` outcome changes mid-test - and because the
	// storage bootstrap this needs is a process-wide singleton (`storage/bootstrap.ts`), so it cannot run
	// while another `startTestServer()`-created server is still open.
	let server: TestServerHandle;
	let previousUpstreamUrl: string | undefined;
	let outcome: DevFolderProbeOutcome;

	const probingDriver: Driver = {
		available: true,
		async init() {},
		async startBuild() {
			throw new Error('not used by this stub');
		},
		async abortBuild() {},
		async startRun() {
			throw new Error('not used by this stub');
		},
		async abortRun() {},
		async reconcileOrphans() {},
		async probeDevFolder() {
			return outcome;
		},
		async ensureProbeImage() {
			return 'stub-probe-image:test';
		},
	};

	beforeEach(async () => {
		outcome = { ok: false, reason: 'not-found' };
		server = await startTestServer(probingDriver);
		previousUpstreamUrl = process.env.APIFY_UPSTREAM_API_BASE_URL;
		await warmUpIdentity(server.baseUrl, server.token);
		setApiFallbackState({ fallbackUnimplementedEnabled: true, fallbackNotFoundEnabled: true });
	});

	afterEach(async () => {
		resetApiFallbackStateForTests();
		if (previousUpstreamUrl === undefined) delete process.env.APIFY_UPSTREAM_API_BASE_URL;
		else process.env.APIFY_UPSTREAM_API_BASE_URL = previousUpstreamUrl;
		await server.close();
	});

	it("dev-folder-path-not-found (400) and internal-error (500), raised from the dev-folder route's recordNotFound-adjacent rejections, never forward - not because of their type alone, but also because /actor-runtime/* is never an eligible path", async () => {
		const stub = await startStubUpstream(fixedOkResponse('should-not-be-hit'));
		process.env.APIFY_UPSTREAM_API_BASE_URL = stub.baseUrl;
		try {
			const actor = await server.client.actors().create({ name: `fallback-devfolder-actor-${generateId()}` });
			const post = (body: string) =>
				axios.post(`${server.baseUrl}/actor-runtime/dev-folder/${actor.id}`, body, {
					headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${server.token}` },
					validateStatus: () => true,
				});

			const notFoundRes = await post(JSON.stringify('/some/path'));
			expect(notFoundRes.status).toBe(400);
			expect(notFoundRes.data.error.type).toBe('dev-folder-path-not-found');
			expect(notFoundRes.headers['x-actor-runtime-fallback']).toBeUndefined();

			outcome = { ok: false, reason: 'image-missing' };
			const internalErrorRes = await post(JSON.stringify('/some/other/path'));
			expect(internalErrorRes.status).toBe(500);
			expect(internalErrorRes.data.error.type).toBe('internal-error');
			expect(internalErrorRes.headers['x-actor-runtime-fallback']).toBeUndefined();

			expect(stub.hitCount()).toBe(0);
		} finally {
			await stub.close();
		}
	});
});

/**
 * The runtime serves its own `/actor-runtime/*` OpenAPI document, and everything that document does
 * not describe is answered from the document too (`requirements/api.md`, "Actor runtime API").
 *
 * The load-bearing test here is "every documented operation is actually served": it is what keeps the
 * document and the routes from drifting apart, in either direction - a route added without a
 * document entry loses its 404/405 contract, a document entry added without a route answers `501`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import axios, { type AxiosResponse } from 'axios';

import { startTestServer, type TestServerHandle } from './helpers/test-server.js';
import { ACTOR_RUNTIME_OPERATIONS } from '../../src/api/actor-runtime-spec.js';

describe('Actor runtime API self-description', () => {
	let server: TestServerHandle;

	beforeEach(async () => {
		server = await startTestServer();
	});

	afterEach(async () => {
		await server.close();
	});

	function call(method: string, path: string, withToken = true): Promise<AxiosResponse> {
		return axios.request({
			method,
			url: `${server.baseUrl}${path}`,
			headers: withToken ? { Authorization: `Bearer ${server.token}` } : {},
			validateStatus: () => true,
		});
	}

	it('serves the document at GET /actor-runtime, enveloped, without a token', async () => {
		const res = await call('get', '/actor-runtime', false);
		expect(res.status).toBe(200);
		expect(res.data.data.openapi).toMatch(/^3\.1\./);
		expect(Object.keys(res.data.data.paths)).toContain('/actor-runtime/dev-folder/{actorId}');
	});

	it('serves the bare document at GET /actor-runtime/openapi.json, for OpenAPI tooling', async () => {
		const bare = await call('get', '/actor-runtime/openapi.json', false);
		const enveloped = await call('get', '/actor-runtime');
		expect(bare.status).toBe(200);
		expect(bare.data).not.toHaveProperty('data');
		expect(bare.data).toEqual(enveloped.data.data);
	});

	it('serves the document identically at both mounts', async () => {
		const canonical = await call('get', '/actor-runtime');
		const alias = await call('get', '/v2/actor-runtime');
		expect(alias.status).toBe(200);
		expect(alias.data).toEqual(canonical.data);
	});

	// One request per documented HTTP operation, with placeholder ids and no body: whatever the
	// endpoint makes of that is its own business (`400`, `record-not-found`, ...), as long as the
	// request reached a route at all rather than the namespace's unmatched handler.
	const httpOperations = ACTOR_RUNTIME_OPERATIONS.filter((operation) => operation.transport === 'http');
	it.each(httpOperations.map((operation) => [`${operation.method} ${operation.path}`, operation] as const))(
		'%s is served by a route, not by the unmatched handler',
		async (_label, operation) => {
			const path = operation.path.replace(/\{[^}]+\}/g, 'does-not-exist-id');
			const res = await call(operation.method.toLowerCase(), path);
			expect(res.status).not.toBe(501);
			expect(res.status).not.toBe(405);
			expect(res.status).not.toBe(426);
			if (res.status === 404) expect(res.data.error.type).toBe('record-not-found');
		},
	);

	it('answers an undocumented path in the namespace with 404 not-found, at both mounts', async () => {
		for (const path of ['/actor-runtime/does-not-exist', '/v2/actor-runtime/does-not-exist']) {
			const res = await call('get', path);
			expect(res.status).toBe(404);
			expect(res.data.error.type).toBe('not-found');
			// The message points at the endpoint that lists what the namespace does have.
			expect(res.data.error.message).toContain('GET /actor-runtime');
		}
	});

	it('answers an undocumented method on a documented path with 405 and an Allow header', async () => {
		const res = await call('get', '/actor-runtime/debug/does-not-exist-id');
		expect(res.status).toBe(405);
		expect(res.data.error.type).toBe('method-not-allowed');
		expect(res.headers.allow).toBe('POST');

		const fallback = await call('put', '/actor-runtime/api-fallback');
		expect(fallback.status).toBe(405);
		expect(fallback.headers.allow?.split(', ').sort()).toEqual(['GET', 'POST']);
	});

	it('answers a plain request to the events websocket with 426, with or without a token', async () => {
		for (const withToken of [true, false]) {
			const res = await call('get', '/actor-runtime/events/some-run', withToken);
			expect(res.status).toBe(426);
			expect(res.data.error.type).toBe('upgrade-required');
		}
	});
});

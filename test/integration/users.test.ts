import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';

import { startTestServer, type TestServerHandle } from './helpers/test-server.js';
import { getRegistries } from '../../src/storage/registries.js';
import * as usersService from '../../src/services/users.js';

describe('users API', () => {
	let server: TestServerHandle;

	beforeEach(async () => {
		server = await startTestServer();
	});

	afterEach(async () => {
		await server.close();
	});

	it('GET /users/me returns the single bootstrap user', async () => {
		const user = await server.client.user('me').get();
		expect(user.username).toBeTruthy();
		expect(user.id).toBeTruthy();
	});

	it('any non-empty bearer token authenticates as the same default user', async () => {
		const { ApifyClient } = await import('apify-client');
		const otherClient = new ApifyClient({ baseUrl: server.baseUrl, token: 'anything-non-empty', maxRetries: 0 });
		const user = await otherClient.user('me').get();
		expect(user.id).toBeTruthy();
	});

	it('auth() resolves the default user through the getDefaultUser memo, not a users.list() scan on every request', async () => {
		const registries = getRegistries();
		const listSpy = vi.spyOn(registries.users, 'list');
		const getSpy = vi.spyOn(registries.users, 'get');

		const first = await server.client.user('me').get();
		const second = await server.client.user('me').get();
		const third = await server.client.user('me').get();

		expect(first.id).toBe(second.id);
		expect(second.id).toBe(third.id);

		// At most one full-registry scan across all three requests (warming the memo, if it was not
		// already warm) - every request after that must resolve through the single-record `get`
		// (`getDefaultUser`'s memoised path), never falling back to `list()` per request the way `auth()`
		// used to.
		expect(listSpy.mock.calls.length).toBeLessThanOrEqual(1);
		expect(getSpy.mock.calls.length).toBeGreaterThanOrEqual(2);

		listSpy.mockRestore();
		getSpy.mockRestore();
	});

	it('auth() lets a getDefaultUser() rejection propagate to the generic error middleware: 500 + internal-error, and the underlying error is logged (regression: a local try/catch used to swallow it silently)', async () => {
		const boom = new Error('simulated getDefaultUser failure - e.g. a corrupted registry read');
		const getDefaultUserSpy = vi.spyOn(usersService, 'getDefaultUser').mockRejectedValueOnce(boom);
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

		const res = await axios.get(`${server.baseUrl}/v2/users/me`, {
			headers: { Authorization: `Bearer ${server.token}` },
			validateStatus: () => true,
		});

		expect(res.status).toBe(500);
		expect(res.data.error.type).toBe('internal-error');
		// The generic error middleware (`server.ts`) must have actually logged the real error - this is
		// the part a local `catch { sendError(...) }` in `auth()` would have swallowed entirely.
		expect(errorSpy).toHaveBeenCalledWith(boom);

		getDefaultUserSpy.mockRestore();
		errorSpy.mockRestore();
	});
});

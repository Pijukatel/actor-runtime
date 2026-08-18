import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { ApifyClient } from 'apify-client';

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

	it('GET /users/me creates a user ad-hoc on first use and returns it', async () => {
		const user = await server.client.user('me').get();
		expect(user.username).toBeTruthy();
		expect(user.id).toBeTruthy();
		// Never a placeholder proxy password (`services/users.ts`'s `resolveProxyPassword`): with no
		// `APIFY_PROXY_PASSWORD` set and nothing harvested from a (blocked, in this sandbox) upstream, the
		// `proxy` field is omitted entirely rather than carrying a made-up value.
		expect((user as unknown as { proxy?: unknown }).proxy).toBeUndefined();

		// The record actually landed in `__USERS__`, keyed by its own id.
		const stored = await getRegistries().users.get(user.id);
		expect(stored?.username).toBe(user.username);
		expect(stored?.token).toBe(server.token);
	});

	it('the same token always resolves back to the same user, across multiple requests', async () => {
		const first = await server.client.user('me').get();
		const second = await server.client.user('me').get();
		const third = await server.client.user('me').get();

		expect(first.id).toBe(second.id);
		expect(second.id).toBe(third.id);
	});

	it('two different never-before-used tokens create two different users', async () => {
		const otherClient = new ApifyClient({ baseUrl: server.baseUrl, token: 'a-second-token', maxRetries: 0 });

		const userA = await server.client.user('me').get();
		const userB = await otherClient.user('me').get();

		expect(userA.id).not.toBe(userB.id);
		expect(userA.username).not.toBe(userB.username);
	});

	it('two concurrent first-requests with the same brand-new token yield exactly one user', async () => {
		const client = new ApifyClient({ baseUrl: server.baseUrl, token: 'concurrent-first-use-token', maxRetries: 0 });

		const [a, b] = await Promise.all([client.user('me').get(), client.user('me').get()]);
		expect(a.id).toBe(b.id);

		const all = await getRegistries().users.list();
		expect(all.filter((u) => u.token === 'concurrent-first-use-token')).toHaveLength(1);
	});

	it('fabricated users get local-user-{n} / 0000000000000000{n} identities, numbered in first-use order', async () => {
		const clientA = new ApifyClient({ baseUrl: server.baseUrl, token: 'fabricated-token-a', maxRetries: 0 });
		const clientB = new ApifyClient({ baseUrl: server.baseUrl, token: 'fabricated-token-b', maxRetries: 0 });

		const userA = await clientA.user('me').get();
		const userB = await clientB.user('me').get();

		expect(userA.username).toMatch(/^local-user-\d+$/);
		expect(userB.username).toMatch(/^local-user-\d+$/);
		expect(userA.username).not.toBe(userB.username);

		const numberOf = (username: string) => Number(/^local-user-(\d+)$/.exec(username)![1]);
		expect(userA.id).toBe(`0000000000000000${numberOf(userA.username)}`);
		expect(userB.id).toBe(`0000000000000000${numberOf(userB.username)}`);
		expect(numberOf(userB.username)).toBe(numberOf(userA.username) + 1);
	});

	it('the fabricated-number counter resumes after a simulated restart, never reusing a number already in the registry', async () => {
		const clientA = new ApifyClient({ baseUrl: server.baseUrl, token: 'restart-fabricated-a', maxRetries: 0 });
		const userA = await clientA.user('me').get();
		const numberOf = (username: string) => Number(/^local-user-(\d+)$/.exec(username)![1]);
		const numberA = numberOf(userA.username);

		// Simulate a process restart: forget every in-memory memo (token cache + fabricated counter) -
		// the `__USERS__` registry itself (this test's data directory) is untouched.
		usersService.resetUsersForTests();

		const clientB = new ApifyClient({ baseUrl: server.baseUrl, token: 'restart-fabricated-b', maxRetries: 0 });
		const userB = await clientB.user('me').get();

		expect(numberOf(userB.username)).toBe(numberA + 1);
		expect(userB.id).toBe(`0000000000000000${numberA + 1}`);
	});

	it("GET /users/:userId with the caller's own id returns the full self DTO", async () => {
		const me = await server.client.user('me').get();
		const byOwnId = await server.client.user(me.id).get();
		expect(byOwnId.id).toBe(me.id);
		expect(byOwnId.username).toBe(me.username);
	});

	it('GET /users/:userId resolves a *different*, already-known user to a minimal public DTO (no token/proxy)', async () => {
		const otherClient = new ApifyClient({ baseUrl: server.baseUrl, token: 'public-profile-token', maxRetries: 0 });
		const other = await otherClient.user('me').get();

		const seenByFirstUser = (await server.client.user(other.id).get()) as unknown as {
			id: string;
			username: string;
			proxy?: unknown;
			token?: unknown;
		};
		expect(seenByFirstUser.id).toBe(other.id);
		expect(seenByFirstUser.username).toBe(other.username);
		expect(seenByFirstUser.proxy).toBeUndefined();
		expect(seenByFirstUser.token).toBeUndefined();
	});

	it('GET /users/:userId 404s for an id that has never been seen', async () => {
		const missing = await server.client.user('totally-unknown-user-id-000').get();
		expect(missing).toBeUndefined();
	});

	it('auth() lets a getOrCreateUserForToken() rejection propagate to the generic error middleware: 500 + internal-error, and the underlying error is logged (regression: a local try/catch used to swallow it silently)', async () => {
		const boom = new Error('simulated getOrCreateUserForToken failure - e.g. a corrupted registry read');
		const spy = vi.spyOn(usersService, 'getOrCreateUserForToken').mockRejectedValueOnce(boom);
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

		spy.mockRestore();
		errorSpy.mockRestore();
	});
});

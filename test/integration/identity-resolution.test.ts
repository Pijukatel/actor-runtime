/**
 * Covers the real-platform identity probe (`services/identity-resolution.ts`'s `fetchRealIdentity`) and
 * its orchestration in `services/users.ts: getOrCreateUserForToken()`, against a stubbed upstream -
 * never real egress to `api.apify.com` (this sandbox's proxy blocks it anyway; see `cli.md`'s User
 * bootstrap section for the documented contract this exercises).
 *
 * Every test below authenticates with its own never-before-used token, so each test's identity
 * resolution is independent - `getOrCreateUserForToken`'s per-token cache is a module-level singleton
 * for the lifetime of this file's test run, and reusing a token across tests would let an earlier
 * test's outcome (adopted or fabricated) leak into a later one.
 */
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApifyClient } from 'apify-client';

import { startTestServer, type TestServerHandle } from './helpers/test-server.js';
import { getRegistries } from '../../src/storage/registries.js';
import type { Driver } from '../../src/driver/types.js';

interface StubUpstream {
	baseUrl: string;
	hitCount: () => number;
	close: () => Promise<void>;
}

/** Stands in for `https://api.apify.com`: always answers `GET /v2/users/me` with the given body, and
 * counts how many times it was hit so the once-per-token caching claim can be asserted directly. */
async function startStubUpstream(body: unknown, status = 200): Promise<StubUpstream> {
	let hits = 0;
	const server: Server = createServer((req, res) => {
		if (req.url === '/v2/users/me') {
			hits += 1;
			res.writeHead(status, { 'content-type': 'application/json' });
			res.end(JSON.stringify(body));
			return;
		}
		res.writeHead(404);
		res.end();
	});
	await new Promise<void>((resolve) => server.listen(0, resolve));
	const { port } = server.address() as AddressInfo;
	return {
		baseUrl: `http://127.0.0.1:${port}`,
		hitCount: () => hits,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

/** Same shape apify-client hands back for `.user(...).get()`, widened enough to read the fields these
 * tests care about without an `any`. */
type UserMeResponse = { id: string; username: string; proxy?: { password?: string } };

function clientWithToken(baseUrl: string, token: string): ApifyClient {
	return new ApifyClient({ baseUrl, token, maxRetries: 0 });
}

describe('identity resolution against the real platform (stubbed upstream)', () => {
	let server: TestServerHandle;
	let previousUpstreamUrl: string | undefined;

	beforeEach(async () => {
		server = await startTestServer();
		previousUpstreamUrl = process.env.APIFY_UPSTREAM_API_BASE_URL;
	});

	afterEach(async () => {
		if (previousUpstreamUrl === undefined) delete process.env.APIFY_UPSTREAM_API_BASE_URL;
		else process.env.APIFY_UPSTREAM_API_BASE_URL = previousUpstreamUrl;
		await server.close();
	});

	it('a never-before-seen token that resolves against the real platform gets a user whose real id/username/proxy password ARE its identity outright', async () => {
		const stub = await startStubUpstream({
			data: {
				id: 'real-user-id-1',
				username: 'real-username-1',
				proxy: { password: 'real-proxy-password-1' },
			},
		});
		process.env.APIFY_UPSTREAM_API_BASE_URL = stub.baseUrl;
		try {
			const client = clientWithToken(server.baseUrl, 'adopt-test-token');

			const me = (await client.user('me').get()) as unknown as UserMeResponse;
			expect(me.id).toBe('real-user-id-1');
			expect(me.username).toBe('real-username-1');
			expect(me.proxy?.password).toBe('real-proxy-password-1');

			// The record itself is keyed by (and owns) the real id - no separate internal id survives
			// alongside it.
			const stored = await getRegistries().users.get('real-user-id-1');
			expect(stored?.username).toBe('real-username-1');
			expect(stored?.token).toBe('adopt-test-token');

			// `/users/:userId` resolves the same real id straight back to the full self DTO.
			const byRealId = (await client.user('real-user-id-1').get()) as unknown as UserMeResponse;
			expect(byRealId.id).toBe('real-user-id-1');

			expect(stub.hitCount()).toBe(1);
		} finally {
			await stub.close();
		}
	});

	it('fabricates a local-user-{n} / 0000000000000000{n} identity, with no error and no proxy field, when the upstream is unreachable', async () => {
		process.env.APIFY_UPSTREAM_API_BASE_URL = 'http://127.0.0.1:1'; // nothing listens here
		const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
		try {
			const client = clientWithToken(server.baseUrl, 'offline-test-token');

			const me = (await client.user('me').get()) as unknown as UserMeResponse;
			expect(me.username).toMatch(/^local-user-\d+$/);
			expect(me.id).toMatch(/^0000000000000000\d+$/);
			// Never a placeholder password: with nothing known, `proxy` is omitted entirely.
			expect(me.proxy).toBeUndefined();

			expect(logSpy).toHaveBeenCalledTimes(1);
			expect(String(logSpy.mock.calls[0]?.[0])).toContain('using local identity');
		} finally {
			logSpy.mockRestore();
		}
	});

	it('resolves the upstream once per token, not once per request', async () => {
		const stub = await startStubUpstream({
			data: {
				id: 'cache-real-id',
				username: 'cache-real-username',
				proxy: { password: 'cache-proxy-password' },
			},
		});
		process.env.APIFY_UPSTREAM_API_BASE_URL = stub.baseUrl;
		try {
			const client = clientWithToken(server.baseUrl, 'cache-test-token');

			const first = (await client.user('me').get()) as unknown as UserMeResponse;
			const second = (await client.user('me').get()) as unknown as UserMeResponse;
			const third = (await client.user('me').get()) as unknown as UserMeResponse;

			expect(first.id).toBe('cache-real-id');
			expect(second.id).toBe('cache-real-id');
			expect(third.id).toBe('cache-real-id');
			expect(stub.hitCount()).toBe(1);
		} finally {
			await stub.close();
		}
	});

	it('a stored token maps back to its persisted user on a simulated restart, with no re-probe of the upstream', async () => {
		const stub = await startStubUpstream({
			data: {
				id: 'restart-real-id',
				username: 'restart-real-username',
				proxy: { password: 'restart-proxy-password' },
			},
		});
		process.env.APIFY_UPSTREAM_API_BASE_URL = stub.baseUrl;
		try {
			const client = clientWithToken(server.baseUrl, 'restart-token');
			const before = (await client.user('me').get()) as unknown as UserMeResponse;
			expect(stub.hitCount()).toBe(1);

			// Simulate a process restart: forget every in-memory memo (token cache + fabricated counter),
			// but the `__USERS__` registry itself (this test's `dataDir`) is untouched.
			const { resetUsersForTests } = await import('../../src/services/users.js');
			resetUsersForTests();

			const after = (await client.user('me').get()) as unknown as UserMeResponse;
			expect(after.id).toBe(before.id);
			expect(after.username).toBe(before.username);
			// No second hit: the stored token resolved straight from the registry, not a re-probe.
			expect(stub.hitCount()).toBe(1);
		} finally {
			await stub.close();
		}
	});
});

/** A driver that is "available" and records the env it was asked to run a container with (same idea as
 * `run-env-vars.test.ts`'s `envCapturingDriver`, duplicated here so this file's proxy-password-precedence
 * tests do not depend on that file's internals). */
function envCapturingDriver(): { driver: Driver; getCapturedEnv: () => Record<string, string> | undefined } {
	let capturedEnv: Record<string, string> | undefined;
	const driver: Driver = {
		available: true,
		unavailableReason: undefined,
		async init() {},
		async startBuild(_ctx, onLog) {
			onLog('build ok\n');
			return { imageId: 'fake-image:test' };
		},
		async abortBuild() {},
		async startRun(ctx, onLog) {
			capturedEnv = ctx.env;
			onLog('done\n');
			return { exitCode: 0 };
		},
		async abortRun() {},
		async reconcileOrphans() {},
		async probeDevFolder() {
			throw new Error('not used by this stub');
		},
		async ensureProbeImage() {
			throw new Error('not used by this stub');
		},
	};
	return { driver, getCapturedEnv: () => capturedEnv };
}

describe('harvested proxy password flows into Actor run containers, per user', () => {
	let server: TestServerHandle;
	let getCapturedEnv: () => Record<string, string> | undefined;
	let previousUpstreamUrl: string | undefined;
	let previousProxyPasswordEnv: string | undefined;

	beforeEach(async () => {
		const capturing = envCapturingDriver();
		getCapturedEnv = capturing.getCapturedEnv;
		server = await startTestServer(capturing.driver);
		previousUpstreamUrl = process.env.APIFY_UPSTREAM_API_BASE_URL;
		previousProxyPasswordEnv = process.env.APIFY_PROXY_PASSWORD;
	});

	afterEach(async () => {
		if (previousUpstreamUrl === undefined) delete process.env.APIFY_UPSTREAM_API_BASE_URL;
		else process.env.APIFY_UPSTREAM_API_BASE_URL = previousUpstreamUrl;
		if (previousProxyPasswordEnv === undefined) delete process.env.APIFY_PROXY_PASSWORD;
		else process.env.APIFY_PROXY_PASSWORD = previousProxyPasswordEnv;
		await server.close();
	});

	/** Drives one push+build+run through a client authenticated with `token`, then returns the run
	 * container's captured env - a fresh, never-before-seen `token` per test keeps each case's identity
	 * resolution independent (see the top-of-file note). */
	async function runOnceAndGetEnv(token: string): Promise<Record<string, string> | undefined> {
		const client = clientWithToken(server.baseUrl, token);
		const actor = await client.actors().create({ name: `proxy-precedence-${token}` });
		await client
			.actor(actor.id)
			.versions()
			.create({
				versionNumber: '0.0',
				buildTag: 'latest',
				sourceType: 'SOURCE_FILES' as never,
				sourceFiles: [],
			} as never);

		const build = await client.actor(actor.id).build('0.0', { waitForFinish: 5 });
		expect(build.status).toBe('SUCCEEDED');

		const run = await client.actor(actor.id).start({}, { waitForFinish: 5 });
		expect(run.status).toBe('SUCCEEDED');

		return getCapturedEnv();
	}

	it('uses the harvested proxy password when the runtime has no APIFY_PROXY_PASSWORD of its own', async () => {
		delete process.env.APIFY_PROXY_PASSWORD;
		const stub = await startStubUpstream({
			data: {
				id: 'proxy-harvest-id-1',
				username: 'proxy-harvest-username-1',
				proxy: { password: 'harvested-proxy-password' },
			},
		});
		process.env.APIFY_UPSTREAM_API_BASE_URL = stub.baseUrl;
		try {
			const env = await runOnceAndGetEnv('proxy-harvest-wins-token');
			expect(env?.APIFY_PROXY_PASSWORD).toBe('harvested-proxy-password');
		} finally {
			await stub.close();
		}
	});

	it("the runtime's own APIFY_PROXY_PASSWORD wins over the harvested value", async () => {
		const stub = await startStubUpstream({
			data: {
				id: 'proxy-harvest-id-2',
				username: 'proxy-harvest-username-2',
				proxy: { password: 'harvested-should-lose' },
			},
		});
		process.env.APIFY_UPSTREAM_API_BASE_URL = stub.baseUrl;
		process.env.APIFY_PROXY_PASSWORD = 'operator-configured-password';
		try {
			const env = await runOnceAndGetEnv('proxy-runtime-env-wins-token');
			expect(env?.APIFY_PROXY_PASSWORD).toBe('operator-configured-password');
		} finally {
			await stub.close();
		}
	});

	it('APIFY_PROXY_PASSWORD stays absent when offline and the runtime has none configured', async () => {
		delete process.env.APIFY_PROXY_PASSWORD;
		process.env.APIFY_UPSTREAM_API_BASE_URL = 'http://127.0.0.1:1';

		const env = await runOnceAndGetEnv('proxy-offline-absent-token');
		expect(env).toBeDefined();
		expect(Object.hasOwn(env!, 'APIFY_PROXY_PASSWORD')).toBe(false);
	});

	it('two different users each get their own harvested proxy password in their own runs', async () => {
		const stubA = await startStubUpstream({
			data: { id: 'proxy-user-a', username: 'proxy-username-a', proxy: { password: 'password-for-a' } },
		});
		process.env.APIFY_UPSTREAM_API_BASE_URL = stubA.baseUrl;
		delete process.env.APIFY_PROXY_PASSWORD;
		let envA: Record<string, string> | undefined;
		try {
			envA = await runOnceAndGetEnv('proxy-per-user-token-a');
		} finally {
			await stubA.close();
		}

		const stubB = await startStubUpstream({
			data: { id: 'proxy-user-b', username: 'proxy-username-b', proxy: { password: 'password-for-b' } },
		});
		process.env.APIFY_UPSTREAM_API_BASE_URL = stubB.baseUrl;
		let envB: Record<string, string> | undefined;
		try {
			envB = await runOnceAndGetEnv('proxy-per-user-token-b');
		} finally {
			await stubB.close();
		}

		expect(envA?.APIFY_PROXY_PASSWORD).toBe('password-for-a');
		expect(envB?.APIFY_PROXY_PASSWORD).toBe('password-for-b');
	});
});

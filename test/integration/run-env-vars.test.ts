import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { startTestServer, type TestServerHandle } from './helpers/test-server.js';
import { CONTAINER_EVENTS_WS_BASE_URL } from '../../src/config.js';
import type { Driver } from '../../src/driver/types.js';

/**
 * A driver that is "available" (unlike the default `unavailableDriver()`) and records the env it was
 * asked to run a container with, so `services/runs.ts: buildEnv()` can be exercised end to end without
 * a real Docker socket.
 */
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

describe('actor version envVars are applied to the run container env', () => {
	let server: TestServerHandle;
	let getCapturedEnv: () => Record<string, string> | undefined;

	beforeEach(async () => {
		const capturing = envCapturingDriver();
		getCapturedEnv = capturing.getCapturedEnv;
		server = await startTestServer(capturing.driver);
	});

	afterEach(async () => {
		await server.close();
	});

	it('merges version-level envVars into the container env, with platform-owned vars taking precedence', async () => {
		const actor = await server.client.actors().create({ name: 'env-vars-actor' });
		await server.client
			.actor(actor.id)
			.versions()
			.create({
				versionNumber: '0.0',
				buildTag: 'latest',
				sourceType: 'SOURCE_FILES' as never,
				sourceFiles: [],
				envVars: [
					{ name: 'MY_CUSTOM_VAR', value: 'hello' },
					// Deliberately tries to clobber a platform-owned var - the system value must win.
					{ name: 'APIFY_TOKEN', value: 'should-not-win' },
				],
			} as never);

		const build = await server.client.actor(actor.id).build('0.0', { waitForFinish: 5 });
		expect(build.status).toBe('SUCCEEDED');

		const run = await server.client.actor(actor.id).start({}, { waitForFinish: 5 });
		expect(run.status).toBe('SUCCEEDED');

		const env = getCapturedEnv();
		expect(env).toBeDefined();
		// Before the fix, `buildEnv()` never read `version.envVars` at all, so this was always undefined.
		expect(env?.MY_CUSTOM_VAR).toBe('hello');
		// The platform contract vars always win over a version's own envVars.
		expect(env?.APIFY_TOKEN).toBe(server.token);
		expect(env?.APIFY_TOKEN).not.toBe('should-not-win');
	});

	it('a version with no envVars still gets the full platform contract env', async () => {
		const actor = await server.client.actors().create({ name: 'no-env-vars-actor' });
		await server.client
			.actor(actor.id)
			.versions()
			.create({
				versionNumber: '0.0',
				buildTag: 'latest',
				sourceType: 'SOURCE_FILES' as never,
				sourceFiles: [],
			} as never);

		const build = await server.client.actor(actor.id).build('0.0', { waitForFinish: 5 });
		expect(build.status).toBe('SUCCEEDED');

		const run = await server.client.actor(actor.id).start({}, { waitForFinish: 5 });
		expect(run.status).toBe('SUCCEEDED');

		const env = getCapturedEnv();
		expect(env?.APIFY_IS_AT_HOME).toBe('1');
		expect(env?.APIFY_ACTOR_ID).toBe(actor.id);
	});

	it('APIFY_PROXY_PASSWORD is present in the run container env when the runtime itself was started with it set', async () => {
		const previous = process.env.APIFY_PROXY_PASSWORD;
		process.env.APIFY_PROXY_PASSWORD = 'super-secret-proxy-password';
		try {
			const actor = await server.client.actors().create({ name: 'proxy-password-present-actor' });
			await server.client
				.actor(actor.id)
				.versions()
				.create({
					versionNumber: '0.0',
					buildTag: 'latest',
					sourceType: 'SOURCE_FILES' as never,
					sourceFiles: [],
				} as never);

			const build = await server.client.actor(actor.id).build('0.0', { waitForFinish: 5 });
			expect(build.status).toBe('SUCCEEDED');

			const run = await server.client.actor(actor.id).start({}, { waitForFinish: 5 });
			expect(run.status).toBe('SUCCEEDED');

			// Before this test, only the "absent" arm of `buildEnv`'s `if (options.proxyPassword)` was
			// ever exercised (grepping the suite for `PROXY_PASSWORD` found zero hits) - this is the
			// "present" arm, covering `requirements/actor-driver.md`'s `APIFY_PROXY_PASSWORD` contract.
			expect(getCapturedEnv()?.APIFY_PROXY_PASSWORD).toBe('super-secret-proxy-password');
		} finally {
			if (previous === undefined) delete process.env.APIFY_PROXY_PASSWORD;
			else process.env.APIFY_PROXY_PASSWORD = previous;
		}
	});

	it('APIFY_PROXY_PASSWORD is absent from the run container env when the runtime was not started with it set', async () => {
		const previous = process.env.APIFY_PROXY_PASSWORD;
		delete process.env.APIFY_PROXY_PASSWORD;
		try {
			const actor = await server.client.actors().create({ name: 'proxy-password-absent-actor' });
			await server.client
				.actor(actor.id)
				.versions()
				.create({
					versionNumber: '0.0',
					buildTag: 'latest',
					sourceType: 'SOURCE_FILES' as never,
					sourceFiles: [],
				} as never);

			const build = await server.client.actor(actor.id).build('0.0', { waitForFinish: 5 });
			expect(build.status).toBe('SUCCEEDED');

			const run = await server.client.actor(actor.id).start({}, { waitForFinish: 5 });
			expect(run.status).toBe('SUCCEEDED');

			const env = getCapturedEnv();
			expect(env).toBeDefined();
			expect(Object.hasOwn(env!, 'APIFY_PROXY_PASSWORD')).toBe(false);
		} finally {
			if (previous === undefined) delete process.env.APIFY_PROXY_PASSWORD;
			else process.env.APIFY_PROXY_PASSWORD = previous;
		}
	});

	// The five new resource/telemetry env vars (`requirements/actor-driver.md`'s "Environment variables
	// in every Actor container" list): byte-identical pairs, the run id in the URL path with no query
	// string, present unconditionally (no dev mount involved anywhere in this describe block).
	it('sets the five resource/telemetry env vars, byte-identical pairs, run id in the URL path, no query string, present without a dev mount', async () => {
		const actor = await server.client.actors().create({ name: 'events-and-resources-env-actor' });
		await server.client
			.actor(actor.id)
			.versions()
			.create({
				versionNumber: '0.0',
				buildTag: 'latest',
				sourceType: 'SOURCE_FILES' as never,
				sourceFiles: [],
			} as never);

		const build = await server.client.actor(actor.id).build('0.0', { waitForFinish: 5 });
		expect(build.status).toBe('SUCCEEDED');

		const run = await server.client.actor(actor.id).start({}, { memory: 2048, waitForFinish: 5 });
		expect(run.status).toBe('SUCCEEDED');

		const env = getCapturedEnv();
		expect(env).toBeDefined();

		const expectedEventsUrl = `${CONTAINER_EVENTS_WS_BASE_URL}/actor-runtime/events/${run.id}`;
		expect(env?.ACTOR_EVENTS_WEBSOCKET_URL).toBe(expectedEventsUrl);
		expect(env?.APIFY_ACTOR_EVENTS_WS_URL).toBe(expectedEventsUrl);
		// Byte-identical to each other - the two SDKs resolve `ACTOR_*`-vs-`APIFY_*` in opposite
		// precedence order, so letting them ever diverge would size a run differently per SDK.
		expect(env?.ACTOR_EVENTS_WEBSOCKET_URL).toBe(env?.APIFY_ACTOR_EVENTS_WS_URL);

		// No token, no query string at all - this endpoint has no authentication (`api/events-ws.ts`).
		const parsedUrl = new URL(env!.ACTOR_EVENTS_WEBSOCKET_URL!.replace(/^ws:/, 'http:'));
		expect(parsedUrl.search).toBe('');
		expect(parsedUrl.pathname).toBe(`/actor-runtime/events/${run.id}`);

		expect(env?.ACTOR_MEMORY_MBYTES).toBe('2048');
		expect(env?.APIFY_MEMORY_MBYTES).toBe('2048');
		expect(env?.ACTOR_MEMORY_MBYTES).toBe(env?.APIFY_MEMORY_MBYTES);

		// 2048 / 4096 = 0.5 core - the same ratio the CPU limit itself uses (`services/resources.ts`).
		expect(env?.APIFY_DEDICATED_CPUS).toBe('0.5');
		// No `ACTOR_`-prefixed counterpart at all - apify-sdk-js's own `ENV_MAP` has no dedicated-CPU key.
		expect(Object.hasOwn(env!, 'ACTOR_DEDICATED_CPUS')).toBe(false);
	});

	it('the five vars are present for a run configured with only default options (no explicit memory/timeout, no dev mount)', async () => {
		const actor = await server.client.actors().create({ name: 'default-options-env-actor' });
		await server.client
			.actor(actor.id)
			.versions()
			.create({
				versionNumber: '0.0',
				buildTag: 'latest',
				sourceType: 'SOURCE_FILES' as never,
				sourceFiles: [],
			} as never);

		const build = await server.client.actor(actor.id).build('0.0', { waitForFinish: 5 });
		expect(build.status).toBe('SUCCEEDED');

		const run = await server.client.actor(actor.id).start({}, { waitForFinish: 5 });
		expect(run.status).toBe('SUCCEEDED');

		const env = getCapturedEnv();
		for (const key of [
			'ACTOR_EVENTS_WEBSOCKET_URL',
			'APIFY_ACTOR_EVENTS_WS_URL',
			'ACTOR_MEMORY_MBYTES',
			'APIFY_MEMORY_MBYTES',
			'APIFY_DEDICATED_CPUS',
		]) {
			expect(Object.hasOwn(env!, key)).toBe(true);
		}
		expect(env?.ACTOR_EVENTS_WEBSOCKET_URL).toContain(`/actor-runtime/events/${run.id}`);
	});
});

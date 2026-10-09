import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { capturingDriver, startTestServer, type TestServerHandle } from './helpers/test-server.js';
import { CONTAINER_EVENTS_WS_BASE_URL } from '../../src/config.js';
import { REAL_APIFY_PROXY_WARNING, setApifyProxyEnabled } from '../../src/services/apify-proxy.js';
import { getRegistries } from '../../src/storage/registries.js';

describe('actor version envVars are applied to the run container env', () => {
	let server: TestServerHandle;
	let getCapturedEnv: () => Record<string, string> | undefined;

	beforeEach(async () => {
		const capturing = capturingDriver();
		getCapturedEnv = () => capturing.captured.runEnv;
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
			const log = (await server.client.log(run.id).get()) ?? '';
			expect(log.split(REAL_APIFY_PROXY_WARNING).length - 1).toBe(1);
		} finally {
			if (previous === undefined) delete process.env.APIFY_PROXY_PASSWORD;
			else process.env.APIFY_PROXY_PASSWORD = previous;
		}
	});

	it('APIFY_PROXY_PASSWORD is empty, with no warning, when Use Apify Proxy is turned off - even with a password configured', async () => {
		const previous = process.env.APIFY_PROXY_PASSWORD;
		process.env.APIFY_PROXY_PASSWORD = 'super-secret-proxy-password';
		setApifyProxyEnabled(false);
		try {
			const actor = await server.client.actors().create({ name: 'proxy-disabled-actor' });
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

			expect(getCapturedEnv()?.APIFY_PROXY_PASSWORD).toBe('');
			expect((await server.client.log(run.id).get()) ?? '').not.toContain(REAL_APIFY_PROXY_WARNING);
			// The SDKs treat an empty `APIFY_PROXY_PASSWORD` as unset and ask `/users/me` for one instead.
			const me = await server.client.user('me').get();
			expect((me as unknown as { proxy?: unknown }).proxy).toBeUndefined();
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

		// 2048 / 4096 = 0.5 core - the same ratio the CPU limit itself uses (`resources.ts`).
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

describe('run metadata env vars (input key, build, user, timestamps), as on the platform', () => {
	let server: TestServerHandle;
	let getCapturedEnv: () => Record<string, string> | undefined;

	beforeEach(async () => {
		const capturing = capturingDriver();
		getCapturedEnv = () => capturing.captured.runEnv;
		server = await startTestServer(capturing.driver);
	});

	afterEach(async () => {
		await server.close();
	});

	async function seedBuiltActor(name: string) {
		const actor = await server.client.actors().create({ name });
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
		return actor;
	}

	it('tells the container its input key, build, owner and timestamps, in both spellings', async () => {
		const actor = await seedBuiltActor('env-metadata-actor');
		const me = await server.client.user('me').get();

		const run = await server.client.actor(actor.id).start({}, { timeout: 120, waitForFinish: 5 });
		expect(run.status).toBe('SUCCEEDED');

		const env = getCapturedEnv()!;
		expect(env.ACTOR_INPUT_KEY).toBe('INPUT');
		expect(env.APIFY_INPUT_KEY).toBe('INPUT');
		expect(env.ACTOR_BUILD_ID).toBe(run.buildId);
		expect(env.APIFY_ACTOR_BUILD_ID).toBe(run.buildId);
		expect(env.ACTOR_BUILD_NUMBER).toBe(run.buildNumber);
		expect(env.APIFY_ACTOR_BUILD_NUMBER).toBe(run.buildNumber);
		expect(env.ACTOR_BUILD_TAGS).toBe('latest');
		expect(env.APIFY_USER_ID).toBe(run.userId);
		expect(env.ACTOR_FULL_NAME).toBe(`${me.username}/env-metadata-actor`);
		// ISO 8601 UTC, as the platform documents its date-valued variables.
		expect(env.ACTOR_STARTED_AT).toBe(new Date(run.startedAt).toISOString());
		expect(env.APIFY_STARTED_AT).toBe(env.ACTOR_STARTED_AT);
		const expectedTimeoutAt = new Date(new Date(run.startedAt).getTime() + 120_000).toISOString();
		expect(env.ACTOR_TIMEOUT_AT).toBe(expectedTimeoutAt);
		expect(env.APIFY_TIMEOUT_AT).toBe(expectedTimeoutAt);
	});

	it('a run with no timeout gets no ACTOR_TIMEOUT_AT', async () => {
		const actor = await seedBuiltActor('env-no-timeout-actor');
		const run = await server.client.actor(actor.id).start({}, { timeout: 0, waitForFinish: 5 });
		expect(run.status).toBe('SUCCEEDED');

		const env = getCapturedEnv()!;
		expect(Object.hasOwn(env, 'ACTOR_TIMEOUT_AT')).toBe(false);
		expect(Object.hasOwn(env, 'APIFY_TIMEOUT_AT')).toBe(false);
		expect(env.ACTOR_STARTED_AT).toBe(new Date(run.startedAt).toISOString());
	});

	it('a resurrection keeps ACTOR_STARTED_AT and restarts the ACTOR_TIMEOUT_AT budget', async () => {
		const actor = await seedBuiltActor('env-resurrect-actor');
		const run = await server.client.actor(actor.id).start({}, { timeout: 120, waitForFinish: 5 });
		expect(run.status).toBe('SUCCEEDED');
		const firstEnv = getCapturedEnv()!;

		await server.client.run(run.id).resurrect();
		const resurrected = await server.client.run(run.id).waitForFinish({ waitSecs: 5 });
		expect(resurrected.status).toBe('SUCCEEDED');

		const record = await getRegistries().runs.get(run.id);
		expect(record?.resurrectedAt).toBeDefined();
		const env = getCapturedEnv()!;
		expect(env.ACTOR_STARTED_AT).toBe(firstEnv.ACTOR_STARTED_AT);
		expect(env.ACTOR_TIMEOUT_AT).toBe(new Date(Date.parse(record!.resurrectedAt!) + 120_000).toISOString());
		expect(env.APIFY_TIMEOUT_AT).toBe(env.ACTOR_TIMEOUT_AT);
	});
});

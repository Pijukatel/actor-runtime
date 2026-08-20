import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { startTestServer, type TestServerHandle } from './helpers/test-server.js';
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
			// "present" arm, success criterion 15's explicit contract.
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
});

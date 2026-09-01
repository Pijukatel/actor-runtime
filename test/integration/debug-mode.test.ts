/**
 * Integration coverage for the per-Actor debug-mode toggle (`api.md`'s `/actor-runtime/debug/:actorId`
 * section, `console.md`'s debug form, `actor-driver.md`'s "Debug mode" section): endpoint
 * auth/ownership/shape contract, that the toggle never leaks into any `/v2` response, persistence across
 * two separate runs, the console form's parity with the API, and the run-start language-resolution
 * wiring through the real `services/runs.ts` path (a controllable `inspectDebugTarget` stub standing in
 * for a real build's image, since there is no Docker daemon in this sandbox - `docker-driver.ts`'s class
 * doc comment). Real port publishing/debugpy injection is only exercised in
 * `test/e2e/debug-mode.test.ts`.
 */
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import axios from 'axios';

import { startTestServer, type TestServerHandle } from './helpers/test-server.js';
import { createConsoleServer } from '../../src/console/server.js';
import { getRegistries } from '../../src/storage/registries.js';
import { updateActor } from '../../src/services/actors.js';
import type { Driver, InspectedDebugTarget, RunContext } from '../../src/driver/types.js';

function post(baseUrl: string, actorId: string, body: unknown, token?: string) {
	return axios.post(`${baseUrl}/actor-runtime/debug/${actorId}`, body, {
		headers: token ? { Authorization: `Bearer ${token}` } : {},
		validateStatus: () => true,
	});
}

/**
 * A driver that is "available" and lets a test control exactly what `inspectDebugTarget` reports for
 * the run's resolved build, then captures every `startRun` call's `RunContext` - the debug-mode analog
 * of `run-env-vars.test.ts`'s `envCapturingDriver`. `startBuild` always succeeds with a fixed image id,
 * since these tests only care about the run-start path.
 */
function debugCapturingDriver(
	inspected: InspectedDebugTarget = { env: {} },
	imageWorkingDirectory?: string,
): {
	driver: Driver;
	getStartRunContexts: () => RunContext[];
	setInspectedTarget(next: InspectedDebugTarget): void;
} {
	let target = inspected;
	const startRunContexts: RunContext[] = [];
	const driver: Driver = {
		available: true,
		async init() {},
		async startBuild(_ctx, onLog) {
			onLog('build ok\n');
			return { imageId: 'fake-image:test', ...(imageWorkingDirectory ? { imageWorkingDirectory } : {}) };
		},
		async abortBuild() {},
		async startRun(ctx, onLog) {
			startRunContexts.push(ctx);
			onLog('done\n');
			return { exitCode: 0, timedOut: false };
		},
		async abortRun() {},
		async reconcileOrphans() {},
		async probeDevFolder() {
			throw new Error('not used by this stub');
		},
		async ensureProbeImage() {
			throw new Error('not used by this stub');
		},
		async inspectDebugTarget() {
			return target;
		},
	};
	return {
		driver,
		getStartRunContexts: () => startRunContexts,
		setInspectedTarget(next) {
			target = next;
		},
	};
}

async function pushAndBuild(server: TestServerHandle, name: string) {
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

describe('POST /actor-runtime/debug/:actorId', () => {
	let server: TestServerHandle;

	afterEach(async () => {
		await server.close();
	});

	it('401s with no auth token', async () => {
		server = await startTestServer();
		const res = await post(server.baseUrl, 'whatever-id', { enabled: true });
		expect(res.status).toBe(401);
	});

	it("404s for an actor id that doesn't exist", async () => {
		server = await startTestServer();
		const res = await post(server.baseUrl, 'totally-made-up-id', { enabled: true }, server.token);
		expect(res.status).toBe(404);
	});

	it("404s for another user's actor (ownership-scoped)", async () => {
		server = await startTestServer();
		const actor = await server.client.actors().create({ name: 'debug-other-users-actor' });
		const res = await post(server.baseUrl, actor.id, { enabled: true }, 'a-completely-different-token');
		expect(res.status).toBe(404);
	});

	it('{"enabled": true} with no overrides returns language "auto" and the nominal default port 5678', async () => {
		server = await startTestServer();
		const actor = await server.client.actors().create({ name: 'debug-default-actor' });

		const res = await post(server.baseUrl, actor.id, { enabled: true }, server.token);
		expect(res.status).toBe(200);
		expect(res.data.data).toEqual({ localDebug: { language: 'auto', port: 5678 } });
	});

	it('a body overriding both language and port is echoed back and persisted verbatim', async () => {
		server = await startTestServer();
		const actor = await server.client.actors().create({ name: 'debug-override-actor' });

		const res = await post(server.baseUrl, actor.id, { enabled: true, language: 'node', port: 9229 }, server.token);
		expect(res.status).toBe(200);
		expect(res.data.data).toEqual({ localDebug: { language: 'node', port: 9229 } });

		const stored = await getRegistries().actors.get(actor.id);
		expect(stored?.localDebug).toEqual({ language: 'node', port: 9229 });
	});

	it('{"enabled": false} clears a previous registration, returning localDebug: null', async () => {
		server = await startTestServer();
		const actor = await server.client.actors().create({ name: 'debug-clear-actor' });
		await post(server.baseUrl, actor.id, { enabled: true }, server.token);

		const res = await post(server.baseUrl, actor.id, { enabled: false }, server.token);
		expect(res.status).toBe(200);
		expect(res.data.data).toEqual({ localDebug: null });

		const stored = await getRegistries().actors.get(actor.id);
		expect(stored?.localDebug).toBeUndefined();
	});

	it('a second {"enabled": true} call fully replaces the first (no merge) - omitting language/port resets them to their own defaults', async () => {
		server = await startTestServer();
		const actor = await server.client.actors().create({ name: 'debug-replace-actor' });
		await post(server.baseUrl, actor.id, { enabled: true, language: 'node', port: 9230 }, server.token);

		const res = await post(server.baseUrl, actor.id, { enabled: true }, server.token);
		expect(res.status).toBe(200);
		expect(res.data.data).toEqual({ localDebug: { language: 'auto', port: 5678 } });
	});

	it('400s for an unknown field, and leaves the prior state untouched', async () => {
		server = await startTestServer();
		const actor = await server.client.actors().create({ name: 'debug-unknown-field-actor' });
		await post(server.baseUrl, actor.id, { enabled: true, language: 'python', port: 5678 }, server.token);

		const bad = await post(server.baseUrl, actor.id, { enabled: true, prot: 9229 }, server.token);
		expect(bad.status).toBe(400);
		expect(bad.data.error.type).toBe('invalid-request');
		expect(bad.data.error.message).toContain('prot');

		// Read the raw stored state directly - a follow-up POST would itself change it (this toggle's
		// accepted calls are full replaces, not merges), so it cannot be used to prove the REJECTED call
		// above left the prior state alone.
		const stored = await getRegistries().actors.get(actor.id);
		expect(stored?.localDebug).toEqual({ language: 'python', port: 5678 });
	});

	it('400s for a bad language value, an out-of-range port, and a non-object body', async () => {
		server = await startTestServer();
		const actor = await server.client.actors().create({ name: 'debug-bad-shapes-actor' });

		expect((await post(server.baseUrl, actor.id, { enabled: true, language: 'ruby' }, server.token)).status).toBe(
			400,
		);
		expect((await post(server.baseUrl, actor.id, { enabled: true, port: 80 }, server.token)).status).toBe(400);
		expect((await post(server.baseUrl, actor.id, [], server.token)).status).toBe(400);
	});

	it("registering debug mode never bumps the Actor's modifiedAt, on or off", async () => {
		server = await startTestServer();
		const actor = await server.client.actors().create({ name: 'debug-modifiedat-actor' });
		const before = (await getRegistries().actors.get(actor.id))!.modifiedAt;

		await post(server.baseUrl, actor.id, { enabled: true }, server.token);
		expect((await getRegistries().actors.get(actor.id))!.modifiedAt).toBe(before);

		await post(server.baseUrl, actor.id, { enabled: false }, server.token);
		expect((await getRegistries().actors.get(actor.id))!.modifiedAt).toBe(before);
	});

	it('never appears on the /v2 actor response (get or list)', async () => {
		server = await startTestServer();
		const actor = await server.client.actors().create({ name: 'debug-no-leak-actor' });
		await post(server.baseUrl, actor.id, { enabled: true, language: 'node', port: 9229 }, server.token);

		const fetched = await server.client.actor(actor.id).get();
		expect(fetched).not.toHaveProperty('localDebug');
		expect(JSON.stringify(fetched)).not.toContain('localDebug');

		const listed = await server.client.actors().list();
		expect(JSON.stringify(listed)).not.toContain('localDebug');
	});
});

describe('POST /v2/actor-runtime/debug/:actorId - the apify-api-hardcoded /v2 alias', () => {
	let server: TestServerHandle;

	afterEach(async () => {
		await server.close();
	});

	it('registers and reads back through the alias, the same handler as the canonical path', async () => {
		server = await startTestServer();
		const actor = await server.client.actors().create({ name: 'debug-alias-actor' });

		const res = await axios.post(
			`${server.baseUrl}/v2/actor-runtime/debug/${actor.id}`,
			{ enabled: true, language: 'python' },
			{ headers: { Authorization: `Bearer ${server.token}` }, validateStatus: () => true },
		);
		expect(res.status).toBe(200);
		expect(res.data.data).toEqual({ localDebug: { language: 'python', port: 5678 } });
	});
});

describe('console: debug-mode form on the Actor detail view', () => {
	let server: TestServerHandle;
	let consoleServer: Server;
	let consoleBaseUrl: string;

	async function setUpConsole(driver?: Driver): Promise<void> {
		server = await startTestServer(driver);
		const app = createConsoleServer({ driver: driver ?? server.driver });
		consoleServer = await new Promise((resolve) => {
			const s = app.listen(0, () => resolve(s));
		});
		consoleBaseUrl = `http://127.0.0.1:${(consoleServer.address() as AddressInfo).port}`;
	}

	afterEach(async () => {
		await new Promise<void>((resolve) => consoleServer.close(() => resolve()));
		await server.close();
	});

	it('renders "(debug mode is off)" and the form for an Actor with no toggle set yet', async () => {
		await setUpConsole();
		const actor = await server.client.actors().create({ name: 'debug-console-render-actor' });

		const detail = await axios.get(`${consoleBaseUrl}/actors/${actor.id}`);
		expect(detail.status).toBe(200);
		expect(detail.data).toContain('(debug mode is off)');
		expect(detail.data).toContain(`<form method="post" action="/actors/${actor.id}/debug">`);
	});

	it('submitting the form with enabled+language+port produces the same outcome the API would for the same input', async () => {
		await setUpConsole();
		const actor = await server.client.actors().create({ name: 'debug-console-submit-actor' });

		const submit = await axios.post(
			`${consoleBaseUrl}/actors/${actor.id}/debug`,
			'enabled=on&language=node&port=9229',
			{
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				maxRedirects: 0,
				validateStatus: () => true,
			},
		);
		expect(submit.status).toBe(302);
		expect(submit.headers.location).toBe(`/actors/${actor.id}`);

		const stored = await getRegistries().actors.get(actor.id);
		expect(stored?.localDebug).toEqual({ language: 'node', port: 9229 });

		const detail = await axios.get(`${consoleBaseUrl}/actors/${actor.id}`);
		expect(detail.data).toContain('node');
		expect(detail.data).toContain('9229');
	});

	it('submitting with "enabled" unchecked clears the toggle, same as {"enabled": false} on the API', async () => {
		await setUpConsole();
		const actor = await server.client.actors().create({ name: 'debug-console-clear-actor' });
		await post(server.baseUrl, actor.id, { enabled: true, language: 'python' }, server.token);

		const submit = await axios.post(`${consoleBaseUrl}/actors/${actor.id}/debug`, 'language=auto&port=', {
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			maxRedirects: 0,
			validateStatus: () => true,
		});
		expect(submit.status).toBe(302);

		const stored = await getRegistries().actors.get(actor.id);
		expect(stored?.localDebug).toBeUndefined();

		const detail = await axios.get(`${consoleBaseUrl}/actors/${actor.id}`);
		expect(detail.data).toContain('(debug mode is off)');
	});

	it('an invalid submission redirects back with the classified error shown inline, never silently applied', async () => {
		await setUpConsole();
		const actor = await server.client.actors().create({ name: 'debug-console-invalid-actor' });

		const submit = await axios.post(
			`${consoleBaseUrl}/actors/${actor.id}/debug`,
			'enabled=on&language=node&port=80',
			{
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				maxRedirects: 0,
				validateStatus: () => true,
			},
		);
		expect(submit.status).toBe(302);
		expect(submit.headers.location).toContain('debugModeError=');

		const stored = await getRegistries().actors.get(actor.id);
		expect(stored?.localDebug).toBeUndefined();
	});

	it('rejects a cross-site form submission with 403 and never touches the toggle', async () => {
		await setUpConsole();
		const actor = await server.client.actors().create({ name: 'debug-console-cross-site-actor' });

		const submit = await axios.post(
			`${consoleBaseUrl}/actors/${actor.id}/debug`,
			'enabled=on&language=node&port=9229',
			{
				headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Sec-Fetch-Site': 'cross-site' },
				maxRedirects: 0,
				validateStatus: () => true,
			},
		);
		expect(submit.status).toBe(403);

		const stored = await getRegistries().actors.get(actor.id);
		expect(stored?.localDebug).toBeUndefined();
	});

	it('a 404 for a nonexistent Actor id renders Not found, not a 500', async () => {
		await setUpConsole();
		const res = await axios.post(`${consoleBaseUrl}/actors/totally-made-up-id/debug`, 'enabled=on', {
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			validateStatus: () => true,
		});
		expect(res.status).toBe(404);
	});
});

describe('run-start debug-plan resolution (services/runs.ts, through the real startRun path)', () => {
	let server: TestServerHandle;

	afterEach(async () => {
		await server.close();
	});

	it('a non-debug Actor gets an unaffected RunContext - debug undefined, env carries no NODE_OPTIONS/PYTHONPATH addition, and the run record has no localDebug', async () => {
		const capturing = debugCapturingDriver();
		server = await startTestServer(capturing.driver);
		const actor = await pushAndBuild(server, 'run-nodebug-actor');

		const run = await server.client.actor(actor.id).start({}, { waitForFinish: 5 });
		expect(run.status).toBe('SUCCEEDED');
		expect(capturing.getStartRunContexts()[0]?.debug).toBeUndefined();

		const stored = await getRegistries().runs.get(run.id);
		expect(stored?.localDebug).toBeUndefined();
	});

	it('a debug-enabled Actor whose build resolves to node gets NODE_OPTIONS, the right ExposedPort target, and a persisted RunRecord.localDebug', async () => {
		const capturing = debugCapturingDriver({ cmd: ['node', 'dist/main.js'], env: {} });
		server = await startTestServer(capturing.driver);
		const actor = await pushAndBuild(server, 'run-debug-node-actor');
		await post(server.baseUrl, actor.id, { enabled: true }, server.token);

		const run = await server.client.actor(actor.id).start({}, { waitForFinish: 5 });
		expect(run.status).toBe('SUCCEEDED');

		const ctx = capturing.getStartRunContexts()[0]!;
		expect(ctx.debug).toEqual({ language: 'node', port: 9229 });
		expect(ctx.env.NODE_OPTIONS).toBe('--inspect-brk=0.0.0.0:9229');

		const stored = await getRegistries().runs.get(run.id);
		expect(stored?.localDebug).toEqual({ language: 'node', port: 9229 });
	});

	it('a debug-enabled Actor whose build resolves to python gets PYTHONPATH + the debug-port env var', async () => {
		const capturing = debugCapturingDriver({ cmd: ['python3', '-m', 'src'], env: {} });
		server = await startTestServer(capturing.driver);
		const actor = await pushAndBuild(server, 'run-debug-python-actor');
		await post(server.baseUrl, actor.id, { enabled: true, port: 5679 }, server.token);

		const run = await server.client.actor(actor.id).start({}, { waitForFinish: 5 });
		expect(run.status).toBe('SUCCEEDED');

		const ctx = capturing.getStartRunContexts()[0]!;
		expect(ctx.debug).toEqual({ language: 'python', port: 5679 });
		expect(ctx.env.PYTHONPATH).toBe('/opt/apify-debug');
		expect(ctx.env.APIFY_ACTOR_RUNTIME_DEBUG_PORT).toBe('5679');

		const stored = await getRegistries().runs.get(run.id);
		expect(stored?.localDebug).toEqual({ language: 'python', port: 5679 });
	});

	it('the toggle is not consumed by one run - two separate runs of the same debug-enabled Actor both resolve a plan', async () => {
		const capturing = debugCapturingDriver({ cmd: ['node', 'dist/main.js'], env: {} });
		server = await startTestServer(capturing.driver);
		const actor = await pushAndBuild(server, 'run-debug-twice-actor');
		await post(server.baseUrl, actor.id, { enabled: true }, server.token);

		const firstRun = await server.client.actor(actor.id).start({}, { waitForFinish: 5 });
		const secondRun = await server.client.actor(actor.id).start({}, { waitForFinish: 5 });
		expect(firstRun.status).toBe('SUCCEEDED');
		expect(secondRun.status).toBe('SUCCEEDED');

		const contexts = capturing.getStartRunContexts();
		expect(contexts).toHaveLength(2);
		expect(contexts[0]?.debug).toEqual({ language: 'node', port: 9229 });
		expect(contexts[1]?.debug).toEqual({ language: 'node', port: 9229 });
	});

	it('a package-manager-launched image (npm start) fails the run before startRun is ever called, with the classified message, and never persists a localDebug', async () => {
		const capturing = debugCapturingDriver({ cmd: ['npm', 'start'], env: { NODE_VERSION: '24.1.0' } });
		server = await startTestServer(capturing.driver);
		const actor = await pushAndBuild(server, 'run-debug-refused-npm-actor');
		await post(server.baseUrl, actor.id, { enabled: true }, server.token);

		const run = await server.client.actor(actor.id).start({}, { waitForFinish: 5 });
		expect(run.status).toBe('FAILED');
		expect(run.statusMessage).toContain('npm start');
		expect(run.statusMessage).toContain('Cannot start run:');
		expect(capturing.getStartRunContexts()).toHaveLength(0);

		const stored = await getRegistries().runs.get(run.id);
		expect(stored?.localDebug).toBeUndefined();

		const log = await axios.get(`${server.baseUrl}/v2/logs/${run.id}`, {
			headers: { Authorization: `Bearer ${server.token}` },
		});
		expect(log.data).toContain('npm start');
	});

	it('an unclassifiable image (language "auto", no recognizable command) fails the run, naming the language override', async () => {
		const capturing = debugCapturingDriver({ env: {} });
		server = await startTestServer(capturing.driver);
		const actor = await pushAndBuild(server, 'run-debug-refused-unclassifiable-actor');
		await post(server.baseUrl, actor.id, { enabled: true }, server.token);

		const run = await server.client.actor(actor.id).start({}, { waitForFinish: 5 });
		expect(run.status).toBe('FAILED');
		expect(run.statusMessage).toContain('language');
		expect(capturing.getStartRunContexts()).toHaveLength(0);
	});

	it('an explicit language override rescues an otherwise-unclassifiable image', async () => {
		const capturing = debugCapturingDriver({ env: {} });
		server = await startTestServer(capturing.driver);
		const actor = await pushAndBuild(server, 'run-debug-override-rescues-actor');
		await post(server.baseUrl, actor.id, { enabled: true, language: 'node' }, server.token);

		const run = await server.client.actor(actor.id).start({}, { waitForFinish: 5 });
		expect(run.status).toBe('SUCCEEDED');
		expect(capturing.getStartRunContexts()[0]?.debug).toEqual({ language: 'node', port: 9229 });
	});

	it('clearing debug mode between two runs makes the second run byte-identical to a never-toggled run (no debug field at all)', async () => {
		const capturing = debugCapturingDriver({ cmd: ['node', 'dist/main.js'], env: {} });
		server = await startTestServer(capturing.driver);
		const actor = await pushAndBuild(server, 'run-debug-then-cleared-actor');
		await post(server.baseUrl, actor.id, { enabled: true }, server.token);
		await server.client.actor(actor.id).start({}, { waitForFinish: 5 });

		await post(server.baseUrl, actor.id, { enabled: false }, server.token);
		const secondRun = await server.client.actor(actor.id).start({}, { waitForFinish: 5 });
		expect(secondRun.status).toBe('SUCCEEDED');

		const contexts = capturing.getStartRunContexts();
		expect(contexts[1]?.debug).toBeUndefined();
		expect(Object.hasOwn(contexts[1]!.env, 'NODE_OPTIONS')).toBe(false);
	});

	it('never appears on the /v2 run response (get) even though it is on the internal record', async () => {
		const capturing = debugCapturingDriver({ cmd: ['node', 'dist/main.js'], env: {} });
		server = await startTestServer(capturing.driver);
		const actor = await pushAndBuild(server, 'run-debug-no-leak-actor');
		await post(server.baseUrl, actor.id, { enabled: true }, server.token);

		const run = await server.client.actor(actor.id).start({}, { waitForFinish: 5 });
		expect(run.status).toBe('SUCCEEDED');

		const fetched = await server.client.run(run.id).get();
		expect(fetched).not.toHaveProperty('localDebug');
		expect(JSON.stringify(fetched)).not.toContain('localDebug');

		// Confirm the field really is on the internal record (i.e. this isn't a false negative from the
		// plan never having resolved at all).
		const stored = await getRegistries().runs.get(run.id);
		expect(stored?.localDebug).toBeDefined();
	});

	it('composes with the dev-folder bind mount - both RunContext.devMount and RunContext.debug are set on the same run, neither suppressing the other (actor-driver.md: "the two features are independent")', async () => {
		const capturing = debugCapturingDriver({ cmd: ['node', 'dist/main.js'], env: {} }, '/usr/src/app');
		server = await startTestServer(capturing.driver);
		const actor = await pushAndBuild(server, 'run-debug-and-devmount-actor');
		await post(server.baseUrl, actor.id, { enabled: true }, server.token);
		await updateActor(actor.id, (current) => ({ ...current, localDevFolder: '/abs/dev/src' }));

		const run = await server.client.actor(actor.id).start({}, { waitForFinish: 5 });
		expect(run.status).toBe('SUCCEEDED');

		const ctx = capturing.getStartRunContexts()[0]!;
		expect(ctx.devMount).toEqual({ localDevFolder: '/abs/dev/src', imageWorkingDirectory: '/usr/src/app' });
		expect(ctx.debug).toEqual({ language: 'node', port: 9229 });
		expect(ctx.env.NODE_OPTIONS).toBe('--inspect-brk=0.0.0.0:9229');
	});
});

describe('console: run page debug row', () => {
	let server: TestServerHandle;
	let consoleServer: Server;
	let consoleBaseUrl: string;

	afterEach(async () => {
		await new Promise<void>((resolve) => consoleServer.close(() => resolve()));
		await server.close();
	});

	it('shows "debug — <language>, attach at 127.0.0.1:<port>" for a run that resolved a debug plan', async () => {
		const capturing = debugCapturingDriver({ cmd: ['node', 'dist/main.js'], env: {} });
		server = await startTestServer(capturing.driver);
		const app = createConsoleServer({ driver: capturing.driver });
		consoleServer = await new Promise((resolve) => {
			const s = app.listen(0, () => resolve(s));
		});
		consoleBaseUrl = `http://127.0.0.1:${(consoleServer.address() as AddressInfo).port}`;

		const actor = await pushAndBuild(server, 'console-run-debug-row-actor');
		await post(server.baseUrl, actor.id, { enabled: true }, server.token);
		const run = await server.client.actor(actor.id).start({}, { waitForFinish: 5 });
		expect(run.status).toBe('SUCCEEDED');

		const detail = await axios.get(`${consoleBaseUrl}/runs/${run.id}`);
		expect(detail.data).toContain('node, attach at 127.0.0.1:9229');
	});

	it('shows no debug row at all for a non-debug run', async () => {
		const capturing = debugCapturingDriver();
		server = await startTestServer(capturing.driver);
		const app = createConsoleServer({ driver: capturing.driver });
		consoleServer = await new Promise((resolve) => {
			const s = app.listen(0, () => resolve(s));
		});
		consoleBaseUrl = `http://127.0.0.1:${(consoleServer.address() as AddressInfo).port}`;

		const actor = await pushAndBuild(server, 'console-run-nodebug-row-actor');
		const run = await server.client.actor(actor.id).start({}, { waitForFinish: 5 });
		expect(run.status).toBe('SUCCEEDED');

		const detail = await axios.get(`${consoleBaseUrl}/runs/${run.id}`);
		expect(detail.data).not.toContain('attach at 127.0.0.1');
	});
});

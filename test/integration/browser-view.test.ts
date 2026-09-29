/** Integration coverage for the per-Actor browser-view toggle (actor-driver.md: "Browser view"): endpoint
 * contract, `/v2` containment, persistence, console form parity, the run lifecycle through a stubbed
 * driver (sidecar started before the container, its address persisted, torn down after), the console's
 * viewer page and static noVNC client, and the console websocket bridge against a fake RFB server. The
 * real x11vnc sidecar is only exercised by `test/e2e/browser-view.test.ts`. */
import type { AddressInfo } from 'node:net';
import { createServer, type Server as NetServer, type Socket } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import axios from 'axios';
import WebSocket from 'ws';

import { startTestServer, type TestServerHandle } from './helpers/test-server.js';
import { createConsoleServer } from '../../src/console/server.js';
import { attachBrowserViewWebSocket, type BrowserViewWebSocketServer } from '../../src/console/browser-view-ws.js';
import { getRegistries } from '../../src/storage/registries.js';
import type { BrowserViewerHandle, BrowserViewerTarget, Driver, RunContext } from '../../src/driver/types.js';

function post(baseUrl: string, actorId: string, body: unknown, token?: string) {
	return axios.post(`${baseUrl}/actor-runtime/browser-view/${actorId}`, body, {
		headers: token ? { Authorization: `Bearer ${token}` } : {},
		validateStatus: () => true,
	});
}

/** An available driver whose `startBrowserViewer` returns a caller-supplied handle (or rejects), recording
 * the order of every lifecycle call so the "sidecar up before the container, down after" contract can be
 * asserted directly. */
function viewerCapturingDriver(
	handle: BrowserViewerHandle = { vncHost: '127.0.0.1', vncPort: 5901, x11SocketVolume: 'vol-test' },
	startError?: Error,
) {
	const events: string[] = [];
	const startRunContexts: RunContext[] = [];
	const viewerTargets: BrowserViewerTarget[] = [];
	const driver: Driver = {
		available: true,
		async init() {},
		async startBuild(_ctx, onLog) {
			onLog('build ok\n');
			return { imageId: 'fake-image:test' };
		},
		async abortBuild() {},
		async startRun(ctx, onLog) {
			events.push('startRun');
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
		async startBrowserViewer(target) {
			events.push('startBrowserViewer');
			viewerTargets.push(target);
			if (startError) throw startError;
			return handle;
		},
		async stopBrowserViewer(runId) {
			events.push(`stopBrowserViewer:${runId}`);
		},
		async containerServerAddress() {
			return undefined;
		},
		async inspectDebugTarget() {
			return { env: {} };
		},
	};
	return { driver, events, startRunContexts, viewerTargets };
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

describe('POST /actor-runtime/browser-view/:actorId', () => {
	let server: TestServerHandle;

	afterEach(async () => {
		await server.close();
	});

	it('401s with no auth token', async () => {
		server = await startTestServer();
		const res = await post(server.baseUrl, 'whatever-id', { enabled: true });
		expect(res.status).toBe(401);
	});

	it("404s for an actor id that doesn't exist, and for another user's actor", async () => {
		server = await startTestServer();
		expect((await post(server.baseUrl, 'made-up-id', { enabled: true }, server.token)).status).toBe(404);
		const actor = await server.client.actors().create({ name: 'bv-other-users-actor' });
		expect((await post(server.baseUrl, actor.id, { enabled: true }, 'a-different-token')).status).toBe(404);
	});

	it('{"enabled": true} turns view-only browser view on and echoes it back; interactive is opt-in', async () => {
		server = await startTestServer();
		const actor = await server.client.actors().create({ name: 'bv-default-actor' });

		const res = await post(server.baseUrl, actor.id, { enabled: true }, server.token);
		expect(res.status).toBe(200);
		expect(res.data).toEqual({ data: { localBrowserView: { interactive: false } } });

		const interactive = await post(server.baseUrl, actor.id, { enabled: true, interactive: true }, server.token);
		expect(interactive.data).toEqual({ data: { localBrowserView: { interactive: true } } });
		expect((await getRegistries().actors.get(actor.id))?.localBrowserView).toEqual({ interactive: true });
	});

	it('a later {"enabled": true} without interactive fully replaces the prior state (no merge)', async () => {
		server = await startTestServer();
		const actor = await server.client.actors().create({ name: 'bv-replace-actor' });
		await post(server.baseUrl, actor.id, { enabled: true, interactive: true }, server.token);

		const res = await post(server.baseUrl, actor.id, { enabled: true }, server.token);
		expect(res.data).toEqual({ data: { localBrowserView: { interactive: false } } });
	});

	it('{"enabled": false} clears the toggle, returning null, whatever else the body names', async () => {
		server = await startTestServer();
		const actor = await server.client.actors().create({ name: 'bv-clear-actor' });
		await post(server.baseUrl, actor.id, { enabled: true, interactive: true }, server.token);

		const res = await post(server.baseUrl, actor.id, { enabled: false, interactive: true }, server.token);
		expect(res.data).toEqual({ data: { localBrowserView: null } });
		expect((await getRegistries().actors.get(actor.id))?.localBrowserView).toBeUndefined();
	});

	it('400s for an unknown field, a non-boolean field, or a non-object body, leaving prior state untouched', async () => {
		server = await startTestServer();
		const actor = await server.client.actors().create({ name: 'bv-invalid-actor' });
		await post(server.baseUrl, actor.id, { enabled: true, interactive: true }, server.token);

		for (const body of [
			{ enabled: true, port: 5900 },
			{ enabled: 'yes' },
			{ enabled: true, interactive: 'yes' },
			'true',
		]) {
			const res = await post(server.baseUrl, actor.id, body, server.token);
			expect(res.status).toBe(400);
			expect(res.data.error.type).toBe('invalid-request');
		}
		expect((await getRegistries().actors.get(actor.id))?.localBrowserView).toEqual({ interactive: true });
	});

	it("never bumps the Actor's modifiedAt, on or off, and never appears on the /v2 actor response", async () => {
		server = await startTestServer();
		const actor = await server.client.actors().create({ name: 'bv-modifiedat-actor' });
		const before = (await getRegistries().actors.get(actor.id))!.modifiedAt;

		await post(server.baseUrl, actor.id, { enabled: true, interactive: true }, server.token);
		await post(server.baseUrl, actor.id, { enabled: false }, server.token);
		expect((await getRegistries().actors.get(actor.id))!.modifiedAt).toBe(before);

		await post(server.baseUrl, actor.id, { enabled: true }, server.token);
		const fetched = await server.client.actor(actor.id).get();
		expect(JSON.stringify(fetched)).not.toContain('localBrowserView');
		const listed = await server.client.actors().list();
		expect(JSON.stringify(listed)).not.toContain('localBrowserView');
	});

	it('is reachable through the apify-api-hardcoded /v2 alias too', async () => {
		server = await startTestServer();
		const actor = await server.client.actors().create({ name: 'bv-alias-actor' });
		const res = await axios.post(
			`${server.baseUrl}/v2/actor-runtime/browser-view/${actor.id}`,
			{ enabled: true },
			{ headers: { Authorization: `Bearer ${server.token}` } },
		);
		expect(res.data).toEqual({ data: { localBrowserView: { interactive: false } } });
	});
});

describe('console: browser-view form on the Actor detail view', () => {
	let server: TestServerHandle;
	let consoleServer: Server;
	let consoleBaseUrl: string;

	async function setUpConsole(): Promise<void> {
		server = await startTestServer();
		const app = createConsoleServer({ driver: server.driver });
		consoleServer = await new Promise((resolve) => {
			const s = app.listen(0, () => resolve(s));
		});
		consoleBaseUrl = `http://127.0.0.1:${(consoleServer.address() as AddressInfo).port}`;
	}

	afterEach(async () => {
		await new Promise<void>((resolve) => consoleServer.close(() => resolve()));
		await server.close();
	});

	const formHeaders = { 'Content-Type': 'application/x-www-form-urlencoded' };

	it('renders "(browser view is off)" and the form for an Actor with no toggle set yet', async () => {
		await setUpConsole();
		const actor = await server.client.actors().create({ name: 'bv-console-render-actor' });

		const detail = await axios.get(`${consoleBaseUrl}/actors/${actor.id}`);
		expect(detail.data).toContain('(browser view is off)');
		expect(detail.data).toContain(`<form method="post" action="/actors/${actor.id}/browser-view" data-autosave>`);
	});

	it('submitting enabled+interactive persists the same state the API would, and shows it', async () => {
		await setUpConsole();
		const actor = await server.client.actors().create({ name: 'bv-console-submit-actor' });

		const submit = await axios.post(
			`${consoleBaseUrl}/actors/${actor.id}/browser-view`,
			'enabled=on&interactive=on',
			{
				headers: formHeaders,
				maxRedirects: 0,
				validateStatus: () => true,
			},
		);
		expect(submit.status).toBe(302);
		expect(submit.headers.location).toBe(`/actors/${actor.id}`);
		expect((await getRegistries().actors.get(actor.id))?.localBrowserView).toEqual({ interactive: true });

		const detail = await axios.get(`${consoleBaseUrl}/actors/${actor.id}`);
		expect(detail.data).toContain('on, interactive');
	});

	it('submitting with "enabled" unchecked clears the toggle even with interactive checked', async () => {
		await setUpConsole();
		const actor = await server.client.actors().create({ name: 'bv-console-clear-actor' });
		await post(server.baseUrl, actor.id, { enabled: true, interactive: true }, server.token);

		const submit = await axios.post(`${consoleBaseUrl}/actors/${actor.id}/browser-view`, 'interactive=on', {
			headers: formHeaders,
			maxRedirects: 0,
			validateStatus: () => true,
		});
		expect(submit.status).toBe(302);
		expect((await getRegistries().actors.get(actor.id))?.localBrowserView).toBeUndefined();
	});

	it('rejects a cross-site form submission with 403 and never touches the toggle', async () => {
		await setUpConsole();
		const actor = await server.client.actors().create({ name: 'bv-console-cross-site-actor' });

		const submit = await axios.post(`${consoleBaseUrl}/actors/${actor.id}/browser-view`, 'enabled=on', {
			headers: { ...formHeaders, 'Sec-Fetch-Site': 'cross-site' },
			validateStatus: () => true,
		});
		expect(submit.status).toBe(403);
		expect((await getRegistries().actors.get(actor.id))?.localBrowserView).toBeUndefined();
	});

	it('a 404 for a nonexistent Actor id renders Not found, not a 500', async () => {
		await setUpConsole();
		const res = await axios.post(`${consoleBaseUrl}/actors/totally-made-up-id/browser-view`, 'enabled=on', {
			headers: formHeaders,
			validateStatus: () => true,
		});
		expect(res.status).toBe(404);
	});
});

describe('run lifecycle with browser view (services/runs.ts, through the real startRun path)', () => {
	let server: TestServerHandle;

	afterEach(async () => {
		await server.close();
	});

	it('an Actor without the toggle never touches the viewer: no startBrowserViewer, no x11SocketVolume, no localBrowserView on the record', async () => {
		const capturing = viewerCapturingDriver();
		server = await startTestServer(capturing.driver);
		const actor = await pushAndBuild(server, 'run-no-bv-actor');

		const run = await server.client.actor(actor.id).start({}, { waitForFinish: 5 });
		expect(run.status).toBe('SUCCEEDED');
		expect(capturing.events).toEqual(['startRun']);
		expect(capturing.startRunContexts[0]?.x11SocketVolume).toBeUndefined();
		expect((await getRegistries().runs.get(run.id))?.localBrowserView).toBeUndefined();
	});

	it('a toggled Actor: sidecar starts before the container and stops after it, the run mounts the volume, the record persists the mirror address, the log carries the viewer URL, and the env is untouched', async () => {
		const capturing = viewerCapturingDriver({ vncHost: '172.18.0.5', vncPort: 5900, x11SocketVolume: 'vol-x' });
		server = await startTestServer(capturing.driver);
		const actor = await pushAndBuild(server, 'run-bv-actor');
		await post(server.baseUrl, actor.id, { enabled: true, interactive: true }, server.token);

		const run = await server.client.actor(actor.id).start({}, { waitForFinish: 5 });
		expect(run.status).toBe('SUCCEEDED');

		expect(capturing.events).toEqual(['startBrowserViewer', 'startRun', `stopBrowserViewer:${run.id}`]);
		expect(capturing.viewerTargets).toEqual([{ runId: run.id, interactive: true }]);
		const ctx = capturing.startRunContexts[0]!;
		expect(ctx.x11SocketVolume).toBe('vol-x');
		// The container's environment is exactly an ordinary run's - nothing browser-view-specific leaks in.
		expect(Object.keys(ctx.env).some((key) => /BROWSER|VIEW|DISPLAY|HEADLESS/i.test(key))).toBe(false);

		const stored = await getRegistries().runs.get(run.id);
		expect(stored?.localBrowserView).toEqual({ interactive: true, vncHost: '172.18.0.5', vncPort: 5900 });

		const log = await server.client.run(run.id).log().get();
		// The URL carries its own color span (`runtime-log.ts`), so it is not contiguous with the text.
		expect(log).toContain(`Browser view: live mirror of this run's display at`);
		expect(log).toContain(`http://localhost:3000/runs/${run.id}/browser`);
		expect(log).toContain('interactive');

		// Never on the emulated /v2 run object.
		const fetched = await server.client.run(run.id).get();
		expect(JSON.stringify(fetched)).not.toContain('localBrowserView');
	});

	it('a sidecar that fails to start fails the run before any container exists, with the classified message naming the clear command', async () => {
		const capturing = viewerCapturingDriver(
			undefined,
			new Error("the runtime's browser-view sidecar payload is missing (ENOENT)."),
		);
		server = await startTestServer(capturing.driver);
		const actor = await pushAndBuild(server, 'run-bv-fail-actor');
		await post(server.baseUrl, actor.id, { enabled: true }, server.token);

		const run = await server.client.actor(actor.id).start({}, { waitForFinish: 5 });
		expect(run.status).toBe('FAILED');
		expect(run.statusMessage).toContain('Cannot start run: browser view is on for this Actor');
		expect(run.statusMessage).toContain('sidecar payload is missing');
		expect(run.statusMessage).toContain(
			`apify api POST /actor-runtime/browser-view/${actor.id} --body '{"enabled": false}'`,
		);
		expect(capturing.events).toEqual(['startBrowserViewer']);
		expect((await getRegistries().runs.get(run.id))?.localBrowserView).toBeUndefined();
	});

	it('clearing the toggle between two runs makes the second run byte-identical to a never-toggled run', async () => {
		const capturing = viewerCapturingDriver();
		server = await startTestServer(capturing.driver);
		const actor = await pushAndBuild(server, 'run-bv-clear-actor');
		await post(server.baseUrl, actor.id, { enabled: true }, server.token);
		await server.client.actor(actor.id).start({}, { waitForFinish: 5 });
		await post(server.baseUrl, actor.id, { enabled: false }, server.token);

		const second = await server.client.actor(actor.id).start({}, { waitForFinish: 5 });
		expect(capturing.startRunContexts[1]?.x11SocketVolume).toBeUndefined();
		expect((await getRegistries().runs.get(second.id))?.localBrowserView).toBeUndefined();
	});
});

describe('console: viewer page, run row, noVNC client, and the websocket bridge', () => {
	let server: TestServerHandle;
	let consoleServer: Server;
	let consoleBaseUrl: string;
	let bridge: BrowserViewWebSocketServer;
	let fakeVnc: NetServer | undefined;

	async function setUpConsole(driver: Driver): Promise<void> {
		server = await startTestServer(driver);
		const app = createConsoleServer({ driver });
		consoleServer = await new Promise((resolve) => {
			const s = app.listen(0, () => resolve(s));
		});
		bridge = attachBrowserViewWebSocket(consoleServer);
		consoleBaseUrl = `http://127.0.0.1:${(consoleServer.address() as AddressInfo).port}`;
	}

	/** A TCP server standing in for the sidecar's x11vnc: greets like an RFB server and echoes everything
	 * it receives, so both directions of the bridge can be asserted. */
	function startFakeVnc(): Promise<{ port: number; connections: Socket[] }> {
		const connections: Socket[] = [];
		fakeVnc = createServer((socket) => {
			connections.push(socket);
			socket.write('RFB 003.008\n');
			socket.on('data', (chunk) => socket.write(Buffer.concat([Buffer.from('echo:'), chunk])));
		});
		return new Promise((resolve) => {
			fakeVnc!.listen(0, '127.0.0.1', () => {
				resolve({ port: (fakeVnc!.address() as AddressInfo).port, connections });
			});
		});
	}

	afterEach(async () => {
		bridge?.close();
		await new Promise<void>((resolve) => consoleServer.close(() => resolve()));
		if (fakeVnc) {
			await new Promise<void>((resolve) => fakeVnc!.close(() => resolve()));
			fakeVnc = undefined;
		}
		await server.close();
	});

	/** Seeds a RUNNING run record with a mirror pointing at `vncPort`, without going through the driver -
	 * the bridge only ever reads the record. */
	async function seedRunningRunWithView(vncPort: number, interactive = false) {
		const actor = await server.client.actors().create({ name: `bv-ws-actor-${vncPort}` });
		const now = new Date().toISOString();
		const runId = `bv-run-${vncPort}-${interactive}`;
		await getRegistries().runs.set(runId, {
			id: runId,
			userId: actor.userId,
			actorId: actor.id,
			buildId: 'build-x',
			buildNumber: '0.0.1',
			status: 'RUNNING',
			startedAt: now,
			defaultDatasetId: 'ds',
			defaultKeyValueStoreId: 'kv',
			defaultRequestQueueId: 'rq',
			options: { memoryMbytes: 256, timeoutSecs: 300 },
			meta: { origin: 'API' },
			localBrowserView: { interactive, vncHost: '127.0.0.1', vncPort },
		});
		return runId;
	}

	function openWs(runId: string): Promise<WebSocket> {
		const ws = new WebSocket(`${consoleBaseUrl.replace('http', 'ws')}/runs/${runId}/browser/ws`);
		return new Promise((resolve, reject) => {
			ws.once('open', () => resolve(ws));
			ws.once('error', reject);
		});
	}

	function nextMessage(ws: WebSocket): Promise<Buffer> {
		return new Promise((resolve) => ws.once('message', (data) => resolve(Buffer.from(data as Buffer))));
	}

	function closeCode(ws: WebSocket): Promise<{ code: number; reason: string }> {
		return new Promise((resolve) =>
			ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() })),
		);
	}

	it('serves the noVNC ES-module client and its pako dependency from the installed package', async () => {
		await setUpConsole(viewerCapturingDriver().driver);
		const rfb = await axios.get(`${consoleBaseUrl}/vendor/novnc/core/rfb.js`);
		expect(rfb.status).toBe(200);
		expect(rfb.headers['content-type']).toMatch(/javascript/);
		expect(rfb.data).toContain('class RFB');
		const pako = await axios.get(`${consoleBaseUrl}/vendor/novnc/vendor/pako/lib/zlib/inflate.js`);
		expect(pako.status).toBe(200);
	});

	it('the run detail view links to the viewer page for a run with a mirror, and the page embeds the noVNC client for a live run', async () => {
		await setUpConsole(viewerCapturingDriver().driver);
		const runId = await seedRunningRunWithView(5999, true);

		const detail = await axios.get(`${consoleBaseUrl}/runs/${runId}`);
		expect(detail.data).toContain(`href="/runs/${runId}/browser"`);
		expect(detail.data).toContain('interactive live mirror');

		const page = await axios.get(`${consoleBaseUrl}/runs/${runId}/browser`);
		expect(page.status).toBe(200);
		expect(page.data).toContain("import RFB from '/vendor/novnc/core/rfb.js'");
		expect(page.data).toContain(`const runId = "${runId}";`);
		expect(page.data).toContain('const viewOnly = false;');
		expect(page.data).toContain('/browser/ws');
		// The one cause of a connected-but-black view, named on the page itself.
		expect(page.data).toContain(
			'A black picture means nothing is drawn on the display: the browser is running headless.',
		);
	});

	it('the viewer page explains itself for a run without a mirror (404) and for an ended run (200, no client)', async () => {
		const capturing = viewerCapturingDriver();
		await setUpConsole(capturing.driver);
		const actor = await pushAndBuild(server, 'bv-page-ended-actor');

		const plain = await server.client.actor(actor.id).start({}, { waitForFinish: 5 });
		const noView = await axios.get(`${consoleBaseUrl}/runs/${plain.id}/browser`, { validateStatus: () => true });
		expect(noView.status).toBe(404);
		expect(noView.data).toContain('Browser view was not on for this run');

		await post(server.baseUrl, actor.id, { enabled: true }, server.token);
		const viewed = await server.client.actor(actor.id).start({}, { waitForFinish: 5 });
		expect(viewed.status).toBe('SUCCEEDED');
		const ended = await axios.get(`${consoleBaseUrl}/runs/${viewed.id}/browser`);
		expect(ended.status).toBe(200);
		expect(ended.data).toContain('This run has ended');
		expect(ended.data).not.toContain('rfb.js');
		// The run detail still links to it after the fact.
		const detail = await axios.get(`${consoleBaseUrl}/runs/${viewed.id}`);
		expect(detail.data).toContain(`href="/runs/${viewed.id}/browser"`);
	});

	it("bridges bytes both ways between the websocket and the mirror's TCP port, and closes 1000 when the TCP side goes away", async () => {
		await setUpConsole(viewerCapturingDriver().driver);
		const { port, connections } = await startFakeVnc();
		const runId = await seedRunningRunWithView(port);

		const ws = await openWs(runId);
		const greeting = await nextMessage(ws);
		expect(greeting.toString()).toBe('RFB 003.008\n');

		ws.send(Buffer.from('RFB 003.008\n'));
		const echoed = await nextMessage(ws);
		expect(echoed.toString()).toBe('echo:RFB 003.008\n');

		const closed = closeCode(ws);
		for (const connection of connections) connection.destroy();
		expect((await closed).code).toBe(1000);
	});

	it('closes 1008 with a reason for an unknown run, a run without a mirror, and an ended run', async () => {
		const capturing = viewerCapturingDriver();
		await setUpConsole(capturing.driver);

		const unknown = await openWs('no-such-run');
		expect((await closeCode(unknown)).reason).toContain('Unknown run id');

		const actor = await pushAndBuild(server, 'bv-ws-1008-actor');
		const plain = await server.client.actor(actor.id).start({}, { waitForFinish: 5 });
		const noView = await openWs(plain.id);
		expect(await closeCode(noView)).toEqual({ code: 1008, reason: `Browser view was not on for run ${plain.id}` });

		await post(server.baseUrl, actor.id, { enabled: true }, server.token);
		const viewed = await server.client.actor(actor.id).start({}, { waitForFinish: 5 });
		const ended = await openWs(viewed.id);
		expect(await closeCode(ended)).toEqual({ code: 1008, reason: `Run ${viewed.id} has already ended` });
	});

	it('keeps retrying the TCP dial while the mirror is not up yet, so a viewer that connects early still gets through', async () => {
		await setUpConsole(viewerCapturingDriver().driver);
		// Reserve a port, then release it so nothing listens there until the fake server starts below.
		const probe = createServer();
		const port: number = await new Promise((resolve) =>
			probe.listen(0, '127.0.0.1', () => resolve((probe.address() as AddressInfo).port)),
		);
		await new Promise<void>((resolve) => probe.close(() => resolve()));
		const runId = await seedRunningRunWithView(port);

		const ws = await openWs(runId);
		const greeting = nextMessage(ws);
		// Only now does the "sidecar" start listening.
		await new Promise((resolve) => setTimeout(resolve, 700));
		fakeVnc = createServer((socket) => socket.write('RFB 003.008\n'));
		await new Promise<void>((resolve) => fakeVnc!.listen(port, '127.0.0.1', () => resolve()));

		expect((await greeting).toString()).toBe('RFB 003.008\n');
		ws.close();
	});

	it('a live run of a toggled Actor whose sidecar is still starting: the page renders the client and the bridge waits for the mirror address instead of reporting "not on"', async () => {
		await setUpConsole(viewerCapturingDriver().driver);
		const { port } = await startFakeVnc();
		const actor = await server.client.actors().create({ name: 'bv-ws-pending-actor' });
		await post(server.baseUrl, actor.id, { enabled: true }, server.token);
		const runId = 'bv-run-pending';
		// The window `services/runs.ts` leaves between creating the record and the sidecar coming up.
		await getRegistries().runs.set(runId, {
			id: runId,
			userId: actor.userId,
			actorId: actor.id,
			buildId: 'build-x',
			buildNumber: '0.0.1',
			status: 'RUNNING',
			startedAt: new Date().toISOString(),
			defaultDatasetId: 'ds',
			defaultKeyValueStoreId: 'kv',
			defaultRequestQueueId: 'rq',
			options: { memoryMbytes: 256, timeoutSecs: 300 },
			meta: { origin: 'API' },
		});

		const page = await axios.get(`${consoleBaseUrl}/runs/${runId}/browser`);
		expect(page.status).toBe(200);
		expect(page.data).toContain("import RFB from '/vendor/novnc/core/rfb.js'");

		const ws = await openWs(runId);
		const greeting = nextMessage(ws);
		await new Promise((resolve) => setTimeout(resolve, 800));
		// The sidecar comes up: the record gets its mirror address, and the waiting bridge dials it.
		await getRegistries().runs.update(runId, (current) =>
			current
				? { ...current, localBrowserView: { interactive: false, vncHost: '127.0.0.1', vncPort: port } }
				: current,
		);
		expect((await greeting).toString()).toBe('RFB 003.008\n');
		ws.close();
	});

	it('a live run without a mirror whose Actor has no toggle is refused at once with "not on", and its page is a 404', async () => {
		await setUpConsole(viewerCapturingDriver().driver);
		const actor = await server.client.actors().create({ name: 'bv-ws-untoggled-actor' });
		const runId = 'bv-run-untoggled';
		await getRegistries().runs.set(runId, {
			id: runId,
			userId: actor.userId,
			actorId: actor.id,
			buildId: 'build-x',
			buildNumber: '0.0.1',
			status: 'RUNNING',
			startedAt: new Date().toISOString(),
			defaultDatasetId: 'ds',
			defaultKeyValueStoreId: 'kv',
			defaultRequestQueueId: 'rq',
			options: { memoryMbytes: 256, timeoutSecs: 300 },
			meta: { origin: 'API' },
		});
		const ws = await openWs(runId);
		expect(await closeCode(ws)).toEqual({ code: 1008, reason: `Browser view is not on for run ${runId}` });
		const page = await axios.get(`${consoleBaseUrl}/runs/${runId}/browser`, { validateStatus: () => true });
		expect(page.status).toBe(404);
	});

	it('an upgrade on any other console path is refused outright', async () => {
		await setUpConsole(viewerCapturingDriver().driver);
		const ws = new WebSocket(`${consoleBaseUrl.replace('http', 'ws')}/runs/whatever/events`);
		const failed = await new Promise<boolean>((resolve) => {
			ws.once('error', () => resolve(true));
			ws.once('open', () => resolve(false));
		});
		expect(failed).toBe(true);
	});
});

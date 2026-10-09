/**
 * Run web server (`actor-driver.md`, `api.md`, `console.md`): every run's `containerUrl`, the env vars
 * that tell the Actor about it, the container-URL router forwarding requests to the server inside the
 * run's container, and the console's link to it. The driver stub runs each "container" as a
 * real local HTTP server, so every request crosses a real proxy hop.
 */
import http, { type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';

import { startTestServer, type TestServerHandle } from './helpers/test-server.js';
import { getRegistries } from '../../src/storage/registries.js';
import { generateId } from '../../src/storage/ids.js';
import { recordTaggedBuild, updateActor } from '../../src/services/actors.js';
import { getFullLog } from '../../src/services/logs.js';
import { createConsoleServer } from '../../src/console/server.js';
import type { ContainerServerAddress, Driver, RunContext, RunOutcome } from '../../src/driver/types.js';
import type { ActorRecord, BuildRecord } from '../../src/storage/entities.js';

interface FakeContainer {
	ctx: RunContext;
	server?: Server;
	address?: ContainerServerAddress;
	finish(outcome: RunOutcome): void;
}

interface ServerDriver extends Driver {
	containers: FakeContainer[];
	/** `false`: the started "container" never listens - an Actor with no web server. */
	listens: boolean;
}

/** Every started "container" echoes each request back as JSON, and answers websocket upgrades. */
function serverDriver(): ServerDriver {
	const containers: FakeContainer[] = [];
	const driver: ServerDriver = {
		available: true,
		containers,
		listens: true,
		async init() {},
		async startBuild() {
			throw new Error('not used by this stub');
		},
		async abortBuild() {},
		startRun(ctx) {
			return new Promise<RunOutcome>((resolve) => {
				const container: FakeContainer = {
					ctx,
					finish: (outcome) => {
						container.server?.closeAllConnections();
						container.server?.close();
						container.address = undefined;
						resolve(outcome);
					},
				};
				containers.push(container);
				const server = http.createServer((req, res) => {
					const chunks: Buffer[] = [];
					req.on('data', (chunk: Buffer) => chunks.push(chunk));
					req.on('end', () => {
						res.setHeader('content-type', 'application/json');
						res.setHeader('x-from-actor', 'yes');
						res.end(
							JSON.stringify({
								runId: ctx.runId,
								method: req.method,
								url: req.url,
								headers: req.headers,
								body: Buffer.concat(chunks).toString('utf8'),
							}),
						);
					});
				});
				const wss = new WebSocketServer({ server });
				wss.on('connection', (ws, req: IncomingMessage) => {
					ws.on('message', (data) => ws.send(`${req.url} ${String(data)}`));
				});
				if (driver.listens) {
					server.listen(0, '127.0.0.1', () => {
						container.server = server;
						container.address = { host: '127.0.0.1', port: (server.address() as AddressInfo).port };
					});
				} else {
					// The container is up and its address known, but nothing listens on the port.
					const probe = http.createServer();
					probe.listen(0, '127.0.0.1', () => {
						const { port } = probe.address() as AddressInfo;
						probe.close(() => {
							container.address = { host: '127.0.0.1', port };
						});
					});
				}
			});
		},
		async abortRun(runId) {
			containers.find((c) => c.ctx.runId === runId)?.finish({ exitCode: 137, timedOut: false });
		},
		async reconcileOrphans() {},
		async probeDevFolder() {
			throw new Error('not used by this stub');
		},
		async ensureProbeImage() {
			throw new Error('not used by this stub');
		},
		async startBrowserViewer() {
			throw new Error('not used by this stub');
		},
		async stopBrowserViewer() {},
		async inspectDebugTarget() {
			throw new Error('not used by this stub');
		},
		async containerServerAddress(runId) {
			return containers.find((c) => c.ctx.runId === runId)?.address;
		},
	};
	return driver;
}

async function seedBuild(actor: ActorRecord): Promise<BuildRecord> {
	const build: BuildRecord = {
		id: generateId(),
		userId: actor.userId,
		actorId: actor.id,
		versionNumber: '0.0',
		buildNumber: '0.0.1',
		tag: 'latest',
		status: 'SUCCEEDED',
		startedAt: new Date().toISOString(),
		finishedAt: new Date().toISOString(),
		imageId: 'fake-image',
	};
	await getRegistries().builds.set(build.id, build);
	await updateActor(actor.id, (current) => recordTaggedBuild(current, 'latest', build.id, build.buildNumber));
	return build;
}

async function waitUntil<T>(probe: () => Promise<T | undefined> | T | undefined, timeoutMs = 10_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await probe();
		if (value) return value;
		if (Date.now() > deadline) throw new Error('timed out waiting');
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

interface RunWithContainerUrl {
	id: string;
	status: string;
	containerUrl: string;
}

/** A request sent the way a browser does to a `*.runs.localhost` URL: to loopback, with the URL's host in `Host`. */
function requestByHost(
	baseUrl: string,
	containerUrl: string,
	path: string,
	headers: Record<string, string> = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
	const { port } = new URL(baseUrl);
	const { host } = new URL(containerUrl);
	return new Promise((resolve, reject) => {
		http.get({ host: '127.0.0.1', port, path, headers: { host, ...headers } }, (res) => {
			let body = '';
			res.on('data', (chunk) => (body += chunk));
			res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
		}).on('error', reject);
	});
}

describe('run web server (containerUrl)', () => {
	let server: TestServerHandle;
	let driver: ServerDriver;
	afterEach(async () => {
		for (const container of driver?.containers ?? []) container.finish({ exitCode: 0, timedOut: false });
		// Every run must be finalized before the storage it writes to is torn down.
		await waitUntil(async () =>
			(await getRegistries().runs.list()).every((run) => ['SUCCEEDED', 'FAILED', 'ABORTED'].includes(run.status)),
		);
		await server?.close();
	});

	async function startedRun(): Promise<{ actor: ActorRecord; run: RunWithContainerUrl; container: FakeContainer }> {
		const created = await server.client.actors().create({ name: 'web-actor' });
		const actor = (await getRegistries().actors.get(created.id))!;
		await seedBuild(actor);
		const run = (await server.client.actor(actor.id).start({})) as unknown as RunWithContainerUrl;
		const container = await waitUntil(() => driver.containers.find((c) => c.ctx.runId === run.id && c.address));
		return { actor, run, container };
	}

	it('gives every run a containerUrl, the Actor its web server env vars, and the run log the URL', async () => {
		driver = serverDriver();
		server = await startTestServer(driver);
		const { run, container } = await startedRun();

		expect(run.containerUrl).toBe(`http://${run.id.toLowerCase()}.runs.localhost:3333`);
		const { ctx } = container;
		expect(ctx.containerServerPort).toBe(4321);
		expect(ctx.containerServerRequired).toBe(false);
		expect(ctx.env).toMatchObject({
			ACTOR_WEB_SERVER_PORT: '4321',
			APIFY_CONTAINER_PORT: '4321',
			ACTOR_WEB_SERVER_URL: run.containerUrl,
			APIFY_CONTAINER_URL: run.containerUrl,
		});
		const log = await waitUntil(async () => {
			const text = await getFullLog(run.id);
			return text.includes('Web server:') ? text : undefined;
		});
		// The runtime colors the URL; the ANSI codes are stripped before asserting.
		// eslint-disable-next-line no-control-regex
		expect(log.replace(/\x1b\[[0-9;]*m/g, '')).toContain(`is served at ${run.containerUrl} (live view).`);

		// The run object read from inside a container carries the path form on the API alias.
		const fromContainer = await new Promise<string>((resolve, reject) => {
			const { port } = new URL(server.baseUrl);
			http.get(
				{
					host: '127.0.0.1',
					port,
					path: `/v2/actor-runs/${run.id}?token=${server.token}`,
					headers: { host: 'apify-api:3333' },
				},
				(res) => {
					let body = '';
					res.on('data', (chunk) => (body += chunk));
					res.on('end', () => resolve(JSON.parse(body).data.containerUrl));
				},
			).on('error', reject);
		});
		expect(fromContainer).toBe(`http://apify-api:3333/actor-runtime/container/${run.id}`);
		// Listed runs carry it too.
		const listed = await server.client.runs().list();
		expect((listed.items[0] as unknown as RunWithContainerUrl).containerUrl).toBe(run.containerUrl);
	});

	it("forwards method, path, query, headers, body and websockets to the run's server, unauthenticated", async () => {
		driver = serverDriver();
		server = await startTestServer(driver);
		const { run } = await startedRun();
		const pathForm = `${server.baseUrl}/actor-runtime/container/${run.id}`;

		const res = await fetch(`${pathForm}/search/items?q=1`, {
			method: 'POST',
			headers: { 'content-type': 'text/plain', 'x-custom': 'c' },
			body: 'hello',
		});
		expect(res.status).toBe(200);
		expect(res.headers.get('x-from-actor')).toBe('yes');
		const echoed = (await res.json()) as {
			runId: string;
			method: string;
			url: string;
			headers: Record<string, string>;
			body: string;
		};
		expect(echoed).toMatchObject({ runId: run.id, method: 'POST', url: '/search/items?q=1', body: 'hello' });
		expect(echoed.headers['x-custom']).toBe('c');

		// The host form, as a browser sends it: the run owns `/`.
		const byHost = await requestByHost(server.baseUrl, run.containerUrl, '/deep/path?x=1');
		expect(byHost.status).toBe(200);
		expect(JSON.parse(byHost.body)).toMatchObject({ runId: run.id, url: '/deep/path?x=1' });
		const root = await requestByHost(server.baseUrl, run.containerUrl, '/');
		expect(JSON.parse(root.body).url).toBe('/');

		const ws = new WebSocket(`${pathForm.replace('http', 'ws')}/socket`);
		const reply = await new Promise<string>((resolve, reject) => {
			ws.on('open', () => ws.send('ping'));
			ws.on('message', (data) => resolve(String(data)));
			ws.on('error', reject);
		});
		ws.close();
		expect(reply).toBe('/socket ping');
	});

	it('answers an unknown run, a run without a listening server, and a finished run each with its own error', async () => {
		driver = serverDriver();
		driver.listens = false;
		server = await startTestServer(driver);
		const { run } = await startedRun();

		const unknown = await fetch(`${server.baseUrl}/actor-runtime/container/nosuchrun/`);
		expect(unknown.status).toBe(404);
		expect(((await unknown.json()) as { error: { type: string } }).error.type).toBe('record-not-found');

		// Nothing listens: a JSON client is told to retry, a browser gets a page that retries by itself.
		const notReady = await fetch(`${server.baseUrl}/actor-runtime/container/${run.id}/`);
		expect(notReady.status).toBe(503);
		expect(notReady.headers.get('retry-after')).toBe('3');
		const notReadyBody = (await notReady.json()) as { error: { type: string; message: string } };
		expect(notReadyBody.error.type).toBe('web-server-not-ready');
		expect(notReadyBody.error.message).toContain('ACTOR_WEB_SERVER_PORT');
		const page = await requestByHost(server.baseUrl, run.containerUrl, '/', { accept: 'text/html,*/*' });
		expect(page.status).toBe(503);
		expect(page.headers['content-type']).toContain('text/html');
		expect(page.body).toContain('<meta http-equiv="refresh" content="3">');
		expect(page.body).toContain('Nothing is listening');

		await server.client.run(run.id).abort();
		await waitUntil(async () => (await server.client.run(run.id).get())?.status === 'ABORTED');
		const finished = await fetch(`${server.baseUrl}/actor-runtime/container/${run.id}/`);
		expect(finished.status).toBe(410);
		expect(((await finished.json()) as { error: { type: string } }).error.type).toBe('run-finished');
		const finishedPage = await requestByHost(server.baseUrl, run.containerUrl, '/', { accept: 'text/html' });
		expect(finishedPage.status).toBe(410);
		expect(finishedPage.body).not.toContain('http-equiv="refresh"');
		// The URL stays on the finished run's object.
		expect(((await server.client.run(run.id).get()) as unknown as RunWithContainerUrl).containerUrl).toBe(
			run.containerUrl,
		);
	});

	it('links the containerUrl, as the live view, on the run page', async () => {
		driver = serverDriver();
		server = await startTestServer(driver);
		const { run } = await startedRun();

		const consoleServer = await new Promise<Server>((resolve) => {
			const s = createConsoleServer({ driver }).listen(0, () => resolve(s));
		});
		try {
			const { port } = consoleServer.address() as AddressInfo;
			const runHtml = await (await fetch(`http://127.0.0.1:${port}/runs/${run.id}`)).text();
			expect(runHtml).toContain('containerUrl (live view)');
			expect(runHtml).toContain(`href="${run.containerUrl}"`);
			expect(runHtml).not.toContain('/live-view');
		} finally {
			await new Promise((resolve) => consoleServer.close(resolve));
		}
	});
});

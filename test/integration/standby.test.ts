/**
 * Actor Standby (`actor-driver.md`, `api.md`): the `actorStandby` Actor field, and the standby router
 * forwarding requests to standby runs it starts, scales and winds down. The driver stub runs each
 * "container" as a real local HTTP server, so every request crosses a real proxy hop.
 */
import http, { type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';

import { startTestServer, type TestServerHandle } from './helpers/test-server.js';
import { getRegistries } from '../../src/storage/registries.js';
import { generateId } from '../../src/storage/ids.js';
import { recordTaggedBuild, updateActor } from '../../src/services/actors.js';
import { configureStandbyForTests, READINESS_PROBE_HEADER } from '../../src/services/standby.js';
import { subscribeEvents } from '../../src/services/events-channel.js';
import { getFullLog } from '../../src/services/logs.js';
import { createConsoleServer } from '../../src/console/server.js';
import type { ContainerServerAddress, Driver, RunContext, RunOutcome } from '../../src/driver/types.js';
import type { ActorRecord, BuildRecord } from '../../src/storage/entities.js';

interface FakeContainer {
	ctx: RunContext;
	server?: Server;
	address?: ContainerServerAddress;
	probes: number;
	finish(outcome: RunOutcome): void;
}

interface ServerDriver extends Driver {
	containers: FakeContainer[];
	abortRunCalls: Array<{ runId: string; graceSecs?: number }>;
	/** Each started container listens only after this many ms; `Infinity` never listens. */
	listenDelayMs: number;
	/** Each request waits this long before being answered. */
	responseDelayMs: number;
}

/** Every started "container" echoes each request back as JSON, and answers websocket upgrades. */
function serverDriver(): ServerDriver {
	const containers: FakeContainer[] = [];
	const abortRunCalls: Array<{ runId: string; graceSecs?: number }> = [];
	const driver: ServerDriver = {
		available: true,
		containers,
		abortRunCalls,
		listenDelayMs: 0,
		responseDelayMs: 0,
		async init() {},
		async startBuild() {
			throw new Error('not used by this stub');
		},
		async abortBuild() {},
		startRun(ctx) {
			return new Promise<RunOutcome>((resolve) => {
				const container: FakeContainer = {
					ctx,
					probes: 0,
					finish: (outcome) => {
						container.server?.closeAllConnections();
						container.server?.close();
						container.address = undefined;
						resolve(outcome);
					},
				};
				containers.push(container);
				const listen = () => {
					const server = http.createServer((req, res) => {
						if (req.headers[READINESS_PROBE_HEADER]) {
							container.probes++;
							res.end('ready');
							return;
						}
						const chunks: Buffer[] = [];
						req.on('data', (chunk: Buffer) => chunks.push(chunk));
						req.on('end', () => {
							setTimeout(() => {
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
							}, driver.responseDelayMs);
						});
					});
					const wss = new WebSocketServer({ server });
					wss.on('connection', (ws, req: IncomingMessage) => {
						ws.on('message', (data) => ws.send(`${req.url} ${String(data)}`));
					});
					server.listen(0, '127.0.0.1', () => {
						container.server = server;
						container.address = { host: '127.0.0.1', port: (server.address() as AddressInfo).port };
					});
				};
				if (Number.isFinite(driver.listenDelayMs)) setTimeout(listen, driver.listenDelayMs);
			});
		},
		async abortRun(runId, options) {
			abortRunCalls.push({ runId, graceSecs: options?.graceSecs });
			containers.find((c) => c.ctx.runId === runId && c.address)?.finish({ exitCode: 137, timedOut: false });
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
			return containers.find((c) => c.ctx.runId === runId && c.address)?.address;
		},
	};
	return driver;
}

async function seedBuild(actor: ActorRecord, buildNumber = '0.0.1'): Promise<BuildRecord> {
	const build: BuildRecord = {
		id: generateId(),
		userId: actor.userId,
		actorId: actor.id,
		versionNumber: '0.0',
		buildNumber,
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

describe('actorStandby on the Actor object', () => {
	let server: TestServerHandle;
	afterEach(async () => server?.close());

	it('is absent with a null standbyUrl until set, and fills the platform defaults on create', async () => {
		server = await startTestServer();
		const plain = await server.client.actors().create({ name: 'plain' });
		expect(plain.actorStandby).toBeUndefined();
		expect((plain as unknown as { standbyUrl: unknown }).standbyUrl).toBeNull();

		const created = await server.client.actors().create({ name: 'My-Server', actorStandby: { isEnabled: true } });
		expect(created.actorStandby).toEqual({
			isEnabled: true,
			disableStandbyFieldsOverride: false,
			tenancy: 'SINGLE_TENANT',
			desiredRequestsPerActorRun: 3,
			maxRequestsPerActorRun: 4,
			idleTimeoutSecs: 300,
			build: 'latest',
			memoryMbytes: 1024,
			shouldPassActorInput: false,
		});
		const me = await server.client.user('me').get();
		expect((created as unknown as { standbyUrl: string }).standbyUrl).toBe(
			`http://${me!.username}--my-server.localhost:3333`,
		);
	});

	it('gives an Actor container the path form on the API alias as the standbyUrl', async () => {
		server = await startTestServer();
		const created = await server.client.actors().create({ name: 'my-server', actorStandby: { isEnabled: true } });
		const me = await server.client.user('me').get();
		const fromContainer = await new Promise<string>((resolve, reject) => {
			const port = new URL(server.baseUrl).port;
			http.get(
				{
					host: '127.0.0.1',
					port,
					path: `/v2/actors/${created.id}?token=${server.token}`,
					headers: { host: `apify-api:${port}` },
				},
				(res) => {
					let body = '';
					res.on('data', (chunk) => (body += chunk));
					res.on('end', () => resolve(JSON.parse(body).data.standbyUrl));
				},
			).on('error', reject);
		});
		expect(fromContainer).toBe(`http://apify-api:3333/actor-runtime/standby/${me!.username}--my-server`);
	});

	it('merges a partial update over the stored settings, and rejects invalid ones unchanged', async () => {
		server = await startTestServer();
		const created = await server.client.actors().create({ name: 'a', actorStandby: { isEnabled: true } });
		const updated = await server.client
			.actor(created.id)
			.update({ actorStandby: { idleTimeoutSecs: 60 } } as never);
		expect(updated.actorStandby).toMatchObject({ isEnabled: true, idleTimeoutSecs: 60, maxRequestsPerActorRun: 4 });

		for (const actorStandby of [
			{ desiredRequestsPerActorRun: 10 },
			{ idleTimeoutSecs: 1 },
			{ tenancy: 'MULTI_TENANT' },
			{ isEnabled: 'yes' },
			{ unknown: true },
		]) {
			const res = await fetch(`${server.baseUrl}/v2/actors/${created.id}?token=${server.token}`, {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ actorStandby }),
			});
			expect(res.status).toBe(400);
			expect(((await res.json()) as { error: { type: string } }).error.type).toBe('invalid-request');
		}
		expect((await server.client.actor(created.id).get())!.actorStandby!.idleTimeoutSecs).toBe(60);
	});

	it('is enabled by a pushed version whose .actor/actor.json declares usesStandbyMode', async () => {
		server = await startTestServer();
		const created = await server.client.actors().create({ name: 'b' });
		await server.client
			.actor(created.id)
			.versions()
			.create({
				versionNumber: '0.0',
				sourceType: 'SOURCE_FILES',
				buildTag: 'latest',
				sourceFiles: [
					{ name: '.actor/actor.json', format: 'TEXT', content: '{ usesStandbyMode: true, name: "b" }' },
				],
			} as never);
		expect((await server.client.actor(created.id).get())!.actorStandby?.isEnabled).toBe(true);
	});
});

describe('standby router', () => {
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

	async function standbyActor(standby: Record<string, unknown> = {}): Promise<{ actor: ActorRecord; url: string }> {
		const created = await server.client
			.actors()
			.create({ name: 'standby-actor', actorStandby: { isEnabled: true, ...standby } } as never);
		const actor = (await getRegistries().actors.get(created.id))!;
		await seedBuild(actor);
		// The path form of the same address: this process cannot resolve the `*.localhost` standbyUrl.
		const label = new URL((created as unknown as { standbyUrl: string }).standbyUrl).hostname.replace(
			/\.localhost$/,
			'',
		);
		return { actor, url: `${server.baseUrl}/actor-runtime/standby/${label}` };
	}

	it('starts a STANDBY run and forwards method, path, query, headers and body to its server', async () => {
		driver = serverDriver();
		server = await startTestServer(driver);
		const { actor, url } = await standbyActor({ memoryMbytes: 2048 });

		const res = await fetch(`${url}/search/items?q=1`, {
			method: 'POST',
			headers: { authorization: `Bearer ${server.token}`, 'content-type': 'text/plain', 'x-custom': 'c' },
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
		expect(echoed).toMatchObject({ method: 'POST', url: '/search/items?q=1', body: 'hello' });
		expect(echoed.headers['x-custom']).toBe('c');
		expect(echoed.headers.authorization).toBe(`Bearer ${server.token}`);

		const run = await server.client.run(echoed.runId).get();
		expect(run).toMatchObject({ actId: actor.id, status: 'RUNNING', meta: { origin: 'STANDBY' } });
		expect(run!.options).toMatchObject({ timeoutSecs: 0, memoryMbytes: 2048, build: 'latest' });
		const ctx = driver.containers[0]!.ctx;
		expect(ctx.containerServerPort).toBe(4321);
		expect(ctx.timeoutSecs).toBe(0);
		expect(ctx.env).toMatchObject({
			APIFY_META_ORIGIN: 'STANDBY',
			ACTOR_STANDBY_PORT: '4321',
			ACTOR_WEB_SERVER_PORT: '4321',
		});
		expect(ctx.env.ACTOR_STANDBY_URL).toMatch(/^http:\/\/.+--standby-actor\.localhost:3333$/);
		expect(driver.containers[0]!.probes).toBeGreaterThan(0);

		// The next request lands on the same run, without starting another.
		const again = (await (await fetch(`${url}?token=${server.token}`)).json()) as { runId: string; url: string };
		expect(again.runId).toBe(echoed.runId);
		expect(again.url).toBe(`/?token=${server.token}`);
		expect(driver.containers).toHaveLength(1);
	});

	it('also answers on the <label>.localhost host and by Actor id', async () => {
		driver = serverDriver();
		server = await startTestServer(driver);
		const { actor, url } = await standbyActor();
		const label = url.split('/').pop()!;

		const byHost = await new Promise<{ status: number; body: string }>((resolve, reject) => {
			const port = new URL(server.baseUrl).port;
			http.get(
				{
					host: '127.0.0.1',
					port,
					path: `/deep/path?token=${server.token}`,
					headers: { host: `${label}.localhost:${port}` },
				},
				(res) => {
					let body = '';
					res.on('data', (chunk) => (body += chunk));
					res.on('end', () => resolve({ status: res.statusCode!, body }));
				},
			).on('error', reject);
		});
		expect(byHost.status).toBe(200);
		expect(JSON.parse(byHost.body).url).toBe(`/deep/path?token=${server.token}`);

		const byId = await fetch(`${server.baseUrl}/actor-runtime/standby/${actor.id}/x?token=${server.token}`);
		expect(((await byId.json()) as { url: string }).url).toBe(`/x?token=${server.token}`);
	});

	it('rejects a missing token, an unknown address, and an Actor without standby', async () => {
		driver = serverDriver();
		server = await startTestServer(driver);
		const { url } = await standbyActor();
		const plain = await server.client.actors().create({ name: 'plain' });

		const cases: Array<[string, number, string]> = [
			[url, 401, 'user-not-authenticated'],
			[`${server.baseUrl}/actor-runtime/standby/nobody--nothing?token=${server.token}`, 404, 'record-not-found'],
			[`${url}?token=someone-else`, 404, 'record-not-found'],
			[`${server.baseUrl}/actor-runtime/standby/${plain.id}?token=${server.token}`, 400, 'standby-not-enabled'],
		];
		for (const [target, status, type] of cases) {
			const res = await fetch(target);
			expect(res.status).toBe(status);
			expect(((await res.json()) as { error: { type: string } }).error.type).toBe(type);
		}
		expect(driver.containers).toHaveLength(0);
	});

	it('starts another run once concurrent requests exceed maxRequestsPerActorRun', async () => {
		driver = serverDriver();
		driver.responseDelayMs = 500;
		server = await startTestServer(driver);
		const { url } = await standbyActor({ desiredRequestsPerActorRun: 1, maxRequestsPerActorRun: 1 });

		const responses = await Promise.all(
			[1, 2, 3].map(
				async () => ((await (await fetch(`${url}?token=${server.token}`)).json()) as { runId: string }).runId,
			),
		);
		expect(new Set(responses).size).toBe(3);
	});

	it('starts a run ahead of demand once every run is above desiredRequestsPerActorRun', async () => {
		driver = serverDriver();
		driver.responseDelayMs = 800;
		server = await startTestServer(driver);
		const { url } = await standbyActor({ desiredRequestsPerActorRun: 1, maxRequestsPerActorRun: 4 });

		const first = fetch(`${url}?token=${server.token}`);
		await waitUntil(() => driver.containers.length === 1);
		const second = fetch(`${url}?token=${server.token}`);
		const ids = await Promise.all(
			[first, second].map(async (r) => ((await (await r).json()) as { runId: string }).runId),
		);
		// Both are served by the first run (below max), but a second run was already started for what comes next.
		expect(ids[0]).toBe(ids[1]);
		await waitUntil(() => driver.containers.length === 2);
	});

	it('winds an idle run down gracefully and reports it SUCCEEDED; the next request starts a fresh run', async () => {
		driver = serverDriver();
		server = await startTestServer(driver);
		configureStandbyForTests({ finishWarningMs: 100 });
		const { url } = await standbyActor({ idleTimeoutSecs: 5 });

		const first = (await (await fetch(`${url}?token=${server.token}`)).json()) as { runId: string };
		const frames: string[] = [];
		subscribeEvents(first.runId, (frame) => frames.push(frame));

		const finished = await waitUntil(async () => {
			const run = await server.client.run(first.runId).get();
			return run?.status === 'SUCCEEDED' ? run : undefined;
		}, 15_000);
		expect(finished.exitCode).toBe(137);
		expect(frames.map((frame) => JSON.parse(frame).name)).toEqual(['aborting', 'persistState']);
		expect(driver.abortRunCalls).toEqual([{ runId: first.runId, graceSecs: 15 }]);
		expect(await getFullLog(first.runId)).toContain('Actor Standby server was idle for too long, finishing run.');

		const next = (await (await fetch(`${url}?token=${server.token}`)).json()) as { runId: string };
		expect(next.runId).not.toBe(first.runId);
	}, 20_000);

	it('answers 503 when the run ends before its server is ready, and 504 when it never listens', async () => {
		driver = serverDriver();
		driver.listenDelayMs = Infinity;
		server = await startTestServer(driver);
		configureStandbyForTests({ readyTimeoutMs: 1_500 });
		const { url } = await standbyActor();

		const notReady = await fetch(`${url}?token=${server.token}`);
		expect(notReady.status).toBe(504);
		expect(((await notReady.json()) as { error: { type: string } }).error.type).toBe('standby-run-not-ready');

		const pending = fetch(`${url}?token=${server.token}`);
		await new Promise((resolve) => setTimeout(resolve, 300));
		driver.containers[0]!.finish({ exitCode: 1, timedOut: false });
		const crashed = await pending;
		expect(crashed.status).toBe(503);
		const body = (await crashed.json()) as { error: { type: string; message: string } };
		expect(body.error.type).toBe('standby-run-finished');
		expect(body.error.message).toContain('FAILED');
	});

	it('retires runs of an older build once a newer one is pushed', async () => {
		driver = serverDriver();
		server = await startTestServer(driver);
		configureStandbyForTests({ finishWarningMs: 50 });
		const { actor, url } = await standbyActor();
		const first = (await (await fetch(`${url}?token=${server.token}`)).json()) as { runId: string };

		await seedBuild(actor, '0.0.2');
		const second = (await (await fetch(`${url}?token=${server.token}`)).json()) as { runId: string };
		expect(second.runId).not.toBe(first.runId);
		await waitUntil(async () => (await server.client.run(first.runId).get())?.status === 'SUCCEEDED');
	});

	it("shows the Actor's standby settings and live runs on its console page", async () => {
		driver = serverDriver();
		server = await startTestServer(driver);
		const { actor, url } = await standbyActor();
		const served = (await (await fetch(`${url}?token=${server.token}`)).json()) as { runId: string };

		const consoleServer = await new Promise<Server>((resolve) => {
			const s = createConsoleServer({ driver }).listen(0, () => resolve(s));
		});
		try {
			const { port } = consoleServer.address() as AddressInfo;
			const html = await (await fetch(`http://127.0.0.1:${port}/actors/${actor.id}`)).text();
			expect(html).toContain('Actor Standby');
			expect(html).toContain('--standby-actor.localhost:3333');
			expect(html).toContain(`/runs/${served.runId}`);
			// A ready-to-use link carries the owner's token, masked on screen.
			const label = url.split('/').pop()!;
			const withToken = `http://${label}.localhost:3333/?token=${server.token}`;
			expect(html).toContain(`href="${withToken}"`);
			expect(html).toContain(`data-copy="${withToken}"`);
			expect(html).toContain(`http://${label}.localhost:3333/?token=••••••••</a>`);
			expect(html).not.toMatch(new RegExp(`>[^<]*${server.token}[^<]*<`));
			const runHtml = await (await fetch(`http://127.0.0.1:${port}/runs/${served.runId}`)).text();
			expect(runHtml).toContain('STANDBY');
		} finally {
			await new Promise((resolve) => consoleServer.close(resolve));
		}
	});

	it("serves a task at its own standby URL, with the task's settings over the Actor's and its input", async () => {
		driver = serverDriver();
		server = await startTestServer(driver);
		const { actor, url: actorUrl } = await standbyActor({ memoryMbytes: 2048 });
		const task = (await server.client.tasks().create({
			actId: actor.id,
			name: 'my-task',
			input: { q: 'saved' },
			actorStandby: { memoryMbytes: 4096, shouldPassActorInput: true },
		} as never)) as unknown as { id: string; standbyUrl: string; actorStandby: Record<string, unknown> };
		expect(task.standbyUrl).toMatch(/^http:\/\/.+--my-task\.localhost:3333$/);
		expect(task.actorStandby).toMatchObject({
			memoryMbytes: 4096,
			shouldPassActorInput: true,
			idleTimeoutSecs: 300,
		});
		expect(task.actorStandby).not.toHaveProperty('isEnabled');
		const label = new URL(task.standbyUrl).hostname.replace(/\.localhost$/, '');

		const served = (await (
			await fetch(`${server.baseUrl}/actor-runtime/standby/${label}/x?token=${server.token}`)
		).json()) as { runId: string; url: string };
		expect(served.url).toBe(`/x?token=${server.token}`);
		const run = await server.client.run(served.runId).get();
		expect(run).toMatchObject({ actId: actor.id, actorTaskId: task.id, meta: { origin: 'STANDBY' } });
		expect(run!.options).toMatchObject({ memoryMbytes: 4096, timeoutSecs: 0 });
		const input = await server.client.keyValueStore(run!.defaultKeyValueStoreId).getRecord('INPUT');
		expect(input?.value).toEqual({ q: 'saved' });
		const ctx = driver.containers[0]!.ctx;
		expect(ctx.env.ACTOR_STANDBY_URL).toBe(task.standbyUrl);
		expect(ctx.env.ACTOR_TASK_ID).toBe(task.id);

		// The Actor's own address has a pool of its own, with the Actor's settings and no input.
		const actorServed = (await (await fetch(`${actorUrl}?token=${server.token}`)).json()) as { runId: string };
		expect(actorServed.runId).not.toBe(served.runId);
		const actorRun = await server.client.run(actorServed.runId).get();
		expect(actorRun!.actorTaskId).toBeUndefined();
		expect(actorRun!.options.memoryMbytes).toBe(2048);

		// The task id addresses it too, landing on the same run.
		const byId = (await (
			await fetch(`${server.baseUrl}/actor-runtime/standby/${task.id}?token=${server.token}`)
		).json()) as { runId: string };
		expect(byId.runId).toBe(served.runId);
	});

	it("serves a task only while its Actor's Standby is on, and rejects Actor-only settings", async () => {
		driver = serverDriver();
		server = await startTestServer(driver);
		const created = await server.client.actors().create({ name: 'plain-actor' });
		await seedBuild((await getRegistries().actors.get(created.id))!);
		const task = (await server.client
			.tasks()
			.create({ actId: created.id, name: 'plain-task' } as never)) as unknown as {
			standbyUrl: string | null;
			username: string;
		};
		expect(task.standbyUrl).toBeNull();
		const res = await fetch(
			`${server.baseUrl}/actor-runtime/standby/${task.username}--plain-task?token=${server.token}`,
		);
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: { type: string } }).error.type).toBe('standby-not-enabled');

		const invalid = await fetch(`${server.baseUrl}/v2/actor-tasks`, {
			method: 'POST',
			headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
			body: JSON.stringify({ actId: created.id, actorStandby: { isEnabled: true } }),
		});
		expect(invalid.status).toBe(400);
	});

	it('proxies websocket upgrades to the run', async () => {
		driver = serverDriver();
		server = await startTestServer(driver);
		const { url } = await standbyActor();

		const ws = new WebSocket(`${url.replace('http', 'ws')}/socket?token=${server.token}`);
		const reply = await new Promise<string>((resolve, reject) => {
			ws.on('open', () => ws.send('ping'));
			ws.on('message', (data) => resolve(String(data)));
			ws.on('error', reject);
		});
		ws.close();
		expect(reply).toBe(`/socket?token=${server.token} ping`);
	});
});

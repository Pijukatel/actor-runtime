/**
 * Actor Standby end to end (`test.md`'s "Actor Standby"), for both standby samples: `apify push` enables
 * Standby from `.actor/actor.json`, requests to the Actor's standby URL are served by one standby run,
 * an idle run is wound down, and the next request starts a fresh one that sees the previous run's
 * totals. `samples/actor_standby_web` covers the two kinds of callers: an external client at the
 * platform-shaped `*.localhost` standby URL, and another Actor's run calling from its container. The
 * requests themselves are plain HTTP and a websocket - the narrow exception `test.md` allows, since no
 * `apify` command sends one; every other assertion reads `apify` output.
 */
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import {
	buildRuntimeImage,
	isDockerAvailable,
	pullBaseImages,
	startRuntimeContainer,
	stopRuntimeContainer,
	waitForHttpOk,
} from './helpers/docker.js';
import {
	apify,
	apifyEnv,
	createIsolatedApifyHome,
	loginApifyCli,
	removeIsolatedApifyHome,
	type ApiEnvelope,
	type CallResult,
	type DatasetInfoResult,
	type PushResult,
} from './helpers/apify-cli.js';
import { waitFor } from './helpers/wait.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const CONTAINER_NAME = 'actor-runtime-e2e-standby';
const IMAGE_TAG = 'actor-runtime:e2e';
/** `helpers/apify-cli.ts`' login token. */
const TOKEN = 'anything';

interface RunSummary {
	id: string;
	status: string;
	meta: { origin: string };
	defaultDatasetId: string;
	options: { timeoutSecs: number };
}

/** Retried once on a keep-alive connection the other side already closed (`helpers/console-view.ts`). */
async function fetchWithRetry(url: string, init?: RequestInit): Promise<Response> {
	try {
		return await fetch(url, init);
	} catch (error) {
		if ((error as { cause?: { code?: string } }).cause?.code !== 'UND_ERR_SOCKET') throw error;
		return fetch(url, init);
	}
}

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
	const res = await fetchWithRetry(url, {
		...init,
		headers: { authorization: `Bearer ${TOKEN}`, ...init?.headers },
	});
	expect(res.status, `${url} answered ${res.status}: ${await res.clone().text()}`).toBe(200);
	return (await res.json()) as T;
}

/**
 * A GET to a `http://<label>.localhost:3333` standby URL, sent the way a browser does: to loopback, with the
 * URL's host in the `Host` header. This process's resolver, unlike a browser's, does not map `*.localhost`.
 */
function getByHost(standbyUrl: string, path: string): Promise<{ status: number; body: string }> {
	const { hostname, host, port } = new URL(standbyUrl);
	expect(hostname).toMatch(/\.localhost$/);
	return new Promise((resolve, reject) => {
		// `agent: false`: a fresh connection each time, so an idle one closed underneath is never reused.
		http.get(
			{ host: '127.0.0.1', port, path, agent: false, headers: { host, authorization: `Bearer ${TOKEN}` } },
			(res) => {
				let body = '';
				res.on('data', (chunk) => (body += chunk));
				res.on('end', () => resolve({ status: res.statusCode!, body }));
			},
		).on('error', reject);
	});
}

function websocketRoundTrip(url: string): Promise<string[]> {
	return new Promise((resolve, reject) => {
		const frames: string[] = [];
		const socket = new WebSocket(url);
		socket.on('message', (data) => {
			frames.push(String(data));
			if (frames.length === 1) socket.send('ping');
			else socket.close();
		});
		socket.on('close', () => resolve(frames));
		socket.on('error', reject);
	});
}

describe('Actor Standby via apify-cli (requires Docker)', () => {
	let isolatedApifyHome: string;

	beforeAll(
		async () => {
			if (!isDockerAvailable()) {
				throw new Error(
					'Docker daemon is not reachable - the e2e suite requires one (see requirements/test.md)',
				);
			}
			pullBaseImages();
			buildRuntimeImage(REPO_ROOT, IMAGE_TAG);
			startRuntimeContainer(IMAGE_TAG, CONTAINER_NAME);
			await waitForHttpOk('http://localhost:3333/v2/users/me?token=x');
			isolatedApifyHome = createIsolatedApifyHome();
			loginApifyCli(REPO_ROOT, isolatedApifyHome);
		},
		10 * 60 * 1000,
	);

	afterAll(() => {
		stopRuntimeContainer(CONTAINER_NAME);
		if (isolatedApifyHome) removeIsolatedApifyHome(isolatedApifyHome);
	});

	for (const sample of ['samples/actor_standby_ts', 'samples/actor_standby_py']) {
		it(
			`${sample}: push enables Standby; one STANDBY run serves every endpoint and is wound down once idle`,
			async () => {
				const actorDir = join(REPO_ROOT, sample);
				const env = apifyEnv(isolatedApifyHome);
				const push = JSON.parse(apify(['push', '--json'], { cwd: actorDir, env })) as PushResult;
				expect(push.build.status).toBe('SUCCEEDED');

				const actorId = push.actor.id;
				const body = JSON.stringify({ actorStandby: { idleTimeoutSecs: 10 } });
				apify(['api', 'PUT', `actors/${actorId}`, '--body', body], { cwd: actorDir, env });
				const actor = JSON.parse(
					apify(['api', 'GET', `actors/${actorId}`], { cwd: actorDir, env }),
				) as ApiEnvelope<{ actorStandby: { isEnabled: boolean; idleTimeoutSecs: number }; standbyUrl: string }>;
				expect(actor.data.actorStandby).toMatchObject({ isEnabled: true, idleTimeoutSecs: 10 });
				// The platform-shaped `*.localhost` standbyUrl; this process reaches the same Actor by the path form.
				const standbyHost = new URL(actor.data.standbyUrl);
				expect(standbyHost.hostname).toMatch(/--[a-z0-9-]+\.localhost$/);
				const url = `http://localhost:${standbyHost.port}/actor-runtime/standby/${standbyHost.hostname.replace(/\.localhost$/, '')}`;

				const index = await getJson<{ runId: string; endpoints: string[] }>(`${url}/`);
				expect(index.endpoints).toContain('GET /hello?name=');
				const runId = index.runId;

				for (const name of ['Ada', 'Grace', 'Linus']) {
					const hello = await getJson<{ greeting: string; runId: string }>(`${url}/hello?name=${name}`);
					expect(hello).toMatchObject({ greeting: `Hello, ${name}!`, runId });
				}

				const echo = await getJson<{ query: Record<string, string>; body: unknown }>(`${url}/echo?x=1`, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ nested: { ok: true } }),
				});
				expect(echo).toMatchObject({ query: { x: '1' }, body: { nested: { ok: true } } });

				const stream = await fetchWithRetry(`${url}/stream?count=3&token=${TOKEN}`);
				expect(stream.headers.get('content-type')).toMatch(/^text\/event-stream/);
				const events = (await stream.text()).match(/^event: \w+$/gm);
				expect(events).toEqual(['event: tick', 'event: tick', 'event: tick', 'event: done']);

				const frames = await websocketRoundTrip(`${url.replace(/^http/, 'ws')}/ws?token=${TOKEN}`);
				expect(JSON.parse(frames[0]!)).toMatchObject({ runId });
				expect(JSON.parse(frames[1]!)).toEqual({ echo: 'ping' });

				const runOf = () =>
					(
						JSON.parse(
							apify(['api', 'GET', `actor-runs/${runId}`], { cwd: actorDir, env }),
						) as ApiEnvelope<RunSummary>
					).data;
				expect(runOf()).toMatchObject({
					status: 'RUNNING',
					meta: { origin: 'STANDBY' },
					options: { timeoutSecs: 0 },
				});

				const finished = await waitFor(
					() => {
						const run = runOf();
						return run.status === 'SUCCEEDED' ? run : undefined;
					},
					120_000,
					'the idle standby run to finish',
				);
				const info = JSON.parse(
					apify(['datasets', 'info', finished.defaultDatasetId, '--json'], { cwd: actorDir, env }),
				) as DatasetInfoResult;
				expect(info.itemCount).toBe(3);
				const log = apify(['api', 'GET', `logs/${runId}`], { cwd: actorDir, env });
				expect(log).toContain('Actor Standby server was idle for too long, finishing run.');

				// A fresh run, which reads the totals the finished one saved: 3 greetings, an echo, a stream,
				// a websocket, and now this request.
				const stats = await getJson<{ runId: string; allRuns: { served: number; runs: number } }>(
					`${url}/stats`,
				);
				expect(stats.runId).not.toBe(runId);
				expect(stats.allRuns).toEqual({ served: 7, runs: 2 });
			},
			8 * 60 * 1000,
		);
	}

	describe('samples/actor_standby_web', () => {
		const actorDir = join(REPO_ROOT, 'samples', 'actor_standby_web');
		let actorId: string;
		let standbyUrl: string;

		beforeAll(
			() => {
				const env = apifyEnv(isolatedApifyHome);
				const push = JSON.parse(apify(['push', '--json'], { cwd: actorDir, env })) as PushResult;
				expect(push.build.status).toBe('SUCCEEDED');
				actorId = push.actor.id;
				standbyUrl = (
					JSON.parse(apify(['api', 'GET', `actors/${actorId}`], { cwd: actorDir, env })) as ApiEnvelope<{
						standbyUrl: string;
					}>
				).data.standbyUrl;
			},
			5 * 60 * 1000,
		);

		it('an external client calls a standby endpoint at the *.localhost standbyUrl, where the Actor owns /', async () => {
			const env = apifyEnv(isolatedApifyHome);
			// The platform's shape: `<username>--<actor-name>.apify.actor` becomes `<username>--<actor-name>.localhost:3333`.
			expect(standbyUrl).toMatch(/^http:\/\/[a-z0-9-]+--my-standby-web-actor\.localhost:3333$/);
			const { host } = new URL(standbyUrl);

			// The page calls its API root-relative, which reaches the Actor only because it owns `/`.
			const page = await getByHost(standbyUrl, `/?token=${TOKEN}`);
			expect(page.status).toBe(200);
			expect(page.body).toContain("fetch('/api/greeting");

			const greeting = await getByHost(standbyUrl, '/api/greeting?name=Ada');
			expect(greeting.status, greeting.body).toBe(200);
			const answer = JSON.parse(greeting.body) as { greeting: string; runId: string; host: string };
			expect(answer).toMatchObject({ greeting: 'Hello, Ada!', host });

			const run = (
				JSON.parse(
					apify(['api', 'GET', `actor-runs/${answer.runId}`], { cwd: actorDir, env }),
				) as ApiEnvelope<RunSummary>
			).data;
			expect(run).toMatchObject({ status: 'RUNNING', meta: { origin: 'STANDBY' } });

			// The path form reaches the same run, for clients that do not resolve `*.localhost`.
			const label = new URL(standbyUrl).hostname.replace(/\.localhost$/, '');
			const byPath = await getJson<{ greeting: string; runId: string }>(
				`http://localhost:3333/actor-runtime/standby/${label}/api/greeting?name=Grace`,
			);
			expect(byPath).toEqual(expect.objectContaining({ greeting: 'Hello, Grace!', runId: answer.runId }));
		});

		it(
			"another Actor's run calls a standby endpoint from inside its container",
			() => {
				const env = apifyEnv(isolatedApifyHome);
				// An ordinary run of the sample is the client: it reads the standby Actor's standbyUrl through the
				// API from its container and calls `/api/greeting` there.
				const call = JSON.parse(
					apify(['call', '--input', JSON.stringify({ standbyActor: actorId, name: 'Actor' }), '--json'], {
						cwd: actorDir,
						env,
					}),
				) as CallResult;
				expect(call.run.status).toBe('SUCCEEDED');

				const items = JSON.parse(
					apify(['api', 'GET', `datasets/${call.storage.defaultDatasetId}/items`], { cwd: actorDir, env }),
				) as Array<{ standbyUrl: string; status: number; greeting: string; runId: string }>;
				expect(items).toHaveLength(1);
				const label = new URL(standbyUrl).hostname.replace(/\.localhost$/, '');
				expect(items[0]).toMatchObject({
					standbyUrl: `http://apify-api:3333/actor-runtime/standby/${label}`,
					status: 200,
					greeting: 'Hello, Actor!',
				});

				const standbyRun = (
					JSON.parse(
						apify(['api', 'GET', `actor-runs/${items[0]!.runId}`], { cwd: actorDir, env }),
					) as ApiEnvelope<RunSummary>
				).data;
				expect(standbyRun.meta.origin).toBe('STANDBY');
				expect(items[0]!.runId).not.toBe(call.run.id);
			},
			5 * 60 * 1000,
		);
	});
});

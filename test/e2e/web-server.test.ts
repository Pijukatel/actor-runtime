/**
 * Run web server and live view end to end (`test.md`'s "Web server and live view"): `samples/actor_ts`
 * serves a progress page on `ACTOR_WEB_SERVER_PORT`, which is reachable at the run's `containerUrl` -
 * in both its forms - while the run goes, framed by the console's live view page, and gone once the run
 * has ended. The requests to the container URL and the console are the narrow exception `test.md`
 * allows; every other assertion reads `apify` output.
 *
 * On Podman 3.x an ordinary run's server is not reachable by the runtime (`actor-driver.md`'s "Web
 * server and live view"); there the suite asserts that documented outcome instead.
 */
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
	buildRuntimeImage,
	isDockerAvailable,
	podmanMajorVersion,
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
	type PushResult,
} from './helpers/apify-cli.js';
import { fetchConsole } from './helpers/console-view.js';
import { waitFor } from './helpers/wait.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const SAMPLE_ACTOR_DIR = join(REPO_ROOT, 'samples', 'actor_ts');
const CONTAINER_NAME = 'actor-runtime-e2e-web-server';
const IMAGE_TAG = 'actor-runtime:e2e-web-server';
const API_URL = 'http://localhost:3333';

interface RunApi {
	id: string;
	status: string;
	statusMessage?: string;
	containerUrl: string;
}

/**
 * A GET to a `http://<runId>.runs.localhost:3333` container URL, sent the way a browser does: to loopback,
 * with the URL's host in the `Host` header. This process's resolver, unlike a browser's, does not map
 * `*.localhost`.
 */
function getByHost(containerUrl: string, path: string): Promise<{ status: number; body: string }> {
	const { hostname, host, port } = new URL(containerUrl);
	expect(hostname).toMatch(/\.runs\.localhost$/);
	return new Promise((resolve, reject) => {
		http.get({ host: '127.0.0.1', port, path, agent: false, headers: { host } }, (res) => {
			let body = '';
			res.on('data', (chunk) => (body += chunk));
			res.on('end', () => resolve({ status: res.statusCode!, body }));
		}).on('error', reject);
	});
}

describe('Run web server and live view via apify-cli (requires Docker)', () => {
	let isolatedApifyHome: string;
	let env: NodeJS.ProcessEnv;

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
			await waitForHttpOk(`${API_URL}/v2/users/me?token=x`);
			isolatedApifyHome = createIsolatedApifyHome();
			loginApifyCli(REPO_ROOT, isolatedApifyHome);
			env = apifyEnv(isolatedApifyHome);
		},
		10 * 60 * 1000,
	);

	afterAll(() => {
		stopRuntimeContainer(CONTAINER_NAME);
		if (isolatedApifyHome) removeIsolatedApifyHome(isolatedApifyHome);
	});

	it(
		"the run's progress page is served at its containerUrl and live view while it runs, and gone once it ended",
		async () => {
			const push = JSON.parse(apify(['push', '--json'], { cwd: SAMPLE_ACTOR_DIR, env })) as PushResult;
			expect(push.build.status).toBe('SUCCEEDED');

			// Started via `apify api`, not `apify call`, so the page can be read while the run goes.
			const started = (
				JSON.parse(
					apify(['api', 'POST', `actors/${push.actor.id}/runs`, '--body', JSON.stringify({ maxPages: 5 })], {
						cwd: REPO_ROOT,
						env,
					}),
				) as ApiEnvelope<RunApi>
			).data;
			const runId = started.id;
			expect(started.containerUrl).toBe(`http://${runId.toLowerCase()}.runs.localhost:3333`);
			const pathForm = `${API_URL}/actor-runtime/container/${runId}`;
			const serverReachable = podmanMajorVersion() !== 3;

			if (serverReachable) {
				// The path form, for clients without `*.localhost`: answered by the Actor once its server listens.
				const page = await waitFor(
					async () => {
						const res = await fetch(`${pathForm}/`);
						const body = await res.text();
						return res.status === 200 && body.includes(`Run ${runId}`) ? body : undefined;
					},
					120_000,
					"the Actor's progress page at the path form of its containerUrl",
				);
				expect(page).toContain('page(s) crawled');
				// The host form, where the run owns `/`.
				const byHost = await getByHost(started.containerUrl, '/');
				expect(byHost.status).toBe(200);
				expect(byHost.body).toContain(`Run ${runId}`);
			} else {
				// Podman 3.x: the server cannot be reached, which the URL says while the run goes.
				const notReady = await waitFor(
					async () => {
						const res = await fetch(`${pathForm}/`);
						return res.status === 503 ? await res.json() : undefined;
					},
					120_000,
					'the containerUrl to report the server as not reachable',
				);
				expect((notReady as { error: { type: string } }).error.type).toBe('web-server-not-ready');
			}

			// The console's run page links both; its live view page frames the URL.
			const runPage = await (await fetchConsole(`/runs/${runId}`)).text();
			expect(runPage).toContain(`href="${started.containerUrl}"`);
			const liveView = await (await fetchConsole(`/runs/${runId}/live-view`)).text();
			expect(liveView).toContain(`<iframe class="live-view-frame" src="${started.containerUrl}/"`);

			const finished = await waitFor(
				() => {
					const run = (
						JSON.parse(
							apify(['api', 'GET', `actor-runs/${runId}`], { cwd: REPO_ROOT, env }),
						) as ApiEnvelope<RunApi>
					).data;
					return ['SUCCEEDED', 'FAILED', 'TIMED-OUT', 'ABORTED'].includes(run.status) ? run : undefined;
				},
				300_000,
				'the run to finish',
			);
			expect(finished.status, finished.statusMessage).toBe('SUCCEEDED');
			expect(finished.containerUrl).toBe(started.containerUrl);
			// The run log named both URLs; the runtime colors them, so the ANSI codes are stripped first.
			const log = apify(['api', 'GET', `actor-runs/${runId}/log`], { cwd: REPO_ROOT, env }).replace(
				// eslint-disable-next-line no-control-regex
				/\x1b\[[0-9;]*m/g,
				'',
			);
			expect(log).toContain(`Live view: http://localhost:3000/runs/${runId}/live-view`);
			expect(log).toContain(`Progress page served at ${started.containerUrl}`);
			if (!serverReachable) expect(log).toContain('is not reachable by this runtime on this container engine');

			const gone = await fetch(`${pathForm}/`);
			expect(gone.status).toBe(410);
			expect(((await gone.json()) as { error: { type: string } }).error.type).toBe('run-finished');
			const endedView = await (await fetchConsole(`/runs/${runId}/live-view`)).text();
			expect(endedView).toContain('Run finished');
			expect(endedView).not.toContain('<iframe');
		},
		10 * 60 * 1000,
	);
});

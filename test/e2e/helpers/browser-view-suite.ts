/**
 * Shared body of the browser-view e2e (`actor-driver.md`'s "Browser view" section) against a real Docker
 * daemon: push a Playwright sample Actor, turn browser view on, start a run, and reach its live view the way
 * the console's viewer page does. Driven by `apify` commands per `requirements/test.md`'s CLI-only rule, with
 * the one exception that rule documents for this test: the viewer websocket is opened directly.
 *
 * The run is started with `apify api POST actors/<id>/runs` rather than `apify call` (which blocks until the
 * run ends), so the view can be probed while the run is live.
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
	buildRuntimeImage,
	isDockerAvailable,
	pullImage,
	startRuntimeContainer,
	stopRuntimeContainer,
	waitForHttpOk,
} from './docker.js';
import { CONSOLE_URL, fetchConsole, readMirrorGreeting } from './console-view.js';
import { withRunLogOnFailure } from './run-log.js';
import { waitFor } from './wait.js';
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
} from './apify-cli.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');

/** Server-rendered, unlike the samples' default `crawlee.dev`, whose links appear only after client-side
 * hydration - so the crawl had to wait for `load` and kept blowing the 60s navigation budget. */
export const CRAWL_START_URL = 'https://demo-webstore.apify.org/';

export interface BrowserViewSample {
	/** Directory under `samples/`. */
	dir: string;
	label: string;
	baseImage: string;
	input: (maxRequests: number) => Record<string, unknown>;
	/** The "toggle cleared" case proves a runtime property; one sample is enough. */
	withToggleClearedCase: boolean;
}

interface RunApi {
	id: string;
	status: string;
	statusMessage?: string;
}

/** The default 1024 MB grants a quarter core (`resources.ts`), too little for a headful browser. */
const RUN_MEMORY_MBYTES = 4096;

function startRun(actorId: string, input: unknown, env: NodeJS.ProcessEnv): RunApi {
	const params = JSON.stringify({ memory: RUN_MEMORY_MBYTES, timeout: 600 });
	const output = apify(
		['api', 'POST', `actors/${actorId}/runs`, '--params', params, '--body', JSON.stringify(input)],
		{
			cwd: REPO_ROOT,
			env,
		},
	);
	return (JSON.parse(output) as ApiEnvelope<RunApi>).data;
}

function getRun(runId: string, env: NodeJS.ProcessEnv): RunApi {
	const output = apify(['api', 'GET', `actor-runs/${runId}`], { cwd: REPO_ROOT, env });
	return (JSON.parse(output) as ApiEnvelope<RunApi>).data;
}

/** Non-streaming log fetch (see `debug-mode.test.ts`'s `currentLog` for why not `apify runs log`). */
function currentLog(runId: string, env: NodeJS.ProcessEnv): string {
	return apify(['api', 'GET', `actor-runs/${runId}/log`], { cwd: REPO_ROOT, env });
}

/** One e2e file per sample (`browser-view-ts.test.ts`, `browser-view-py.test.ts`), so CI runs them as separate
 * jobs and each pulls only its own base image. */
export function describeBrowserViewSuite(sample: BrowserViewSample): void {
	const CONTAINER_NAME = `actor-runtime-e2e-browser-view-${sample.dir}`;
	const IMAGE_TAG = `actor-runtime:e2e-browser-view-${sample.dir}`;

	describe(`per-Actor browser view: live mirror of the ${sample.label} Playwright sample Actor (requires Docker)`, () => {
		let isolatedApifyHome: string;
		/** Pushed once for the whole suite: a repeated `apify push` of an unchanged Actor is refused by the CLI
		 * ("already exists ... newer changes than your local copy"), so neither a retried case nor the second
		 * case may push again. */
		let pushedActorId: string;

		beforeAll(
			async () => {
				if (!isDockerAvailable()) {
					throw new Error(
						'Docker daemon is not reachable - this e2e case requires one (see requirements/test.md)',
					);
				}

				pullImage(sample.baseImage);
				buildRuntimeImage(REPO_ROOT, IMAGE_TAG);
				startRuntimeContainer(IMAGE_TAG, CONTAINER_NAME);
				await waitForHttpOk('http://localhost:3333/v2/users/me?token=x');

				isolatedApifyHome = createIsolatedApifyHome();
				loginApifyCli(REPO_ROOT, isolatedApifyHome);

				const pushOutput = apify(['push', '--json'], {
					cwd: join(REPO_ROOT, 'samples', sample.dir),
					env: apifyEnv(isolatedApifyHome),
				});
				const push = JSON.parse(pushOutput) as PushResult;
				if (push.build.status !== 'SUCCEEDED') {
					throw new Error(`apify push of ${sample.dir} ended with build status ${push.build.status}`);
				}
				pushedActorId = push.actor.id;
			},
			15 * 60 * 1000,
		);

		afterAll(() => {
			stopRuntimeContainer(CONTAINER_NAME);
			if (isolatedApifyHome) removeIsolatedApifyHome(isolatedApifyHome);
		});

		it(
			`${sample.label} sample: toggle on -> run: the log names the viewer URL, the viewer websocket reaches a live RFB server while the run crawls, the console links to the page, and the run finishes with the input-dependent item count`,
			async () => {
				const env = apifyEnv(isolatedApifyHome);
				const actorDir = join(REPO_ROOT, 'samples', sample.dir);
				const actorId = pushedActorId;

				const toggle = apify(
					['api', 'POST', `/actor-runtime/browser-view/${actorId}`, '--body', '{"enabled": true}'],
					{ cwd: REPO_ROOT, env },
				);
				expect(JSON.parse(toggle).data.localBrowserView).toEqual({ interactive: false });

				// Enough pages to keep the browser busy while the mirror is probed below.
				const run = startRun(actorId, sample.input(4), env);

				const log = await waitFor(
					() => {
						const text = currentLog(run.id, env);
						return text.includes('Browser view:') ? text : undefined;
					},
					60_000,
					'the browser-view line to appear in the run log',
				);
				expect(log).toContain(`${CONSOLE_URL}/runs/${run.id}/browser`);
				expect(log).toContain('view-only');

				// The mirror: the console's own websocket bridge reaches the sidecar's x11vnc, which greets with the
				// RFB protocol version once the Actor's Xvfb display exists. Chrome starting inside a fresh
				// container can take a while, hence the generous bound.
				const greeting = await readMirrorGreeting(run.id, 120_000);
				expect(greeting.startsWith('RFB 003.')).toBe(true);

				// The console's run page links to the viewer, and the viewer page embeds the noVNC client.
				const runPage = await fetchConsole(`/runs/${run.id}`);
				expect(await runPage.text()).toContain(`href="/runs/${run.id}/browser"`);
				const viewerPage = await fetchConsole(`/runs/${run.id}/browser`);
				expect(viewerPage.status).toBe(200);
				expect(await viewerPage.text()).toContain('/vendor/novnc/core/rfb.js');
				const client = await fetchConsole(`/vendor/novnc/core/rfb.js`);
				expect(client.status).toBe(200);

				await withRunLogOnFailure(
					run.id,
					() => currentLog(run.id, env),
					async () => {
						const finished = await waitFor(
							() => {
								const current = getRun(run.id, env);
								return ['SUCCEEDED', 'FAILED', 'TIMED-OUT', 'ABORTED'].includes(current.status)
									? current
									: undefined;
							},
							8 * 60 * 1000,
							'the browser-view run to finish',
						);
						expect(finished.status).toBe('SUCCEEDED');
						const runDetail = JSON.parse(
							apify(['api', 'GET', `actor-runs/${run.id}`], { cwd: REPO_ROOT, env }),
						) as ApiEnvelope<{ defaultDatasetId: string }>;
						const info = JSON.parse(
							apify(['datasets', 'info', runDetail.data.defaultDatasetId, '--json'], {
								cwd: actorDir,
								env,
							}),
						) as DatasetInfoResult;
						expect(info.itemCount).toBe(4);
					},
				);

				// Once the run is over its mirror is gone: the viewer page says so, and the websocket is refused.
				const endedPage = await fetchConsole(`/runs/${run.id}/browser`);
				expect(await endedPage.text()).toContain('This run has ended');
				await expect(readMirrorGreeting(run.id, 10_000)).rejects.toThrow(/1008/);
			},
			// One retry: the sample crawls a real external site (deliberately - the route out of an Actor is part
			// of what is tested), and CI runners occasionally see its navigations time out; a defect reproduces.
			{ timeout: 10 * 60 * 1000, retry: 1 },
		);

		it.runIf(sample.withToggleClearedCase)(
			'with the toggle cleared, a plain `apify call` of the same Actor runs exactly as before (no mirror, same crawl)',
			() => {
				const env = apifyEnv(isolatedApifyHome);
				const actorDir = join(REPO_ROOT, 'samples', sample.dir);
				const actorId = pushedActorId;
				apify(['api', 'POST', `/actor-runtime/browser-view/${actorId}`, '--body', '{"enabled": false}'], {
					cwd: REPO_ROOT,
					env,
				});

				const callOutput = apify(
					[
						'call',
						'--input',
						JSON.stringify(sample.input(2)),
						'--memory',
						String(RUN_MEMORY_MBYTES),
						'--json',
					],
					{
						cwd: actorDir,
						env,
					},
				);
				const call = JSON.parse(callOutput) as CallResult;
				expect(call.run.status).toBe('SUCCEEDED');
				expect(currentLog(call.run.id, env)).not.toContain('Browser view:');

				const info = JSON.parse(
					apify(['datasets', 'info', call.storage.defaultDatasetId, '--json'], { cwd: actorDir, env }),
				) as DatasetInfoResult;
				expect(info.itemCount).toBe(2);
			},
			{ timeout: 5 * 60 * 1000, retry: 1 },
		);
	});
}

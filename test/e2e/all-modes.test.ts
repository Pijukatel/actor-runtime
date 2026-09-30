/**
 * One run with debug mode, a live dev folder and browser view all on. `samples/actor_playwright` is the
 * only sample that can carry all three - headful for the view, `CMD ["node", ...]` for debug mode.
 * Started via `apify api`, never `apify call`, which a paused run would block indefinitely.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import {
	PLAYWRIGHT_BASE_IMAGE,
	buildRuntimeImage,
	isDockerAvailable,
	pullImage,
	startRuntimeContainer,
	stopRuntimeContainer,
	waitForHttpOk,
} from './helpers/docker.js';
import { CRAWL_START_URL } from './helpers/browser-view-suite.js';
import { CONSOLE_URL, fetchConsole, readMirrorGreeting } from './helpers/console-view.js';
import { withRunLogOnFailure } from './helpers/run-log.js';
import { waitFor } from './helpers/wait.js';
import {
	apify,
	apifyEnv,
	createIsolatedApifyHome,
	enableLiveDevFolder,
	loginApifyCli,
	removeIsolatedApifyHome,
	type ApiEnvelope,
	type DatasetInfoResult,
	type PushResult,
} from './helpers/apify-cli.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const SAMPLE_ACTOR_DIR = join(REPO_ROOT, 'samples', 'actor_playwright');
const CONTAINER_NAME = 'actor-runtime-e2e-all-modes';
const IMAGE_TAG = 'actor-runtime:e2e-all-modes';

const EXPECTED_IMAGE_WORKING_DIR = '/home/myuser';
const DEBUG_PORT = 9229;
/** The default 1024 MB grants a quarter core (`resources.ts`), too little for a headful browser. */
const RUN_MEMORY_MBYTES = 4096;
const MAX_REQUESTS_PER_CRAWL = 4;

/** Edited in the dev folder after the push, so printing it proves the mount supplied the code. */
const ORIGINAL_MARKER = 'page(s) with a headful Chrome,';
const EDITED_MARKER = 'page(s) with a headful Chrome (all-modes-dev-folder-marker),';

interface RunApi {
	id: string;
	status: string;
	statusMessage?: string;
}

function startRun(actorId: string, input: unknown, env: NodeJS.ProcessEnv): RunApi {
	// Debug mode does not extend the run timeout for the time spent attaching.
	const params = JSON.stringify({ memory: RUN_MEMORY_MBYTES, timeout: 900 });
	const output = apify(
		['api', 'POST', `actors/${actorId}/runs`, '--params', params, '--body', JSON.stringify(input)],
		{ cwd: REPO_ROOT, env },
	);
	return (JSON.parse(output) as ApiEnvelope<RunApi>).data;
}

function getRun(runId: string, env: NodeJS.ProcessEnv): RunApi {
	const output = apify(['api', 'GET', `actor-runs/${runId}`], { cwd: REPO_ROOT, env });
	return (JSON.parse(output) as ApiEnvelope<RunApi>).data;
}

function currentLog(runId: string, env: NodeJS.ProcessEnv): string {
	return apify(['api', 'GET', `actor-runs/${runId}/log`], { cwd: REPO_ROOT, env });
}

interface InspectorTarget {
	id: string;
	webSocketDebuggerUrl?: string;
}

async function nodeInspectorTargets(port: number): Promise<InspectorTarget[] | undefined> {
	try {
		const res = await fetch(`http://127.0.0.1:${port}/json/list`);
		if (!res.ok) return undefined;
		const body: unknown = await res.json();
		return Array.isArray(body) && body.length > 0 ? (body as InspectorTarget[]) : undefined;
	} catch {
		return undefined;
	}
}

/** Dialed at `127.0.0.1`, not the target's advertised `webSocketDebuggerUrl` - Node reports the
 * `0.0.0.0` it bound inside the container. */
function resumePausedNodeProcess(port: number, targetId: string, timeoutMs = 30_000): Promise<void> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(`ws://127.0.0.1:${port}/${targetId}`);
		const timer = setTimeout(() => {
			ws.terminate();
			reject(new Error('Timed out waiting for the inspector to acknowledge Runtime.runIfWaitingForDebugger'));
		}, timeoutMs);
		// `settle` closes the socket; that close must not report itself as a premature one.
		let settled = false;
		const settle = (error?: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			ws.close();
			if (error) reject(error);
			else resolve();
		};
		ws.once('open', () => {
			ws.send(JSON.stringify({ id: 1, method: 'Runtime.enable' }));
			ws.send(JSON.stringify({ id: 2, method: 'Runtime.runIfWaitingForDebugger' }));
		});
		ws.on('message', (data) => {
			const message = JSON.parse(Buffer.from(data as Buffer).toString('utf8')) as { id?: number };
			if (message.id === 2) settle();
		});
		ws.once('error', (error) => settle(error));
		ws.once('close', () => settle(new Error('The inspector websocket closed before acknowledging the resume')));
	});
}

describe('all advanced modes at once: debug + live dev folder + browser view on one run (requires Docker)', () => {
	let isolatedApifyHome: string;
	let actorDir: string;
	let actorId: string;
	let startedRunId: string | undefined;

	// A `retry` must not inherit the previous attempt's container: it still holds the published debug
	// port, and the next run dies with "Host port 9229 is already in use".
	afterEach(() => {
		const runId = startedRunId;
		startedRunId = undefined;
		if (!runId) return;
		try {
			apify(['api', 'POST', `actor-runs/${runId}/abort`], {
				cwd: REPO_ROOT,
				env: apifyEnv(isolatedApifyHome),
			});
		} catch {
			// Already terminal.
		}
	});

	beforeAll(
		async () => {
			if (!isDockerAvailable()) {
				throw new Error(
					'Docker daemon is not reachable - this e2e case requires one (see requirements/test.md)',
				);
			}

			pullImage(PLAYWRIGHT_BASE_IMAGE);
			buildRuntimeImage(REPO_ROOT, IMAGE_TAG);
			startRuntimeContainer(IMAGE_TAG, CONTAINER_NAME);
			await waitForHttpOk('http://localhost:3333/v2/users/me?token=x');

			isolatedApifyHome = createIsolatedApifyHome();
			loginApifyCli(REPO_ROOT, isolatedApifyHome);

			actorDir = mkdtempSync(join(tmpdir(), 'actor-runtime-e2e-all-modes-actor-'));
			const excluded = [join(SAMPLE_ACTOR_DIR, 'node_modules'), join(SAMPLE_ACTOR_DIR, 'dist')];
			cpSync(SAMPLE_ACTOR_DIR, actorDir, {
				recursive: true,
				filter: (src) => !excluded.some((dir) => src === dir || src.startsWith(`${dir}/`)),
			});
			// `mkdtemp` makes it 0700, which this image's non-root `myuser` could not read under the mount.
			chmodSync(actorDir, 0o777);

			// Pushed before the edit below, so the edited marker is the mount's doing alone.
			const push = JSON.parse(
				apify(['push', '--json'], { cwd: actorDir, env: apifyEnv(isolatedApifyHome) }),
			) as PushResult;
			if (push.build.status !== 'SUCCEEDED') {
				throw new Error(`apify push of the sample Actor ended with build status ${push.build.status}`);
			}
			actorId = push.actor.id;

			// `--ignore-scripts` skips the sample's browser download; the run uses the image's.
			execFileSync('npm', ['install', '--ignore-scripts'], { cwd: actorDir, stdio: 'inherit' });

			// Here, not in the test body, so a `retry` does not edit it twice.
			const mainTs = join(actorDir, 'src', 'main.ts');
			const originalMainTs = readFileSync(mainTs, 'utf8');
			if (!originalMainTs.includes(ORIGINAL_MARKER)) {
				throw new Error(`${mainTs} no longer contains the marker line this suite edits`);
			}
			writeFileSync(mainTs, originalMainTs.replace(ORIGINAL_MARKER, EDITED_MARKER));
			execFileSync('npm', ['run', 'build'], { cwd: actorDir, stdio: 'inherit' });
		},
		20 * 60 * 1000,
	);

	afterAll(() => {
		stopRuntimeContainer(CONTAINER_NAME);
		if (isolatedApifyHome) removeIsolatedApifyHome(isolatedApifyHome);
		// This folder is the container's `HOME`; Chrome leaves dot-directories owned by the image's
		// non-root `myuser`, which this suite's uid cannot unlink.
		if (actorDir) {
			try {
				rmSync(actorDir, { recursive: true, force: true });
			} catch (error) {
				console.warn(`Could not fully remove the temporary Actor folder ${actorDir}: ${String(error)}`);
			}
		}
	});

	it(
		'one run with all three toggles on: it pauses for a debugger, mirrors its display live, runs the locally recompiled source once released, and finishes SUCCEEDED with an input-dependent item count',
		async () => {
			const env = apifyEnv(isolatedApifyHome);

			const devFolder = apify(
				['api', 'POST', `/actor-runtime/dev-folder/${actorId}`, '--body', JSON.stringify(actorDir)],
				{ cwd: REPO_ROOT, env },
			);
			expect(JSON.parse(devFolder).data.localDevFolder).toBe(actorDir);
			enableLiveDevFolder(actorId, REPO_ROOT, env);
			const debug = apify(['api', 'POST', `/actor-runtime/debug/${actorId}`, '--body', '{"enabled": true}'], {
				cwd: REPO_ROOT,
				env,
			});
			expect(JSON.parse(debug).data.localDebug).toEqual({ language: 'auto', port: 5678 });
			const browserView = apify(
				['api', 'POST', `/actor-runtime/browser-view/${actorId}`, '--body', '{"enabled": true}'],
				{ cwd: REPO_ROOT, env },
			);
			expect(JSON.parse(browserView).data.localBrowserView).toEqual({ interactive: false });

			const run = startRun(
				actorId,
				{ maxRequestsPerCrawl: MAX_REQUESTS_PER_CRAWL, startUrls: [{ url: CRAWL_START_URL }] },
				env,
			);
			startedRunId = run.id;

			// The debug line lands last of the three, so waiting on it waits on all of them.
			const pausedLog = await waitFor(
				() => {
					const text = currentLog(run.id, env);
					return text.includes('Debug mode: this run is paused') ? text : undefined;
				},
				2 * 60 * 1000,
				'the debug attach line to appear in the run log',
			);
			expect(pausedLog).toContain(`Live dev folder: ${actorDir}`);
			expect(pausedLog).toContain(EXPECTED_IMAGE_WORKING_DIR);
			expect(pausedLog).toContain(`Browser view: live mirror of this run's display`);
			expect(pausedLog).toContain(`${CONSOLE_URL}/runs/${run.id}/browser`);
			expect(pausedLog).toContain(`0.0.0.0:${DEBUG_PORT}`);
			expect(pausedLog).toContain(`127.0.0.1:${DEBUG_PORT}`);
			// The mount hides the image's entrypoint; the driver preserves it, or nothing would start.
			expect(pausedLog).toContain(`starts through ${EXPECTED_IMAGE_WORKING_DIR}/xvfb-entrypoint.sh`);
			expect(pausedLog).not.toContain('Crawling up to');
			expect(getRun(run.id, env).status).toBe('RUNNING');

			const targets = await waitFor(
				() => nodeInspectorTargets(DEBUG_PORT),
				60_000,
				`127.0.0.1:${DEBUG_PORT} to answer the Node inspector protocol`,
			);
			await resumePausedNodeProcess(DEBUG_PORT, targets[0]!.id);

			const runningLog = await waitFor(
				() => {
					const text = currentLog(run.id, env);
					return text.includes('Crawling up to') ? text : undefined;
				},
				2 * 60 * 1000,
				'the Actor to reach its own first log line after the debugger released it',
			);
			expect(runningLog).toContain(EDITED_MARKER);

			// Chrome in a fresh container is slow to appear.
			const greeting = await readMirrorGreeting(run.id, 3 * 60 * 1000);
			expect(greeting.startsWith('RFB 003.')).toBe(true);

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
						'the all-modes run to finish',
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
					expect(info.itemCount).toBe(MAX_REQUESTS_PER_CRAWL);
				},
			);

			const finalLog = currentLog(run.id, env);
			expect(finalLog).toContain(EDITED_MARKER);
			expect(finalLog).not.toContain(ORIGINAL_MARKER);

			const endedPage = await fetchConsole(`/runs/${run.id}/browser`);
			expect(await endedPage.text()).toContain('This run has ended');
			await expect(readMirrorGreeting(run.id, 10_000)).rejects.toThrow(/1008/);
		},
		{ timeout: 20 * 60 * 1000, retry: 1 },
	);
});

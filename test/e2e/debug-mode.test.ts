/**
 * E2E coverage for per-Actor debug mode (`actor-driver.md`'s "Debug mode" section), driven entirely by
 * `apify` commands per `requirements/test.md`'s CLI-only rule - except the one narrow exception that
 * same rule now documents: this test opens a raw TCP/HTTP check against the published debug port,
 * because the workflow under test is an IDE attach and no `apify` command can express it.
 *
 * Deliberately does NOT use `apify call` (which blocks until the run finishes) to start the debug run -
 * a debug run pauses indefinitely until a debugger attaches, which this test never does, so `apify call`
 * would simply hang for its whole timeout. Instead it starts the run the same way `apify call` itself
 * does under the hood: `POST /v2/actors/:actorId/runs`, reachable as a stock CLI command via
 * `apify api POST actors/<id>/runs` - the run record comes back immediately (`READY`, about to become
 * `RUNNING`), so this test can poll its log and abort it explicitly.
 *
 * Each sample Actor's own image invokes its interpreter directly already (`sample_actor_ts/Dockerfile`:
 * `CMD ["node", "dist/main.js"]`; `sample_actor_py/Dockerfile`: `CMD ["python3", "-m", "src"]`), so
 * `language: "auto"` resolves correctly for both with zero Actor-side changes - exactly the "zero
 * cooperation" property this feature promises.
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { connect } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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
	type PushResult,
} from './helpers/apify-cli.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const CONTAINER_NAME = 'actor-runtime-e2e-debug';
const IMAGE_TAG = 'actor-runtime:e2e-debug';

interface RunApi {
	id: string;
	status: string;
	statusMessage?: string;
}

function startRun(actorId: string, env: NodeJS.ProcessEnv): RunApi {
	const output = apify(['api', 'POST', `actors/${actorId}/runs`, '--body', '{}'], { cwd: REPO_ROOT, env });
	return (JSON.parse(output) as ApiEnvelope<RunApi>).data;
}

function getRun(runId: string, env: NodeJS.ProcessEnv): RunApi {
	const output = apify(['api', 'GET', `actor-runs/${runId}`], { cwd: REPO_ROOT, env });
	return (JSON.parse(output) as ApiEnvelope<RunApi>).data;
}

function abortRun(runId: string, env: NodeJS.ProcessEnv): RunApi {
	const output = apify(['api', 'POST', `actor-runs/${runId}/abort`], { cwd: REPO_ROOT, env });
	return (JSON.parse(output) as ApiEnvelope<RunApi>).data;
}

/**
 * `GET actor-runs/<id>/log` (no `?stream=true`) rather than the CLI's own `apify runs log <id>` command -
 * deliberately: that command's own `outputJobLog` helper streams and blocks until the log ends whenever
 * the job is non-terminal, with no timeout applied by `runs log` itself. A paused debug run stays
 * `RUNNING` until this test explicitly aborts it, so `apify runs log` would hang for the run's own
 * lifetime instead of returning the log as it currently stands - exactly what polling here needs.
 * `apify api GET` is a single, non-streaming fetch of the exact same plain-text endpoint either way.
 */
function currentLog(runId: string, env: NodeJS.ProcessEnv): string {
	return apify(['api', 'GET', `actor-runs/${runId}/log`], { cwd: REPO_ROOT, env });
}

/**
 * Polls `check` until it returns a defined value or `timeoutMs` elapses. `check` may be sync or async -
 * either way its result is `await`ed before being tested, so an async check (e.g. `nodeInspectorAnswers`,
 * `canConnectTcp`) is genuinely retried on each poll rather than resolving this function on its very
 * first call with whatever that one probe happened to return. A check that throws (a transient CLI/HTTP
 * hiccup) is treated the same as one that returns `undefined` - retried, not propagated - so a single
 * flaky poll can't fail the whole wait before its deadline.
 */
async function waitFor<T>(
	check: () => T | undefined | Promise<T | undefined>,
	timeoutMs: number,
	description: string,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		let result: T | undefined;
		try {
			result = await check();
		} catch {
			result = undefined;
		}
		if (result !== undefined) return result;
		if (Date.now() >= deadline) throw new Error(`Timed out waiting for: ${description}`);
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
}

/** A bare TCP connect to `127.0.0.1:port` - succeeds the moment something is listening, with no protocol
 * handshake at all. Used for the Python case: debugpy's own listen socket accepts a raw TCP connection
 * before any DAP handshake happens. This only proves the port is reachable and something is listening,
 * not that a real IDE could attach - asserting a full DAP initialize/attach/configurationDone handshake
 * is deliberately out of scope for this test. */
function canConnectTcp(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = connect({ host: '127.0.0.1', port, timeout: 2000 });
		socket.once('connect', () => {
			socket.destroy();
			resolve(true);
		});
		socket.once('error', () => resolve(false));
		socket.once('timeout', () => {
			socket.destroy();
			resolve(false);
		});
	});
}

/** Node's inspector protocol answers `GET /json/list` with a JSON array describing the debug target -
 * served the moment `--inspect-brk` starts listening, before any client ever attaches over the
 * websocket. A genuine protocol-level check, not just "something is listening on this port". */
async function nodeInspectorAnswers(port: number): Promise<boolean> {
	try {
		const res = await fetch(`http://127.0.0.1:${port}/json/list`);
		if (!res.ok) return false;
		const body: unknown = await res.json();
		return Array.isArray(body);
	} catch {
		return false;
	}
}

/**
 * `waitFor` itself, in isolation - no Docker, no `apify` CLI. Pins that an async `check` is genuinely
 * `await`ed and retried on every poll, not just called once and compared against its own pending Promise
 * (which is never `=== undefined`) - the one property this helper exists to guarantee, in a file whose
 * real assertions all require Docker to even run.
 */
describe('waitFor (self-check, no Docker required)', () => {
	it('retries a sync check across multiple polls until it returns a defined value', async () => {
		let calls = 0;
		const result = await waitFor(
			() => {
				calls += 1;
				return calls >= 3 ? calls : undefined;
			},
			5000,
			'a sync check to succeed on its 3rd call',
		);
		expect(result).toBe(3);
		expect(calls).toBe(3);
	});

	it('awaits an ASYNC check and genuinely retries it across multiple polls, not just its first call', async () => {
		let calls = 0;
		const result = await waitFor(
			async () => {
				calls += 1;
				await new Promise((resolve) => setTimeout(resolve, 5));
				return calls >= 4 ? calls : undefined;
			},
			5000,
			'an async check to succeed on its 4th call',
		);
		expect(result).toBe(4);
		// `calls` reaching 4 (not 1) is the proof: an un-awaited `check()` call would compare its own
		// pending Promise against `undefined` - always false-y `!==` - and return on the very first poll.
		expect(calls).toBe(4);
	});

	it('treats a throwing check the same as one returning undefined - retried, not propagated', async () => {
		let calls = 0;
		const result = await waitFor(
			() => {
				calls += 1;
				if (calls < 3) throw new Error('transient failure');
				return 'ok';
			},
			5000,
			'a check that throws twice before succeeding',
		);
		expect(result).toBe('ok');
		expect(calls).toBe(3);
	});

	it('throws its own timeout error, naming the description, when the check never succeeds', async () => {
		await expect(waitFor(() => undefined, 300, 'a check that never succeeds')).rejects.toThrow(
			/Timed out waiting for: a check that never succeeds/,
		);
	});
});

describe('per-Actor debug mode: pause, published port, and abort while paused (requires Docker)', () => {
	let isolatedApifyHome: string;

	beforeAll(
		async () => {
			if (!isDockerAvailable()) {
				throw new Error(
					'Docker daemon is not reachable - this e2e case requires one (see requirements/test.md)',
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

	it(
		'Node Actor (sample_actor_ts, CMD invokes node directly): pauses before user code, publishes 9229, answers the inspector protocol, then aborts cleanly while paused',
		async () => {
			const env = apifyEnv(isolatedApifyHome);
			const actorDir = join(REPO_ROOT, 'sample_actor_ts');

			const pushOutput = apify(['push', '--json'], { cwd: actorDir, env });
			const push = JSON.parse(pushOutput) as PushResult;
			expect(push.build.status).toBe('SUCCEEDED');
			const actorId = push.actor.id;

			const toggle = apify(['api', 'POST', `/actor-runtime/debug/${actorId}`, '--body', '{"enabled": true}'], {
				cwd: REPO_ROOT,
				env,
			});
			expect(JSON.parse(toggle).data.localDebug).toEqual({ language: 'auto', port: 5678 });

			const run = startRun(actorId, env);

			// The attach line lands in the log before the container is even created (`docker-driver.ts`),
			// so it should appear almost immediately - polled rather than assumed instantaneous.
			const log = await waitFor(
				() => {
					const text = currentLog(run.id, env);
					return text.includes('Debug mode: this run is paused') ? text : undefined;
				},
				60_000,
				'the debug attach line to appear in the run log',
			);
			expect(log).toContain('paused before its first line');
			expect(log).toContain('0.0.0.0:9229');
			expect(log).toContain('127.0.0.1:9229');
			expect(log).toMatch(/Node/);
			expect(log).toContain('NOT extended');
			// No user code has run at all - not even `Actor.init()`'s own first log line.
			expect(log).not.toContain('Resources granted');
			expect(log).not.toContain('Crawling up to');

			// The published port answers the real Node inspector protocol before any client ever attaches.
			const answered = await waitFor(
				async () => ((await nodeInspectorAnswers(9229)) ? true : undefined),
				30_000,
				'127.0.0.1:9229 to answer the Node inspector protocol',
			);
			expect(answered).toBe(true);

			// Still paused - no debugger ever attached in this test, so the run must still be RUNNING, never
			// SUCCEEDED/FAILED.
			const stillRunning = getRun(run.id, env);
			expect(stillRunning.status).toBe('RUNNING');

			abortRun(run.id, env);
			const finalRun = await waitFor(
				() => {
					const current = getRun(run.id, env);
					return current.status === 'ABORTED' ? current : undefined;
				},
				30_000,
				'the paused run to reach ABORTED after an explicit abort',
			);
			expect(finalRun.status).toBe('ABORTED');
		},
		3 * 60 * 1000,
	);

	it(
		'Python Actor (sample_actor_py, CMD invokes python3 directly): pauses before user code, publishes 5678, accepts a TCP connection, then aborts cleanly while paused',
		async () => {
			const env = apifyEnv(isolatedApifyHome);
			const actorDir = join(REPO_ROOT, 'sample_actor_py');

			const pushOutput = apify(['push', '--json'], { cwd: actorDir, env });
			const push = JSON.parse(pushOutput) as PushResult;
			expect(push.build.status).toBe('SUCCEEDED');
			const actorId = push.actor.id;

			const toggle = apify(['api', 'POST', `/actor-runtime/debug/${actorId}`, '--body', '{"enabled": true}'], {
				cwd: REPO_ROOT,
				env,
			});
			expect(JSON.parse(toggle).data.localDebug).toEqual({ language: 'auto', port: 5678 });

			const run = startRun(actorId, env);

			const log = await waitFor(
				() => {
					const text = currentLog(run.id, env);
					return text.includes('Debug mode: this run is paused') ? text : undefined;
				},
				60_000,
				'the debug attach line to appear in the run log',
			);
			expect(log).toContain('paused before its first line');
			expect(log).toContain('0.0.0.0:5678');
			expect(log).toContain('127.0.0.1:5678');
			expect(log).toMatch(/debugpy \d+\.\d+\.\d+/);
			expect(log).toContain('Attach to DAP');
			expect(log).toContain('NOT extended');

			// The injected `sitecustomize.py` (`docker/sitecustomize.py`) prints its own "listening" line
			// from *inside* the container, as real stdout - its presence is the diagnosable proof that
			// injection actually worked, independent of the driver's own attach line above.
			const sitecustomizeLog = await waitFor(
				() => {
					const text = currentLog(run.id, env);
					return text.includes('debugpy is listening on 0.0.0.0:5678') ? text : undefined;
				},
				30_000,
				'sitecustomize.py\'s own "listening" line to appear in the run log',
			);
			expect(sitecustomizeLog).toContain('[actor-runtime debug] debugpy is listening on 0.0.0.0:5678');
			// No user code has run yet - not even the Actor's own first log line.
			expect(sitecustomizeLog).not.toContain('Resources granted');
			expect(sitecustomizeLog).not.toContain('Crawling up to');

			const connected = await waitFor(
				async () => ((await canConnectTcp(5678)) ? true : undefined),
				30_000,
				'127.0.0.1:5678 to accept a TCP connection',
			);
			expect(connected).toBe(true);

			const stillRunning = getRun(run.id, env);
			expect(stillRunning.status).toBe('RUNNING');

			abortRun(run.id, env);
			const finalRun = await waitFor(
				() => {
					const current = getRun(run.id, env);
					return current.status === 'ABORTED' ? current : undefined;
				},
				30_000,
				'the paused run to reach ABORTED after an explicit abort',
			);
			expect(finalRun.status).toBe('ABORTED');
		},
		3 * 60 * 1000,
	);
});

/**
 * E2E coverage for Actors unlike anything an Apify template produces, driven through
 * `samples/actor_nonstandard`: unusual base image, custom entry point, unusual working directory - plus
 * an image with no working directory at all. The runtime must read all of it off the built image.
 *
 * `apify` commands only, except the debug-port TCP connect no CLI command can express
 * (`requirements/test.md`'s documented exception). Requires Docker and fails loudly without it.
 */
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { connect } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
	NONSTANDARD_ACTOR_BASE_IMAGE,
	NO_WORKDIR_ACTOR_BASE_IMAGE,
	buildRuntimeImage,
	isDockerAvailable,
	pullImage,
	startRuntimeContainer,
	stopRuntimeContainer,
	waitForHttpOk,
} from './helpers/docker.js';
import {
	apify,
	apifyEnv,
	createIsolatedApifyHome,
	enableLiveDevFolder,
	loginApifyCli,
	removeIsolatedApifyHome,
	type ApiEnvelope,
	type CallResult,
	type DatasetInfoResult,
	type PushResult,
} from './helpers/apify-cli.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const SAMPLE_ACTOR_DIR = join(REPO_ROOT, 'samples', 'actor_nonstandard');
const CONTAINER_NAME = 'actor-runtime-e2e-nonstandard';
const IMAGE_TAG = 'actor-runtime:e2e-nonstandard';

/** The sample's own `WORKDIR` and `USER` - neither of them an Apify base image's. */
const WORKING_DIRECTORY = '/opt/weird-app';
const ACTOR_UID = '1500';
/** `app/main.py`'s `FINISHED_MARKER`, and the edit a dev-folder run must pick up instead. */
const ORIGINAL_MARKER = 'Non-standard Actor finished.';
const EDITED_MARKER = 'Non-standard Actor finished (dev-folder-edit-marker).';
/** `launch.sh`'s `$0` when started from the image's own copy. Docker keeps `./launch.sh`, Podman
 * resolves it to `<workdir>/./launch.sh`; either way, not the preserved copy below. */
const IMAGE_ENTRY_POINT_LINE = new RegExp(
	`launch\\.sh: entry point running as (?:${WORKING_DIRECTORY}/)?\\./launch\\.sh`,
);
/** `docker-driver.ts`'s `PRESERVED_ENTRYPOINT_DIR` copy - the runtime's own absolute path. */
const PRESERVED_ENTRY_POINT = '/apify-runtime-entrypoint/launch.sh';

/** Pushed by the first test, reused by the later ones (they run in declaration order). */
let actorId: string;

/** The stored log: this Actor exits so fast that `apify call`'s stream can miss its last lines. */
function storedLog(runId: string, env: NodeJS.ProcessEnv): string {
	return apify(['api', 'GET', `actor-runs/${runId}/log`], { cwd: REPO_ROOT, env });
}

function buildLog(buildId: string, env: NodeJS.ProcessEnv): string {
	return apify(['api', 'GET', `actor-builds/${buildId}/log`], { cwd: REPO_ROOT, env });
}

function callWith(input: object, env: NodeJS.ProcessEnv, cwd = SAMPLE_ACTOR_DIR): CallResult {
	return JSON.parse(apify(['call', '--input', JSON.stringify(input), '--json'], { cwd, env })) as CallResult;
}

function registerDevFolder(id: string, path: string, env: NodeJS.ProcessEnv): { localDevFolder: string | null } {
	enableLiveDevFolder(id, REPO_ROOT, env);
	const output = apify(['api', 'POST', `/actor-runtime/dev-folder/${id}`, '--body', JSON.stringify(path)], {
		cwd: REPO_ROOT,
		env,
	});
	return (JSON.parse(output) as ApiEnvelope<{ localDevFolder: string | null }>).data;
}

/** Polls until `check` returns a value or the deadline passes; a throwing check just retries. */
async function waitFor<T>(check: () => T | undefined, timeoutMs: number, description: string): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		let result: T | undefined;
		try {
			result = check();
		} catch {
			result = undefined;
		}
		if (result !== undefined) return result;
		if (Date.now() >= deadline) throw new Error(`Timed out waiting for: ${description}`);
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
}

/** A bare TCP connect - debugpy accepts one before any DAP handshake. */
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

describe('non-standard Actors: unusual base image, custom entry point, unusual working directory (requires Docker)', () => {
	let isolatedApifyHome: string;

	beforeAll(
		async () => {
			if (!isDockerAvailable()) {
				throw new Error(
					'Docker daemon is not reachable - this e2e case requires one (see requirements/test.md)',
				);
			}

			// Only what this file builds against; it never touches the `apify/actor-*` samples.
			pullImage(NONSTANDARD_ACTOR_BASE_IMAGE);
			pullImage(NO_WORKDIR_ACTOR_BASE_IMAGE);
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
		"push -> build (Dockerfile found only via .actor/actor.json) -> call(itemCount=2) -> call(itemCount=5): the item count tracks the input, and the run really starts through the custom entry point, in the unusual working directory, as the image's own non-root user",
		() => {
			const env = apifyEnv(isolatedApifyHome);

			const push = JSON.parse(apify(['push', '--json'], { cwd: SAMPLE_ACTOR_DIR, env })) as PushResult;
			expect(push.build.status).toBe('SUCCEEDED');
			actorId = push.actor.id;

			// In neither default location - reachable only through `.actor/actor.json`'s `dockerfile` field.
			expect(buildLog(push.build.id, env)).toContain(
				'Using Dockerfile "docker/Actor.dockerfile" (from the "dockerfile" field in .actor/actor.json).',
			);

			const itemCountFor = (itemCount: number): number => {
				const call = callWith({ itemCount }, env);
				expect(call.run.status).toBe('SUCCEEDED');

				const log = storedLog(call.run.id, env);
				// The custom entry point ran, in the image's own working directory, as its own user.
				expect(log).toMatch(IMAGE_ENTRY_POINT_LINE);
				expect(log).toContain(`launch.sh: working directory ${WORKING_DIRECTORY}`);
				expect(log).toContain(`launch.sh: user id ${ACTOR_UID}`);
				expect(log).toContain('launch.sh: handing over to: app/main.py');
				expect(log).toContain(`main.py: working directory ${WORKING_DIRECTORY}`);
				// The platform env vars reach an Actor that never imports the SDK.
				expect(log).toContain('main.py: APIFY_IS_AT_HOME=1');
				expect(log).toContain(`main.py: ACTOR_RUN_ID=${call.run.id}`);
				expect(log).toContain(ORIGINAL_MARKER);

				// The `OUTPUT` record it wrote over plain HTTP, read back through the CLI.
				const output = JSON.parse(
					apify(['api', 'GET', `key-value-stores/${call.storage.defaultKeyValueStoreId}/records/OUTPUT`], {
						cwd: REPO_ROOT,
						env,
					}),
				) as { itemCount: number; workingDirectory: string };
				expect(output).toEqual({ itemCount, workingDirectory: WORKING_DIRECTORY });

				const info = JSON.parse(
					apify(['datasets', 'info', call.storage.defaultDatasetId, '--json'], { cwd: REPO_ROOT, env }),
				) as DatasetInfoResult;
				return info.itemCount;
			};

			expect(itemCountFor(2)).toBe(2);
			expect(itemCountFor(5)).toBe(5);
		},
		10 * 60 * 1000,
	);

	it(
		"the dev-folder bind mount lands on the image's own unusual working directory, and the custom entry point keeps working whether the dev folder carries it or not",
		() => {
			const env = apifyEnv(isolatedApifyHome);
			expect(actorId).toBeTruthy();

			// A throwaway copy - this case edits the source, and the committed sample must stay untouched.
			const devFolder = mkdtempSync(join(tmpdir(), 'actor-runtime-e2e-nonstandard-dev-'));
			try {
				// `mkdtemp` makes it 0700: unreadable to the image's own uid-1500 user once mounted.
				chmodSync(devFolder, 0o755);
				cpSync(SAMPLE_ACTOR_DIR, devFolder, { recursive: true });
				// The mounted copy is what `ENTRYPOINT ["./launch.sh"]` executes - it needs the mode.
				chmodSync(join(devFolder, 'launch.sh'), 0o755);
				const mainPy = join(devFolder, 'app', 'main.py');
				writeFileSync(mainPy, readFileSync(mainPy, 'utf8').replace(ORIGINAL_MARKER, EDITED_MARKER));

				expect(registerDevFolder(actorId, devFolder, env).localDevFolder).toBe(devFolder);

				// No push/build between the edit and this call, against a working directory the runtime could
				// only have learned from the image.
				const mounted = callWith({ itemCount: 1 }, env);
				expect(mounted.run.status).toBe('SUCCEEDED');
				const mountedLog = storedLog(mounted.run.id, env);
				expect(mountedLog).toContain(`Live dev folder: ${devFolder}`);
				expect(mountedLog).toContain(`mounted over the image's working directory ${WORKING_DIRECTORY}`);
				expect(mountedLog).toContain(EDITED_MARKER);
				expect(mountedLog).not.toContain(`${ORIGINAL_MARKER}\n`);
				// The dev folder carries `launch.sh`, so the image's copy is never substituted.
				expect(mountedLog).toMatch(IMAGE_ENTRY_POINT_LINE);
				expect(mountedLog).not.toContain(PRESERVED_ENTRY_POINT);
				expect(mountedLog).not.toContain("using the image's own copy of it");

				// The other branch: without it the mount would hide `./launch.sh` and the container would not
				// start - the runtime must fall back to the image's copy, at a path no mount covers.
				rmSync(join(devFolder, 'launch.sh'));
				const preserved = callWith({ itemCount: 4 }, env);
				expect(preserved.run.status).toBe('SUCCEEDED');
				const preservedLog = storedLog(preserved.run.id, env);
				expect(preservedLog).toContain('The image starts through ./launch.sh in its working directory');
				expect(preservedLog).toContain(`launch.sh: entry point running as ${PRESERVED_ENTRY_POINT}`);
				// Still the dev folder's edited body, started by the image's entry point.
				expect(preservedLog).toContain(EDITED_MARKER);
				expect(preservedLog).toContain(`launch.sh: working directory ${WORKING_DIRECTORY}`);

				const info = JSON.parse(
					apify(['datasets', 'info', preserved.storage.defaultDatasetId, '--json'], { cwd: REPO_ROOT, env }),
				) as DatasetInfoResult;
				expect(info.itemCount).toBe(4);
			} finally {
				// Later cases run this Actor from its image alone; a registration on a removed folder would
				// fail them.
				apify(['api', 'POST', `/actor-runtime/dev-folder/${actorId}`, '--body', '""'], {
					cwd: REPO_ROOT,
					env,
				});
				rmSync(devFolder, { recursive: true, force: true });
			}
		},
		10 * 60 * 1000,
	);

	it(
		'an image with no working directory at all runs fine, and a dev folder registered for it is reported as unmountable instead of being silently ignored',
		() => {
			const env = apifyEnv(isolatedApifyHome);

			// No `WORKDIR` at all: the `imageWorkingDirectory` half of the mount's precondition is absent.
			const noWorkdirActorDir = mkdtempSync(join(tmpdir(), 'actor-runtime-e2e-no-workdir-'));
			const devFolder = mkdtempSync(join(tmpdir(), 'actor-runtime-e2e-no-workdir-src-'));
			try {
				mkdirSync(join(noWorkdirActorDir, '.actor'));
				writeFileSync(
					join(noWorkdirActorDir, '.actor', 'actor.json'),
					JSON.stringify({
						actorSpecification: 1,
						name: 'no-workdir-actor',
						version: '0.0',
						buildTag: 'latest',
					}),
				);
				writeFileSync(
					join(noWorkdirActorDir, 'run.sh'),
					'#!/bin/sh\necho "no-workdir actor: pwd=$(pwd)"\necho "no-workdir actor: done"\n',
				);
				writeFileSync(
					join(noWorkdirActorDir, 'Dockerfile'),
					[
						`FROM ${NO_WORKDIR_ACTOR_BASE_IMAGE}`,
						'COPY run.sh /run.sh',
						'RUN chmod 755 /run.sh',
						'CMD ["/run.sh"]',
						'',
					].join('\n'),
				);
				writeFileSync(join(devFolder, 'only-in-dev-folder.txt'), 'x');

				const push = JSON.parse(apify(['push', '--json'], { cwd: noWorkdirActorDir, env })) as PushResult;
				expect(push.build.status).toBe('SUCCEEDED');

				expect(registerDevFolder(push.actor.id, devFolder, env).localDevFolder).toBe(devFolder);

				const call = JSON.parse(apify(['call', '--json'], { cwd: noWorkdirActorDir, env })) as CallResult;
				// The run starts exactly as if the feature did not exist...
				expect(call.run.status).toBe('SUCCEEDED');
				const log = storedLog(call.run.id, env);
				expect(log).toContain('no-workdir actor: pwd=/');
				expect(log).toContain('no-workdir actor: done');
				// ...but says why the folder was not mounted, instead of ignoring it silently.
				expect(log).toContain(`Not mounting the registered local dev folder ${devFolder} for this run`);
				expect(log).toContain('has no working directory of its own');
				// Nothing was mounted.
				expect(log).not.toContain('Live dev folder mode');
			} finally {
				rmSync(noWorkdirActorDir, { recursive: true, force: true });
				rmSync(devFolder, { recursive: true, force: true });
			}
		},
		10 * 60 * 1000,
	);

	it(
		"debug mode classifies the non-standard image from the image itself: `language: auto` resolves Python even though the image's command names a shell script, not an interpreter",
		async () => {
			const env = apifyEnv(isolatedApifyHome);
			expect(actorId).toBeTruthy();

			const toggle = apify(['api', 'POST', `/actor-runtime/debug/${actorId}`, '--body', '{"enabled": true}'], {
				cwd: REPO_ROOT,
				env,
			});
			expect((JSON.parse(toggle) as ApiEnvelope<{ localDebug: unknown }>).data.localDebug).toEqual({
				language: 'auto',
				port: 5678,
			});

			// Not `apify call`: a paused debug run would block it for the whole timeout. This is how `call`
			// starts a run under the hood, returning immediately.
			const run = (
				JSON.parse(
					apify(['api', 'POST', `actors/${actorId}/runs`, '--body', '{}'], { cwd: REPO_ROOT, env }),
				) as ApiEnvelope<{
					id: string;
					status: string;
				}>
			).data;

			try {
				const log = await waitFor(
					() => {
						const text = storedLog(run.id, env);
						return text.includes('Debug mode: this run is paused') ? text : undefined;
					},
					60_000,
					'the debug attach line to appear in the run log',
				);
				// Resolved from the image's env fingerprint: its argv names no interpreter at all.
				expect(log).toMatch(/debugpy \d+\.\d+\.\d+/);
				expect(log).toContain('0.0.0.0:5678');
				expect(log).toContain('127.0.0.1:5678');

				// The injected payload works in a container that starts through a shell script as uid 1500.
				const listeningLog = await waitFor(
					() => {
						const text = storedLog(run.id, env);
						return text.includes('debugpy is listening on 0.0.0.0:5678') ? text : undefined;
					},
					60_000,
					'sitecustomize.py\'s own "listening" line to appear in the run log',
				);
				// The entry point ran, but the Actor's body is paused before its first line.
				expect(listeningLog).toContain('launch.sh: handing over to: app/main.py');
				expect(listeningLog).not.toContain('main.py: pushing');
				expect(listeningLog).not.toContain(ORIGINAL_MARKER);

				expect(await canConnectTcp(5678)).toBe(true);

				const stillRunning = (
					JSON.parse(apify(['api', 'GET', `actor-runs/${run.id}`], { cwd: REPO_ROOT, env })) as ApiEnvelope<{
						status: string;
					}>
				).data;
				expect(stillRunning.status).toBe('RUNNING');
			} finally {
				apify(['api', 'POST', `actor-runs/${run.id}/abort`], { cwd: REPO_ROOT, env });
				apify(['api', 'POST', `/actor-runtime/debug/${actorId}`, '--body', '{"enabled": false}'], {
					cwd: REPO_ROOT,
					env,
				});
			}

			const finalRun = await waitFor(
				() => {
					const current = (
						JSON.parse(
							apify(['api', 'GET', `actor-runs/${run.id}`], { cwd: REPO_ROOT, env }),
						) as ApiEnvelope<{
							status: string;
						}>
					).data;
					return current.status === 'ABORTED' ? current : undefined;
				},
				60_000,
				'the paused run to reach ABORTED after an explicit abort',
			);
			expect(finalRun.status).toBe('ABORTED');
		},
		10 * 60 * 1000,
	);
});

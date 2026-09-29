/**
 * E2E case for the local dev-folder bind mount - only a real Docker daemon can prove a genuine host
 * path passes the probe and the mount itself, so this is the one place that exercise runs: after one
 * real push+build, registering the Actor's host source folder via the documented
 * `apify api POST /actor-runtime/dev-folder/<actorId>` invocation and then recompiling *locally* must
 * be picked up by the *next* `apify call`, with no intervening `apify push`/build - and the image's own
 * `node_modules` must survive the mount (the anonymous-volume guarantee). Registration is itself an
 * `apify` command, so `requirements/test.md`'s CLI-only rule needs no exception here.
 *
 * Drives the loop against a throwaway copy of `samples/actor_ts` in a temp directory, never against the
 * committed sample Actor itself - an interrupted run (Ctrl-C, an OOM, a crash between the edit and the
 * restore) must not risk leaving an edited marker line in tracked source.
 *
 * Requires a reachable Docker daemon and fails loudly, never skips, mirroring `actor-dev-loop.test.ts`.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
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
	apifyAllOutput,
	apifyEnv,
	createIsolatedApifyHome,
	loginApifyCli,
	removeIsolatedApifyHome,
	type ApiEnvelope,
	type CallResult,
	type PushResult,
} from './helpers/apify-cli.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const SAMPLE_ACTOR_DIR = join(REPO_ROOT, 'samples', 'actor_ts');
const CONTAINER_NAME = 'actor-runtime-e2e-devfolder';
const IMAGE_TAG = 'actor-runtime:e2e-devfolder';
// `samples/actor_ts/Dockerfile` sets no `WORKDIR` of its own, so it inherits the base image's - the
// `apify/actor-node` image's own Dockerfile sets `WORKDIR /usr/src/app`. Asserted independently below
// via the run's own log, not only assumed here - if the base image ever moves its
// `WORKDIR`, that assertion (not the mount itself) is what will fail first and explain why.
const EXPECTED_IMAGE_WORKING_DIR = '/usr/src/app';
const ORIGINAL_MARKER = 'Crawl finished.';
const EDITED_MARKER = 'Crawl finished (dev-folder-edit-marker).';

/** `apify api POST ...`'s printed `{ data: ... }` envelope for this endpoint's response shape
 * (`services/dev-folder.ts: devFolderStatus`) - just the registered folder, nothing about any build:
 * whether a mount applies is a per-run question this Actor-level status has no way to answer in advance. */
interface DevFolderApiResult {
	data: { localDevFolder: string | null };
}

function registerDevFolder(actorId: string, path: string, env: NodeJS.ProcessEnv): DevFolderApiResult {
	// The exact CLI invocation `requirements/api.md`'s `/actor-runtime/*` section documents - the clean
	// form, no `../`, which `apify api` resolves onto `/v2/actor-runtime/dev-folder/<actorId>` (the alias
	// `server.ts` mounts solely for this ergonomics reason). `cwd: REPO_ROOT` matters here since
	// `/actor-runtime/...` resolves against the CLI's configured base URL, not the filesystem; it is
	// unrelated to `path` itself.
	const output = apify(['api', 'POST', `/actor-runtime/dev-folder/${actorId}`, '--body', JSON.stringify(path)], {
		cwd: REPO_ROOT,
		env,
	});
	return JSON.parse(output) as DevFolderApiResult;
}

describe('local dev-folder bind mount: edit-compile-call loop with no rebuild (requires Docker)', () => {
	let isolatedApifyHome: string;
	let actorDir: string;
	let mainTs: string;
	let originalMainTs: string;

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

			// A throwaway copy of the sample Actor - this suite edits `src/main.ts` and runs local builds
			// against it, and neither must ever touch the committed `samples/actor_ts` tree. `node_modules`/
			// `dist` are excluded: they are gitignored and unnecessary to copy, since `npm install`/`npm run
			// build` below regenerate both fresh inside the copy anyway.
			actorDir = mkdtempSync(join(tmpdir(), 'actor-runtime-e2e-devfolder-actor-'));
			const EXCLUDED_TOP_LEVEL_DIRS = [join(SAMPLE_ACTOR_DIR, 'node_modules'), join(SAMPLE_ACTOR_DIR, 'dist')];
			cpSync(SAMPLE_ACTOR_DIR, actorDir, {
				recursive: true,
				filter: (src) => !EXCLUDED_TOP_LEVEL_DIRS.some((dir) => src === dir || src.startsWith(`${dir}/`)),
			});
			mainTs = join(actorDir, 'src', 'main.ts');
			originalMainTs = readFileSync(mainTs, 'utf8');

			// A genuine local compile needs the sample Actor's own devDependencies (`typescript`) present on
			// the *host* - distinct from what `apify push` sends the runtime (source files only; the
			// runtime's own Docker build installs and compiles them again, inside the image).
			execFileSync('npm', ['install'], { cwd: actorDir, stdio: 'inherit' });
		},
		10 * 60 * 1000,
	);

	afterAll(() => {
		stopRuntimeContainer(CONTAINER_NAME);
		if (isolatedApifyHome) removeIsolatedApifyHome(isolatedApifyHome);
		if (actorDir) rmSync(actorDir, { recursive: true, force: true });
	});

	it(
		"two consecutive runs of the registered Actor, with a local recompile in between and no push/build between them, differ the way the recompile dictates - the dev loop's actual point",
		async () => {
			const env = apifyEnv(isolatedApifyHome);

			// A real push + build (needed so there is something to run at all - not a precondition of
			// registration itself, which never requires any build) - this is the very first test in the
			// file to touch `mainTs`, so the source pushed here (and the image's own baked-in
			// `dist/main.js`, compiled by the Dockerfile's `RUN npm run build` inside the container) both
			// still carry `ORIGINAL_MARKER`.
			const pushOutput = apify(['push', '--json'], { cwd: actorDir, env });
			const push = JSON.parse(pushOutput) as PushResult;
			expect(push.build.status).toBe('SUCCEEDED');
			const actorId = push.actor.id;

			// An initial local compile of the still-pristine source, so the registered host folder has a
			// real `dist/` for the FIRST of the two runs below - registering a folder never compiles
			// anything itself, and `beforeAll` only ran `npm install`, never a build.
			execFileSync('npm', ['run', 'build'], { cwd: actorDir, stdio: 'inherit' });

			const registered = registerDevFolder(actorId, actorDir, env);
			expect(registered.data.localDevFolder).toBe(actorDir);

			// Run #1: no edit, no recompile since the push above - the host folder's `dist/` still matches
			// what the image itself was just built from.
			const firstCallOutput = apify(['call', '--input', JSON.stringify({ maxPages: 1 }), '--json'], {
				cwd: actorDir,
				env,
			});
			const firstCall = JSON.parse(firstCallOutput) as CallResult;
			expect(firstCall.run.status).toBe('SUCCEEDED');
			const firstLog = apifyAllOutput(['runs', 'log', firstCall.run.id], { cwd: REPO_ROOT, env });
			expect(firstLog).toContain(ORIGINAL_MARKER);
			expect(firstLog).not.toContain(EDITED_MARKER);

			// The recompile IN BETWEEN the two runs - the entire point of this feature. No `apify
			// push`/`apify build` anywhere in this test after the one push above.
			writeFileSync(mainTs, originalMainTs.replace(ORIGINAL_MARKER, EDITED_MARKER));
			execFileSync('npm', ['run', 'build'], { cwd: actorDir, stdio: 'inherit' });

			// Run #2: same registered Actor, same image throughout (asserted below via buildId) - only the
			// host folder's own compiled output changed.
			const secondCallOutput = apify(['call', '--input', JSON.stringify({ maxPages: 1 }), '--json'], {
				cwd: actorDir,
				env,
			});
			const secondCall = JSON.parse(secondCallOutput) as CallResult;
			expect(secondCall.run.status).toBe('SUCCEEDED');
			const secondLog = apifyAllOutput(['runs', 'log', secondCall.run.id], { cwd: REPO_ROOT, env });
			expect(secondLog).toContain(EDITED_MARKER);
			expect(secondLog).not.toContain(`${ORIGINAL_MARKER}\n`);

			// Both runs resolved to the exact same build - direct proof that no image build happened
			// between them, so the output difference above is attributable only to the local recompile,
			// never to a new image. `apify api GET actor-runs/<id>` (a real, already-implemented `/v2`
			// path - no alias needed) reads back each run's `buildId` (`runDto`).
			const firstRunApi = JSON.parse(
				apify(['api', 'GET', `actor-runs/${firstCall.run.id}`], { cwd: REPO_ROOT, env }),
			) as ApiEnvelope<{ buildId: string }>;
			const secondRunApi = JSON.parse(
				apify(['api', 'GET', `actor-runs/${secondCall.run.id}`], { cwd: REPO_ROOT, env }),
			) as ApiEnvelope<{ buildId: string }>;
			expect(secondRunApi.data.buildId).toBe(firstRunApi.data.buildId);
		},
		5 * 60 * 1000,
	);

	it(
		'a run started with devFolder=false uses the built image alone and leaves the registration in place',
		() => {
			const env = apifyEnv(isolatedApifyHome);

			// The previous test's local `dist/` must not be pushed: Docker's API build ignores `.dockerignore`
			// and would bake the edited compile into the image.
			writeFileSync(mainTs, originalMainTs);
			rmSync(join(actorDir, 'dist'), { recursive: true, force: true });
			const push = JSON.parse(apify(['push', '--json', '--force'], { cwd: actorDir, env })) as PushResult;
			expect(push.build.status).toBe('SUCCEEDED');
			const actorId = push.actor.id;
			registerDevFolder(actorId, actorDir, env);
			writeFileSync(mainTs, originalMainTs.replace(ORIGINAL_MARKER, EDITED_MARKER));
			execFileSync('npm', ['run', 'build'], { cwd: actorDir, stdio: 'inherit' });

			const optedOut = JSON.parse(
				apify(
					[
						'api',
						'POST',
						`actors/${actorId}/runs`,
						'--params',
						JSON.stringify({ devFolder: 'false', waitForFinish: 180 }),
						'--body',
						JSON.stringify({ maxPages: 1 }),
					],
					{ cwd: REPO_ROOT, env },
				),
			) as ApiEnvelope<{ id: string; status: string }>;
			expect(optedOut.data.status).toBe('SUCCEEDED');
			const optedOutLog = apifyAllOutput(['runs', 'log', optedOut.data.id], { cwd: REPO_ROOT, env });
			expect(optedOutLog).toContain(`Skipping the registered local dev folder ${actorDir}`);
			expect(optedOutLog).toContain(ORIGINAL_MARKER);
			expect(optedOutLog).not.toContain(EDITED_MARKER);
			expect(optedOutLog).not.toContain('Live dev folder');

			// The registration survived.
			const call = JSON.parse(
				apify(['call', '--input', JSON.stringify({ maxPages: 1 }), '--json'], { cwd: actorDir, env }),
			) as CallResult;
			expect(call.run.status).toBe('SUCCEEDED');
			const callLog = apifyAllOutput(['runs', 'log', call.run.id], { cwd: REPO_ROOT, env });
			expect(callLog).toContain(EDITED_MARKER);
			expect(callLog).toContain(`Live dev folder: ${actorDir}`);
			expect(callLog).toContain('Live dev folder mode');
			expect(callLog).toContain('apify call --no-dev-folder');
		},
		5 * 60 * 1000,
	);

	it(
		'registers the host folder, then a local recompile (no push/build) is what the next run sees, with node_modules preserved',
		async () => {
			const env = apifyEnv(isolatedApifyHome);

			// A real push + build - needed so the run below has something to actually execute, not because
			// registration requires one (it does not). The pushed source still carries `ORIGINAL_MARKER`,
			// so the image's own baked-in `dist/main.js` (compiled by the Dockerfile's own `RUN npm run
			// build`, inside the container) contains `ORIGINAL_MARKER`, not `EDITED_MARKER` - that
			// distinction is what the log assertions below rely on.
			// `--force`: the previous test's successful build bumped this same remote Actor's
			// `modifiedAt` (its build recording bumps `updateActor`) to after `actorDir`'s files' mtimes,
			// which were fixed once when `beforeAll` copied `samples/actor_ts` into the temp dir. Without
			// `--force`, `apify push` refuses any push whose files are all older than the remote record -
			// a deliberate staleness guard, not a bug - and this push's files never got newer.
			const pushOutput = apify(['push', '--json', '--force'], { cwd: actorDir, env });
			const push = JSON.parse(pushOutput) as PushResult;
			expect(push.build.status).toBe('SUCCEEDED');
			const actorId = push.actor.id;

			// Edit the source and recompile locally - deliberately no `apify push`/`apify build` between
			// here and the `apify call` below, which is the entire point of the feature. `node_modules`
			// (installed in `beforeAll`) is still present in `actorDir` at this point, so `tsc` can run.
			writeFileSync(mainTs, originalMainTs.replace(ORIGINAL_MARKER, EDITED_MARKER));
			execFileSync('npm', ['run', 'build'], { cwd: actorDir, stdio: 'inherit' });

			// Remove `node_modules` from the copied folder now, before registering it as the dev folder -
			// this is what makes the run below actually discriminate the anonymous volume, rather than
			// merely being consistent with it. `samples/actor_ts/package.json` lists `apify` and
			// `@crawlee/cheerio` as regular dependencies, so a `node_modules` left in place here would let
			// the Actor's imports resolve from the *host's* own install, and the `call` below would succeed
			// whether or not the anonymous volume worked at all. With it gone, the only place those imports
			// can resolve from inside the container is the anonymous `node_modules` volume seeded from the
			// image's own install (`actor-driver.md`'s anonymous-volume guarantee) - if that volume ever
			// stopped preserving the image's installed packages, the call below would fail with a
			// module-resolution error instead of silently succeeding.
			rmSync(join(actorDir, 'node_modules'), { recursive: true, force: true });

			const registered = registerDevFolder(actorId, actorDir, env);
			expect(registered.data.localDevFolder).toBe(actorDir);

			const callOutput = apify(['call', '--input', JSON.stringify({ maxPages: 1 }), '--json'], {
				cwd: actorDir,
				env,
			});
			const call = JSON.parse(callOutput) as CallResult;
			// Succeeds despite `actorDir` having no `node_modules` of its own (removed above) - the crawl
			// cannot run at all without `apify`/`@crawlee/cheerio` resolving, and the only place they could
			// have come from inside the container is the anonymous `node_modules` volume seeded from the
			// image's own install, which is exactly the guarantee this test proves.
			expect(call.run.status).toBe('SUCCEEDED');

			const log = apifyAllOutput(['runs', 'log', call.run.id], { cwd: REPO_ROOT, env });
			// The recompiled marker line, not the original - proves the container's working directory came
			// from the freshly-recompiled host folder, not the image's originally-baked-in `dist/`.
			expect(log).toContain(EDITED_MARKER);
			expect(log).not.toContain(`${ORIGINAL_MARKER}\n`);

			expect(log).toContain(actorDir);
			expect(log).toContain(EXPECTED_IMAGE_WORKING_DIR);
		},
		5 * 60 * 1000,
	);

	it(
		'clearing the registration (empty JSON string) makes the next run see the image again, not the host folder',
		async () => {
			const env = apifyEnv(isolatedApifyHome);

			// Restore the original source before pushing, for this case's own clarity - but no local
			// rebuild is needed, and none would be possible without reinstalling: the previous test removed
			// `actorDir/node_modules` for good (see its comments) and this test's assertions don't read
			// `actorDir`'s compiled output at all. With the mount cleared below, the container runs
			// whichever `dist/main.js` the push+build above just baked into the image - `actorDir`'s own
			// `dist/` is never mounted over it, so its content (or `node_modules`' absence) is irrelevant.
			writeFileSync(mainTs, originalMainTs);

			// `--force`: same staleness guard as the previous test's push (see its comment) - the prior
			// test's own build bumped this Actor's remote `modifiedAt` again, past `actorDir`'s files'
			// mtimes.
			const pushOutput = apify(['push', '--json', '--force'], { cwd: actorDir, env });
			const push = JSON.parse(pushOutput) as PushResult;
			const actorId = push.actor.id;

			registerDevFolder(actorId, actorDir, env);

			const clearOutput = apify(['api', 'POST', `/actor-runtime/dev-folder/${actorId}`, '--body', '""'], {
				cwd: REPO_ROOT,
				env,
			});
			const cleared = JSON.parse(clearOutput) as DevFolderApiResult;
			expect(cleared.data.localDevFolder).toBeNull();

			const callOutput = apify(['call', '--input', JSON.stringify({ maxPages: 1 }), '--json'], {
				cwd: actorDir,
				env,
			});
			const call = JSON.parse(callOutput) as CallResult;
			expect(call.run.status).toBe('SUCCEEDED');

			const log = apifyAllOutput(['runs', 'log', call.run.id], { cwd: REPO_ROOT, env });
			expect(log).not.toContain('Live dev folder');
		},
		5 * 60 * 1000,
	);

	it(
		"an entrypoint the image keeps inside its working directory (Apify's Playwright images start through one) stays available under the mount when the dev folder lacks it",
		() => {
			const env = apifyEnv(isolatedApifyHome);
			// A tiny Actor of its own: busybox, an entrypoint script at ./entry.sh in the working directory
			// (what `apify/actor-*-playwright*` images do with their Xvfb wrapper), and a dev folder that has
			// no such file - mounting it over /app would hide the script.
			const entryActorDir = mkdtempSync(join(tmpdir(), 'actor-runtime-e2e-devfolder-entry-'));
			const devFolder = mkdtempSync(join(tmpdir(), 'actor-runtime-e2e-devfolder-entry-src-'));
			try {
				mkdirSync(join(entryActorDir, '.actor'));
				writeFileSync(
					join(entryActorDir, '.actor', 'actor.json'),
					JSON.stringify({
						actorSpecification: 1,
						name: 'devfolder-entrypoint',
						version: '0.0',
						buildTag: 'latest',
					}),
				);
				writeFileSync(
					join(entryActorDir, 'entry.sh'),
					'#!/bin/sh\necho "entry.sh from the image: $0"\nexec "$@"\n',
				);
				writeFileSync(
					join(entryActorDir, 'Dockerfile'),
					[
						'FROM docker.io/library/busybox',
						'WORKDIR /app',
						'COPY entry.sh ./entry.sh',
						'RUN chmod 755 ./entry.sh',
						'ENTRYPOINT ["./entry.sh"]',
						'CMD ["sh", "-c", "ls /app; echo run-body-done"]',
						'',
					].join('\n'),
				);
				writeFileSync(join(devFolder, 'only-in-dev-folder.txt'), 'x');

				const push = JSON.parse(apify(['push', '--json'], { cwd: entryActorDir, env })) as PushResult;
				expect(push.build.status).toBe('SUCCEEDED');
				registerDevFolder(push.actor.id, devFolder, env);

				const call = JSON.parse(apify(['call', '--json'], { cwd: entryActorDir, env })) as CallResult;
				expect(call.run.status).toBe('SUCCEEDED');
				// The stored log, not `apify call`'s streamed copy: for an Actor that exits within milliseconds
				// the CLI's stream can close before its last lines are flushed, on any engine.
				const log = apify(['api', 'GET', `actor-runs/${call.run.id}/log`], { cwd: REPO_ROOT, env });
				expect(log).toContain('starts through ./entry.sh in its working directory');
				expect(log).toContain('entry.sh from the image: /apify-runtime-entrypoint/entry.sh');
				// The dev folder, not the image's /app, is what the run sees in the working directory.
				expect(log).toContain('only-in-dev-folder.txt');
				expect(log).toContain('run-body-done');
			} finally {
				rmSync(entryActorDir, { recursive: true, force: true });
				rmSync(devFolder, { recursive: true, force: true });
			}
		},
		5 * 60 * 1000,
	);

	it(
		'anonymous node_modules volumes do not accumulate across runs ({ v: true } cleanup)',
		async () => {
			const env = apifyEnv(isolatedApifyHome);

			// `--force`: same staleness guard as the earlier pushes in this file (see the first
			// occurrence's comment above) - the previous test's build bumped this Actor's remote
			// `modifiedAt` again, past `actorDir`'s files' mtimes.
			const pushOutput = apify(['push', '--json', '--force'], { cwd: actorDir, env });
			const push = JSON.parse(pushOutput) as PushResult;
			const actorId = push.actor.id;

			// Reuses `actorDir/dist` exactly as the first test in this file compiled it - still valid,
			// dependency-resolving JS regardless of what `mainTs`'s source text says now (`it` blocks in
			// this file run in declaration order, and nothing after the first test recompiles `dist`). This
			// test only measures volume accounting across repeated runs, not what marker the log contains,
			// so no further edit or local rebuild is needed here - and none would be possible without
			// reinstalling, since `actorDir/node_modules` stays removed for the rest of this file (see the
			// first test).
			registerDevFolder(actorId, actorDir, env);

			// Dangling (unattached) volumes on the whole daemon - a coarse but simple proxy: this suite is
			// the only thing exercising anonymous volumes against this daemon in a CI run, so a stable count
			// across repeated runs is sufficient evidence the driver's `{ v: true }` cleanup (not some
			// unrelated daemon-wide accumulation) is what's being measured.
			const countDanglingVolumes = (): number =>
				execFileSync('docker', ['volume', 'ls', '-q', '-f', 'dangling=true'], { encoding: 'utf8' })
					.split('\n')
					.filter((line) => line.trim().length > 0).length;

			const before = countDanglingVolumes();
			for (let i = 0; i < 3; i++) {
				const callOutput = apify(['call', '--input', JSON.stringify({ maxPages: 1 }), '--json'], {
					cwd: actorDir,
					env,
				});
				const call = JSON.parse(callOutput) as CallResult;
				expect(call.run.status).toBe('SUCCEEDED');
			}
			const after = countDanglingVolumes();

			expect(after).toBe(before);
		},
		5 * 60 * 1000,
	);
});

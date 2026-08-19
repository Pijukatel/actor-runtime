/**
 * E2E case for the local dev-folder bind mount - only a real Docker daemon can prove a genuine host
 * path passes the probe and the mount itself, so this is the one place that exercise runs: after one
 * real push+build, registering the Actor's host source folder via the documented
 * `apify api POST ../actor-runtime/dev-folder/<actorId>` invocation and then recompiling *locally* must
 * be picked up by the *next* `apify call`, with no intervening `apify push`/build - and the image's own
 * `node_modules` must survive the mount (the anonymous-volume guarantee). Registration is itself an
 * `apify` command, so `requirements/test.md`'s CLI-only rule needs no exception here.
 *
 * Requires a reachable Docker daemon and fails loudly, never skips, mirroring `actor-dev-loop.test.ts`.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
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
	type CallResult,
	type PushResult,
} from './helpers/apify-cli.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const ACTOR_DIR = join(REPO_ROOT, 'sample_actor_ts');
const MAIN_TS = join(ACTOR_DIR, 'src', 'main.ts');
const CONTAINER_NAME = 'actor-runtime-e2e-devfolder';
const IMAGE_TAG = 'actor-runtime:e2e-devfolder';
// `sample_actor_ts/Dockerfile` sets no `WORKDIR` of its own, so it inherits the base image's - the
// `apify/actor-node` image's own Dockerfile sets `WORKDIR /usr/src/app`. Asserted independently below
// via the registration response's own `imageWorkingDirectory`, not only assumed here - if the base
// image ever moves its `WORKDIR`, that assertion (not the mount itself) is what will fail first and
// explain why.
const EXPECTED_IMAGE_WORKING_DIR = '/usr/src/app';
const ORIGINAL_MARKER = 'Crawl finished.';
const EDITED_MARKER = 'Crawl finished (dev-folder-edit-marker).';

/** `apify api POST ...`'s printed `{ data: ... }` envelope for this endpoint's response shape
 * (`services/actors.ts: devFolderStatus`). */
interface DevFolderApiResult {
	data: { localDevFolder: string | null; imageWorkingDirectory: string | null; mountWillApply: boolean };
}

function registerDevFolder(actorId: string, path: string, env: NodeJS.ProcessEnv): DevFolderApiResult {
	// The exact CLI invocation `requirements/api.md`'s `/actor-runtime/*` section documents, escaping the
	// CLI's own `/v2` base - `cwd: REPO_ROOT` matters here since `../actor-runtime/...` resolves against
	// the CLI's configured base URL, not the filesystem; it is unrelated to `path` itself, which is
	// always this test's own absolute `ACTOR_DIR`.
	const output = apify(['api', 'POST', `../actor-runtime/dev-folder/${actorId}`, '--body', JSON.stringify(path)], {
		cwd: REPO_ROOT,
		env,
	});
	return JSON.parse(output) as DevFolderApiResult;
}

describe('local dev-folder bind mount: edit-compile-call loop with no rebuild (requires Docker)', () => {
	let isolatedApifyHome: string;
	let originalMainTs: string | undefined;

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

			originalMainTs = readFileSync(MAIN_TS, 'utf8');
			// A genuine local compile needs the sample Actor's own devDependencies (`typescript`) present on
			// the *host* - distinct from what `apify push` sends the runtime (source files only; the
			// runtime's own Docker build installs and compiles them again, inside the image).
			execFileSync('npm', ['install'], { cwd: ACTOR_DIR, stdio: 'inherit' });
		},
		10 * 60 * 1000,
	);

	afterAll(() => {
		// Best-effort: restore src/ and dist/ to what they were before this suite touched them, so a
		// later local run of `actor-dev-loop.test.ts` (or a human) doesn't inherit the edited marker.
		// Guarded the same way `isolatedApifyHome` below is - `beforeAll` can throw before either is ever
		// assigned (e.g. the Docker-unreachable check at its top).
		if (originalMainTs !== undefined) {
			writeFileSync(MAIN_TS, originalMainTs);
			try {
				execFileSync('npm', ['run', 'build'], { cwd: ACTOR_DIR, stdio: 'ignore' });
			} catch {
				// best-effort only
			}
		}
		stopRuntimeContainer(CONTAINER_NAME);
		if (isolatedApifyHome) removeIsolatedApifyHome(isolatedApifyHome);
	});

	it(
		'registers the host folder, then a local recompile (no push/build) is what the next run sees, with node_modules preserved',
		async () => {
			const env = apifyEnv(isolatedApifyHome);

			// One real push + build, as the product description requires ("push and build once, then
			// register") - the build-first precondition (`requirements/api.md`).
			const pushOutput = apify(['push', '--json'], { cwd: ACTOR_DIR, env });
			const push = JSON.parse(pushOutput) as PushResult;
			expect(push.build.status).toBe('SUCCEEDED');
			const actorId = push.actor.id;

			// Local build, so the host folder already looks like the image's working directory before it
			// is ever bind-mounted over it - `dist/main.js` for the container's own `CMD` to run,
			// matching the layout the image itself expects. The host folder's own `node_modules` (just
			// installed above) is
			// deliberately NOT what the container is meant to rely on - the assertion below proves the
			// anonymous volume, not this directory's own `node_modules`, is what the container actually used.
			execFileSync('npm', ['run', 'build'], { cwd: ACTOR_DIR, stdio: 'inherit' });

			const registered = registerDevFolder(actorId, ACTOR_DIR, env);
			expect(registered.data.localDevFolder).toBe(ACTOR_DIR);
			expect(registered.data.imageWorkingDirectory).toBe(EXPECTED_IMAGE_WORKING_DIR);
			expect(registered.data.mountWillApply).toBe(true);

			// Edit the source, recompile locally - deliberately no `apify push`/`apify build` between here
			// and the `apify call` below, which is the entire point of the feature.
			writeFileSync(MAIN_TS, originalMainTs!.replace(ORIGINAL_MARKER, EDITED_MARKER));
			execFileSync('npm', ['run', 'build'], { cwd: ACTOR_DIR, stdio: 'inherit' });

			const callOutput = apify(['call', '--input', JSON.stringify({ maxPages: 1 }), '--json'], {
				cwd: ACTOR_DIR,
				env,
			});
			const call = JSON.parse(callOutput) as CallResult;
			// The dependencies (`apify`, `@crawlee/cheerio`) still resolved and the crawl actually ran -
			// proving the anonymous `node_modules` volume preserved the image's own installed packages,
			// even though the bind mount just replaced the whole working directory with the host folder.
			expect(call.run.status).toBe('SUCCEEDED');

			const log = apifyAllOutput(['runs', 'log', call.run.id], { cwd: REPO_ROOT, env });
			// The recompiled marker line, not the original - proves the container's working directory came
			// from the freshly-recompiled host folder, not the image's originally-baked-in `dist/`.
			expect(log).toContain(EDITED_MARKER);
			expect(log).not.toContain(`${ORIGINAL_MARKER}\n`);

			// An explicit mount line at the top of the run's log (`actor-driver.md`'s "Observability"
			// bullet), naming both the host path and the container path being mounted.
			expect(log).toContain(ACTOR_DIR);
			expect(log).toContain(EXPECTED_IMAGE_WORKING_DIR);
		},
		5 * 60 * 1000,
	);

	it(
		'clearing the registration (empty JSON string) makes the next run see the image again, not the host folder',
		async () => {
			const env = apifyEnv(isolatedApifyHome);

			const pushOutput = apify(['push', '--json'], { cwd: ACTOR_DIR, env });
			const push = JSON.parse(pushOutput) as PushResult;
			const actorId = push.actor.id;

			registerDevFolder(actorId, ACTOR_DIR, env);

			const clearOutput = apify(['api', 'POST', `../actor-runtime/dev-folder/${actorId}`, '--body', '""'], {
				cwd: REPO_ROOT,
				env,
			});
			const cleared = JSON.parse(clearOutput) as DevFolderApiResult;
			expect(cleared.data.localDevFolder).toBeNull();
			expect(cleared.data.mountWillApply).toBe(false);

			// The edited marker from a previous test in this file (if it ran first) or the host `dist/`
			// otherwise must NOT be what this run sees - restore the original source/build first so this
			// case is self-contained regardless of test order.
			writeFileSync(MAIN_TS, originalMainTs!);
			execFileSync('npm', ['run', 'build'], { cwd: ACTOR_DIR, stdio: 'inherit' });

			const callOutput = apify(['call', '--input', JSON.stringify({ maxPages: 1 }), '--json'], {
				cwd: ACTOR_DIR,
				env,
			});
			const call = JSON.parse(callOutput) as CallResult;
			expect(call.run.status).toBe('SUCCEEDED');

			const log = apifyAllOutput(['runs', 'log', call.run.id], { cwd: REPO_ROOT, env });
			// No mount line at all - the observability line only appears for a run that actually has one.
			expect(log).not.toContain('Mounting local dev folder');
		},
		5 * 60 * 1000,
	);

	it(
		'anonymous node_modules volumes do not accumulate across runs ({ v: true } cleanup)',
		async () => {
			const env = apifyEnv(isolatedApifyHome);

			const pushOutput = apify(['push', '--json'], { cwd: ACTOR_DIR, env });
			const push = JSON.parse(pushOutput) as PushResult;
			const actorId = push.actor.id;

			writeFileSync(MAIN_TS, originalMainTs!);
			execFileSync('npm', ['run', 'build'], { cwd: ACTOR_DIR, stdio: 'inherit' });
			registerDevFolder(actorId, ACTOR_DIR, env);

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
					cwd: ACTOR_DIR,
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

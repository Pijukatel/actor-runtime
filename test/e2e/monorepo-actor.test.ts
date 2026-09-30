/**
 * Monorepo Actors (`actor-driver.md`'s "Monorepo Actors") through `apify-cli` only: both Actors of
 * `samples/actor_monorepo` share one Dockerfile, one input schema and one package outside their own folders,
 * so each builds only from the whole Docker context `apify push` sends. Needs an `apify-cli` with monorepo
 * support - until it is published, point `ACTOR_RUNTIME_E2E_APIFY_CLI` at a built one (`helpers/apify-cli.ts`).
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import process from 'node:process';
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
	apifyExpectingFailure,
	createIsolatedApifyHome,
	loginApifyCli,
	removeIsolatedApifyHome,
	type CallResult,
	type PushResult,
} from './helpers/apify-cli.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const MONOREPO_ROOT = join(REPO_ROOT, 'samples', 'actor_monorepo');
const CONTAINER_NAME = 'actor-runtime-e2e';
const IMAGE_TAG = 'actor-runtime:e2e';

interface GreetingItem {
	index: number;
	text: string;
	actorPath: string;
}

// Until a published apify-cli supports monorepo Actors, this file runs only against a locally built one.
describe.skipIf(!process.env.ACTOR_RUNTIME_E2E_APIFY_CLI)('monorepo Actors via apify-cli (requires Docker)', () => {
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

	const cases = [
		{ actorPath: 'actors/greeter', firstText: 'Hello #1 from greeter' },
		{ actorPath: 'actors/shouter', firstText: 'HELLO #1 FROM SHOUTER' },
	];

	for (const { actorPath, firstText } of cases) {
		it(
			`${actorPath}: push builds it from the monorepo's Docker context, and a call runs it`,
			() => {
				const env = apifyEnv(isolatedApifyHome);
				const actorDir = join(MONOREPO_ROOT, actorPath);

				const push = JSON.parse(apify(['push', '--json'], { cwd: actorDir, env })) as PushResult;
				expect(push.build.status).toBe('SUCCEEDED');

				// The Dockerfile and the input schema are the shared ones, outside the Actor's own folder.
				const buildLog = apifyAllOutput(['builds', 'log', push.build.id], { cwd: actorDir, env });
				expect(buildLog).toContain(`Building "${actorPath}" from a Docker context of`);
				expect(buildLog).toContain('Using Dockerfile "shared/Dockerfile"');
				expect(buildLog).toContain('Using the input schema from "shared/input_schema.json"');
				// The build ran the shared script, which a lost executable bit would have failed.
				expect(buildLog).toContain('RUN ./shared/check-context.sh');

				const call = JSON.parse(
					apify(['call', '--input', JSON.stringify({ count: 3 }), '--json'], { cwd: actorDir, env }),
				) as CallResult;
				expect(call.run.status).toBe('SUCCEEDED');

				// The shared package ran, and the image knew which Actor of the monorepo it was built for.
				const items = JSON.parse(
					apify(['datasets', 'get-items', call.storage.defaultDatasetId, '--format', 'json'], {
						cwd: actorDir,
						env,
					}),
				) as GreetingItem[];
				expect(items).toHaveLength(3);
				expect(items[0]).toEqual({ index: 1, text: firstText, actorPath });
			},
			5 * 60 * 1000,
		);
	}

	it('the shared input schema supplies the defaults and rejects an invalid input', () => {
		const env = apifyEnv(isolatedApifyHome);
		const actorDir = join(MONOREPO_ROOT, 'actors', 'greeter');

		const call = JSON.parse(apify(['call', '--json'], { cwd: actorDir, env })) as CallResult;
		expect(call.run.status).toBe('SUCCEEDED');
		const storedInput = apify(['key-value-stores', 'get-value', call.storage.defaultKeyValueStoreId, 'INPUT'], {
			cwd: actorDir,
			env,
		});
		expect(JSON.parse(storedInput) as Record<string, unknown>).toEqual({ count: 2 });

		const rejected = apifyExpectingFailure(['call', '--input', JSON.stringify({ count: 0 }), '--json'], {
			cwd: actorDir,
			env,
		});
		expect(rejected).toMatch(/count/);
	});

	describe('builds exactly what a build from a Git clone on the platform would', () => {
		let repo: string;
		const git = (...args: string[]) =>
			execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@example.com', ...args], {
				cwd: repo,
				stdio: 'ignore',
			});

		beforeAll(() => {
			// A monorepo of its own, so what Git tracks is under the test's control.
			repo = mkdtempSync(join(tmpdir(), 'actor-runtime-e2e-monorepo-'));
			cpSync(MONOREPO_ROOT, repo, { recursive: true });
			appendFileSync(join(repo, 'shared', 'Dockerfile'), 'COPY actors/greeter/dist/extra.txt ./extra.txt\n');
			writeFileSync(join(repo, 'actors', 'greeter', '.gitignore'), 'dist\n');
			writeFileSync(join(repo, 'actors', 'greeter', '.actorignore'), '!dist/\n');
			mkdirSync(join(repo, 'actors', 'greeter', 'dist'));
			writeFileSync(join(repo, 'actors', 'greeter', 'dist', 'extra.txt'), 'built locally\n');
			git('init', '--quiet');
			git('add', '.');
			git('commit', '--quiet', '-m', 'init');
		});

		afterAll(() => {
			if (repo) rmSync(repo, { recursive: true, force: true });
		});

		it(
			'fails on a git-ignored file the Dockerfile needs, even if .actorignore force-includes it, and succeeds once it is committed',
			() => {
				const env = apifyEnv(isolatedApifyHome);
				const actorDir = join(repo, 'actors', 'greeter');

				// The platform's clone has no `dist/`, so its build fails at that COPY - and so does this one.
				// `--force`: the Actor may exist from an earlier test, with a newer modification time than these files.
				const failed = apifyExpectingFailure(['push', '--json', '--force'], { cwd: actorDir, env });
				expect(failed).toMatch(/"status":\s*"FAILED"/);
				expect(failed).toContain('extra.txt');

				rmSync(join(actorDir, '.gitignore'));
				git('add', '.');
				git('commit', '--quiet', '-m', 'commit dist');
				const push = JSON.parse(apify(['push', '--json', '--force'], { cwd: actorDir, env })) as PushResult;
				expect(push.build.status).toBe('SUCCEEDED');
			},
			5 * 60 * 1000,
		);

		it('refuses a dockerContextDir above the repository, which the platform could not clone', () => {
			const env = apifyEnv(isolatedApifyHome);
			const actorDir = join(repo, 'actors', 'shouter');
			const actorJsonPath = join(actorDir, '.actor', 'actor.json');
			writeFileSync(
				actorJsonPath,
				JSON.stringify({
					actorSpecification: 1,
					name: 'monorepo-sample-shouter',
					version: '0.0',
					dockerContextDir: '../../../..',
				}),
			);

			const refused = apifyExpectingFailure(['push', '--json'], { cwd: actorDir, env });
			expect(refused).toContain('outside the Git repository');
		});
	});
});

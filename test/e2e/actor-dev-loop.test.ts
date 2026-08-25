/**
 * The mandated end-to-end test (`test.md`): full Actor dev loop through `apify-cli` only (no direct
 * HTTP/API calls), for both sample Actors, each driven with an input that measurably changes its
 * output. Requires a reachable Docker daemon and fails loudly, with an explicit message, when one
 * isn't reachable - `test.md`: "the e2e suite requires a reachable Docker daemon ... and detects
 * its absence, failing in such case" (it used to skip cleanly; that is no longer the contract).
 */
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
	type DatasetInfoResult,
	type PushResult,
} from './helpers/apify-cli.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const CONTAINER_NAME = 'actor-runtime-e2e';
const IMAGE_TAG = 'actor-runtime:e2e';

describe('full Actor dev loop via apify-cli (requires Docker)', () => {
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

			// Isolate the CLI's credential store to a suite-owned `$HOME`, then let the CLI's own
			// `login` command bootstrap the "already logged in" state - no direct `auth.json` write
			// (`requirements/cli.md`'s User bootstrap section; `helpers/apify-cli.ts` has the full
			// derivation). This can never read or clobber the real developer's/runner's `~/.apify`.
			isolatedApifyHome = createIsolatedApifyHome();
			loginApifyCli(REPO_ROOT, isolatedApifyHome);
		},
		10 * 60 * 1000,
	);

	afterAll(() => {
		stopRuntimeContainer(CONTAINER_NAME);
		// `beforeAll` can throw before `isolatedApifyHome` is ever assigned (e.g. the Docker-unreachable
		// check above) - guard the same way `stopRuntimeContainer` already tolerates "never started".
		if (isolatedApifyHome) removeIsolatedApifyHome(isolatedApifyHome);
	});

	const cases = [
		{ actorDir: join(REPO_ROOT, 'sample_actor_ts'), label: 'TypeScript sample actor' },
		{ actorDir: join(REPO_ROOT, 'sample_actor_py'), label: 'Python sample actor' },
	];

	for (const { actorDir, label } of cases) {
		it(
			`${label}: push -> build -> call(maxPages=2) -> call(maxPages=4), item count tracks input`,
			async () => {
				const env = apifyEnv(isolatedApifyHome);

				const pushOutput = apify(['push', '--json'], { cwd: actorDir, env });
				const push = JSON.parse(pushOutput) as PushResult;
				expect(push.build.status).toBe('SUCCEEDED');

				const itemCountFor = async (maxPages: number): Promise<number> => {
					const callOutput = apify(['call', '--input', JSON.stringify({ maxPages }), '--json'], {
						cwd: actorDir,
						env,
					});
					const call = JSON.parse(callOutput) as CallResult;
					expect(call.run.status).toBe('SUCCEEDED');

					const infoOutput = apify(['datasets', 'info', call.storage.defaultDatasetId, '--json'], {
						cwd: actorDir,
						env,
					});
					const info = JSON.parse(infoOutput) as DatasetInfoResult;
					return info.itemCount;
				};

				expect(await itemCountFor(2)).toBe(2);
				expect(await itemCountFor(4)).toBe(4);
			},
			5 * 60 * 1000,
		);
	}

	it(
		'sample_actor_crawler: push -> build succeeds (build-only - its Dockerfile lives at .actor/Dockerfile, ' +
			'the layout that used to fail with a daemon-side "Cannot locate specified Dockerfile" error)',
		() => {
			const env = apifyEnv(isolatedApifyHome);
			const actorDir = join(REPO_ROOT, 'sample_actor_crawler');

			const pushOutput = apify(['push', '--json'], { cwd: actorDir, env });
			const push = JSON.parse(pushOutput) as PushResult;

			expect(push.build.status).toBe('SUCCEEDED');
		},
		5 * 60 * 1000,
	);

	it('the run log contains the crawler per-page lines', () => {
		const env = apifyEnv(isolatedApifyHome);
		const callOutput = apify(['call', '--input', JSON.stringify({ maxPages: 1 }), '--json'], {
			cwd: join(REPO_ROOT, 'sample_actor_ts'),
			env,
		});
		const call = JSON.parse(callOutput) as CallResult;

		const log = apifyAllOutput(['runs', 'log', call.run.id], { cwd: REPO_ROOT, env });
		expect(log).toMatch(/Processing/);
	});

	it('apify api reads back the run and its default dataset (requirements/cli.md: `apify api`)', () => {
		const env = apifyEnv(isolatedApifyHome);
		const callOutput = apify(['call', '--input', JSON.stringify({ maxPages: 1 }), '--json'], {
			cwd: join(REPO_ROOT, 'sample_actor_ts'),
			env,
		});
		const call = JSON.parse(callOutput) as CallResult;

		// `apify api GET <endpoint>` - positional method + path, exactly as documented in the CLI's own
		// `apify api --help` examples (see `commands/api.ts`).
		const runApiOutput = apify(['api', 'GET', `actor-runs/${call.run.id}`], { cwd: REPO_ROOT, env });
		const runApi = JSON.parse(runApiOutput) as ApiEnvelope<{ id: string; status: string }>;
		expect(runApi.data.id).toBe(call.run.id);
		expect(runApi.data.status).toBe('SUCCEEDED');

		const datasetApiOutput = apify(['api', 'GET', `datasets/${call.storage.defaultDatasetId}`], {
			cwd: REPO_ROOT,
			env,
		});
		const datasetApi = JSON.parse(datasetApiOutput) as ApiEnvelope<{ id: string; itemCount: number }>;
		expect(datasetApi.data.id).toBe(call.storage.defaultDatasetId);
		expect(datasetApi.data.itemCount).toBe(1);
	});
});

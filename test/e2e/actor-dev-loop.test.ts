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
	ensureApifyCliAuthenticated,
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

			// `apify login` is no longer a supported command (`requirements/cli.md`). Real `apify-cli`
			// v1.8.0's top-level commands (`push`/`call`/`runs`/`datasets`/`api`) resolve their token only
			// from the CLI's own on-disk credential store (`getLoggedClientOrThrow()` in its
			// `lib/utils.ts`), never from an `APIFY_TOKEN` env var - that env var is only consulted by
			// `apify actor:*` and `mcp install`, not by the commands this suite drives (verified against
			// the published v1.8.0 source; a bare `APIFY_TOKEN` with no stored credentials still fails
			// every command below with "You are not logged in"). Seeding that credential store directly
			// is what actually replaces the removed `apify login --token x` call.
			ensureApifyCliAuthenticated();
		},
		10 * 60 * 1000,
	);

	afterAll(() => {
		stopRuntimeContainer(CONTAINER_NAME);
	});

	const cases = [
		{ actorDir: join(REPO_ROOT, 'sample_actor_ts'), label: 'TypeScript sample actor' },
		{ actorDir: join(REPO_ROOT, 'sample_actor_py'), label: 'Python sample actor' },
	];

	for (const { actorDir, label } of cases) {
		it(
			`${label}: push -> build -> call(maxPages=2) -> call(maxPages=4), item count tracks input`,
			async () => {
				const env = apifyEnv();

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

	it('the run log contains the crawler per-page lines', () => {
		const env = apifyEnv();
		const callOutput = apify(['call', '--input', JSON.stringify({ maxPages: 1 }), '--json'], {
			cwd: join(REPO_ROOT, 'sample_actor_ts'),
			env,
		});
		const call = JSON.parse(callOutput) as CallResult;

		const log = apifyAllOutput(['runs', 'log', call.run.id], { cwd: REPO_ROOT, env });
		expect(log).toMatch(/Processing/);
	});

	it('apify api reads back the run and its default dataset (requirements/cli.md: `apify api`)', () => {
		const env = apifyEnv();
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

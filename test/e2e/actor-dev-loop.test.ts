/**
 * The mandated end-to-end test (`test.md`): full Actor dev loop through `apify-cli` only (no direct
 * HTTP/API calls), for both sample Actors, each driven with an input that measurably changes its
 * output. Requires a reachable Docker daemon - cleanly skips otherwise (this sandbox has none).
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
	type CallResult,
	type DatasetInfoResult,
	type PushResult,
} from './helpers/apify-cli.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const CONTAINER_NAME = 'actor-runtime-e2e';
const IMAGE_TAG = 'actor-runtime:e2e';

const dockerAvailable = isDockerAvailable();

describe.skipIf(!dockerAvailable)('full Actor dev loop via apify-cli (requires Docker)', () => {
	beforeAll(
		async () => {
			pullBaseImages();
			buildRuntimeImage(REPO_ROOT, IMAGE_TAG);
			startRuntimeContainer(IMAGE_TAG, CONTAINER_NAME);
			await waitForHttpOk('http://localhost:3333/v2/users/me?token=x');

			apify(['login', '--token', 'x'], { cwd: REPO_ROOT, env: apifyEnv() });
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
});

describe.skipIf(dockerAvailable)('full Actor dev loop via apify-cli', () => {
	it('is skipped: no Docker daemon reachable from this sandbox', () => {
		expect(dockerAvailable).toBe(false);
	});
});

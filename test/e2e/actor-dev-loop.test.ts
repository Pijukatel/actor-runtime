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
	apifyExpectingFailure,
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
		{ actorDir: join(REPO_ROOT, 'samples', 'actor_ts'), label: 'TypeScript sample actor' },
		{ actorDir: join(REPO_ROOT, 'samples', 'actor_py'), label: 'Python sample actor' },
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

	it('Python sample actor fills the extra datasets its .actor/actor.json declares', () => {
		const env = apifyEnv(isolatedApifyHome);
		const actorDir = join(REPO_ROOT, 'samples', 'actor_py');
		const callOutput = apify(['call', '--input', JSON.stringify({ maxPages: 2 }), '--json'], {
			cwd: actorDir,
			env,
		});
		const call = JSON.parse(callOutput) as CallResult;
		expect(call.run.status).toBe('SUCCEEDED');

		const runApiOutput = apify(['api', 'GET', `actor-runs/${call.run.id}`], { cwd: REPO_ROOT, env });
		const { datasets } = (
			JSON.parse(runApiOutput) as ApiEnvelope<{ storageIds: { datasets: Record<string, string> } }>
		).data.storageIds;
		expect(datasets.default).toBe(call.storage.defaultDatasetId);

		const itemCountOf = (datasetId: string | undefined): number => {
			expect(datasetId).toBeTruthy();
			const infoOutput = apify(['datasets', 'info', datasetId!, '--json'], { cwd: actorDir, env });
			return (JSON.parse(infoOutput) as DatasetInfoResult).itemCount;
		};
		expect(itemCountOf(datasets.pageLinks)).toBe(2);
		expect(itemCountOf(datasets.summary)).toBe(1);
	});

	it(
		'samples/actor_crawler: push -> build succeeds (build-only - its Dockerfile lives at .actor/Dockerfile, ' +
			'the layout that used to fail with a daemon-side "Cannot locate specified Dockerfile" error)',
		() => {
			const env = apifyEnv(isolatedApifyHome);
			const actorDir = join(REPO_ROOT, 'samples', 'actor_crawler');

			const pushOutput = apify(['push', '--json'], { cwd: actorDir, env });
			const push = JSON.parse(pushOutput) as PushResult;

			expect(push.build.status).toBe('SUCCEEDED');
		},
		5 * 60 * 1000,
	);

	it('the run log contains the crawler per-page lines', () => {
		const env = apifyEnv(isolatedApifyHome);
		const callOutput = apify(['call', '--input', JSON.stringify({ maxPages: 1 }), '--json'], {
			cwd: join(REPO_ROOT, 'samples', 'actor_ts'),
			env,
		});
		const call = JSON.parse(callOutput) as CallResult;

		const log = apifyAllOutput(['runs', 'log', call.run.id], { cwd: REPO_ROOT, env });
		expect(log).toMatch(/Processing/);
	});

	it("a call with no input at all runs on the input schema's defaults, and one the schema rejects never starts", () => {
		const env = apifyEnv(isolatedApifyHome);
		const actorDir = join(REPO_ROOT, 'samples', 'actor_ts');

		const callOutput = apify(['call', '--json'], { cwd: actorDir, env });
		const call = JSON.parse(callOutput) as CallResult;
		expect(call.run.status).toBe('SUCCEEDED');

		// The run's own INPUT record, which only the runtime ever writes: every field of the schema, at
		// its default. This is what distinguishes the schema's defaults from the Actor's own internal
		// fallback for a missing field - the item count alone cannot tell the two apart.
		const storedInput = apify(['key-value-stores', 'get-value', call.storage.defaultKeyValueStoreId, 'INPUT'], {
			cwd: actorDir,
			env,
		});
		expect(JSON.parse(storedInput) as Record<string, unknown>).toEqual({
			startUrl: 'https://crawlee.dev/',
			maxPages: 10,
		});

		const infoOutput = apify(['datasets', 'info', call.storage.defaultDatasetId, '--json'], {
			cwd: actorDir,
			env,
		});
		// A 10-page crawl of crawlee.dev can drain its queue a page short of `maxPages` (seen: 9), so the
		// count only has to rule out the old default of 2; the INPUT check above pins the defaults.
		const { itemCount } = JSON.parse(infoOutput) as DatasetInfoResult;
		expect(itemCount).toBeGreaterThan(2);
		expect(itemCount).toBeLessThanOrEqual(10);

		// `maxPages` has `minimum: 1` - the run is refused before any container starts, and the CLI
		// surfaces the runtime's validation message.
		const rejected = apifyExpectingFailure(['call', '--input', JSON.stringify({ maxPages: 0 }), '--json'], {
			cwd: actorDir,
			env,
		});
		expect(rejected).toMatch(/maxPages/);
	});

	it('apify api reads back the run and its default dataset (requirements/cli.md: `apify api`)', () => {
		const env = apifyEnv(isolatedApifyHome);
		const callOutput = apify(['call', '--input', JSON.stringify({ maxPages: 1 }), '--json'], {
			cwd: join(REPO_ROOT, 'samples', 'actor_ts'),
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

/**
 * `Actor.charge()` as the real, unmodified Python `apify` SDK (PyPI package, not the JS one
 * `sdk-charging.test.ts` already covers) actually calls it, driven as a real `python3` subprocess against
 * `startTestServer` - no mock, no shim.
 *
 * This closes a real gap: the Python SDK's `apify_client` validates every API response through pydantic
 * (`RunResponse.model_validate(...)` in `run().get()`), unlike the JS client, which does no runtime schema
 * check. Before `PricingInfo` carried `createdAt`/`startedAt`/`apifyMarginPercentage` and a required
 * `eventDescription` per event (`src/pricing.ts`), a real Python `Actor.init()` failed outright with a
 * pydantic `ValidationError` while parsing this runtime's own run response - the Python SDK could not run
 * a pay-per-event Actor against this runtime at all, regardless of what the charging logic itself did.
 *
 * When `python3` or the `apify` package isn't importable: skips cleanly outside CI (a developer's laptop
 * with no Python is the reasonable local case), but fails loudly in CI (`process.env.CI`) - the `checks`
 * job in `.github/workflows/ci.yml` is expected to provision the package before `pnpm test` runs, so a
 * missing package there means that provisioning step regressed, not that Python is legitimately absent.
 * See `test/integration/helpers/python-sdk-gate.ts` and `requirements/test.md`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import axios from 'axios';

import { fixedRunOutcomeDriver, startTestServer, type TestServerHandle } from './helpers/test-server.js';
import { decidePythonSdkGate, isCi } from './helpers/python-sdk-gate.js';
import { recordTaggedBuild, updateActor } from '../../src/services/actors.js';
import { generateId } from '../../src/storage/ids.js';
import { getRegistries } from '../../src/storage/registries.js';
import type { ActorRecord, BuildRecord } from '../../src/storage/entities.js';

const execFileAsync = promisify(execFile);

async function detectPythonSdk(): Promise<boolean> {
	try {
		await execFileAsync('python3', ['-c', 'import apify'], { timeout: 15_000 });
		return true;
	} catch {
		return false;
	}
}

// Evaluated once, at collection time - top-level await is valid ESM here (`tsconfig.json`'s
// `target: "ES2023"`/`module: "NodeNext"`), so `decidePythonSdkGate` below sees a real boolean, not a
// Promise.
const pythonSdkAvailable = await detectPythonSdk();

// `requirements/test.md`'s CI philosophy (stated for the e2e suite's Docker dependency) applies here
// too: a dependency CI is expected to provide must never silently no-op when it's missing. The `checks`
// job in `.github/workflows/ci.yml` installs the Python `apify` package before `pnpm test` runs, so if
// it's unimportable while `CI` is set, that provisioning step regressed - fail loudly instead of
// skipping. Outside CI (a developer's laptop with no Python), skip cleanly as before -
// `test/unit/python-sdk-gate.test.ts` covers this decision directly.
const pythonSdkGate = decidePythonSdkGate({ available: pythonSdkAvailable, ci: isCi() });

async function seedActor(server: TestServerHandle, name: string): Promise<ActorRecord> {
	const created = await server.client.actors().create({ name });
	return (await getRegistries().actors.get(created.id))!;
}

/** A SUCCEEDED build with a fake image, seeded directly - identical to `sdk-charging.test.ts`'s helper
 * (the stub driver used below cannot build one). */
async function seedSucceededBuild(actor: ActorRecord): Promise<BuildRecord> {
	const build: BuildRecord = {
		id: generateId(),
		userId: actor.userId,
		actorId: actor.id,
		versionNumber: '0.0',
		buildNumber: '0.0.1',
		tag: 'latest',
		status: 'SUCCEEDED',
		startedAt: new Date().toISOString(),
		finishedAt: new Date().toISOString(),
		imageId: 'fake-image:latest',
	};
	await getRegistries().builds.set(build.id, build);
	return build;
}

async function seedRunnableActor(server: TestServerHandle, name: string): Promise<ActorRecord> {
	const actor = await seedActor(server, name);
	const build = await seedSucceededBuild(actor);
	await updateActor(actor.id, (current) => recordTaggedBuild(current, 'latest', build.id, build.buildNumber));
	return (await getRegistries().actors.get(actor.id))!;
}

function declarePricing(baseUrl: string, actorId: string, body: unknown, token: string) {
	return axios.post(`${baseUrl}/actor-runtime/pricing/${actorId}`, JSON.stringify(body), {
		headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
		validateStatus: () => true,
	});
}

const SAMPLE_PRICING_BODY = {
	pricingModel: 'PAY_PER_EVENT',
	pricingPerEvent: {
		actorChargeEvents: {
			'apify-actor-start': {
				eventTitle: 'Actor start',
				eventDescription: 'Charged per GB of memory at start',
				eventPriceUsd: 0.005,
			},
			'page-scraped': { eventTitle: 'Page scraped', eventDescription: 'One page scraped', eventPriceUsd: 0.001 },
		},
	},
};

interface SdkRunHandle {
	id: string;
	defaultDatasetId: string;
	defaultKeyValueStoreId: string;
	defaultRequestQueueId: string;
}

/** The exact env-var contract `services/runs.ts: buildEnv` puts into a real container's environment,
 * minus the fields these tests don't need - byte-identical set to `sdk-charging.test.ts`'s
 * `setSdkEnvFor`, confirmed against the Python SDK's own `_configuration.py` `validation_alias`es (which
 * accept the same `APIFY_*` names, case-insensitively, as the JS SDK's `Configuration`). Passed directly
 * as the subprocess's `env`, never mutating this process's own `process.env` - no snapshot/restore needed,
 * unlike the in-process JS SDK tests. */
function pythonSdkEnv(server: TestServerHandle, run: SdkRunHandle, actorId: string): NodeJS.ProcessEnv {
	return {
		...process.env,
		APIFY_IS_AT_HOME: '1',
		APIFY_TOKEN: server.token,
		APIFY_API_BASE_URL: server.baseUrl,
		APIFY_ACTOR_RUN_ID: run.id,
		APIFY_ACTOR_ID: actorId,
		ACTOR_ID: actorId,
		APIFY_DEFAULT_DATASET_ID: run.defaultDatasetId,
		APIFY_DEFAULT_KEY_VALUE_STORE_ID: run.defaultKeyValueStoreId,
		APIFY_DEFAULT_REQUEST_QUEUE_ID: run.defaultRequestQueueId,
	};
}

/** Runs `script` as a `python3 -c` subprocess against `env` and parses its last stdout line as JSON.
 * Every script below prints its result *before* calling `Actor.exit()`: `Actor.exit()` calls `sys.exit()`
 * by default outside IPython/Scrapy (`_ActorType._get_default_exit_process` in `apify/_actor.py`), which
 * would otherwise terminate the process before a later `print` ever ran - confirmed by trial (an earlier
 * draft printed after `exit()` and always produced empty stdout). */
async function runPythonScript(env: NodeJS.ProcessEnv, script: string): Promise<Record<string, unknown>> {
	const { stdout } = await execFileAsync('python3', ['-c', script], { env, timeout: 30_000 });
	const lastLine = stdout
		.trim()
		.split('\n')
		.filter((line) => line.length > 0)
		.pop();
	if (!lastLine) throw new Error(`python3 produced no stdout output (script: ${script})`);
	return JSON.parse(lastLine) as Record<string, unknown>;
}

const SINGLE_CHARGE_SCRIPT = `
import asyncio, json
from apify import Actor

async def main():
    await Actor.init()
    result = await Actor.charge(event_name='page-scraped', count=5)
    print(json.dumps({'chargedCount': result.charged_count, 'eventChargeLimitReached': result.event_charge_limit_reached}), flush=True)
    await Actor.exit()

asyncio.run(main())
`;

const SEQUENTIAL_CHARGES_SCRIPT = `
import asyncio, json
from apify import Actor

async def main():
    await Actor.init()
    first = await Actor.charge(event_name='page-scraped', count=2)
    second = await Actor.charge(event_name='page-scraped', count=3)
    print(json.dumps({'first': first.charged_count, 'second': second.charged_count}), flush=True)
    await Actor.exit()

asyncio.run(main())
`;

describe.skipIf(pythonSdkGate === 'skip')('Actor.charge() via the real, unmodified Python apify SDK', () => {
	let server: TestServerHandle;

	beforeEach(() => {
		if (pythonSdkGate === 'fail') {
			// CI is expected to provision the Python `apify` package before `pnpm test` runs
			// (`.github/workflows/ci.yml`); getting here means that provisioning step regressed. Fail
			// loudly and explicitly, rather than skip, or let the test fail later with a less legible
			// subprocess/import error - see `test/integration/helpers/python-sdk-gate.ts` and
			// `requirements/test.md`.
			throw new Error(
				'python3 -c "import apify" failed while running in CI (process.env.CI is set). The `checks` ' +
					'job in .github/workflows/ci.yml is expected to install the Python `apify` package before ' +
					'`pnpm test` runs. This is a hard failure, not a skip, because CI is expected to provide ' +
					'this dependency - see requirements/test.md.',
			);
		}
	});

	afterEach(async () => {
		await server?.close();
	});

	it('a Python Actor.charge() call completes without throwing, and chargedEventCounts on the run reflects it', async () => {
		server = await startTestServer(fixedRunOutcomeDriver({ exitCode: 0, timedOut: false }));
		const actor = await seedRunnableActor(server, 'python-sdk-charge-actor');
		const declared = await declarePricing(server.baseUrl, actor.id, SAMPLE_PRICING_BODY, server.token);
		expect(declared.status).toBe(200);
		const run = await server.client.actor(actor.id).start({}, { memory: 1024, waitForFinish: 5 });

		const result = await runPythonScript(pythonSdkEnv(server, run, actor.id), SINGLE_CHARGE_SCRIPT);
		expect(result.chargedCount).toBe(5);
		expect(result.eventChargeLimitReached).toBe(false);

		// Independently re-read the run - proof the charge actually landed server-side, not just that the
		// Python client's own in-memory return value looked right.
		const after = await server.client.run(run.id).get();
		expect(after?.chargedEventCounts?.['page-scraped']).toBe(5);
	}, 30_000);

	it('two sequential Python Actor.charge() calls for the same event build on each other rather than resetting', async () => {
		server = await startTestServer(fixedRunOutcomeDriver({ exitCode: 0, timedOut: false }));
		const actor = await seedRunnableActor(server, 'python-sdk-sequential-charge-actor');
		const declared = await declarePricing(server.baseUrl, actor.id, SAMPLE_PRICING_BODY, server.token);
		expect(declared.status).toBe(200);
		const run = await server.client.actor(actor.id).start({}, { memory: 1024, waitForFinish: 5 });

		const result = await runPythonScript(pythonSdkEnv(server, run, actor.id), SEQUENTIAL_CHARGES_SCRIPT);
		expect(result.first).toBe(2);
		expect(result.second).toBe(3);

		const after = await server.client.run(run.id).get();
		// Builds on the first charge (2 + 3 = 5), not reset by the second call - the Python SDK's
		// `ChargingManager` re-reads `run().get()` fresh, exactly as the JS one does.
		expect(after?.chargedEventCounts?.['page-scraped']).toBe(5);
	}, 30_000);
});

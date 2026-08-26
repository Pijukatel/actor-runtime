/**
 * End-to-end coverage for `Actor.charge()` as an Actor built with the real, unmodified Apify JS SDK
 * (the `apify` npm package) actually calls it - unlike `pricing-and-charging.test.ts` (which drives
 * `apify-client` directly, a client-library method, not the SDK's charging logic), every test in this
 * file drives the REAL, unmodified `apify` package's `Actor`/`ChargingManager` - the exact code path
 * `Actor.charge()` runs through on the platform (`ChargingManager.fetchPricingInfo()`/`charge()` in
 * `apify/dist/charging.js`), against this runtime.
 *
 * `new Actor({...})` (a fully public, documented alternative to the static `Actor.init()`/`Actor.charge()`
 * helpers) is used instead of the static form specifically because the static form caches one `Actor`
 * instance for the whole process (`Actor.getDefaultInstance()`), which would leak state between tests; a
 * fresh instance per test needs no such cache.
 *
 * Every field is set through `process.env`, not constructor options - this SDK version's
 * `Configuration.get()` reads env vars *first*, falling back to constructor options only when no env var
 * is set (`@crawlee/core`'s own doc comment: "Env vars will have precedence over those [options]"), so a real
 * `APIFY_TOKEN` already present in the ambient environment (e.g. from an Apify CLI login on the host)
 * would silently win over a same-named constructor option. Setting the env vars directly - exactly the
 * approach the task verified feasible - sidesteps that precedence entirely. Each key this file touches is
 * snapshotted before and restored after every test (`snapshotSdkEnv`/`restoreSdkEnv`), so no test leaks
 * its env into the next.
 *
 * `purgeOnStart: false` (a constructor option, not an env var this sandbox happens to preset) is passed
 * deliberately: `Actor.init()` otherwise calls crawlee's `purgeDefaultStorages()`, which would call
 * `.purge()` on the storage client - exactly what this repo's own eslint rule ("Never call *.purge()
 * outside the storage bootstrap module") exists to keep out of test code, and orthogonal to what these
 * tests are about. Passing any constructor option also forces a fresh per-instance `Configuration`
 * (`Object.keys(options).length === 0` is the only case that reuses the process-wide cached one), so this
 * doubles as what keeps each test's `Actor` fully independent of the others'.
 *
 * Deliberately NOT set anywhere here: `APIFY_ACTOR_PRICING_INFO`/`APIFY_CHARGED_ACTOR_EVENT_COUNTS` -
 * setting either would make `ChargingManager.fetchPricingInfo()` short-circuit onto a frozen snapshot
 * instead of exercising the `run(id).get()` path this runtime's `runDto` projection exists to serve (see
 * `services/runs.ts: buildEnv`'s own doc comment for the same point from the runtime's side).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Actor } from 'apify';
import axios from 'axios';

import {
	deferredRunDriver,
	fixedRunOutcomeDriver,
	startTestServer,
	type TestServerHandle,
} from './helpers/test-server.js';
import { recordTaggedBuild, updateActor } from '../../src/services/actors.js';
import { generateId } from '../../src/storage/ids.js';
import { getRegistries } from '../../src/storage/registries.js';
import type { ActorRecord, BuildRecord } from '../../src/storage/entities.js';

async function seedActor(server: TestServerHandle, name: string): Promise<ActorRecord> {
	const created = await server.client.actors().create({ name });
	return (await getRegistries().actors.get(created.id))!;
}

/** A SUCCEEDED build with a fake image, seeded directly - `pricing-and-charging.test.ts`'s identical
 * helper (the stub drivers used below cannot build one). */
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

/** Every env var this file's SDK-driven tests ever set - snapshotted/restored around each test by
 * `snapshotSdkEnv`/`restoreSdkEnv`, so a real value already present in the ambient environment (see this
 * file's doc comment) is put back afterward, not left clobbered for the rest of the suite. */
const SDK_ENV_KEYS = [
	'APIFY_IS_AT_HOME',
	'APIFY_TOKEN',
	'APIFY_API_BASE_URL',
	'APIFY_ACTOR_RUN_ID',
	'APIFY_ACTOR_ID',
	'ACTOR_ID',
	'APIFY_DEFAULT_DATASET_ID',
	'APIFY_DEFAULT_KEY_VALUE_STORE_ID',
	'APIFY_DEFAULT_REQUEST_QUEUE_ID',
] as const;

function snapshotSdkEnv(): Partial<Record<(typeof SDK_ENV_KEYS)[number], string | undefined>> {
	const snapshot: Partial<Record<(typeof SDK_ENV_KEYS)[number], string | undefined>> = {};
	for (const key of SDK_ENV_KEYS) snapshot[key] = process.env[key];
	return snapshot;
}

function restoreSdkEnv(snapshot: Partial<Record<(typeof SDK_ENV_KEYS)[number], string | undefined>>): void {
	for (const key of SDK_ENV_KEYS) {
		const value = snapshot[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

/** Points every env var the SDK's `Configuration` reads at `server`/`run`/`actorId` - the exact set
 * `services/runs.ts: buildEnv` puts into a real container's environment, minus the fields these tests
 * don't need (memory/timeout/events-websocket). Caller is responsible for snapshot/restore
 * (`snapshotSdkEnv`/`restoreSdkEnv`). */
function setSdkEnvFor(server: TestServerHandle, run: SdkRunHandle, actorId: string): void {
	process.env.APIFY_IS_AT_HOME = '1';
	process.env.APIFY_TOKEN = server.token;
	process.env.APIFY_API_BASE_URL = server.baseUrl;
	process.env.APIFY_ACTOR_RUN_ID = run.id;
	process.env.APIFY_ACTOR_ID = actorId;
	process.env.ACTOR_ID = actorId;
	process.env.APIFY_DEFAULT_DATASET_ID = run.defaultDatasetId;
	process.env.APIFY_DEFAULT_KEY_VALUE_STORE_ID = run.defaultKeyValueStoreId;
	process.env.APIFY_DEFAULT_REQUEST_QUEUE_ID = run.defaultRequestQueueId;
}

/** Builds a fresh, isolated `Actor` instance pointed at `server`/`run` (via env vars already set by
 * `setSdkEnvFor`) - see this file's doc comment for why a fresh instance (never the static `Actor.*`
 * singleton) and why `purgeOnStart: false`. */
function sdkActorFor(): Actor {
	return new Actor({ purgeOnStart: false });
}

describe('Actor.charge() via the real, unmodified apify SDK', () => {
	let server: TestServerHandle;
	let envSnapshot: ReturnType<typeof snapshotSdkEnv>;

	afterEach(async () => {
		restoreSdkEnv(envSnapshot);
		await server.close();
	});

	it('a successful charge() on a PPE run increments chargedEventCounts on the run, and the ChargingManager never takes the non-PPE no-op path', async () => {
		server = await startTestServer(fixedRunOutcomeDriver({ exitCode: 0, timedOut: false }));
		const actor = await seedRunnableActor(server, 'sdk-ppe-charge-actor');
		await declarePricing(server.baseUrl, actor.id, SAMPLE_PRICING_BODY, server.token);
		const run = await server.client.actor(actor.id).start({}, { memory: 1024, waitForFinish: 5 });

		envSnapshot = snapshotSdkEnv();
		setSdkEnvFor(server, run, actor.id);
		// `ChargingManager`'s non-PPE no-op path warns through `console.warn` (`@apify/log`'s WARNING level
		// writes there) - spying here directly pins that this specific message is never printed for a
		// correctly-declared PPE run.
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const sdkActor = sdkActorFor();
		await sdkActor.init({ gracefulShutdown: false });

		const result = await sdkActor.charge({ eventName: 'page-scraped', count: 5 });
		await sdkActor.exit(undefined, { exit: false });
		// Read the recorded calls BEFORE `mockRestore()` - restoring a spy also clears its call history,
		// so reading after would always see an empty array regardless of what was actually logged.
		const warnedText = warnSpy.mock.calls.flat(2).join(' ');
		warnSpy.mockRestore();

		// Structural proof `isPayPerEvent` was true, not the no-op branch: that branch always returns
		// `chargedCount: 0` regardless of the requested count.
		expect(result.chargedCount).toBe(5);
		expect(result.eventChargeLimitReached).toBe(false);
		expect(warnedText).not.toContain('Ignored attempt to charge for an event');

		const after = await server.client.run(run.id).get();
		expect(after?.chargedEventCounts?.['page-scraped']).toBe(5);
	});

	it('two sequential charge() calls for the same event build on each other rather than resetting', async () => {
		server = await startTestServer(fixedRunOutcomeDriver({ exitCode: 0, timedOut: false }));
		const actor = await seedRunnableActor(server, 'sdk-sequential-charge-actor');
		await declarePricing(server.baseUrl, actor.id, SAMPLE_PRICING_BODY, server.token);
		const run = await server.client.actor(actor.id).start({}, { memory: 1024, waitForFinish: 5 });

		envSnapshot = snapshotSdkEnv();
		setSdkEnvFor(server, run, actor.id);
		const sdkActor = sdkActorFor();
		await sdkActor.init({ gracefulShutdown: false });

		const first = await sdkActor.charge({ eventName: 'page-scraped', count: 2 });
		const second = await sdkActor.charge({ eventName: 'page-scraped', count: 3 });
		await sdkActor.exit(undefined, { exit: false });

		expect(first.chargedCount).toBe(2);
		expect(second.chargedCount).toBe(3);
		const after = await server.client.run(run.id).get();
		// Builds on the first charge (2 + 3 = 5), not reset by the second call.
		expect(after?.chargedEventCounts?.['page-scraped']).toBe(5);
	});

	it('a low ACTOR_MAX_TOTAL_CHARGE_USD makes the SDK self-limit chargedCount below the requested count', async () => {
		server = await startTestServer(fixedRunOutcomeDriver({ exitCode: 0, timedOut: false }));
		const actor = await seedRunnableActor(server, 'sdk-max-charge-actor');
		// Only `page-scraped`, at $0.01/event - keeps the arithmetic below exact, no `apify-actor-start`
		// baseline to account for.
		await declarePricing(
			server.baseUrl,
			actor.id,
			{
				pricingModel: 'PAY_PER_EVENT',
				pricingPerEvent: {
					actorChargeEvents: { 'page-scraped': { eventTitle: 'Page scraped', eventPriceUsd: 0.01 } },
				},
			},
			server.token,
		);
		const run = await server.client
			.actor(actor.id)
			.start({}, { memory: 1024, maxTotalChargeUsd: 0.05, waitForFinish: 5 });
		expect(run.options.maxTotalChargeUsd).toBe(0.05); // echoed by GET /v2/actor-runs/:runId, the SDK's input.

		envSnapshot = snapshotSdkEnv();
		setSdkEnvFor(server, run, actor.id);
		const sdkActor = sdkActorFor();
		await sdkActor.init({ gracefulShutdown: false });

		// floor(0.05 / 0.01) = 5 chargeable within budget; the SDK deliberately overcharges by one more
		// (to 6) so the platform would detect and terminate the run - `apify/dist/charging.js`'s own
		// comment: "overcharge by one event so that the Actor is detected by the platform and terminated".
		// Either way, far short of the 10 events actually requested - this is the SDK's own client-side
		// self-limiting the task asks to prove, with nothing on this runtime enforcing anything.
		const result = await sdkActor.charge({ eventName: 'page-scraped', count: 10 });
		await sdkActor.exit(undefined, { exit: false });

		expect(result.chargedCount).toBeLessThan(10);
		expect(result.chargedCount).toBe(6);

		const after = await server.client.run(run.id).get();
		expect(after?.chargedEventCounts?.['page-scraped']).toBe(6);
	});

	it('both-sides: a run of a non-PPE Actor still no-ops exactly as before - chargedCount 0, and the SDK logs its own warning once', async () => {
		server = await startTestServer(fixedRunOutcomeDriver({ exitCode: 0, timedOut: false }));
		const actor = await seedRunnableActor(server, 'sdk-non-ppe-actor');
		// No pricing declared - `run.pricingInfo` stays `undefined`, the design's own cited failure mode.
		const run = await server.client.actor(actor.id).start({}, { waitForFinish: 5 });

		envSnapshot = snapshotSdkEnv();
		setSdkEnvFor(server, run, actor.id);
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const sdkActor = sdkActorFor();
		await sdkActor.init({ gracefulShutdown: false });

		const result = await sdkActor.charge({ eventName: 'page-scraped', count: 3 });
		await sdkActor.exit(undefined, { exit: false });
		// Read before `mockRestore()` - see the sibling PPE test's identical comment for why.
		const warnedText = warnSpy.mock.calls.flat(2).join(' ');
		warnSpy.mockRestore();

		expect(result.chargedCount).toBe(0);
		expect(warnedText).toContain('Ignored attempt to charge for an event');
	});
});

describe('POST /v2/actor-runs/:runId/charge - nothing here aborts an over-cap run', () => {
	let server: TestServerHandle;

	afterEach(async () => {
		await server.close();
	});

	it('charging a RUNNING run far past its declared maxTotalChargeUsd, directly (bypassing the SDK), is accepted and the run stays RUNNING', async () => {
		const driver = deferredRunDriver();
		server = await startTestServer(driver);
		const actor = await seedRunnableActor(server, 'over-cap-not-aborted-actor');
		await declarePricing(
			server.baseUrl,
			actor.id,
			{
				pricingModel: 'PAY_PER_EVENT',
				pricingPerEvent: {
					actorChargeEvents: { 'page-scraped': { eventTitle: 'Page scraped', eventPriceUsd: 1 } },
				},
			},
			server.token,
		);

		const startedPromise = server.client.actor(actor.id).start({}, { memory: 1024, maxTotalChargeUsd: 1 });
		await driver.started;
		const started = await startedPromise;
		const beforeCharge = await server.client.run(started.id).get();
		expect(beforeCharge?.status).toBe('RUNNING');

		// $1,000 worth of a $1/event charge against a $1 cap, sent straight to the charge endpoint - the
		// SDK's own client-side cap is never in the loop here.
		const res = await axios.post(
			`${server.baseUrl}/v2/actor-runs/${started.id}/charge`,
			{ eventName: 'page-scraped', count: 1000 },
			{ headers: { Authorization: `Bearer ${server.token}`, 'idempotency-key': 'over-cap-1' } },
		);
		expect(res.status).toBe(201);
		expect(res.data).toEqual({});

		const after = await server.client.run(started.id).get();
		expect(after?.chargedEventCounts?.['page-scraped']).toBe(1000);
		expect(after?.status).toBe('RUNNING');

		driver.resolveRun({ exitCode: 0, timedOut: false });
		await server.client.run(started.id).waitForFinish();
	});
});

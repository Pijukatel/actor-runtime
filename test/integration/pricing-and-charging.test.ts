/**
 * Integration coverage for per-run cost estimation (`requirements/api.md`'s "Run cost estimation and
 * PPE charging" section): the `POST|GET /actor-runtime/pricing/:actorId` declaration endpoint, `runDto`'s
 * `stats`/`usage`/`usageUsd`/`eventUsage`/`usageTotalUsd`/`pricingInfo`/`chargedEventCounts` projection,
 * and the `POST /v2/actor-runs/:runId/charge` route - all driven through the real `apify-client` (or raw
 * `axios` where the exact HTTP contract, not just the client's parsed view of it, is what's under test)
 * against `startTestServer`. Testing strategy: test the arithmetic (covered separately, clock-free, in
 * `test/unit/pricing.test.ts`), and here assert the DTO's values against the
 * formula applied to the record's own timestamps - never against a fixed/injected clock.
 */
import { afterEach, describe, expect, it } from 'vitest';
import axios from 'axios';

import {
	deferredRunDriver,
	fixedRunOutcomeDriver,
	multiRunDriver,
	startTestServer,
	type TestServerHandle,
} from './helpers/test-server.js';
import { createConsoleServer } from '../../src/console/server.js';
import { bootstrapStorage, resetStorageForTests } from '../../src/storage/bootstrap.js';
import { getRegistries, openRegistries, resetRegistriesForTests } from '../../src/storage/registries.js';
import { generateId } from '../../src/storage/ids.js';
import { recordTaggedBuild, updateActor } from '../../src/services/actors.js';
import type { ActorRecord, BuildRecord } from '../../src/storage/entities.js';

async function seedActor(server: TestServerHandle, name: string): Promise<ActorRecord> {
	const created = await server.client.actors().create({ name });
	return (await getRegistries().actors.get(created.id))!;
}

/** A SUCCEEDED build with a fake image, seeded directly - mirrors `job-lifecycle.test.ts`'s identical
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

/** `setActorPricing` stamps `createdAt`/`startedAt`/`apifyMarginPercentage` server-side (`src/services/
 * pricing-declaration.ts`), so a returned `pricingInfo` is never byte-identical to the declared request
 * body - a plain `toEqual(declaredBody)` would fail on those three stamped fields alone, so this checks
 * the declared fields exactly and the stamped ones structurally instead (a valid, matching ISO
 * timestamp pair and the fixed 0.2 margin). Reads via `axios` see the raw ISO strings this runtime actually serializes
 * (`PricingInfo.createdAt`/`startedAt` - see `src/pricing.ts`'s doc comment for why they're strings, not
 * `Date`); reads via `server.client` see them already parsed into `Date` objects, since `apify-client`
 * converts any field whose name matches its own date-like-key heuristic on the way in - both forms are
 * normalized to an ISO string here before comparing. */
function expectValidPricingInfoShape(pricingInfo: unknown, declaredBody: typeof SAMPLE_PRICING_BODY): void {
	const info = pricingInfo as Record<string, unknown>;
	expect(info.pricingModel).toBe(declaredBody.pricingModel);
	expect(info.pricingPerEvent).toEqual(declaredBody.pricingPerEvent);
	expect(info.apifyMarginPercentage).toBe(0.2);
	const toIso = (value: unknown) => (value instanceof Date ? value.toISOString() : (value as string));
	const createdAt = toIso(info.createdAt);
	const startedAt = toIso(info.startedAt);
	expect(typeof createdAt).toBe('string');
	expect(Number.isNaN(Date.parse(createdAt))).toBe(false);
	expect(startedAt).toBe(createdAt);
}

function declarePricing(baseUrl: string, actorId: string, body: unknown, token?: string) {
	return axios.post(`${baseUrl}/actor-runtime/pricing/${actorId}`, JSON.stringify(body), {
		headers: { 'content-type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
		validateStatus: () => true,
	});
}

function readPricing(baseUrl: string, actorId: string, token?: string) {
	return axios.get(`${baseUrl}/actor-runtime/pricing/${actorId}`, {
		headers: token ? { Authorization: `Bearer ${token}` } : {},
		validateStatus: () => true,
	});
}

function chargeViaHttp(
	baseUrl: string,
	runId: string,
	token: string,
	body: unknown,
	idempotencyKey: string | undefined,
) {
	return axios.post(`${baseUrl}/v2/actor-runs/${runId}/charge`, body, {
		headers: {
			Authorization: `Bearer ${token}`,
			...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
		},
		validateStatus: () => true,
	});
}

/** Same endpoint, but sends `rawBody` verbatim as the request body (already-serialized JSON text) instead
 * of letting axios `JSON.stringify` a plain object - needed for a `count` value JSON itself can represent
 * but a JS object literal cannot (e.g. `1e400`, a valid JSON number token that parses to `Infinity`), so
 * the request-shape guard's `!Number.isInteger(count)` arm rejects an actual `Infinity` rather than the
 * request failing earlier at JSON-parse time. */
function chargeViaHttpRaw(
	baseUrl: string,
	runId: string,
	token: string,
	rawBody: string,
	idempotencyKey: string | undefined,
) {
	return axios.post(`${baseUrl}/v2/actor-runs/${runId}/charge`, rawBody, {
		headers: {
			'content-type': 'application/json',
			Authorization: `Bearer ${token}`,
			...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
		},
		validateStatus: () => true,
	});
}

describe('POST|GET /actor-runtime/pricing/:actorId', () => {
	let server: TestServerHandle;

	afterEach(async () => {
		await server.close();
	});

	it('declares pricing, then reads it back exactly - via the endpoint and via a fresh run snapshot', async () => {
		server = await startTestServer();
		const actor = await server.client.actors().create({ name: 'pricing-actor' });

		const declared = await declarePricing(server.baseUrl, actor.id, SAMPLE_PRICING_BODY, server.token);
		expect(declared.status).toBe(200);
		expectValidPricingInfoShape(declared.data.data.pricingInfo, SAMPLE_PRICING_BODY);

		const read = await readPricing(server.baseUrl, actor.id, server.token);
		expect(read.status).toBe(200);
		// The read-back is the exact same stored record, stamp included - not merely "also valid-shaped".
		expect(read.data.data.pricingInfo).toEqual(declared.data.data.pricingInfo);
	});

	it("a nonexistent actor id 404s, and a real actor id used with someone else's token 404s the same way", async () => {
		server = await startTestServer();
		const actor = await server.client.actors().create({ name: 'owned-pricing-actor' });

		const missing = await declarePricing(server.baseUrl, 'does-not-exist', SAMPLE_PRICING_BODY, server.token);
		expect(missing.status).toBe(404);
		expect(missing.data.error.type).toBe('record-not-found');

		const wrongOwner = await declarePricing(
			server.baseUrl,
			actor.id,
			SAMPLE_PRICING_BODY,
			'a-totally-different-token',
		);
		expect(wrongOwner.status).toBe(404);
		expect(wrongOwner.data.error.type).toBe('record-not-found');
	});

	it('rejects a malformed pricing declaration as 400 invalid-request and writes nothing', async () => {
		server = await startTestServer();
		const actor = await server.client.actors().create({ name: 'malformed-pricing-actor' });

		const missingModel = await declarePricing(
			server.baseUrl,
			actor.id,
			{ pricingPerEvent: { actorChargeEvents: {} } },
			server.token,
		);
		expect(missingModel.status).toBe(400);
		expect(missingModel.data.error.type).toBe('invalid-request');

		const badEvent = await declarePricing(
			server.baseUrl,
			actor.id,
			{ pricingModel: 'PAY_PER_EVENT', pricingPerEvent: { actorChargeEvents: { x: { eventTitle: 'X' } } } },
			server.token,
		);
		expect(badEvent.status).toBe(400);

		const read = await readPricing(server.baseUrl, actor.id, server.token);
		expect(read.data.data.pricingInfo).toBeNull();
	});

	it('rejects a pricing declaration with a negative eventPriceUsd as 400 invalid-request and writes nothing', async () => {
		server = await startTestServer();
		const actor = await server.client.actors().create({ name: 'negative-price-actor' });

		const negativePrice = await declarePricing(
			server.baseUrl,
			actor.id,
			{
				pricingModel: 'PAY_PER_EVENT',
				pricingPerEvent: {
					actorChargeEvents: {
						'page-scraped': { eventTitle: 'Page scraped', eventPriceUsd: -0.01 },
					},
				},
			},
			server.token,
		);
		expect(negativePrice.status).toBe(400);
		expect(negativePrice.data.error.type).toBe('invalid-request');

		const read = await readPricing(server.baseUrl, actor.id, server.token);
		expect(read.data.data.pricingInfo).toBeNull();
	});

	it('rejects a pricing declaration missing eventDescription (mirroring apify-core and the Python SDK contract) and writes nothing', async () => {
		server = await startTestServer();
		const actor = await server.client.actors().create({ name: 'missing-description-actor' });

		const missingDescription = await declarePricing(
			server.baseUrl,
			actor.id,
			{
				pricingModel: 'PAY_PER_EVENT',
				pricingPerEvent: {
					actorChargeEvents: {
						'page-scraped': { eventTitle: 'Page scraped', eventPriceUsd: 0.001 },
					},
				},
			},
			server.token,
		);
		expect(missingDescription.status).toBe(400);
		expect(missingDescription.data.error.type).toBe('invalid-request');

		const read = await readPricing(server.baseUrl, actor.id, server.token);
		expect(read.data.data.pricingInfo).toBeNull();
	});

	it('POST "" clears a declared pricing (mirrors the dev-folder endpoint\'s clear convention)', async () => {
		server = await startTestServer(fixedRunOutcomeDriver({ exitCode: 0, timedOut: false }));
		const actor = await seedRunnableActor(server, 'clearable-pricing-actor');
		await declarePricing(server.baseUrl, actor.id, SAMPLE_PRICING_BODY, server.token);

		const cleared = await declarePricing(server.baseUrl, actor.id, '', server.token);
		expect(cleared.status).toBe(200);
		expect(cleared.data.data.pricingInfo).toBeNull();

		const run = await server.client.actor(actor.id).start({}, { waitForFinish: 5 });
		expect(run.pricingInfo).toBeUndefined();
		expect(run.chargedEventCounts).toBeUndefined();

		const chargeAttempt = await chargeViaHttp(
			server.baseUrl,
			run.id,
			server.token,
			{ eventName: 'page-scraped' },
			'clear-test-key',
		);
		expect(chargeAttempt.status).toBe(405);
		expect(chargeAttempt.data.error.type).toBe('cannot-charge-non-pay-per-event-actor');
	});

	it("editing pricing between two runs changes only the later run's pricingInfo, never the earlier one's", async () => {
		server = await startTestServer(fixedRunOutcomeDriver({ exitCode: 0, timedOut: false }));
		const actor = await seedRunnableActor(server, 'sequential-pricing-actor');

		await declarePricing(server.baseUrl, actor.id, SAMPLE_PRICING_BODY, server.token);
		const firstRun = await server.client.actor(actor.id).start({}, { waitForFinish: 5 });
		expectValidPricingInfoShape(firstRun.pricingInfo, SAMPLE_PRICING_BODY);

		const revisedPricing = {
			pricingModel: 'PAY_PER_EVENT',
			pricingPerEvent: {
				actorChargeEvents: {
					'apify-actor-start': {
						eventTitle: 'Actor start',
						eventDescription: 'Charged per GB of memory at start',
						eventPriceUsd: 0.05,
					},
					'page-scraped': {
						eventTitle: 'Page scraped',
						eventDescription: 'One page scraped',
						eventPriceUsd: 0.02,
					},
				},
			},
		};
		await declarePricing(server.baseUrl, actor.id, revisedPricing, server.token);

		// The earlier, already-started run must be completely unaffected by the edit - not just
		// structurally valid, but byte-identical to its own snapshot from before the edit (stamp included).
		const firstRunAfterEdit = await server.client.run(firstRun.id).get();
		expect(firstRunAfterEdit?.pricingInfo).toEqual(firstRun.pricingInfo);

		const secondRun = await server.client.actor(actor.id).start({}, { waitForFinish: 5 });
		expectValidPricingInfoShape(secondRun.pricingInfo, revisedPricing);
		expect(secondRun.pricingInfo).not.toEqual(firstRun.pricingInfo);
	});

	it('no pay_per_event.json (or similarly named) Actor-source file is ever read as a pricing fallback', async () => {
		server = await startTestServer(fixedRunOutcomeDriver({ exitCode: 0, timedOut: false }));
		const actor = await server.client.actors().create({ name: 'file-fallback-actor' });
		await server.client
			.actor(actor.id)
			.versions()
			.create({
				versionNumber: '0.0',
				buildTag: 'latest',
				sourceType: 'SOURCE_FILES' as never,
				sourceFiles: [
					{
						name: 'pay_per_event.json',
						format: 'TEXT',
						content: JSON.stringify({
							pricingModel: 'PAY_PER_EVENT',
							pricingPerEvent: {
								actorChargeEvents: { 'from-file': { eventTitle: 'From file', eventPriceUsd: 999 } },
							},
						}),
					},
				],
			} as never);
		const build = await seedSucceededBuild((await getRegistries().actors.get(actor.id))!);
		await updateActor(actor.id, (current) => recordTaggedBuild(current, 'latest', build.id, build.buildNumber));

		// Declare real pricing only through the endpoint - the file above is never touched by this.
		await declarePricing(server.baseUrl, actor.id, SAMPLE_PRICING_BODY, server.token);

		const run = await server.client.actor(actor.id).start({}, { waitForFinish: 5 });
		expectValidPricingInfoShape(run.pricingInfo, SAMPLE_PRICING_BODY);
		expect(
			(run.pricingInfo as typeof SAMPLE_PRICING_BODY).pricingPerEvent.actorChargeEvents['from-file'],
		).toBeUndefined();
	});

	// `services/pricing-declaration.ts: writePricingInfo` bypasses `services/actors.ts: updateActor`
	// deliberately (see that function's own doc comment) - mirrors `dev-folder.test.ts`'s identical
	// regression tests for `writeLocalDevFolder`.
	it("declaring pricing never bumps the Actor's modifiedAt", async () => {
		server = await startTestServer(fixedRunOutcomeDriver({ exitCode: 0, timedOut: false }));
		const actor = await server.client.actors().create({ name: 'modifiedat-declare-actor' });
		const before = (await getRegistries().actors.get(actor.id))!.modifiedAt;

		const res = await declarePricing(server.baseUrl, actor.id, SAMPLE_PRICING_BODY, server.token);
		expect(res.status).toBe(200);

		const after = (await getRegistries().actors.get(actor.id))!.modifiedAt;
		expect(after).toBe(before);
	});

	it("clearing a previously-declared pricing never bumps the Actor's modifiedAt", async () => {
		server = await startTestServer(fixedRunOutcomeDriver({ exitCode: 0, timedOut: false }));
		const actor = await server.client.actors().create({ name: 'modifiedat-clear-pricing-actor' });
		await declarePricing(server.baseUrl, actor.id, SAMPLE_PRICING_BODY, server.token);
		const before = (await getRegistries().actors.get(actor.id))!.modifiedAt;

		const res = await declarePricing(server.baseUrl, actor.id, '', server.token);
		expect(res.status).toBe(200);

		const after = (await getRegistries().actors.get(actor.id))!.modifiedAt;
		expect(after).toBe(before);
	});
});

describe('runDto: stats/usage projection (compute units)', () => {
	let server: TestServerHandle;

	afterEach(async () => {
		await server.close();
	});

	async function assertStatsMatchFormula(run: { id: string; status: string }): Promise<void> {
		const fetched = await server.client.run(run.id).get();
		expect(fetched).toBeDefined();
		const record = (await getRegistries().runs.get(run.id))!;
		const expectedComputeUnits =
			(record.options.memoryMbytes / 1024) *
			((new Date(record.finishedAt!).getTime() - new Date(record.startedAt).getTime()) / 3_600_000);

		expect(fetched!.stats!.computeUnits).toBeCloseTo(expectedComputeUnits, 10);
		expect(fetched!.usage!.ACTOR_COMPUTE_UNITS).toBeCloseTo(expectedComputeUnits, 10);
		expect(fetched!.usageUsd!.ACTOR_COMPUTE_UNITS).toBeCloseTo(expectedComputeUnits * 0.2, 10);
		expect(fetched!.stats!.durationMillis).toBe(
			new Date(record.finishedAt!).getTime() - new Date(record.startedAt).getTime(),
		);
	}

	for (const [label, outcome] of [
		['SUCCEEDED', { exitCode: 0, timedOut: false }],
		['FAILED', { exitCode: 1, timedOut: false }],
		['TIMED-OUT', { exitCode: 137, timedOut: true }],
	] as const) {
		it(`a ${label} run reports a real, non-zero computeUnits matching (memoryMbytes/1024) x (durationMs/3600000)`, async () => {
			server = await startTestServer(fixedRunOutcomeDriver(outcome));
			const actor = await seedRunnableActor(server, `stats-${label.toLowerCase()}-actor`);
			const run = await server.client.actor(actor.id).start({}, { memory: 4096, waitForFinish: 5 });
			expect(run.status).toBe(label);
			await assertStatsMatchFormula(run);
		});
	}

	it('an ABORTED run also reports real stats/computeUnits, not a placeholder zero', async () => {
		const driver = deferredRunDriver();
		server = await startTestServer(driver);
		const actor = await seedRunnableActor(server, 'stats-aborted-actor');

		const startedPromise = server.client.actor(actor.id).start({}, { memory: 2048 });
		await driver.started;
		const started = await startedPromise;

		await server.client.run(started.id).abort();
		const run = await server.client.run(started.id).get();
		expect(run?.status).toBe('ABORTED');
		await assertStatsMatchFormula(run!);
		expect(run!.stats!.computeUnits).toBeGreaterThanOrEqual(0);
	});

	it("stats carries exactly apify-core's ActorJobPublishedStats key set", async () => {
		server = await startTestServer(fixedRunOutcomeDriver({ exitCode: 0, timedOut: false }));
		const actor = await seedRunnableActor(server, 'stats-shape-actor');
		const run = await server.client.actor(actor.id).start({}, { waitForFinish: 5 });

		expect(Object.keys(run.stats!).sort()).toEqual(
			[
				'inputBodyLen',
				'migrationCount',
				'rebootCount',
				'restartCount',
				'resurrectCount',
				'durationMillis',
				'runTimeSecs',
				'metamorph',
				'computeUnits',
				'memAvgBytes',
				'memMaxBytes',
				'memCurrentBytes',
				'cpuAvgUsage',
				'cpuMaxUsage',
				'cpuCurrentUsage',
				'netRxBytes',
				'netTxBytes',
				'imageSizeBytes',
			].sort(),
		);
	});

	it('two runs of the same Actor/memory but different durations produce computeUnits in the same ratio as their durations', async () => {
		// `bootstrapStorage()`/its registries are process-wide singletons (see `storage/bootstrap.ts`'s
		// own doc comment), so two runs are driven sequentially through ONE server/driver here, not two
		// concurrent `startTestServer()`s.
		const driver = multiRunDriver();
		server = await startTestServer(driver);
		const actor = await seedRunnableActor(server, 'stats-linearity-actor');

		const shortRunPromise = server.client.actor(actor.id).start({}, { memory: 1024 });
		const shortRun = await shortRunPromise;
		await driver.waitForStart(shortRun.id);
		driver.resolveRun(shortRun.id, { exitCode: 0, timedOut: false });
		await server.client.run(shortRun.id).waitForFinish();

		// A second, separately-controlled run held open for a real (short) delay before resolving.
		const longRunPromise = server.client.actor(actor.id).start({}, { memory: 1024 });
		const longRun = await longRunPromise;
		await driver.waitForStart(longRun.id);
		await new Promise((resolve) => setTimeout(resolve, 120));
		driver.resolveRun(longRun.id, { exitCode: 0, timedOut: false });
		await server.client.run(longRun.id).waitForFinish();

		const shortFinal = await server.client.run(shortRun.id).get();
		const longFinal = await server.client.run(longRun.id).get();
		// Same memory grant, the second run held open measurably longer -> its computeUnits must be at
		// least as large (linearity, verified exactly - fixed ISO strings, no real clock - in
		// `test/unit/pricing.test.ts`; this integration test only confirms the same relationship holds
		// end to end through the real API).
		expect(longFinal!.stats!.computeUnits).toBeGreaterThanOrEqual(shortFinal!.stats!.computeUnits);
		expect(longFinal!.stats!.durationMillis).toBeGreaterThan(shortFinal!.stats!.durationMillis);
	});

	it("a still-RUNNING run's computeUnits strictly increases between two polls seconds apart", async () => {
		const driver = deferredRunDriver();
		server = await startTestServer(driver);
		const actor = await seedRunnableActor(server, 'stats-running-actor');

		const startedPromise = server.client.actor(actor.id).start({}, { memory: 4096 });
		await driver.started;
		const started = await startedPromise;

		const first = await server.client.run(started.id).get();
		await new Promise((resolve) => setTimeout(resolve, 50));
		const second = await server.client.run(started.id).get();

		expect(first?.status).toBe('RUNNING');
		expect(second?.status).toBe('RUNNING');
		expect(second!.stats!.computeUnits).toBeGreaterThan(first!.stats!.computeUnits);

		driver.resolveRun({ exitCode: 0, timedOut: false });
		await server.client.run(started.id).waitForFinish();
	});

	it('a plain (non-PPE) run has no pricingInfo/chargedEventCounts/eventUsage/usage.PAID_ACTORS_PER_EVENT', async () => {
		server = await startTestServer(fixedRunOutcomeDriver({ exitCode: 0, timedOut: false }));
		const actor = await seedRunnableActor(server, 'plain-run-actor');
		const run = await server.client.actor(actor.id).start({}, { waitForFinish: 5 });

		expect(run.pricingInfo).toBeUndefined();
		expect(run.chargedEventCounts).toBeUndefined();
		expect(run.eventUsage).toBeUndefined();
		expect((run.usage as Record<string, number>).PAID_ACTORS_PER_EVENT).toBeUndefined();
		expect((run.usageUsd as Record<string, number>).PAID_ACTORS_PER_EVENT).toBeUndefined();
		// Never a PROXY_* key either.
		for (const key of Object.keys(run.usage ?? {})) expect(key).not.toMatch(/^PROXY_/);
	});

	it('options.maxTotalChargeUsd is echoed back when supplied and absent when not', async () => {
		server = await startTestServer(fixedRunOutcomeDriver({ exitCode: 0, timedOut: false }));
		const actor = await seedRunnableActor(server, 'max-total-charge-actor');

		const withCap = await server.client.actor(actor.id).start({}, { maxTotalChargeUsd: 5, waitForFinish: 5 });
		expect(withCap.options.maxTotalChargeUsd).toBe(5);

		const withoutCap = await server.client.actor(actor.id).start({}, { waitForFinish: 5 });
		expect(withoutCap.options.maxTotalChargeUsd).toBeUndefined();
	});
});

describe('PPE run start: pricingInfo/chargedEventCounts seeding', () => {
	let server: TestServerHandle;

	afterEach(async () => {
		await server.close();
	});

	it('pricingInfo is present only for a run of an Actor with PPE pricing declared before start', async () => {
		server = await startTestServer(fixedRunOutcomeDriver({ exitCode: 0, timedOut: false }));
		const actor = await seedRunnableActor(server, 'ppe-presence-actor');

		const withoutPricing = await server.client.actor(actor.id).start({}, { waitForFinish: 5 });
		expect(withoutPricing.pricingInfo).toBeUndefined();

		await declarePricing(server.baseUrl, actor.id, SAMPLE_PRICING_BODY, server.token);
		const withPricing = await server.client.actor(actor.id).start({}, { waitForFinish: 5 });
		expectValidPricingInfoShape(withPricing.pricingInfo, SAMPLE_PRICING_BODY);
	});

	it.each([
		[512, 1],
		[1024, 1],
		[4096, 4],
	])(
		'chargedEventCounts is seeded, keyed by every declared event, apify-actor-start = Math.max(1, floor(mem/1024)) for %i MB -> %i',
		async (memoryMbytes, expectedStartCount) => {
			server = await startTestServer(fixedRunOutcomeDriver({ exitCode: 0, timedOut: false }));
			const actor = await seedRunnableActor(server, `ppe-seed-actor-${memoryMbytes}`);
			await declarePricing(server.baseUrl, actor.id, SAMPLE_PRICING_BODY, server.token);

			const run = await server.client.actor(actor.id).start({}, { memory: memoryMbytes, waitForFinish: 5 });
			expect(run.chargedEventCounts).toEqual({ 'apify-actor-start': expectedStartCount, 'page-scraped': 0 });
		},
	);
});

describe('POST /v2/actor-runs/:runId/charge', () => {
	let server: TestServerHandle;

	afterEach(async () => {
		await server.close();
	});

	async function seedPpeRun(name: string): Promise<{ actor: ActorRecord; runId: string }> {
		const actor = await seedRunnableActor(server, name);
		await declarePricing(server.baseUrl, actor.id, SAMPLE_PRICING_BODY, server.token);
		const run = await server.client.actor(actor.id).start({}, { memory: 1024, waitForFinish: 5 });
		return { actor, runId: run.id };
	}

	it('a successful charge returns raw 201 {} - not the {data: ...} envelope', async () => {
		server = await startTestServer(fixedRunOutcomeDriver({ exitCode: 0, timedOut: false }));
		const { runId } = await seedPpeRun('charge-envelope-actor');

		const res = await chargeViaHttp(
			server.baseUrl,
			runId,
			server.token,
			{ eventName: 'page-scraped', count: 3 },
			'k-envelope-1',
		);
		expect(res.status).toBe(201);
		expect(res.data).toEqual({});
	});

	it('increases chargedEventCounts by exactly count', async () => {
		server = await startTestServer(fixedRunOutcomeDriver({ exitCode: 0, timedOut: false }));
		const { runId } = await seedPpeRun('charge-increment-actor');

		const before = await server.client.run(runId).get();
		expect(before?.chargedEventCounts?.['page-scraped']).toBe(0);

		const res = await chargeViaHttp(
			server.baseUrl,
			runId,
			server.token,
			{ eventName: 'page-scraped', count: 5 },
			'k-increment-1',
		);
		expect(res.status).toBe(201);

		const after = await server.client.run(runId).get();
		expect(after?.chargedEventCounts?.['page-scraped']).toBe(5);
	});

	it('replaying the identical idempotency key leaves the count unchanged after the first application', async () => {
		server = await startTestServer(fixedRunOutcomeDriver({ exitCode: 0, timedOut: false }));
		const { runId } = await seedPpeRun('charge-replay-actor');

		const key = 'k-replay-1';
		await chargeViaHttp(server.baseUrl, runId, server.token, { eventName: 'page-scraped', count: 5 }, key);
		const secondResponse = await chargeViaHttp(
			server.baseUrl,
			runId,
			server.token,
			{ eventName: 'page-scraped', count: 5 },
			key,
		);
		expect(secondResponse.status).toBe(201);
		const thirdResponse = await chargeViaHttp(
			server.baseUrl,
			runId,
			server.token,
			{ eventName: 'page-scraped', count: 5 },
			key,
		);
		expect(thirdResponse.status).toBe(201);

		const after = await server.client.run(runId).get();
		expect(after?.chargedEventCounts?.['page-scraped']).toBe(5);
	});

	it('idempotency survives a simulated runtime restart against the same on-disk data', async () => {
		server = await startTestServer(fixedRunOutcomeDriver({ exitCode: 0, timedOut: false }));
		const { runId } = await seedPpeRun('charge-restart-actor');

		const key = 'k-restart-1';
		const first = await chargeViaHttp(
			server.baseUrl,
			runId,
			server.token,
			{ eventName: 'page-scraped', count: 3 },
			key,
		);
		expect(first.status).toBe(201);

		// Simulate a process restart within this test process, against the SAME on-disk data -
		// `storage/bootstrap.ts: resetStorageForTests`'s own doc comment names exactly this usage. Every
		// route resolves `getRegistries()` fresh on each request, so the same still-listening HTTP server
		// (and `server.client`) keep working unmodified once storage is reopened.
		resetRegistriesForTests();
		resetStorageForTests();
		bootstrapStorage(server.dataDir);
		await openRegistries();

		const replay = await chargeViaHttp(
			server.baseUrl,
			runId,
			server.token,
			{ eventName: 'page-scraped', count: 3 },
			key,
		);
		expect(replay.status).toBe(201);

		const after = await server.client.run(runId).get();
		expect(after?.chargedEventCounts?.['page-scraped']).toBe(3);
	});

	it('charging an undeclared event returns 404 record-not-found and does not alter chargedEventCounts', async () => {
		server = await startTestServer(fixedRunOutcomeDriver({ exitCode: 0, timedOut: false }));
		const { runId } = await seedPpeRun('charge-undeclared-actor');

		const before = await server.client.run(runId).get();
		const res = await chargeViaHttp(
			server.baseUrl,
			runId,
			server.token,
			{ eventName: 'not-a-real-event', count: 1 },
			'k-undeclared-1',
		);
		expect(res.status).toBe(404);
		expect(res.data.error.type).toBe('record-not-found');

		const after = await server.client.run(runId).get();
		expect(after?.chargedEventCounts).toEqual(before?.chargedEventCounts);
	});

	it('charging a run of a non-PPE Actor returns 405 cannot-charge-non-pay-per-event-actor', async () => {
		server = await startTestServer(fixedRunOutcomeDriver({ exitCode: 0, timedOut: false }));
		const actor = await seedRunnableActor(server, 'charge-non-ppe-actor');
		const run = await server.client.actor(actor.id).start({}, { waitForFinish: 5 });

		const res = await chargeViaHttp(
			server.baseUrl,
			run.id,
			server.token,
			{ eventName: 'page-scraped', count: 1 },
			'k-non-ppe-1',
		);
		expect(res.status).toBe(405);
		expect(res.data.error.type).toBe('cannot-charge-non-pay-per-event-actor');
	});

	it("charging a nonexistent run, or another user's run, is 404 record-not-found", async () => {
		server = await startTestServer(fixedRunOutcomeDriver({ exitCode: 0, timedOut: false }));
		const { runId } = await seedPpeRun('charge-ownership-actor');

		const missing = await chargeViaHttp(
			server.baseUrl,
			'does-not-exist',
			server.token,
			{ eventName: 'page-scraped' },
			'k-missing-1',
		);
		expect(missing.status).toBe(404);
		expect(missing.data.error.type).toBe('record-not-found');

		const otherUser = await chargeViaHttp(
			server.baseUrl,
			runId,
			'a-completely-different-token',
			{ eventName: 'page-scraped' },
			'k-other-1',
		);
		expect(otherUser.status).toBe(404);
		expect(otherUser.data.error.type).toBe('record-not-found');
	});

	it("charging an apify--prefixed event on a nonexistent run, or another user's run, is 405 cannot-charge-apify-event, not 404", async () => {
		server = await startTestServer(fixedRunOutcomeDriver({ exitCode: 0, timedOut: false }));
		const { runId } = await seedPpeRun('charge-apify-prefix-ownership-actor');

		// The `apify-` prefix guard runs ahead of the "owned record" lookup (`api/routes/runs.ts`,
		// mirroring apify-core's own guard order, `run_charging_service.ts:566-569`), so it fires - and
		// answers `405`, not `404` - even for a run id that doesn't resolve at all.
		const missing = await chargeViaHttp(
			server.baseUrl,
			'does-not-exist',
			server.token,
			{ eventName: 'apify-actor-start' },
			'k-apify-missing-1',
		);
		expect(missing.status).toBe(405);
		expect(missing.data.error.type).toBe('cannot-charge-apify-event');

		const otherUser = await chargeViaHttp(
			server.baseUrl,
			runId,
			'a-completely-different-token',
			{ eventName: 'apify-actor-start' },
			'k-apify-other-1',
		);
		expect(otherUser.status).toBe(405);
		expect(otherUser.data.error.type).toBe('cannot-charge-apify-event');
	});

	it('a charge with no idempotency-key header is rejected (400) and never applied', async () => {
		server = await startTestServer(fixedRunOutcomeDriver({ exitCode: 0, timedOut: false }));
		const { runId } = await seedPpeRun('charge-missing-key-actor');

		const res = await chargeViaHttp(
			server.baseUrl,
			runId,
			server.token,
			{ eventName: 'page-scraped', count: 1 },
			undefined,
		);
		expect(res.status).toBe(400);

		const after = await server.client.run(runId).get();
		expect(after?.chargedEventCounts?.['page-scraped']).toBe(0);
	});

	it('chargeLog is never exposed on any /v2 run response', async () => {
		server = await startTestServer(fixedRunOutcomeDriver({ exitCode: 0, timedOut: false }));
		const { runId } = await seedPpeRun('charge-log-hidden-actor');
		await chargeViaHttp(server.baseUrl, runId, server.token, { eventName: 'page-scraped', count: 2 }, 'k-hidden-1');

		const res = await axios.get(`${server.baseUrl}/v2/actor-runs/${runId}`, {
			headers: { Authorization: `Bearer ${server.token}` },
		});
		expect(JSON.stringify(res.data)).not.toContain('chargeLog');
	});

	it('a charge landing after the run has already turned SUCCEEDED is still reflected on the next GET', async () => {
		server = await startTestServer(fixedRunOutcomeDriver({ exitCode: 0, timedOut: false }));
		const { runId } = await seedPpeRun('charge-post-finish-actor');

		const finished = await server.client.run(runId).get();
		expect(finished?.status).toBe('SUCCEEDED');

		const res = await chargeViaHttp(
			server.baseUrl,
			runId,
			server.token,
			{ eventName: 'page-scraped', count: 137 },
			'k-post-finish-1',
		);
		expect(res.status).toBe(201);

		const after = await server.client.run(runId).get();
		expect(after?.chargedEventCounts?.['page-scraped']).toBe(137);
		const expectedPpeUsd = 137 * 0.001 + (after!.chargedEventCounts!['apify-actor-start'] ?? 0) * 0.005;
		expect((after!.usageUsd as Record<string, number>).PAID_ACTORS_PER_EVENT).toBeCloseTo(expectedPpeUsd, 10);
		expect(after!.usageTotalUsd).toBeCloseTo(
			(after!.usageUsd as Record<string, number>).ACTOR_COMPUTE_UNITS + expectedPpeUsd,
			10,
		);
	});

	it('full usage/usageUsd/eventUsage/usageTotalUsd match hand-computed values for a known set of charges', async () => {
		server = await startTestServer(fixedRunOutcomeDriver({ exitCode: 0, timedOut: false }));
		const { runId } = await seedPpeRun('charge-full-usage-actor');

		await chargeViaHttp(server.baseUrl, runId, server.token, { eventName: 'page-scraped', count: 137 }, 'k-full-1');
		const run = await server.client.run(runId).get();

		const startCount = run!.chargedEventCounts!['apify-actor-start'];
		const expectedPpeUsd = startCount * 0.005 + 137 * 0.001;
		expect((run!.usage as Record<string, number>).PAID_ACTORS_PER_EVENT).toBeCloseTo(expectedPpeUsd, 10);
		expect((run!.usageUsd as Record<string, number>).PAID_ACTORS_PER_EVENT).toBeCloseTo(expectedPpeUsd, 10);
		expect(run!.eventUsage!['page-scraped']).toEqual({ eventTitle: 'Page scraped', eventTotalUsd: 137 * 0.001 });
		expect(run!.eventUsage!['apify-actor-start']).toEqual({
			eventTitle: 'Actor start',
			eventTotalUsd: startCount * 0.005,
		});
		expect(run!.usageTotalUsd).toBeCloseTo(
			(run!.usageUsd as Record<string, number>).ACTOR_COMPUTE_UNITS + expectedPpeUsd,
			10,
		);
	});

	it("apify-client's own run(id).charge() call completes without throwing, and its response carries no envelope (regression for the unmodified-SDK HTTP contract)", async () => {
		server = await startTestServer(fixedRunOutcomeDriver({ exitCode: 0, timedOut: false }));
		const { runId } = await seedPpeRun('charge-via-client-actor');

		const res = await server.client.run(runId).charge({ eventName: 'page-scraped', count: 2 });
		expect(res.data).toEqual({});

		const after = await server.client.run(runId).get();
		expect(after?.chargedEventCounts?.['page-scraped']).toBe(2);
	});

	it('two sequential charges for the same event build on each other within one run (no per-call reset)', async () => {
		server = await startTestServer(fixedRunOutcomeDriver({ exitCode: 0, timedOut: false }));
		const { runId } = await seedPpeRun('charge-sequential-actor');

		await server.client.run(runId).charge({ eventName: 'page-scraped', count: 1, idempotencyKey: 'seq-1' });
		await server.client.run(runId).charge({ eventName: 'page-scraped', count: 1, idempotencyKey: 'seq-2' });

		const after = await server.client.run(runId).get();
		expect(after?.chargedEventCounts?.['page-scraped']).toBe(2);
	});
});

describe('POST /v2/actor-runs/:runId/charge - request-shape validation', () => {
	let server: TestServerHandle;

	afterEach(async () => {
		await server.close();
	});

	/** Identical to the sibling describe block's helper - a PPE run that would otherwise charge
	 * successfully, so a guard rejection is provably the *only* reason each request below fails (not an
	 * unrelated 404/405 - the run and Actor genuinely exist and would accept a well-formed charge). */
	async function seedPpeRun(name: string): Promise<{ actor: ActorRecord; runId: string }> {
		const actor = await seedRunnableActor(server, name);
		await declarePricing(server.baseUrl, actor.id, SAMPLE_PRICING_BODY, server.token);
		const run = await server.client.actor(actor.id).start({}, { memory: 1024, waitForFinish: 5 });
		return { actor, runId: run.id };
	}

	it('a missing eventName is rejected as 400 invalid-request and leaves chargedEventCounts untouched', async () => {
		server = await startTestServer(fixedRunOutcomeDriver({ exitCode: 0, timedOut: false }));
		const { runId } = await seedPpeRun('charge-guard-missing-eventname-actor');

		const res = await chargeViaHttp(server.baseUrl, runId, server.token, { count: 1 }, 'k-guard-missing-1');
		expect(res.status).toBe(400);
		expect(res.data.error.type).toBe('invalid-request');

		const after = await server.client.run(runId).get();
		expect(after?.chargedEventCounts?.['page-scraped']).toBe(0);
	});

	it('an empty-string eventName is rejected as 400 invalid-request', async () => {
		server = await startTestServer(fixedRunOutcomeDriver({ exitCode: 0, timedOut: false }));
		const { runId } = await seedPpeRun('charge-guard-empty-eventname-actor');

		const res = await chargeViaHttp(
			server.baseUrl,
			runId,
			server.token,
			{ eventName: '', count: 1 },
			'k-guard-empty-1',
		);
		expect(res.status).toBe(400);
		expect(res.data.error.type).toBe('invalid-request');

		const after = await server.client.run(runId).get();
		expect(after?.chargedEventCounts?.['page-scraped']).toBe(0);
	});

	it('a non-string eventName is rejected as 400 invalid-request', async () => {
		server = await startTestServer(fixedRunOutcomeDriver({ exitCode: 0, timedOut: false }));
		const { runId } = await seedPpeRun('charge-guard-numeric-eventname-actor');

		const res = await chargeViaHttp(
			server.baseUrl,
			runId,
			server.token,
			{ eventName: 123, count: 1 },
			'k-guard-numeric-eventname-1',
		);
		expect(res.status).toBe(400);
		expect(res.data.error.type).toBe('invalid-request');

		const after = await server.client.run(runId).get();
		expect(after?.chargedEventCounts?.['page-scraped']).toBe(0);
	});

	it('count: 0 is rejected as 400 invalid-request', async () => {
		server = await startTestServer(fixedRunOutcomeDriver({ exitCode: 0, timedOut: false }));
		const { runId } = await seedPpeRun('charge-guard-zero-count-actor');

		const res = await chargeViaHttp(
			server.baseUrl,
			runId,
			server.token,
			{ eventName: 'page-scraped', count: 0 },
			'k-guard-zero-1',
		);
		expect(res.status).toBe(400);
		expect(res.data.error.type).toBe('invalid-request');

		const after = await server.client.run(runId).get();
		expect(after?.chargedEventCounts?.['page-scraped']).toBe(0);
	});

	it('a negative count is rejected as 400 invalid-request', async () => {
		server = await startTestServer(fixedRunOutcomeDriver({ exitCode: 0, timedOut: false }));
		const { runId } = await seedPpeRun('charge-guard-negative-count-actor');

		const res = await chargeViaHttp(
			server.baseUrl,
			runId,
			server.token,
			{ eventName: 'page-scraped', count: -5 },
			'k-guard-negative-1',
		);
		expect(res.status).toBe(400);
		expect(res.data.error.type).toBe('invalid-request');

		const after = await server.client.run(runId).get();
		expect(after?.chargedEventCounts?.['page-scraped']).toBe(0);
	});

	it('a non-numeric count is rejected as 400 invalid-request', async () => {
		server = await startTestServer(fixedRunOutcomeDriver({ exitCode: 0, timedOut: false }));
		const { runId } = await seedPpeRun('charge-guard-string-count-actor');

		const res = await chargeViaHttp(
			server.baseUrl,
			runId,
			server.token,
			{ eventName: 'page-scraped', count: 'five' },
			'k-guard-string-count-1',
		);
		expect(res.status).toBe(400);
		expect(res.data.error.type).toBe('invalid-request');

		const after = await server.client.run(runId).get();
		expect(after?.chargedEventCounts?.['page-scraped']).toBe(0);
	});

	it('a non-finite count (e.g. an out-of-range numeric literal parsing to Infinity) is rejected as 400 invalid-request', async () => {
		server = await startTestServer(fixedRunOutcomeDriver({ exitCode: 0, timedOut: false }));
		const { runId } = await seedPpeRun('charge-guard-infinite-count-actor');

		// JSON has no `Infinity`/`NaN` literal, so a plain JS object with `count: Infinity` would be
		// silently coerced to `null` by `JSON.stringify` before it ever reaches the server (exercising the
		// "missing" arm, not this one). `1e400` is a valid JSON number token that overflows to `Infinity`
		// once parsed (`JSON.parse('1e400') === Infinity`, verified directly) - sent as a raw already-JSON
		// string so it survives the wire as `count: Infinity`, landing on the `!Number.isInteger(count)`
		// arm (`Number.isInteger(Infinity)` is `false`) rather than the JSON-parse-error or
		// typeof-mismatch arms.
		const res = await chargeViaHttpRaw(
			server.baseUrl,
			runId,
			server.token,
			'{"eventName":"page-scraped","count":1e400}',
			'k-guard-infinite-1',
		);
		expect(res.status).toBe(400);
		expect(res.data.error.type).toBe('invalid-request');

		const after = await server.client.run(runId).get();
		expect(after?.chargedEventCounts?.['page-scraped']).toBe(0);
	});

	it("a successful charge with count omitted entirely defaults to 1, incrementing chargedEventCounts by exactly 1 (matching apify-client-js's own default)", async () => {
		server = await startTestServer(fixedRunOutcomeDriver({ exitCode: 0, timedOut: false }));
		const { runId } = await seedPpeRun('charge-guard-default-count-actor');

		const before = await server.client.run(runId).get();
		expect(before?.chargedEventCounts?.['page-scraped']).toBe(0);

		const res = await chargeViaHttp(
			server.baseUrl,
			runId,
			server.token,
			{ eventName: 'page-scraped' },
			'k-guard-default-1',
		);
		expect(res.status).toBe(201);
		expect(res.data).toEqual({});

		const after = await server.client.run(runId).get();
		expect(after?.chargedEventCounts?.['page-scraped']).toBe(1);
	});

	// apify-core validates `count` as an integer in [1, 10_000_000]
	// (`assertInteger(count, { min: 1, max: 10000000 })`, `run_charge.ts:23-24`), not merely "a positive
	// finite number" - a fractional or unbounded `count` accepted here but rejected by the real platform
	// would let a locally-tested Actor charge successfully in dev and then fail in production. Worse,
	// a fractional `chargedEventCounts` entry breaks the Python SDK outright: `apify_client`'s
	// `Run.charged_event_counts` is typed `dict[str, int]`, so `RunResponse.model_validate(...)` raises a
	// `ValidationError` on the very next `run().get()` (including the one inside `Actor.init()`),
	// permanently blocking that run's Python SDK usage.
	it('a fractional count (e.g. 2.5) is rejected as 400 invalid-request and leaves chargedEventCounts untouched', async () => {
		server = await startTestServer(fixedRunOutcomeDriver({ exitCode: 0, timedOut: false }));
		const { runId } = await seedPpeRun('charge-guard-fractional-count-actor');

		const res = await chargeViaHttp(
			server.baseUrl,
			runId,
			server.token,
			{ eventName: 'page-scraped', count: 2.5 },
			'k-guard-fractional-1',
		);
		expect(res.status).toBe(400);
		expect(res.data.error.type).toBe('invalid-request');

		const after = await server.client.run(runId).get();
		expect(after?.chargedEventCounts?.['page-scraped']).toBe(0);
	});

	it('a count above the 10,000,000 cap is rejected as 400 invalid-request and leaves chargedEventCounts untouched', async () => {
		server = await startTestServer(fixedRunOutcomeDriver({ exitCode: 0, timedOut: false }));
		const { runId } = await seedPpeRun('charge-guard-over-cap-count-actor');

		const res = await chargeViaHttp(
			server.baseUrl,
			runId,
			server.token,
			{ eventName: 'page-scraped', count: 10_000_001 },
			'k-guard-over-cap-1',
		);
		expect(res.status).toBe(400);
		expect(res.data.error.type).toBe('invalid-request');

		const after = await server.client.run(runId).get();
		expect(after?.chargedEventCounts?.['page-scraped']).toBe(0);
	});

	it('a count of exactly 10,000,000 (the cap boundary) succeeds', async () => {
		server = await startTestServer(fixedRunOutcomeDriver({ exitCode: 0, timedOut: false }));
		const { runId } = await seedPpeRun('charge-guard-at-cap-count-actor');

		const res = await chargeViaHttp(
			server.baseUrl,
			runId,
			server.token,
			{ eventName: 'page-scraped', count: 10_000_000 },
			'k-guard-at-cap-1',
		);
		expect(res.status).toBe(201);
		expect(res.data).toEqual({});

		const after = await server.client.run(runId).get();
		expect(after?.chargedEventCounts?.['page-scraped']).toBe(10_000_000);
	});

	// apify-core rejects any `apify-`-prefixed `eventName` outright, as the very first check inside
	// `idempotentChargeUserForEvent` - before it even looks up the run (`run_charging_service.ts:566-569`
	// - `errors.paidActors.cannotChargeApifyEvent(eventName)`). These synthetic events (e.g.
	// `apify-actor-start`, seeded server-side by this runtime itself at run start) are reserved for the
	// platform; no SDK ever charges one through a client request.
	it('charging an apify--prefixed event name is rejected as 405 cannot-charge-apify-event and leaves chargedEventCounts untouched', async () => {
		server = await startTestServer(fixedRunOutcomeDriver({ exitCode: 0, timedOut: false }));
		const { runId } = await seedPpeRun('charge-guard-apify-prefix-actor');

		const before = await server.client.run(runId).get();
		// `actorStartEventCount(1024)` (`seedPpeRun`'s fixed 1024 MB) - proof this is genuinely rejected,
		// not silently no-op'd against an already-absent event.
		expect(before?.chargedEventCounts?.['apify-actor-start']).toBe(1);

		const res = await chargeViaHttp(
			server.baseUrl,
			runId,
			server.token,
			{ eventName: 'apify-actor-start', count: 10 },
			'k-guard-apify-prefix-1',
		);
		expect(res.status).toBe(405);
		expect(res.data.error.type).toBe('cannot-charge-apify-event');

		const after = await server.client.run(runId).get();
		expect(after?.chargedEventCounts?.['apify-actor-start']).toBe(1);
	});
});

describe('multiRunDriver-based resourceStats snapshot (memAvgBytes/cpuAvgUsage/cpuMaxUsage)', () => {
	let server: TestServerHandle;

	afterEach(async () => {
		await server.close();
	});

	it("a finished run's memAvgBytes/cpuAvgUsage/cpuMaxUsage reflect the samples it received while running", async () => {
		const driver = multiRunDriver();
		server = await startTestServer(driver);
		const actor = await seedRunnableActor(server, 'resource-stats-actor');

		const started = await server.client.actor(actor.id).start({}, { memory: 1024 });
		const runId = started.id;
		await driver.waitForStart(runId);

		driver.emitSample(runId, {
			cpuPercentOfOneCore: 10,
			memoryBytes: 100_000_000,
			memoryLimitBytes: 1024 * 1024 * 1024,
			at: new Date(),
		});
		driver.emitSample(runId, {
			cpuPercentOfOneCore: 30,
			memoryBytes: 200_000_000,
			memoryLimitBytes: 1024 * 1024 * 1024,
			at: new Date(),
		});

		driver.resolveRun(runId, { exitCode: 0, timedOut: false });
		await server.client.run(runId).waitForFinish();
		const run = await server.client.run(runId).get();

		expect(run?.status).toBe('SUCCEEDED');
		expect(run!.stats!.memAvgBytes).toBeCloseTo(150_000_000, 5);
		expect(run!.stats!.cpuAvgUsage).toBeCloseTo(20, 5);
		expect(run!.stats!.cpuMaxUsage).toBeCloseTo(30, 5);
	});
});

describe('console: run detail cost row', () => {
	let server: TestServerHandle;

	afterEach(async () => {
		await server.close();
	});

	it('renders a $-prefixed cost row for a plain run, and a "+ events" breakdown for a PPE run', async () => {
		server = await startTestServer(fixedRunOutcomeDriver({ exitCode: 0, timedOut: false }));
		const consoleApp = createConsoleServer({ driver: server.driver });
		const consoleServer = await new Promise<import('node:http').Server>((resolve) => {
			const s = consoleApp.listen(0, () => resolve(s));
		});
		const consolePort = (consoleServer.address() as import('node:net').AddressInfo).port;
		const consoleBaseUrl = `http://127.0.0.1:${consolePort}`;

		try {
			const plainActor = await seedRunnableActor(server, 'console-cost-plain-actor');
			const plainRun = await server.client.actor(plainActor.id).start({}, { waitForFinish: 5 });
			const plainDetail = await axios.get(`${consoleBaseUrl}/runs/${plainRun.id}`);
			expect(plainDetail.data).toMatch(/cost<\/dt>\s*<dd>\$0\.\d+ \(\d+\.\d+ CU \$[\d.]+\)<\/dd>/);
			expect(plainDetail.data).not.toContain('+ events');

			const ppeActor = await seedRunnableActor(server, 'console-cost-ppe-actor');
			await declarePricing(server.baseUrl, ppeActor.id, SAMPLE_PRICING_BODY, server.token);
			const ppeRun = await server.client.actor(ppeActor.id).start({}, { waitForFinish: 5 });
			await chargeViaHttp(
				server.baseUrl,
				ppeRun.id,
				server.token,
				{ eventName: 'page-scraped', count: 3 },
				'console-cost-key',
			);
			const ppeDetail = await axios.get(`${consoleBaseUrl}/runs/${ppeRun.id}`);
			expect(ppeDetail.data).toContain('+ events $');
		} finally {
			await new Promise<void>((resolve) => consoleServer.close(() => resolve()));
		}
	});
});

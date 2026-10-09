/**
 * Pay-per-event charging and the run cost estimate (`actor-driver.md`), end to end over a real
 * `apify-client`: pricing on the Actor, a run's charges and its maximum, the charge endpoint's
 * idempotency and errors, the estimate on the run object, and the console's pricing and usage views.
 */
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import axios from 'axios';

import {
	fixedRunOutcomeDriver,
	restartTrackingDriver,
	startTestServer,
	type RestartTrackingDriver,
	type TestServerHandle,
} from './helpers/test-server.js';
import { createConsoleServer } from '../../src/console/server.js';
import { getRegistries } from '../../src/storage/registries.js';
import { generateId } from '../../src/storage/ids.js';
import { recordTaggedBuild, updateActor } from '../../src/services/actors.js';
import { subscribeEvents } from '../../src/services/events-channel.js';
import { isTerminalJobStatus } from '../../src/services/job-status.js';
import type { ActorRecord, BuildRecord } from '../../src/storage/entities.js';

const PAGE_EVENT = 'page-scraped';
const PAGE_PRICE_USD = 0.02;

/** A pay-per-event pricing with one flat-priced event, one tiered one, and the synthetic start event. */
const PPE_PRICING = [
	{
		pricingModel: 'PAY_PER_EVENT',
		pricingPerEvent: {
			actorChargeEvents: {
				[PAGE_EVENT]: {
					eventTitle: 'Page scraped',
					eventDescription: 'One page',
					eventPriceUsd: PAGE_PRICE_USD,
				},
				'premium-page': {
					eventTitle: 'Premium page',
					eventTieredPricingUsd: {
						BRONZE: { tieredEventPriceUsd: 0.05 },
						SILVER: { tieredEventPriceUsd: 0.04 },
					},
				},
				'apify-actor-start': { eventTitle: 'Actor start', eventPriceUsd: 0.005, isOneTimeEvent: true },
			},
		},
	},
];

/** Same, plus the synthetic per-dataset-item event. */
const PPE_PRICING_WITH_DATASET_ITEMS = [
	{
		pricingModel: 'PAY_PER_EVENT',
		pricingPerEvent: {
			actorChargeEvents: {
				[PAGE_EVENT]: { eventTitle: 'Page scraped', eventPriceUsd: PAGE_PRICE_USD },
				'apify-default-dataset-item': { eventTitle: 'Dataset item', eventPriceUsd: 0.001 },
			},
		},
	},
];

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

/** An Actor with the given pricing (set through the real `PUT /v2/actors/:actorId`) and a runnable build. */
async function seedRunnableActor(server: TestServerHandle, name: string, pricingInfos?: unknown): Promise<string> {
	const created = await server.client.actors().create({ name });
	if (pricingInfos) await server.client.actor(created.id).update({ pricingInfos } as never);
	const actor = (await getRegistries().actors.get(created.id))!;
	const build = await seedSucceededBuild(actor);
	await updateActor(actor.id, (current) => recordTaggedBuild(current, 'latest', build.id, build.buildNumber));
	return actor.id;
}

/** A run of a pay-per-event Actor, kept `RUNNING` by the deferred driver until the test resolves it. */
async function startLiveRun(
	server: TestServerHandle,
	driver: RestartTrackingDriver,
	actorId: string,
	options: Record<string, unknown> = {},
): Promise<string> {
	const started = await server.client.actor(actorId).start({}, options as never);
	await driver.waitForStartCalls(driver.startCalls.length + 1);
	return started.id;
}

async function finishRun(server: TestServerHandle, driver: RestartTrackingDriver, runId: string): Promise<void> {
	const call = driver.startCalls.find((c) => c.ctx.runId === runId)!;
	call.resolve({ exitCode: 0, timedOut: false });
	await server.client.run(runId).waitForFinish({ waitSecs: 5 });
}

describe('pay-per-event: pricing on the Actor', () => {
	let server: TestServerHandle;

	beforeEach(async () => {
		server = await startTestServer();
	});

	afterEach(async () => {
		await server.close();
	});

	it('refuses pricingInfos while the Actor is being created, takes them on update, and returns the normalized array', async () => {
		// The platform never accepts pricing on the call that creates an Actor, only on a later update.
		await expect(
			server.client.actors().create({ name: 'priced-on-create', pricingInfos: PPE_PRICING } as never),
		).rejects.toMatchObject({ statusCode: 403, type: 'operation-not-allowed' });

		const created = await server.client.actors().create({ name: 'priced-on-create' });
		await server.client.actor(created.id).update({ pricingInfos: PPE_PRICING } as never);
		const fetched = (await server.client.actor(created.id).get()) as unknown as { pricingInfos: unknown[] };
		expect(fetched.pricingInfos).toHaveLength(1);
		const info = fetched.pricingInfos[0] as Record<string, unknown>;
		expect(info.pricingModel).toBe('PAY_PER_EVENT');
		expect(info.apifyMarginPercentage).toBe(0);
		// apify-client parses every `*At` field into a `Date`; over the wire they are ISO-8601 strings.
		expect(new Date(info.createdAt as string).getTime()).not.toBeNaN();
		expect(new Date(info.startedAt as string).getTime()).not.toBeNaN();
		const events = (info.pricingPerEvent as { actorChargeEvents: Record<string, Record<string, unknown>> })
			.actorChargeEvents;
		expect(events[PAGE_EVENT]).toEqual({
			eventTitle: 'Page scraped',
			eventDescription: 'One page',
			eventPriceUsd: PAGE_PRICE_USD,
		});
		expect(events['premium-page']?.eventTieredPricingUsd).toBeDefined();

		// Free again means appending a FREE entry; dropping the history is refused.
		await expect(server.client.actor(created.id).update({ pricingInfos: [] } as never)).rejects.toMatchObject({
			statusCode: 400,
			type: 'cannot-remove-pricing-info',
		});
		const freed = (await server.client.actor(created.id).update({
			pricingInfos: [...fetched.pricingInfos, { pricingModel: 'FREE', startedAt: '2030-01-01T00:00:00.000Z' }],
		} as never)) as unknown as { pricingInfos: unknown[] };
		expect(freed.pricingInfos).toHaveLength(2);

		const unpriced = (await server.client.actors().create({ name: 'unpriced' })) as unknown as {
			pricingInfos: unknown[];
		};
		expect(unpriced.pricingInfos).toEqual([]);
	});

	it('rejects an invalid pricingInfos with 400 invalid-request naming the problem, leaving the stored pricing untouched', async () => {
		const created = await server.client.actors().create({ name: 'badly-priced' });
		await server.client.actor(created.id).update({ pricingInfos: PPE_PRICING } as never);
		await expect(
			server.client
				.actor(created.id)
				.update({ pricingInfos: [{ pricingModel: 'PRICE_PER_DATASET_ITEM' }] } as never),
		).rejects.toMatchObject({
			statusCode: 400,
			type: 'invalid-request',
			message: expect.stringMatching(/not emulated/),
		});
		await expect(
			server.client.actor(created.id).update({ pricingInfos: 'PAY_PER_EVENT' } as never),
		).rejects.toMatchObject({
			statusCode: 400,
			type: 'invalid-request',
		});
		const fetched = (await server.client.actor(created.id).get()) as unknown as { pricingInfos: unknown[] };
		expect(fetched.pricingInfos).toHaveLength(1);
	});
});

describe('pay-per-event: runs and charging', () => {
	let server: TestServerHandle;
	let driver: RestartTrackingDriver;

	beforeEach(async () => {
		driver = restartTrackingDriver();
		server = await startTestServer(driver);
	});

	afterEach(async () => {
		await server.close();
	});

	it('a run of a priced Actor carries the resolved pricingInfo (tiered prices at the BRONZE tier), zeroed chargedEventCounts with the start event pre-charged, the cap, and the env var', async () => {
		const actorId = await seedRunnableActor(server, 'ppe-actor', PPE_PRICING);
		const runId = await startLiveRun(server, driver, actorId, { memory: 2048, maxTotalChargeUsd: 1.5 });

		const run = (await server.client.run(runId).get()) as unknown as Record<string, unknown>;
		const pricingInfo = run.pricingInfo as {
			pricingModel: string;
			pricingPerEvent: { actorChargeEvents: Record<string, Record<string, unknown>> };
		};
		expect(pricingInfo.pricingModel).toBe('PAY_PER_EVENT');
		expect(pricingInfo.pricingPerEvent.actorChargeEvents['premium-page']).toEqual({
			eventTitle: 'Premium page',
			eventDescription: '',
			eventPriceUsd: 0.05,
		});
		expect(pricingInfo.pricingPerEvent.actorChargeEvents[PAGE_EVENT]?.eventPriceUsd).toBe(PAGE_PRICE_USD);
		// 2048 MB = 2 whole gigabytes -> the synthetic start event is pre-charged twice.
		expect(run.chargedEventCounts).toEqual({ [PAGE_EVENT]: 0, 'premium-page': 0, 'apify-actor-start': 2 });
		expect((run.options as { maxTotalChargeUsd?: number }).maxTotalChargeUsd).toBe(1.5);
		expect((run.eventUsage as Record<string, { eventTotalUsd: number }>)['apify-actor-start']?.eventTotalUsd).toBe(
			0.01,
		);

		// A grant the platform accepts draws no warning, only the pre-charge line.
		const log = await server.client.log(runId).get();
		expect(log).not.toContain('Warning: the requested memory');
		expect(log).toContain("Pre-charged 2 'apify-actor-start' event(s), $0.01 in total, for 2048 MB of memory");

		const env = driver.startCalls[0]!.ctx.env;
		expect(env.ACTOR_MAX_TOTAL_CHARGE_USD).toBe('1.5');
		// The SDKs must fetch the run object for pricing, never read stale env copies (`services/runs.ts`).
		expect(Object.hasOwn(env, 'APIFY_ACTOR_PRICING_INFO')).toBe(false);
		expect(Object.hasOwn(env, 'APIFY_CHARGED_ACTOR_EVENT_COUNTS')).toBe(false);

		await finishRun(server, driver, runId);
	});

	it("warns about memory the platform would refuse, and says what the run's start pre-charge covers", async () => {
		const actorId = await seedRunnableActor(server, 'odd-memory-actor', PPE_PRICING);
		// 8096 MB is between two steps: the platform refuses it outright, this runtime runs it and
		// pre-charges for the 7 whole gigabytes it covers.
		const runId = await startLiveRun(server, driver, actorId, { memory: 8096 });

		const log = await server.client.log(runId).get();
		expect(log).toContain('8096 MB is not a power of two');
		expect(log).toContain("Pre-charged 7 'apify-actor-start' event(s), $0.035 in total, for 8096 MB of memory");

		const run = (await server.client.run(runId).get()) as unknown as Record<string, unknown>;
		expect((run.chargedEventCounts as Record<string, number>)['apify-actor-start']).toBe(7);

		await finishRun(server, driver, runId);
	});

	it('a run of an unpriced Actor has no pricingInfo, chargedEventCounts, or maxTotalChargeUsd, and no cap env var', async () => {
		const actorId = await seedRunnableActor(server, 'free-actor');
		const runId = await startLiveRun(server, driver, actorId);
		const run = (await server.client.run(runId).get()) as unknown as Record<string, unknown>;
		expect(run).not.toHaveProperty('pricingInfo');
		expect(run).not.toHaveProperty('chargedEventCounts');
		expect(run).not.toHaveProperty('eventUsage');
		expect(run.options).toEqual({ build: 'latest', memoryMbytes: 1024, timeoutSecs: 300, diskMbytes: 2048 });
		// Present but empty without a cap, as on the platform.
		expect(driver.startCalls[0]!.ctx.env.ACTOR_MAX_TOTAL_CHARGE_USD).toBe('');
		await finishRun(server, driver, runId);
	});

	it('a pricing change on the Actor does not reprice a run already created', async () => {
		const actorId = await seedRunnableActor(server, 'repriced-actor', PPE_PRICING);
		const runId = await startLiveRun(server, driver, actorId);
		const current = (await server.client.actor(actorId).get()) as unknown as {
			pricingInfos: Array<{ startedAt: string | Date }>;
		};
		// Effective at once (a millisecond after the entry it follows), so the run is only unrepriced
		// because it resolved its pricing when it was created, not because the change is still pending.
		const freeFrom = new Date(new Date(current.pricingInfos[0]!.startedAt).getTime() + 1).toISOString();
		await server.client.actor(actorId).update({
			pricingInfos: [...current.pricingInfos, { pricingModel: 'FREE', startedAt: freeFrom }],
		} as never);
		const run = (await server.client.run(runId).get()) as unknown as Record<string, unknown>;
		expect((run.pricingInfo as { pricingModel: string }).pricingModel).toBe('PAY_PER_EVENT');
		await finishRun(server, driver, runId);
	});

	it("POST .../charge via the client's run.charge(): 201 with an empty body, counts add up, and a repeated idempotency key is replayed, not charged twice", async () => {
		const actorId = await seedRunnableActor(server, 'charging-actor', PPE_PRICING);
		const runId = await startLiveRun(server, driver, actorId);
		const runClient = server.client.run(runId);

		const first = await runClient.charge({ eventName: PAGE_EVENT, count: 3, idempotencyKey: 'key-1' });
		expect(first.status).toBe(201);
		expect(first.data).toEqual({});

		const replay = await runClient.charge({ eventName: PAGE_EVENT, count: 3, idempotencyKey: 'key-1' });
		expect(replay.status).toBe(201);
		await runClient.charge({ eventName: PAGE_EVENT, idempotencyKey: 'key-2' }); // count defaults to 1
		await runClient.charge({ eventName: 'premium-page', count: 2, idempotencyKey: 'key-3' });

		const run = (await runClient.get()) as unknown as Record<string, unknown>;
		expect(run.chargedEventCounts).toEqual({ [PAGE_EVENT]: 4, 'premium-page': 2, 'apify-actor-start': 1 });
		const eventUsage = run.eventUsage as Record<string, { eventTitle: string; eventTotalUsd: number }>;
		expect(eventUsage[PAGE_EVENT]).toEqual({ eventTitle: 'Page scraped', eventTotalUsd: 0.08 });
		expect(eventUsage['premium-page']).toEqual({ eventTitle: 'Premium page', eventTotalUsd: 0.1 });
		expect(eventUsage['apify-actor-start']).toEqual({ eventTitle: 'Actor start', eventTotalUsd: 0.005 });
		// Platform usage (a few milliseconds of a 1 GB run) is negligible; the total is dominated by the events.
		expect(run.usageTotalUsd as number).toBeGreaterThanOrEqual(0.185);
		expect(run.usageTotalUsd as number).toBeLessThan(0.186);

		await finishRun(server, driver, runId);
	});

	it("charging is refused with the platform's error types: apify- events (405), an unpriced event (404), a run that is not pay-per-event (405), and a missing idempotency-key header (400)", async () => {
		const pricedActorId = await seedRunnableActor(server, 'refusals-actor', PPE_PRICING);
		const pricedRunId = await startLiveRun(server, driver, pricedActorId);
		const freeActorId = await seedRunnableActor(server, 'refusals-free-actor');
		const freeRunId = await startLiveRun(server, driver, freeActorId);

		await expect(
			server.client.run(pricedRunId).charge({ eventName: 'apify-actor-start', idempotencyKey: 'k' }),
		).rejects.toMatchObject({ statusCode: 405, type: 'cannot-charge-apify-event' });
		await expect(
			server.client.run(pricedRunId).charge({ eventName: 'no-such-event', idempotencyKey: 'k' }),
		).rejects.toMatchObject({
			statusCode: 404,
			type: 'record-not-found',
			message: 'Pricing for the event no-such-event',
		});
		await expect(
			server.client.run(freeRunId).charge({ eventName: PAGE_EVENT, idempotencyKey: 'k' }),
		).rejects.toMatchObject({
			statusCode: 405,
			type: 'cannot-charge-non-pay-per-event-actor',
		});
		await expect(
			server.client.run('0000000000000000X').charge({ eventName: PAGE_EVENT, idempotencyKey: 'k' }),
		).rejects.toMatchObject({
			statusCode: 404,
			type: 'record-not-found',
		});

		const noHeader = await axios.post(
			`${server.baseUrl}/v2/actor-runs/${pricedRunId}/charge`,
			{ eventName: PAGE_EVENT, count: 1 },
			{ headers: { Authorization: `Bearer ${server.token}` }, validateStatus: () => true },
		);
		expect(noHeader.status).toBe(400);
		expect(noHeader.data.error.type).toBe('invalid-request');
		expect(noHeader.data.error.message).toMatch(/idempotency-key/);

		const badCount = await axios.post(
			`${server.baseUrl}/v2/actor-runs/${pricedRunId}/charge`,
			{ eventName: PAGE_EVENT, count: 0 },
			{
				headers: { Authorization: `Bearer ${server.token}`, 'idempotency-key': 'k' },
				validateStatus: () => true,
			},
		);
		expect(badCount.status).toBe(400);

		// None of the refusals changed anything.
		const run = (await server.client.run(pricedRunId).get()) as unknown as Record<string, unknown>;
		expect(run.chargedEventCounts).toEqual({ [PAGE_EVENT]: 0, 'premium-page': 0, 'apify-actor-start': 1 });

		await finishRun(server, driver, pricedRunId);
		await finishRun(server, driver, freeRunId);
	});

	it('another user cannot charge a run they do not own (404, as for every other owner-scoped route)', async () => {
		const actorId = await seedRunnableActor(server, 'foreign-charge-actor', PPE_PRICING);
		const runId = await startLiveRun(server, driver, actorId);
		const response = await axios.post(
			`${server.baseUrl}/v2/actor-runs/${runId}/charge`,
			{ eventName: PAGE_EVENT, count: 1 },
			{ headers: { Authorization: 'Bearer someone-else', 'idempotency-key': 'k' }, validateStatus: () => true },
		);
		expect(response.status).toBe(404);
		await finishRun(server, driver, runId);
	});

	it('reaching maxTotalChargeUsd stamps chargingStoppedAt once, gracefully aborts the run with a status message naming the cap, and later charges are still recorded without a second abort', async () => {
		const actorId = await seedRunnableActor(server, 'capped-actor', PPE_PRICING);
		// The start event pre-charges $0.005; two pages ($0.04) stay under $0.05, the third crosses it.
		const runId = await startLiveRun(server, driver, actorId, { maxTotalChargeUsd: 0.05 });
		const frames: string[] = [];
		const unsubscribe = subscribeEvents(runId, (frame) => frames.push(frame));
		const runClient = server.client.run(runId);

		await runClient.charge({ eventName: PAGE_EVENT, count: 2, idempotencyKey: 'under' });
		let run = (await runClient.get()) as unknown as Record<string, unknown>;
		expect(run.status).toBe('RUNNING');
		expect(run).not.toHaveProperty('chargingStoppedAt');
		expect(frames).toEqual([]);

		await runClient.charge({ eventName: PAGE_EVENT, count: 1, idempotencyKey: 'over' });
		run = (await runClient.get()) as unknown as Record<string, unknown>;
		expect(run.status).toBe('ABORTING');
		expect(new Date(run.chargingStoppedAt as string).getTime()).not.toBeNaN();
		expect(run.statusMessage).toMatch(/maximum total charge of \$0\.05 was reached/);
		expect(run.isStatusMessageTerminal).toBe(true);
		expect(frames.map((f) => JSON.parse(f).name)).toEqual(['aborting', 'persistState']);
		// Graceful: the container is given its window, not killed on the spot.
		expect(driver.abortRunCalls).toEqual([]);
		expect(await server.client.run(runId).log().get()).toMatch(/maximum total charge/);

		// The SDK deliberately overshoots by one event once at the cap; the charge is recorded, nothing else changes.
		const stoppedAt = run.chargingStoppedAt;
		await runClient.charge({ eventName: PAGE_EVENT, count: 5, idempotencyKey: 'after' });
		run = (await runClient.get()) as unknown as Record<string, unknown>;
		expect((run.chargedEventCounts as Record<string, number>)[PAGE_EVENT]).toBe(8);
		expect(String(run.chargingStoppedAt)).toBe(String(stoppedAt));
		expect(run.status).toBe('ABORTING');
		expect(frames).toHaveLength(2);

		// The Actor honours the aborting frame and exits: the run ends ABORTED, still with its reason.
		await finishRun(server, driver, runId);
		run = (await runClient.get()) as unknown as Record<string, unknown>;
		expect(run.status).toBe('ABORTED');
		expect(run.statusMessage).toMatch(/maximum total charge/);
		unsubscribe();
	});

	it('a maxTotalChargeUsd of 0 means no cap, and a negative one is rejected on run start', async () => {
		const actorId = await seedRunnableActor(server, 'uncapped-actor', PPE_PRICING);
		const runId = await startLiveRun(server, driver, actorId, { maxTotalChargeUsd: 0 });
		await server.client.run(runId).charge({ eventName: PAGE_EVENT, count: 1000, idempotencyKey: 'k' });
		const run = (await server.client.run(runId).get()) as unknown as Record<string, unknown>;
		expect(run.status).toBe('RUNNING');
		expect((run.options as { maxTotalChargeUsd: number }).maxTotalChargeUsd).toBe(0);
		await finishRun(server, driver, runId);

		// apify-client refuses a negative cap itself, so the server-side check needs a raw request.
		const negative = await axios.post(
			`${server.baseUrl}/v2/actors/${actorId}/runs?maxTotalChargeUsd=-1`,
			{},
			{ headers: { Authorization: `Bearer ${server.token}` }, validateStatus: () => true },
		);
		expect(negative.status).toBe(400);
		expect(negative.data.error.type).toBe('invalid-request');
	});

	it('every item pushed to the default dataset of a run priced with apify-default-dataset-item counts as one charge, whether pushed by dataset id or through the run alias; other datasets never do', async () => {
		const actorId = await seedRunnableActor(server, 'dataset-items-actor', PPE_PRICING_WITH_DATASET_ITEMS);
		const runId = await startLiveRun(server, driver, actorId);
		const run = await server.client.run(runId).get();

		await server.client.dataset(run!.defaultDatasetId).pushItems([{ a: 1 }, { a: 2 }, { a: 3 }]);
		await server.client.run(runId).dataset().pushItems({ a: 4 });
		const other = await server.client.datasets().getOrCreate('unrelated');
		await server.client.dataset(other.id).pushItems([{ b: 1 }, { b: 2 }]);

		const charged = (await server.client.run(runId).get()) as unknown as Record<string, unknown>;
		expect(charged.chargedEventCounts).toEqual({ [PAGE_EVENT]: 0, 'apify-default-dataset-item': 4 });
		expect(
			(charged.eventUsage as Record<string, { eventTotalUsd: number }>)['apify-default-dataset-item']
				?.eventTotalUsd,
		).toBe(0.004);

		// A run whose pricing has no such event is unaffected by pushes to its default dataset.
		const plainActorId = await seedRunnableActor(server, 'no-dataset-event-actor', PPE_PRICING);
		const plainRunId = await startLiveRun(server, driver, plainActorId);
		const plainRun = await server.client.run(plainRunId).get();
		await server.client.dataset(plainRun!.defaultDatasetId).pushItems([{ a: 1 }]);
		const plain = (await server.client.run(plainRunId).get()) as unknown as Record<string, unknown>;
		expect(plain.chargedEventCounts).toEqual({ [PAGE_EVENT]: 0, 'premium-page': 0, 'apify-actor-start': 1 });

		await finishRun(server, driver, runId);
		await finishRun(server, driver, plainRunId);
	});

	it('the dataset-item event counts toward the cap too, and pushes after the run ends are no longer attributed', async () => {
		const actorId = await seedRunnableActor(server, 'dataset-cap-actor', PPE_PRICING_WITH_DATASET_ITEMS);
		const runId = await startLiveRun(server, driver, actorId, { maxTotalChargeUsd: 0.003 });
		const run = await server.client.run(runId).get();
		await server.client.dataset(run!.defaultDatasetId).pushItems([{ a: 1 }, { a: 2 }, { a: 3 }]);
		let current = (await server.client.run(runId).get()) as unknown as Record<string, unknown>;
		expect(current.status).toBe('ABORTING');
		expect(current.statusMessage).toMatch(/\$0\.003/);

		await finishRun(server, driver, runId);
		await server.client.dataset(run!.defaultDatasetId).pushItems([{ a: 4 }]);
		current = (await server.client.run(runId).get()) as unknown as Record<string, unknown>;
		expect((current.chargedEventCounts as Record<string, number>)['apify-default-dataset-item']).toBe(3);
	});
});

describe('run usage estimate', () => {
	let server: TestServerHandle;

	afterEach(async () => {
		await server.close();
	});

	it('a finished run reports compute units from its memory and duration, priced at $0.20 per unit, with the platform stats fields', async () => {
		server = await startTestServer(fixedRunOutcomeDriver({ exitCode: 0, timedOut: false }));
		const actorId = await seedRunnableActor(server, 'usage-actor');
		const run = (await server.client
			.actor(actorId)
			.start({ hello: 'world' }, { memory: 2048, waitForFinish: 5 })) as unknown as Record<string, unknown>;
		expect(run.status).toBe('SUCCEEDED');

		const stats = run.stats as Record<string, number>;
		// `new Date(...)` rather than `Date.parse`: apify-client has already turned both into `Date`s.
		const durationMillis =
			new Date(run.finishedAt as string).getTime() - new Date(run.startedAt as string).getTime();
		expect(stats.durationMillis).toBe(durationMillis);
		expect(stats.runTimeSecs).toBe(durationMillis / 1000);
		// 2 GB for `durationMillis` of an hour.
		expect(stats.computeUnits).toBeCloseTo((2 * durationMillis) / 3_600_000, 12);
		expect(stats.inputBodyLen).toBe(JSON.stringify({ hello: 'world' }).length);
		expect(stats.metamorph).toBe(0);
		expect(stats.migrationCount).toBe(0);
		// No container was ever sampled by this driver, so no telemetry fields are invented.
		expect(stats).not.toHaveProperty('memAvgBytes');

		const usage = run.usage as Record<string, number>;
		const usageUsd = run.usageUsd as Record<string, number>;
		expect(usage.ACTOR_COMPUTE_UNITS).toBe(stats.computeUnits);
		// The runtime's own rounding rather than a tolerance - see the same assertion in the e2e test.
		expect(usageUsd.ACTOR_COMPUTE_UNITS).toBe(Number((stats.computeUnits! * 0.2).toFixed(6)));
		expect(run.usageTotalUsd).toBe(usageUsd.ACTOR_COMPUTE_UNITS);
		expect(run).not.toHaveProperty('eventUsage');

		// The same figures on the list endpoint.
		const listed = (await server.client.actor(actorId).runs().list()).items[0] as unknown as Record<
			string,
			unknown
		>;
		expect(listed.usageTotalUsd).toBe(run.usageTotalUsd);
	});

	it("a live run's stats carry the sampled CPU/memory telemetry and grow with time; once the run ends the final figures stay on the record", async () => {
		const driver = restartTrackingDriver();
		server = await startTestServer(driver);
		const actorId = await seedRunnableActor(server, 'telemetry-actor');
		const runId = await startLiveRun(server, driver, actorId);
		const call = driver.startCalls[0]!;

		const before = (await server.client.run(runId).get()) as unknown as { stats: Record<string, number> };
		expect(before.stats).not.toHaveProperty('memAvgBytes');

		call.onSample?.({ cpuPercentOfOneCore: 10, memoryBytes: 100, memoryLimitBytes: 1024 ** 3, at: new Date() });
		call.onSample?.({ cpuPercentOfOneCore: 30, memoryBytes: 300, memoryLimitBytes: 1024 ** 3, at: new Date() });
		const live = (await server.client.run(runId).get()) as unknown as { stats: Record<string, number> };
		expect(live.stats.memAvgBytes).toBe(200);
		expect(live.stats.memMaxBytes).toBe(300);
		expect(live.stats.memCurrentBytes).toBe(300);
		expect(live.stats.cpuAvgUsage).toBe(20);
		expect(live.stats.cpuMaxUsage).toBe(30);
		expect(live.stats.cpuCurrentUsage).toBe(30);
		expect(live.stats.computeUnits).toBeGreaterThan(0);
		expect(live.stats.computeUnits).toBeGreaterThanOrEqual(before.stats.computeUnits!);

		// The sampled figures are written before the status turns terminal, the same guarantee the log
		// flush has: whoever sees the run finish reads the record next, and must not find them missing.
		const firstTerminalRead = (async () => {
			for (;;) {
				const current = await getRegistries().runs.get(runId);
				if (current && isTerminalJobStatus(current.status)) return current;
				await new Promise((resolve) => setImmediate(resolve));
			}
		})();
		await finishRun(server, driver, runId);
		expect((await firstTerminalRead).stats?.memAvgBytes).toBe(200);

		const finished = (await server.client.run(runId).get()) as unknown as { stats: Record<string, number> };
		expect(finished.stats.memAvgBytes).toBe(200);
		expect(finished.stats.cpuMaxUsage).toBe(30);
		const stored = await getRegistries().runs.get(runId);
		expect(stored?.stats?.memAvgBytes).toBe(200);
	});
});

describe('console: pricing form and usage section', () => {
	let server: TestServerHandle;
	let driver: RestartTrackingDriver;
	let consoleServer: Server;
	let consoleBaseUrl: string;

	beforeEach(async () => {
		driver = restartTrackingDriver();
		server = await startTestServer(driver);
		const app = createConsoleServer({ driver: server.driver });
		consoleServer = await new Promise((resolve) => {
			const s = app.listen(0, () => resolve(s));
		});
		consoleBaseUrl = `http://127.0.0.1:${(consoleServer.address() as AddressInfo).port}`;
	});

	afterEach(async () => {
		await new Promise<void>((resolve) => consoleServer.close(() => resolve()));
		await server.close();
	});

	it('the Actor detail view shows the effective pricing and its form sets it with the same validation as the API', async () => {
		const actor = await server.client.actors().create({ name: 'console-priced-actor' });

		const free = await axios.get(`${consoleBaseUrl}/actors/${actor.id}`);
		expect(free.data).toContain('<h2>Pricing</h2>');
		expect(free.data).toContain('the Actor is free');

		const saved = await axios.post(
			`${consoleBaseUrl}/actors/${actor.id}/pricing`,
			new URLSearchParams({ pricingInfos: JSON.stringify(PPE_PRICING) }),
			{ maxRedirects: 0, validateStatus: () => true },
		);
		expect(saved.status).toBe(302);
		expect(saved.headers.location).toBe(`/actors/${actor.id}`);
		const priced = await axios.get(`${consoleBaseUrl}/actors/${actor.id}`);
		expect(priced.data).toContain('premium-page');
		expect(priced.data).toContain('$0.05 (BRONZE tier)');
		const viaApi = (await server.client.actor(actor.id).get()) as unknown as { pricingInfos: unknown[] };
		expect(viaApi.pricingInfos).toHaveLength(1);

		const rejected = await axios.post(
			`${consoleBaseUrl}/actors/${actor.id}/pricing`,
			new URLSearchParams({ pricingInfos: JSON.stringify([{ pricingModel: 'FLAT_PRICE_PER_MONTH' }]) }),
			{ maxRedirects: 0, validateStatus: () => true },
		);
		expect(rejected.status).toBe(302);
		expect(rejected.headers.location).toMatch(/pricingError=.*not\+emulated|pricingError=.*not%20emulated/);
		const notJson = await axios.post(
			`${consoleBaseUrl}/actors/${actor.id}/pricing`,
			new URLSearchParams({ pricingInfos: '{oops' }),
			{
				maxRedirects: 0,
				validateStatus: () => true,
			},
		);
		expect(notJson.headers.location).toMatch(/pricingError=Not\+valid\+JSON|pricingError=Not%20valid%20JSON/);
		const stillPriced = (await server.client.actor(actor.id).get()) as unknown as { pricingInfos: unknown[] };
		expect(stillPriced.pricingInfos).toHaveLength(1);

		// The form is append-only too: an emptied box would drop the history the API keeps.
		const emptied = await axios.post(
			`${consoleBaseUrl}/actors/${actor.id}/pricing`,
			new URLSearchParams({ pricingInfos: '[]' }),
			{ maxRedirects: 0, validateStatus: () => true },
		);
		expect(emptied.headers.location).toMatch(/pricingError=.*cannot\+remove|pricingError=.*cannot%20remove/);

		const crossSite = await axios.post(
			`${consoleBaseUrl}/actors/${actor.id}/pricing`,
			new URLSearchParams({ pricingInfos: '[]' }),
			{ headers: { 'Sec-Fetch-Site': 'cross-site' }, maxRedirects: 0, validateStatus: () => true },
		);
		expect(crossSite.status).toBe(403);
	});

	it('the run detail view shows the usage and cost section with the charged events, and the runs list a cost column', async () => {
		const actorId = await seedRunnableActor(server, 'console-usage-actor', PPE_PRICING);
		const runId = await startLiveRun(server, driver, actorId, { maxTotalChargeUsd: 2 });
		await server.client.run(runId).charge({ eventName: PAGE_EVENT, count: 5, idempotencyKey: 'k' });

		const detail = await axios.get(`${consoleBaseUrl}/runs/${runId}`);
		expect(detail.data).toContain('<h2>Usage and cost</h2>');
		expect(detail.data).toContain('<h3>Charged events</h3>');
		expect(detail.data).toContain('Page scraped');
		expect(detail.data).toContain('<td>5</td>');
		expect(detail.data).toContain('$0.1</td>');
		expect(detail.data).toContain('$2');
		expect(detail.data).toContain('usageTotalUsd');

		const list = await axios.get(`${consoleBaseUrl}/runs`);
		expect(list.data).toContain('<th>usageTotalUsd</th>');

		await finishRun(server, driver, runId);
	});
});

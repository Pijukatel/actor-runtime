/**
 * Run resurrection (`requirements/api.md`, "Resurrecting a finished run"): the
 * `POST /v2/actor-runs/:runId/resurrect` contract over a real `apify-client`, with the same fake driver
 * discipline as `migration.test.ts`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import axios from 'axios';

import {
	restartTrackingDriver,
	startTestServer,
	type RestartTrackingDriver,
	type TestServerHandle,
} from './helpers/test-server.js';
import { realDelay } from './helpers/fake-timers.js';
import { getRegistries } from '../../src/storage/registries.js';
import { generateId } from '../../src/storage/ids.js';
import { recordTaggedBuild, updateActor } from '../../src/services/actors.js';
import { resurrectRun } from '../../src/services/runs.js';
import { isLogTerminal } from '../../src/services/logs.js';
import { isEventsTerminal } from '../../src/services/events-channel.js';
import type { ActorRecord, BuildRecord, JobStatus, RunRecord } from '../../src/storage/entities.js';

async function seedActor(server: TestServerHandle, name: string): Promise<ActorRecord> {
	const created = await server.client.actors().create({ name });
	return (await getRegistries().actors.get(created.id))!;
}

async function seedTaggedBuild(actor: ActorRecord, tag = 'latest', buildNumber = '0.0.1'): Promise<BuildRecord> {
	const build: BuildRecord = {
		id: generateId(),
		userId: actor.userId,
		actorId: actor.id,
		versionNumber: '0.0',
		buildNumber,
		tag,
		status: 'SUCCEEDED',
		startedAt: new Date().toISOString(),
		finishedAt: new Date().toISOString(),
		imageId: `fake-image:${tag}`,
	};
	await getRegistries().builds.set(build.id, build);
	await updateActor(actor.id, (current) => recordTaggedBuild(current, tag, build.id, build.buildNumber));
	return build;
}

async function waitForRunStatus(runId: string, status: JobStatus, timeoutMs = 3000): Promise<RunRecord> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const current = await getRegistries().runs.get(runId);
		if (current?.status === status) return current;
		if (Date.now() > deadline) {
			throw new Error(`timed out waiting for run ${runId} to reach ${status} (last seen: ${current?.status})`);
		}
		await realDelay(5);
	}
}

/** A run started through the real client whose first container has already exited with `exitCode`. */
async function startFinishedRun(
	server: TestServerHandle,
	driver: RestartTrackingDriver,
	name: string,
	exitCode = 0,
	startOptions: Record<string, unknown> = {},
): Promise<{ actor: ActorRecord; runId: string }> {
	const actor = await seedActor(server, name);
	await seedTaggedBuild(actor);
	const started = await server.client.actor(actor.id).start({}, startOptions);
	await driver.waitForStartCalls(1);
	driver.startCalls[0]!.resolve({ exitCode, timedOut: false });
	await waitForRunStatus(started.id, exitCode === 0 ? 'SUCCEEDED' : 'FAILED');
	return { actor, runId: started.id };
}

function postResurrect(baseUrl: string, runId: string, token?: string, query = '') {
	return axios.post(`${baseUrl}/v2/actor-runs/${runId}/resurrect${query}`, undefined, {
		headers: token ? { Authorization: `Bearer ${token}` } : {},
		validateStatus: () => true,
	});
}

describe('run resurrection', () => {
	let server: TestServerHandle;

	afterEach(async () => {
		await server.close();
	});

	it('resurrects a SUCCEEDED run as the same run: same id, storages and env, cleared finish, resurrectCount 1, full timeout again, log continued - and it finishes again normally', async () => {
		const driver = restartTrackingDriver();
		server = await startTestServer(driver);
		const { runId } = await startFinishedRun(server, driver, 'resurrect-flow-actor');
		const finished = (await getRegistries().runs.get(runId))!;
		expect(finished.finishedAt).toBeDefined();
		expect(isLogTerminal(runId)).toBe(true);

		const resurrected = await server.client.run(runId).resurrect();
		expect(resurrected.id).toBe(runId);
		expect(['READY', 'RUNNING']).toContain(resurrected.status);
		expect(resurrected.startedAt).toEqual(new Date(finished.startedAt));
		expect(resurrected.finishedAt).toBeUndefined();
		expect(resurrected.exitCode).toBeUndefined();
		expect(resurrected.statusMessage).toBe('The Actor has been resurrected from SUCCEEDED status.');
		expect(resurrected.defaultDatasetId).toBe(finished.defaultDatasetId);
		expect(resurrected.defaultKeyValueStoreId).toBe(finished.defaultKeyValueStoreId);
		expect(resurrected.defaultRequestQueueId).toBe(finished.defaultRequestQueueId);
		expect(resurrected.buildId).toBe(finished.buildId);
		expect(resurrected.options).toEqual(finished.options);
		expect((resurrected.stats as { resurrectCount?: number }).resurrectCount).toBe(1);
		expect(isLogTerminal(runId)).toBe(false);
		expect(isEventsTerminal(runId)).toBe(false);

		await driver.waitForStartCalls(2);
		const second = driver.startCalls[1]!;
		expect(second.ctx.runId).toBe(runId);
		expect(second.ctx.imageId).toBe(driver.startCalls[0]!.ctx.imageId);
		expect(second.ctx.env).toEqual(driver.startCalls[0]!.ctx.env);
		// The budget restarts in full, not what was left of the first incarnation's.
		expect(second.ctx.timeoutSecs).toBeGreaterThanOrEqual(299);
		expect(second.ctx.timeoutSecs).toBeLessThanOrEqual(300);

		const running = await waitForRunStatus(runId, 'RUNNING');
		expect(running.resurrectedAt).toBeDefined();

		second.resolve({ exitCode: 0, timedOut: false });
		await waitForRunStatus(runId, 'SUCCEEDED');
		const final = (await server.client.run(runId).get())!;
		expect(final.finishedAt).toBeDefined();
		expect(final.exitCode).toBe(0);
		expect((final.stats as { resurrectCount?: number }).resurrectCount).toBe(1);

		const log = await server.client.log(runId).get();
		expect(log).toContain('Resurrecting Actor run from SUCCEEDED status.');
	});

	it('resurrects a FAILED run and an ABORTED one too, and the resurrected run can be aborted like any other', async () => {
		const driver = restartTrackingDriver();
		server = await startTestServer(driver);
		const { runId } = await startFinishedRun(server, driver, 'resurrect-failed-actor', 1);

		const resurrected = await server.client.run(runId).resurrect();
		expect(resurrected.statusMessage).toBe('The Actor has been resurrected from FAILED status.');
		await driver.waitForStartCalls(2);
		await waitForRunStatus(runId, 'RUNNING');

		const aborted = await server.client.run(runId).abort();
		expect(aborted.status).toBe('ABORTED');
		driver.startCalls[1]!.resolve({ exitCode: 137, timedOut: false });
		await realDelay(50);
		expect((await getRegistries().runs.get(runId))?.status).toBe('ABORTED');

		const again = await server.client.run(runId).resurrect();
		expect(again.statusMessage).toBe('The Actor has been resurrected from ABORTED status.');
		expect((again.stats as { resurrectCount?: number }).resurrectCount).toBe(2);
		await driver.waitForStartCalls(3);
		driver.startCalls[2]!.resolve({ exitCode: 0, timedOut: false });
		await waitForRunStatus(runId, 'SUCCEEDED');
	});

	it('an unfinished run is 400 invalid-input naming its status; unknown, foreign and unauthenticated calls are 404/401', async () => {
		const driver = restartTrackingDriver();
		server = await startTestServer(driver);
		const actor = await seedActor(server, 'resurrect-running-actor');
		await seedTaggedBuild(actor);
		const started = await server.client.actor(actor.id).start({});
		await driver.waitForStartCalls(1);

		const running = await postResurrect(server.baseUrl, started.id, server.token);
		expect(running.status).toBe(400);
		expect(running.data).toEqual({
			error: { type: 'invalid-input', message: 'Cannot resurrect an Actor run with the RUNNING status' },
		});

		expect((await postResurrect(server.baseUrl, started.id)).status).toBe(401);
		const unknown = await postResurrect(server.baseUrl, 'no-such-run', server.token);
		expect(unknown.status).toBe(404);
		expect(unknown.data.error.type).toBe('record-not-found');
		const foreign = await postResurrect(server.baseUrl, started.id, 'another-users-token');
		expect(foreign.status).toBe(404);
		expect(foreign.data.error.type).toBe('record-not-found');

		expect(driver.startCalls).toHaveLength(1);
		driver.startCalls[0]!.resolve({ exitCode: 0, timedOut: false });
		await waitForRunStatus(started.id, 'SUCCEEDED');
	});

	it('build, memory and timeout can be changed for the new incarnation; an unknown build tag and invalid figures are rejected before anything starts', async () => {
		const driver = restartTrackingDriver();
		server = await startTestServer(driver);
		const { actor, runId } = await startFinishedRun(server, driver, 'resurrect-options-actor');
		const beta = await seedTaggedBuild(actor, 'beta', '0.0.2');

		const noSuchTag = await postResurrect(server.baseUrl, runId, server.token, '?build=nope');
		expect(noSuchTag.status).toBe(404);
		expect(noSuchTag.data.error.message).toBe('Actor has no build tagged "nope"');
		for (const query of ['?memory=0', '?timeout=-1', '?maxTotalChargeUsd=-1']) {
			const invalid = await postResurrect(server.baseUrl, runId, server.token, query);
			expect(invalid.status).toBe(400);
			expect(invalid.data.error.type).toBe('invalid-request');
		}
		expect(driver.startCalls).toHaveLength(1);

		const resurrected = await server.client.run(runId).resurrect({ build: 'beta', memory: 2048, timeout: 60 });
		expect(resurrected.buildId).toBe(beta.id);
		expect(resurrected.buildNumber).toBe('0.0.2');
		expect(resurrected.options.build).toBe('beta');
		expect(resurrected.options.memoryMbytes).toBe(2048);
		expect(resurrected.options.timeoutSecs).toBe(60);
		expect(resurrected.options.diskMbytes).toBe(4096);

		await driver.waitForStartCalls(2);
		const second = driver.startCalls[1]!;
		expect(second.ctx.imageId).toBe('fake-image:beta');
		expect(second.ctx.memoryMbytes).toBe(2048);
		expect(second.ctx.env.ACTOR_MEMORY_MBYTES).toBe('2048');
		expect(second.ctx.timeoutSecs).toBeGreaterThanOrEqual(59);
		expect(second.ctx.timeoutSecs).toBeLessThanOrEqual(60);
		second.resolve({ exitCode: 0, timedOut: false });
		await waitForRunStatus(runId, 'SUCCEEDED');
	});

	it('the cost cap can be raised or lifted but never lowered, and a reached cap enforces again after the resurrection', async () => {
		const driver = restartTrackingDriver();
		server = await startTestServer(driver);
		const { runId } = await startFinishedRun(server, driver, 'resurrect-cap-actor', 0, { maxTotalChargeUsd: 1 });
		await getRegistries().runs.update(runId, (current) =>
			current ? { ...current, chargingStoppedAt: new Date().toISOString() } : current,
		);

		const lowered = await postResurrect(server.baseUrl, runId, server.token, '?maxTotalChargeUsd=0.5');
		expect(lowered.status).toBe(400);
		expect(lowered.data).toEqual({
			error: {
				type: 'parameters-mismatched',
				message: 'Parameters mismatched: Maximum cost per run cannot be decreased when resurrecting run',
			},
		});
		expect(driver.startCalls).toHaveLength(1);

		const raised = await server.client.run(runId).resurrect({ maxTotalChargeUsd: 2 });
		expect(raised.options.maxTotalChargeUsd).toBe(2);
		expect((raised as { chargingStoppedAt?: string }).chargingStoppedAt).toBeUndefined();
		await driver.waitForStartCalls(2);
		expect(driver.startCalls[1]!.ctx.env.ACTOR_MAX_TOTAL_CHARGE_USD).toBe('2');
		driver.startCalls[1]!.resolve({ exitCode: 0, timedOut: false });
		await waitForRunStatus(runId, 'SUCCEEDED');

		const lifted = await server.client.run(runId).resurrect({ maxTotalChargeUsd: 0 });
		expect(lifted.options.maxTotalChargeUsd).toBe(0);
		await driver.waitForStartCalls(3);
		driver.startCalls[2]!.resolve({ exitCode: 0, timedOut: false });
		await waitForRunStatus(runId, 'SUCCEEDED');
	});

	it('a pay-per-event run is charged the start event again, for the memory it is resurrected with', async () => {
		const driver = restartTrackingDriver();
		server = await startTestServer(driver);
		const actor = await seedActor(server, 'resurrect-ppe-actor');
		await server.client.actor(actor.id).update({
			pricingInfos: [
				{
					pricingModel: 'PAY_PER_EVENT',
					pricingPerEvent: {
						actorChargeEvents: {
							'apify-actor-start': {
								eventTitle: 'Actor start',
								eventPriceUsd: 0.01,
								isOneTimeEvent: true,
							},
						},
					},
				},
			],
		} as never);
		await seedTaggedBuild((await getRegistries().actors.get(actor.id))!);
		const started = await server.client.actor(actor.id).start({}, { memory: 2048 });
		expect(started.chargedEventCounts).toEqual({ 'apify-actor-start': 2 });
		await driver.waitForStartCalls(1);
		driver.startCalls[0]!.resolve({ exitCode: 0, timedOut: false });
		await waitForRunStatus(started.id, 'SUCCEEDED');

		const resurrected = await server.client.run(started.id).resurrect({ memory: 4096 });
		expect(resurrected.chargedEventCounts).toEqual({ 'apify-actor-start': 6 });
		expect(resurrected.pricingInfo).toEqual(started.pricingInfo);
		await driver.waitForStartCalls(2);
		driver.startCalls[1]!.resolve({ exitCode: 0, timedOut: false });
		await waitForRunStatus(started.id, 'SUCCEEDED');

		const log = await server.client.log(started.id).get();
		expect(log).toContain("Pre-charged 4 'apify-actor-start' event(s), $0.04 in total, for 4096 MB of memory");
	});

	it('two concurrent resurrections start one container: the second is refused as not finished', async () => {
		const driver = restartTrackingDriver();
		server = await startTestServer(driver);
		const { runId } = await startFinishedRun(server, driver, 'resurrect-race-actor');

		const [first, second] = await Promise.all([
			postResurrect(server.baseUrl, runId, server.token),
			postResurrect(server.baseUrl, runId, server.token),
		]);
		const statuses = [first.status, second.status].sort();
		expect(statuses).toEqual([200, 400]);
		const refused = first.status === 400 ? first : second;
		expect(refused.data.error.type).toBe('invalid-input');

		await driver.waitForStartCalls(2);
		await realDelay(50);
		expect(driver.startCalls).toHaveLength(2);
		expect((await getRegistries().runs.get(runId))?.stats?.resurrectCount).toBe(1);
		driver.startCalls[1]!.resolve({ exitCode: 0, timedOut: false });
		await waitForRunStatus(runId, 'SUCCEEDED');
	});

	it('usage counts only the time the run actually ran: the gap before the resurrection is neither run time nor compute units', async () => {
		const driver = restartTrackingDriver();
		server = await startTestServer(driver);
		const actor = await seedActor(server, 'resurrect-usage-actor');
		const build = await seedTaggedBuild(actor);

		// Hand-seeded: ran for 100s, then sat finished for an hour.
		const now = Date.now();
		const record: RunRecord = {
			id: generateId(),
			userId: actor.userId,
			actorId: actor.id,
			buildId: build.id,
			buildNumber: build.buildNumber,
			status: 'SUCCEEDED',
			startedAt: new Date(now - 3_700_000).toISOString(),
			finishedAt: new Date(now - 3_600_000).toISOString(),
			exitCode: 0,
			defaultDatasetId: 'd',
			defaultKeyValueStoreId: 'k',
			defaultRequestQueueId: 'r',
			options: { memoryMbytes: 1024, timeoutSecs: 300 },
			meta: { origin: 'API' },
		};
		await getRegistries().runs.set(record.id, record);

		const result = await resurrectRun(driver, actor, record, { apiBaseUrl: server.baseUrl, token: server.token });
		expect(result.kind).toBe('resurrected');
		expect((result as { run: RunRecord }).run.stats?.durationMillisBeforeResurrect).toBeGreaterThanOrEqual(100_000);
		expect((result as { run: RunRecord }).run.stats?.durationMillisBeforeResurrect).toBeLessThan(101_000);

		await driver.waitForStartCalls(1);
		// The full budget again, not the (long exhausted) remainder counted from `startedAt`.
		expect(driver.startCalls[0]!.ctx.timeoutSecs).toBeGreaterThanOrEqual(299);

		const live = (await server.client.run(record.id).get())!;
		const stats = live.stats as { durationMillis: number; resurrectCount: number };
		expect(stats.resurrectCount).toBe(1);
		expect(stats.durationMillis).toBeGreaterThanOrEqual(100_000);
		expect(stats.durationMillis).toBeLessThan(110_000);

		driver.startCalls[0]!.resolve({ exitCode: 0, timedOut: false });
		await waitForRunStatus(record.id, 'SUCCEEDED');
		const done = (await server.client.run(record.id).get())!;
		expect((done.stats as { durationMillis: number }).durationMillis).toBeLessThan(110_000);
	});
});

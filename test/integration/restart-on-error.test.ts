/**
 * Restart on error (`requirements/api.md`, "Restart on error"): a run started with `restartOnError`
 * restarts as the same run when its container exits non-zero, up to the platform's limit.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
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
import type { ActorRecord, BuildRecord, JobStatus } from '../../src/storage/entities.js';

async function seedActorWithBuild(server: TestServerHandle, name: string): Promise<ActorRecord> {
	const created = await server.client.actors().create({ name });
	const actor = (await getRegistries().actors.get(created.id))!;
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
	await updateActor(actor.id, (current) => recordTaggedBuild(current, 'latest', build.id, build.buildNumber));
	return actor;
}

async function waitForRunStatus(runId: string, status: JobStatus, timeoutMs = 3000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const current = await getRegistries().runs.get(runId);
		if (current?.status === status) return;
		if (Date.now() > deadline) {
			throw new Error(`timed out waiting for run ${runId} to reach ${status} (last seen: ${current?.status})`);
		}
		await realDelay(5);
	}
}

async function startRun(server: TestServerHandle, actorId: string, query: string): Promise<string> {
	const response = await axios.post(`${server.baseUrl}/v2/actors/${actorId}/runs?${query}`, undefined, {
		headers: { Authorization: `Bearer ${server.token}` },
	});
	return response.data.data.id as string;
}

/** Fails the container behind start call `index` and waits for the run's next container. */
async function failAndExpectRestart(driver: RestartTrackingDriver, index: number): Promise<void> {
	driver.startCalls[index]!.resolve({ exitCode: 1, timedOut: false });
	await driver.waitForStartCalls(index + 2);
}

describe('restart on error', () => {
	let server: TestServerHandle;

	afterEach(async () => {
		vi.useRealTimers();
		await server.close();
	});

	it('restarts a failed run as the same run, counts it in stats.restartCount, and reports the option', async () => {
		const driver = restartTrackingDriver();
		server = await startTestServer(driver);
		const actor = await seedActorWithBuild(server, 'restart-on-error-actor');
		const runId = await startRun(server, actor.id, 'restartOnError=true');
		await driver.waitForStartCalls(1);

		await failAndExpectRestart(driver, 0);
		const restarted = await server.client.run(runId).get();
		expect(restarted?.status).toBe('RUNNING');
		expect(restarted?.exitCode).toBeUndefined();
		expect((restarted?.stats as { restartCount?: number }).restartCount).toBe(1);
		expect((restarted?.options as { restartOnError?: boolean }).restartOnError).toBe(true);
		expect(driver.startCalls[1]!.ctx.env).toEqual(driver.startCalls[0]!.ctx.env);

		driver.startCalls[1]!.resolve({ exitCode: 0, timedOut: false });
		await waitForRunStatus(runId, 'SUCCEEDED');
		const log = await server.client.log(runId).get();
		expect(log).toContain('The Actor run exited with code 1, restarting it (restart on error).');
	});

	it('fails the run once it failed more than 3 times within a minute', async () => {
		const driver = restartTrackingDriver();
		server = await startTestServer(driver);
		const actor = await seedActorWithBuild(server, 'restart-limit-actor');
		const runId = await startRun(server, actor.id, 'restartOnError=1');
		await driver.waitForStartCalls(1);

		for (let index = 0; index < 3; index++) await failAndExpectRestart(driver, index);
		driver.startCalls[3]!.resolve({ exitCode: 2, timedOut: false });
		await waitForRunStatus(runId, 'FAILED');

		const final = await server.client.run(runId).get();
		expect(final?.exitCode).toBe(2);
		expect((final?.stats as { restartCount?: number }).restartCount).toBe(3);
		expect(driver.startCalls).toHaveLength(4);
		const log = await server.client.log(runId).get();
		expect(log).toContain(
			'The Actor run failed more than 3 times within 60 seconds, so it is not restarted again.',
		);
	});

	it('restarts older than a minute do not count towards the limit', async () => {
		const driver = restartTrackingDriver();
		server = await startTestServer(driver);
		const actor = await seedActorWithBuild(server, 'restart-window-actor');
		const runId = await startRun(server, actor.id, 'restartOnError=true&timeout=0');
		await driver.waitForStartCalls(1);

		vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
		for (let index = 0; index < 3; index++) await failAndExpectRestart(driver, index);
		vi.setSystemTime(Date.now() + 61_000);
		await failAndExpectRestart(driver, 3);

		const current = await getRegistries().runs.get(runId);
		expect(current?.status).toBe('RUNNING');
		expect(current?.stats?.restartCount).toBe(4);
		vi.useRealTimers();
		driver.startCalls[4]!.resolve({ exitCode: 0, timedOut: false });
		await waitForRunStatus(runId, 'SUCCEEDED');
	});

	it('without the option, a timeout, or an abort, a failed container ends the run', async () => {
		const driver = restartTrackingDriver();
		server = await startTestServer(driver);
		const actor = await seedActorWithBuild(server, 'restart-off-actor');

		const plainRunId = await startRun(server, actor.id, '');
		await driver.waitForStartCalls(1);
		driver.startCalls[0]!.resolve({ exitCode: 1, timedOut: false });
		await waitForRunStatus(plainRunId, 'FAILED');
		const plain = await server.client.run(plainRunId).get();
		expect((plain?.options as { restartOnError?: boolean }).restartOnError).toBeUndefined();

		const timedOutRunId = await startRun(server, actor.id, 'restartOnError=true');
		await driver.waitForStartCalls(2);
		driver.startCalls[1]!.resolve({ exitCode: 137, timedOut: true });
		await waitForRunStatus(timedOutRunId, 'TIMED-OUT');

		const abortedRunId = await startRun(server, actor.id, 'restartOnError=true');
		await driver.waitForStartCalls(3);
		const aborting = server.client.run(abortedRunId).abort();
		await vi.waitFor(() => expect(driver.abortRunCalls).toContain(abortedRunId));
		driver.startCalls[2]!.resolve({ exitCode: 137, timedOut: false });
		await aborting;
		await waitForRunStatus(abortedRunId, 'ABORTED');

		expect(driver.startCalls).toHaveLength(3);
	});

	it('resurrect can turn the option on for a finished run', async () => {
		const driver = restartTrackingDriver();
		server = await startTestServer(driver);
		const actor = await seedActorWithBuild(server, 'restart-resurrect-actor');
		const runId = await startRun(server, actor.id, '');
		await driver.waitForStartCalls(1);
		driver.startCalls[0]!.resolve({ exitCode: 1, timedOut: false });
		await waitForRunStatus(runId, 'FAILED');

		const response = await axios.post(
			`${server.baseUrl}/v2/actor-runs/${runId}/resurrect?restartOnError=true`,
			undefined,
			{ headers: { Authorization: `Bearer ${server.token}` } },
		);
		expect(response.data.data.options.restartOnError).toBe(true);
		await driver.waitForStartCalls(2);
		await failAndExpectRestart(driver, 1);
		driver.startCalls[2]!.resolve({ exitCode: 0, timedOut: false });
		await waitForRunStatus(runId, 'SUCCEEDED');
	});
});

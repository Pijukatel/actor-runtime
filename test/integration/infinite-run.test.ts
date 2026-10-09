/**
 * Runs with no timeout (`requirements/actor-driver.md`): `?timeout=0` on `POST /v2/actors/:actorId/runs`
 * is a deliberate "no timeout", kept distinct from the omitted option's 300s default, and such a run ends
 * only when its container exits or it is aborted. The driver side (no timer armed for `timeoutSecs: 0`)
 * is covered in `docker-driver-standby.test.ts`.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { restartTrackingDriver, startTestServer, type TestServerHandle } from './helpers/test-server.js';
import { realDelay } from './helpers/fake-timers.js';
import { getRegistries } from '../../src/storage/registries.js';
import { generateId } from '../../src/storage/ids.js';
import { recordTaggedBuild, updateActor } from '../../src/services/actors.js';
import type { ActorRecord, JobStatus } from '../../src/storage/entities.js';

async function seedActorWithBuild(server: TestServerHandle, name: string): Promise<ActorRecord> {
	const created = await server.client.actors().create({ name });
	const actor = (await getRegistries().actors.get(created.id))!;
	const buildId = generateId();
	await getRegistries().builds.set(buildId, {
		id: buildId,
		userId: actor.userId,
		actorId: actor.id,
		versionNumber: '0.0',
		buildNumber: '0.0.1',
		tag: 'latest',
		status: 'SUCCEEDED',
		startedAt: new Date().toISOString(),
		finishedAt: new Date().toISOString(),
		imageId: 'fake-image:latest',
	});
	await updateActor(actor.id, (current) => recordTaggedBuild(current, 'latest', buildId, '0.0.1'));
	return actor;
}

async function waitForRunStatus(runId: string, status: JobStatus): Promise<void> {
	const deadline = Date.now() + 3000;
	for (;;) {
		const current = await getRegistries().runs.get(runId);
		if (current?.status === status) return;
		if (Date.now() > deadline) {
			throw new Error(`timed out waiting for run ${runId} to reach ${status} (last seen: ${current?.status})`);
		}
		await realDelay(5);
	}
}

describe('runs with no timeout (?timeout=0)', () => {
	let server: TestServerHandle;

	afterEach(async () => {
		await server.close();
	});

	it('keeps timeoutSecs 0 on the run (not the 300s default), hands the driver 0, and the run ends only by abort', async () => {
		const driver = restartTrackingDriver();
		server = await startTestServer(driver);
		const actor = await seedActorWithBuild(server, 'no-timeout-actor');

		const run = await server.client.actor(actor.id).start({}, { timeout: 0 });
		expect(run.options.timeoutSecs).toBe(0);
		expect((await server.client.run(run.id).get())!.options.timeoutSecs).toBe(0);

		await driver.waitForStartCalls(1);
		expect(driver.startCalls[0]!.ctx.timeoutSecs).toBe(0);
		expect((await getRegistries().runs.get(run.id))!.status).toBe('RUNNING');

		await server.client.run(run.id).abort();
		await waitForRunStatus(run.id, 'ABORTED');
		expect(driver.abortRunCalls).toEqual([run.id]);
		// The stopped container's exit lands after the abort already finalised the run: a no-op write.
		driver.startCalls[0]!.resolve({ exitCode: 137, timedOut: false });
		await realDelay(20);
		expect((await getRegistries().runs.get(run.id))!.status).toBe('ABORTED');
	});

	it('an omitted timeout still gets the 300s default', async () => {
		const driver = restartTrackingDriver();
		server = await startTestServer(driver);
		const actor = await seedActorWithBuild(server, 'default-timeout-actor');

		const run = await server.client.actor(actor.id).start({});
		expect(run.options.timeoutSecs).toBe(300);
		await driver.waitForStartCalls(1);
		expect(driver.startCalls[0]!.ctx.timeoutSecs).toBe(300);
		driver.startCalls[0]!.resolve({ exitCode: 0, timedOut: false });
		await waitForRunStatus(run.id, 'SUCCEEDED');
	});
});

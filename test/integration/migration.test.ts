/**
 * Migration emulation and reboot (`requirements/api.md`, "Migration emulation"): the
 * `POST /actor-runtime/migrate/:runId` and `POST /v2/actor-runs/:runId/reboot` contracts. The console's
 * Migrate button is covered in `migrate-console.test.ts`. Fake-timer discipline follows
 * `graceful-abort.test.ts` (only `setTimeout`/`clearTimeout` faked).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';

import {
	restartTrackingDriver,
	startTestServer,
	type RestartTrackingDriver,
	type TestServerHandle,
} from './helpers/test-server.js';
import { realDelay, waitForPendingTimer } from './helpers/fake-timers.js';
import { getRegistries } from '../../src/storage/registries.js';
import { generateId } from '../../src/storage/ids.js';
import { recordTaggedBuild, updateActor } from '../../src/services/actors.js';
import { abortRun, runInBackground } from '../../src/services/runs.js';
import { MIGRATING_STOP_WINDOW_MS, hasPendingMigrationStop, migrateRun } from '../../src/services/migrations.js';
import { subscribeEvents } from '../../src/services/events-channel.js';
import type { ActorRecord, BuildRecord, JobStatus, RunRecord } from '../../src/storage/entities.js';

/** Creates an Actor via the real client (so it has a genuine owner) and returns the underlying
 * `ActorRecord` - mirrors `graceful-abort.test.ts`'s identical helper. */
async function seedActor(server: TestServerHandle, name: string): Promise<ActorRecord> {
	const created = await server.client.actors().create({ name });
	return (await getRegistries().actors.get(created.id))!;
}

/** A SUCCEEDED build with a fake image, seeded directly and tagged `latest` so `.start()` resolves it. */
async function seedTaggedBuild(actor: ActorRecord): Promise<BuildRecord> {
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
	return build;
}

/** Real-time poll (never a fake timer) until `predicate` holds - the migration stop's registry write
 * is real fs I/O that lands after the faked timer fires. */
async function pollUntil(predicate: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await realDelay(5);
	}
}

/** Real-time poll for a run's registry status - see `pollUntil`'s doc comment. */
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

/** Starts a run through the real client against a seeded Actor and waits until its (first) container
 * is genuinely running in the driver. */
async function startRunningRun(
	server: TestServerHandle,
	driver: RestartTrackingDriver,
	name: string,
): Promise<{ actor: ActorRecord; runId: string }> {
	const actor = await seedActor(server, name);
	await seedTaggedBuild(actor);
	const started = await server.client.actor(actor.id).start({});
	await driver.waitForStartCalls(1);
	return { actor, runId: started.id };
}

function postMigrate(baseUrl: string, runId: string, token?: string) {
	return axios.post(`${baseUrl}/actor-runtime/migrate/${runId}`, undefined, {
		headers: token ? { Authorization: `Bearer ${token}` } : {},
		validateStatus: () => true,
	});
}

describe('migration emulation and reboot', () => {
	let server: TestServerHandle;

	afterEach(async () => {
		vi.useRealTimers();
		await server.close();
	});

	it('POST /actor-runtime/migrate/:runId: migrating frame immediately, run stays RUNNING, container stopped only after the full window, then the same run restarts with byte-identical env and migrationCount 1, and still finishes normally afterwards', async () => {
		const driver = restartTrackingDriver();
		server = await startTestServer(driver);
		const { runId } = await startRunningRun(server, driver, 'migrate-flow-actor');

		const frames: string[] = [];
		const unsubscribe = subscribeEvents(runId, (frame) => frames.push(frame));

		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

		const response = await postMigrate(server.baseUrl, runId, server.token);
		expect(response.status).toBe(200);
		// The response is the run object, like abort/reboot - still RUNNING, since migration is not a status.
		expect(response.data.data.id).toBe(runId);
		expect(response.data.data.status).toBe('RUNNING');

		// Only a migrating frame - never a server-sent persistState alongside it.
		expect(frames).toEqual([JSON.stringify({ name: 'migrating', data: {} })]);

		// Mid-window: the run is untouched - still RUNNING, container still up.
		const midWindow = await getRegistries().runs.get(runId);
		expect(midWindow?.status).toBe('RUNNING');
		expect(driver.abortRunCalls).toEqual([]);

		// Just under the window: still not stopped.
		await vi.advanceTimersByTimeAsync(MIGRATING_STOP_WINDOW_MS - 1);
		expect(driver.abortRunCalls).toEqual([]);

		// At the window: the stop lands (after the timer's own real registry write - poll in real time).
		await vi.advanceTimersByTimeAsync(1);
		await pollUntil(() => driver.abortRunCalls.length === 1, 'the migration stop to reach the driver');
		expect(driver.abortRunCalls).toEqual([runId]);

		// The container exits the way a stopped container does; the run must NOT finish - it restarts.
		driver.startCalls[0]!.resolve({ exitCode: 137, timedOut: false });
		await driver.waitForStartCalls(2);

		const afterRestart = await getRegistries().runs.get(runId);
		expect(afterRestart?.status).toBe('RUNNING');
		expect(afterRestart?.finishedAt).toBeUndefined();
		expect(afterRestart?.stats?.migrationCount).toBe(1);
		expect(afterRestart?.stats?.rebootCount).toBe(0);

		// Byte-identical env for the new container, like the platform's re-execution of the same run.
		expect(driver.startCalls[1]!.ctx.env).toEqual(driver.startCalls[0]!.ctx.env);
		expect(driver.startCalls[1]!.ctx.runId).toBe(runId);
		expect(driver.startCalls[1]!.ctx.imageId).toBe(driver.startCalls[0]!.ctx.imageId);

		// The restarted incarnation then finishes normally.
		vi.useRealTimers();
		driver.startCalls[1]!.resolve({ exitCode: 0, timedOut: false });
		await waitForRunStatus(runId, 'SUCCEEDED');

		const final = await server.client.run(runId).get();
		expect(final?.status).toBe('SUCCEEDED');
		expect(final?.exitCode).toBe(0);
		expect((final?.stats as { migrationCount?: number }).migrationCount).toBe(1);

		// The log is cumulative across the restart, with this runtime's own marker line in between.
		const log = await server.client.log(runId).get();
		expect(log).toContain('Migrating Actor run to a new container.');

		unsubscribe();
	});

	it('a second migrate call while the window is open joins it: same run-object response, but no second migrating frame and no second window', async () => {
		const driver = restartTrackingDriver();
		server = await startTestServer(driver);
		const { runId } = await startRunningRun(server, driver, 'migrate-join-actor');

		const frames: string[] = [];
		const unsubscribe = subscribeEvents(runId, (frame) => frames.push(frame));

		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

		const first = await postMigrate(server.baseUrl, runId, server.token);
		expect(first.status).toBe(200);
		expect(first.data.data.id).toBe(runId);
		const timersAfterFirst = vi.getTimerCount();

		const second = await postMigrate(server.baseUrl, runId, server.token);
		expect(second.status).toBe(200);
		expect(second.data.data.id).toBe(runId);
		expect(second.data.data.status).toBe('RUNNING');

		expect(frames).toEqual([JSON.stringify({ name: 'migrating', data: {} })]);
		expect(vi.getTimerCount()).toBe(timersAfterFirst);

		// The one window still ends in exactly one stop.
		await vi.advanceTimersByTimeAsync(MIGRATING_STOP_WINDOW_MS);
		await pollUntil(() => driver.abortRunCalls.length === 1, 'the single migration stop');
		expect(driver.abortRunCalls).toEqual([runId]);

		driver.startCalls[0]!.resolve({ exitCode: 137, timedOut: false });
		await driver.waitForStartCalls(2);
		const afterRestart = await getRegistries().runs.get(runId);
		expect(afterRestart?.stats?.migrationCount).toBe(1);

		vi.useRealTimers();
		driver.startCalls[1]!.resolve({ exitCode: 0, timedOut: false });
		await waitForRunStatus(runId, 'SUCCEEDED');
		unsubscribe();
	});

	it("POST /v2/actor-runs/:runId/reboot during the open window - the SDKs' default migrating reaction - cancels the pending stop and restarts immediately, and the stale window never kills the new container", async () => {
		const driver = restartTrackingDriver();
		server = await startTestServer(driver);
		const { runId } = await startRunningRun(server, driver, 'migrate-reboot-actor');
		const record = (await getRegistries().runs.get(runId))!;

		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

		expect(await migrateRun(driver, record)).toBe('migrating');
		await waitForPendingTimer();
		expect(hasPendingMigrationStop(runId)).toBe(true);

		// What Actor.reboot() does: the real platform endpoint, over a real HTTP round trip.
		const rebooted = await server.client.run(runId).reboot();
		expect(rebooted.status).toBe('RUNNING');
		expect((rebooted.stats as { rebootCount?: number }).rebootCount).toBe(1);

		// The pending migration stop is cancelled and the container stops NOW, without advancing time.
		expect(hasPendingMigrationStop(runId)).toBe(false);
		expect(driver.abortRunCalls).toEqual([runId]);

		driver.startCalls[0]!.resolve({ exitCode: 137, timedOut: false });
		await driver.waitForStartCalls(2);

		// The stale window, had it survived, would fire about now - nothing further may stop the run.
		await vi.advanceTimersByTimeAsync(MIGRATING_STOP_WINDOW_MS * 2);
		await realDelay(50);
		expect(driver.abortRunCalls).toEqual([runId]);

		const afterRestart = await getRegistries().runs.get(runId);
		expect(afterRestart?.status).toBe('RUNNING');
		// The reboot pre-empted the migration's stop, so only rebootCount moved.
		expect(afterRestart?.stats?.rebootCount).toBe(1);
		expect(afterRestart?.stats?.migrationCount).toBe(0);

		vi.useRealTimers();
		driver.startCalls[1]!.resolve({ exitCode: 0, timedOut: false });
		await waitForRunStatus(runId, 'SUCCEEDED');
	});

	it('a standalone reboot restarts the container immediately, bumps rebootCount, keeps the run RUNNING, and leaves its marker in the cumulative log', async () => {
		const driver = restartTrackingDriver();
		server = await startTestServer(driver);
		const { runId } = await startRunningRun(server, driver, 'reboot-alone-actor');

		const rebooted = await server.client.run(runId).reboot();
		expect(rebooted.status).toBe('RUNNING');
		expect(driver.abortRunCalls).toEqual([runId]);

		driver.startCalls[0]!.resolve({ exitCode: 137, timedOut: false });
		await driver.waitForStartCalls(2);

		const afterRestart = await getRegistries().runs.get(runId);
		expect(afterRestart?.status).toBe('RUNNING');
		expect(afterRestart?.stats?.rebootCount).toBe(1);

		driver.startCalls[1]!.resolve({ exitCode: 0, timedOut: false });
		await waitForRunStatus(runId, 'SUCCEEDED');

		const log = await server.client.log(runId).get();
		expect(log).toContain('Rebooting Actor run container.');
	});

	it('reboot of a finished run is rejected 403 job-finished, matching apify-core', async () => {
		const driver = restartTrackingDriver();
		server = await startTestServer(driver);
		const { runId } = await startRunningRun(server, driver, 'reboot-finished-actor');

		driver.startCalls[0]!.resolve({ exitCode: 0, timedOut: false });
		await waitForRunStatus(runId, 'SUCCEEDED');

		const response = await axios.post(`${server.baseUrl}/v2/actor-runs/${runId}/reboot`, undefined, {
			headers: { Authorization: `Bearer ${server.token}` },
			validateStatus: () => true,
		});
		expect(response.status).toBe(403);
		expect(response.data).toEqual({
			error: { type: 'job-finished', message: 'Actor job is already finished.' },
		});
		expect(driver.startCalls).toHaveLength(1);
	});

	it('a hard abort landing inside the open migration window wins: the run ends ABORTED, no restart ever happens, and migrationCount stays 0', async () => {
		const driver = restartTrackingDriver();
		server = await startTestServer(driver);
		const { runId } = await startRunningRun(server, driver, 'migrate-abort-race-actor');
		const record = (await getRegistries().runs.get(runId))!;

		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

		expect(await migrateRun(driver, record)).toBe('migrating');
		await waitForPendingTimer();

		// The escalation: a plain abort mid-window, exactly like the graceful-abort suite's race tests.
		const aborted = await abortRun(driver, (await getRegistries().runs.get(runId))!, false);
		expect(aborted?.status).toBe('ABORTED');
		expect(driver.abortRunCalls).toEqual([runId]);

		driver.startCalls[0]!.resolve({ exitCode: 137, timedOut: false });

		// The window still elapses; the migration must stand down: no second stop, restart, or bump.
		await vi.advanceTimersByTimeAsync(MIGRATING_STOP_WINDOW_MS);
		await realDelay(50);

		expect(driver.startCalls).toHaveLength(1);
		expect(driver.abortRunCalls).toEqual([runId]);
		const final = await getRegistries().runs.get(runId);
		expect(final?.status).toBe('ABORTED');
		expect(final?.stats?.migrationCount).toBe(0);
	});

	it('migrating an ABORTING run (a graceful-abort window is open) is 400 invalid-request - the abort owns the container', async () => {
		const driver = restartTrackingDriver();
		server = await startTestServer(driver);
		const { runId } = await startRunningRun(server, driver, 'migrate-aborting-actor');

		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		const abortPromise = abortRun(driver, (await getRegistries().runs.get(runId))!, true);
		await waitForPendingTimer();
		expect((await getRegistries().runs.get(runId))?.status).toBe('ABORTING');

		const response = await postMigrate(server.baseUrl, runId, server.token);
		expect(response.status).toBe(400);
		expect(response.data.error.type).toBe('invalid-request');

		await vi.advanceTimersByTimeAsync(30_000);
		await abortPromise;
		driver.startCalls[0]!.resolve({ exitCode: 137, timedOut: false });
	});

	it('migrate endpoint: 401 with no token, 404 for an unknown or foreign run, 403 job-finished for a finished run - and the /v2 alias works on a RUNNING one', async () => {
		const driver = restartTrackingDriver();
		server = await startTestServer(driver);
		const { runId } = await startRunningRun(server, driver, 'migrate-errors-actor');

		const unauthenticated = await postMigrate(server.baseUrl, runId);
		expect(unauthenticated.status).toBe(401);

		const unknown = await postMigrate(server.baseUrl, 'no-such-run', server.token);
		expect(unknown.status).toBe(404);
		expect(unknown.data.error.type).toBe('record-not-found');

		// Ownership-scoped like every other run endpoint: another user's token cannot even see this run.
		const foreign = await postMigrate(server.baseUrl, runId, 'another-users-token');
		expect(foreign.status).toBe(404);
		expect(foreign.data.error.type).toBe('record-not-found');

		// The /v2 alias (the path `apify api` actually reaches) triggers the same migration for real.
		const viaAlias = await axios.post(`${server.baseUrl}/v2/actor-runtime/migrate/${runId}`, undefined, {
			headers: { Authorization: `Bearer ${server.token}` },
			validateStatus: () => true,
		});
		expect(viaAlias.status).toBe(200);
		expect(viaAlias.data.data.id).toBe(runId);
		expect(viaAlias.data.data.status).toBe('RUNNING');

		// Let the migration play out in real time (no fake timers here) so the run can finish.
		await pollUntil(() => driver.abortRunCalls.length === 1, 'the migration stop', MIGRATING_STOP_WINDOW_MS + 3000);
		driver.startCalls[0]!.resolve({ exitCode: 137, timedOut: false });
		await driver.waitForStartCalls(2);
		driver.startCalls[1]!.resolve({ exitCode: 0, timedOut: false });
		await waitForRunStatus(runId, 'SUCCEEDED');

		const finished = await postMigrate(server.baseUrl, runId, server.token);
		expect(finished.status).toBe(403);
		expect(finished.data).toEqual({
			error: { type: 'job-finished', message: 'Actor job is already finished.' },
		});
	});

	it("the restarted container gets only the run's remaining timeout budget, counted from the run's own startedAt - never the full figure again", async () => {
		const driver = restartTrackingDriver();
		server = await startTestServer(driver);
		const actor = await seedActor(server, 'migrate-timeout-actor');
		const build = await seedTaggedBuild(actor);

		// Hand-seeded so startedAt can be planted 100s in the past against a 300s budget.
		const record: RunRecord = {
			id: generateId(),
			userId: actor.userId,
			actorId: actor.id,
			buildId: build.id,
			buildNumber: build.buildNumber,
			status: 'READY',
			startedAt: new Date(Date.now() - 100_000).toISOString(),
			defaultDatasetId: 'd',
			defaultKeyValueStoreId: 'k',
			defaultRequestQueueId: 'r',
			options: { memoryMbytes: 1024, timeoutSecs: 300 },
			meta: { origin: 'API' },
		};
		await getRegistries().runs.set(record.id, record);

		const bg = runInBackground(driver, actor, record, { apiBaseUrl: server.baseUrl, token: server.token });
		await driver.waitForStartCalls(1);
		// Already the remaining budget on the first container too, ~200s of the 300s.
		expect(driver.startCalls[0]!.ctx.timeoutSecs).toBeGreaterThanOrEqual(195);
		expect(driver.startCalls[0]!.ctx.timeoutSecs).toBeLessThanOrEqual(201);

		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		expect(await migrateRun(driver, (await getRegistries().runs.get(record.id))!)).toBe('migrating');
		await waitForPendingTimer();
		await vi.advanceTimersByTimeAsync(MIGRATING_STOP_WINDOW_MS);
		await pollUntil(() => driver.abortRunCalls.length === 1, 'the migration stop');
		vi.useRealTimers();

		driver.startCalls[0]!.resolve({ exitCode: 137, timedOut: false });
		await driver.waitForStartCalls(2);
		expect(driver.startCalls[1]!.ctx.timeoutSecs).toBeGreaterThanOrEqual(195);
		expect(driver.startCalls[1]!.ctx.timeoutSecs).toBeLessThanOrEqual(201);

		driver.startCalls[1]!.resolve({ exitCode: 0, timedOut: false });
		await bg;
	});
});

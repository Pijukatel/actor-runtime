/**
 * The console's Migrate button (`requirements/console.md`, "Migrate button"): rendering, the press
 * flow, the cross-site guard, and the raced-press error. The API endpoint itself is covered in
 * `migration.test.ts`.
 */
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';

import { createConsoleServer } from '../../src/console/server.js';
import { getRegistries } from '../../src/storage/registries.js';
import { generateId } from '../../src/storage/ids.js';
import { recordTaggedBuild, updateActor } from '../../src/services/actors.js';
import { subscribeEvents } from '../../src/services/events-channel.js';
import { MIGRATING_STOP_WINDOW_MS, hasPendingMigrationStop } from '../../src/services/migrations.js';
import { realDelay } from './helpers/fake-timers.js';
import {
	restartTrackingDriver,
	startTestServer,
	type RestartTrackingDriver,
	type TestServerHandle,
} from './helpers/test-server.js';
import type { ActorRecord, BuildRecord } from '../../src/storage/entities.js';

describe('console Migrate button (run detail view)', () => {
	let server: TestServerHandle;
	let driver: RestartTrackingDriver;
	let consoleServer: Server;
	let consoleBaseUrl: string;

	beforeEach(async () => {
		driver = restartTrackingDriver();
		server = await startTestServer(driver);
		const app = createConsoleServer({ driver });
		consoleServer = await new Promise((resolve) => {
			const s = app.listen(0, () => resolve(s));
		});
		consoleBaseUrl = `http://127.0.0.1:${(consoleServer.address() as AddressInfo).port}`;
	});

	afterEach(async () => {
		vi.useRealTimers();
		await new Promise<void>((resolve) => consoleServer.close(() => resolve()));
		await server.close();
	});

	async function seedActorWithBuild(name: string): Promise<ActorRecord> {
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

	/** Starts a run via the real API client and waits until its container is genuinely running. */
	async function startRunningRun(name: string): Promise<string> {
		const actor = await seedActorWithBuild(name);
		const started = await server.client.actor(actor.id).start({});
		await driver.waitForStartCalls(1);
		return started.id;
	}

	it('a RUNNING run detail view shows the Migrate button (with the migration counters); a finished run shows the only-RUNNING note instead of a button', async () => {
		const runId = await startRunningRun('console-migrate-render-actor');

		const runningDetail = await axios.get(`${consoleBaseUrl}/runs/${runId}`);
		expect(runningDetail.status).toBe(200);
		expect(runningDetail.data).toContain(`action="/runs/${runId}/migrate"`);
		expect(runningDetail.data).toContain('>Migrate</button>');
		expect(runningDetail.data).toContain('migrationCount');
		expect(runningDetail.data).toContain('rebootCount');

		driver.startCalls[0]!.resolve({ exitCode: 0, timedOut: false });
		const deadline = Date.now() + 3000;
		for (;;) {
			const current = await getRegistries().runs.get(runId);
			if (current?.status === 'SUCCEEDED') break;
			if (Date.now() > deadline) throw new Error('run never finished');
			await realDelay(5);
		}

		const finishedDetail = await axios.get(`${consoleBaseUrl}/runs/${runId}`);
		expect(finishedDetail.status).toBe(200);
		expect(finishedDetail.data).not.toContain(`action="/runs/${runId}/migrate"`);
		expect(finishedDetail.data).toContain('Only a RUNNING run can be migrated');
	});

	it('pressing Migrate redirects back to the run detail page and triggers the real migration: migrating frame now, window open, restart after the stop, migrationCount 1 on the reloaded page', async () => {
		const runId = await startRunningRun('console-migrate-press-actor');

		const frames: string[] = [];
		const unsubscribe = subscribeEvents(runId, (frame) => frames.push(frame));

		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

		// The button's own submission shape: a same-origin form POST.
		const pressed = await axios.post(`${consoleBaseUrl}/runs/${runId}/migrate`, '', {
			headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Sec-Fetch-Site': 'same-origin' },
			maxRedirects: 0,
			validateStatus: () => true,
		});
		expect(pressed.status).toBe(302);
		expect(pressed.headers.location).toBe(`/runs/${runId}`);

		expect(frames).toEqual([JSON.stringify({ name: 'migrating', data: {} })]);
		expect(hasPendingMigrationStop(runId)).toBe(true);
		expect(driver.abortRunCalls).toEqual([]);

		await vi.advanceTimersByTimeAsync(MIGRATING_STOP_WINDOW_MS);
		const stopDeadline = Date.now() + 3000;
		while (driver.abortRunCalls.length === 0) {
			if (Date.now() > stopDeadline) throw new Error('migration stop never reached the driver');
			await realDelay(5);
		}
		expect(driver.abortRunCalls).toEqual([runId]);

		driver.startCalls[0]!.resolve({ exitCode: 137, timedOut: false });
		await driver.waitForStartCalls(2);

		vi.useRealTimers();
		const reloaded = await axios.get(`${consoleBaseUrl}/runs/${runId}`);
		expect(reloaded.data).toContain('RUNNING');
		expect(reloaded.data).toContain('Migrating Actor run to a new container.');
		const afterRestart = await getRegistries().runs.get(runId);
		expect(afterRestart?.stats?.migrationCount).toBe(1);

		driver.startCalls[1]!.resolve({ exitCode: 0, timedOut: false });
		unsubscribe();
	});

	it("rejects a cross-site form submission with 403 and starts nothing, like the console's other writes", async () => {
		const runId = await startRunningRun('console-migrate-xsite-actor');

		const frames: string[] = [];
		const unsubscribe = subscribeEvents(runId, (frame) => frames.push(frame));

		const pressed = await axios.post(`${consoleBaseUrl}/runs/${runId}/migrate`, '', {
			headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Sec-Fetch-Site': 'cross-site' },
			validateStatus: () => true,
		});
		expect(pressed.status).toBe(403);
		expect(frames).toEqual([]);
		expect(hasPendingMigrationStop(runId)).toBe(false);

		driver.startCalls[0]!.resolve({ exitCode: 0, timedOut: false });
		unsubscribe();
	});

	it('404s for an unknown run id, and a press that raced the run ending redirects back with the reason shown inline', async () => {
		const unknown = await axios.post(`${consoleBaseUrl}/runs/does-not-exist/migrate`, '', {
			validateStatus: () => true,
		});
		expect(unknown.status).toBe(404);

		const runId = await startRunningRun('console-migrate-raced-actor');
		driver.startCalls[0]!.resolve({ exitCode: 0, timedOut: false });
		const deadline = Date.now() + 3000;
		for (;;) {
			const current = await getRegistries().runs.get(runId);
			if (current?.status === 'SUCCEEDED') break;
			if (Date.now() > deadline) throw new Error('run never finished');
			await realDelay(5);
		}

		const pressed = await axios.post(`${consoleBaseUrl}/runs/${runId}/migrate`, '', {
			maxRedirects: 0,
			validateStatus: () => true,
		});
		expect(pressed.status).toBe(302);
		expect(pressed.headers.location).toContain('migrateError=');

		const followed = await axios.get(`${consoleBaseUrl}${pressed.headers.location}`);
		expect(followed.data).toContain('Only a RUNNING run can be migrated');
	});
});

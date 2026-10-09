/** Covers `v2/schedules/*` (`api.md`'s "Schedules") through a real `apify-client`. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import axios from 'axios';

import { capturingDriver, startTestServer, type TestServerHandle } from './helpers/test-server.js';
import { getRegistries } from '../../src/storage/registries.js';
import { generateId } from '../../src/storage/ids.js';
import { recordTaggedBuild, updateActor } from '../../src/services/actors.js';
import type { Driver, RunContext, RunOutcome } from '../../src/driver/types.js';
import type { InputSchema, RunRecord } from '../../src/storage/entities.js';

const SCHEMA: InputSchema = {
	title: 'Input',
	type: 'object',
	schemaVersion: 1,
	properties: {
		query: { title: 'Query', type: 'string', editor: 'textfield', description: 'q', prefill: 'apify' },
		maxPages: { title: 'Max pages', type: 'integer', description: 'm', default: 3, minimum: 1 },
	},
	required: [],
};

type RunBehaviour = (ctx: RunContext) => Promise<Omit<RunOutcome, 'timedOut'> & { timedOut?: boolean }>;

function scriptedDriver() {
	let behaviour: RunBehaviour = async () => ({ exitCode: 0 });
	const releases = new Map<string, () => void>();
	const driver: Driver = {
		...capturingDriver().driver,
		async startRun(ctx) {
			return { timedOut: false, ...(await behaviour(ctx)) };
		},
		async abortRun(runId) {
			releases.get(runId)?.();
		},
	};
	return {
		driver,
		/** Runs started from now on keep running until aborted. */
		runUntilAborted() {
			behaviour = (ctx) =>
				new Promise((resolve) => releases.set(ctx.env.ACTOR_RUN_ID!, () => resolve({ exitCode: 143 })));
		},
	};
}

async function waitFor<T>(probe: () => Promise<T | undefined> | T | undefined, timeoutMs = 5000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await probe();
		if (value !== undefined && value !== false) return value;
		if (Date.now() > deadline) throw new Error('waitFor timed out');
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

describe('schedules', () => {
	let server: TestServerHandle;
	let scripted: ReturnType<typeof scriptedDriver>;
	let actorId: string;
	let userId: string;

	beforeEach(async () => {
		scripted = scriptedDriver();
		server = await startTestServer(scripted.driver);
		const actor = await server.client.actors().create({ name: 'my-actor' });
		actorId = actor.id;
		userId = actor.userId;
		const buildId = generateId();
		await getRegistries().builds.set(buildId, {
			id: buildId,
			userId,
			actorId,
			versionNumber: '0.0',
			buildNumber: '0.0.1',
			tag: 'latest',
			status: 'SUCCEEDED',
			startedAt: new Date().toISOString(),
			finishedAt: new Date().toISOString(),
			imageId: 'fake-image:latest',
			inputSchema: SCHEMA,
		});
		await updateActor(actorId, (current) => recordTaggedBuild(current, 'latest', buildId, '0.0.1'));
	});

	afterEach(async () => {
		await server.close();
	});

	function call(method: 'get' | 'post' | 'put' | 'delete', path: string, body?: unknown) {
		return axios.request({
			method,
			url: `${server.baseUrl}/v2/${path}`,
			data: body,
			headers: { Authorization: `Bearer ${server.token}`, 'Content-Type': 'application/json' },
			validateStatus: () => true,
		});
	}

	async function runInput(runId: string): Promise<unknown> {
		const run = await server.client.run(runId).get();
		const record = await server.client.keyValueStore(run!.defaultKeyValueStoreId).getRecord('INPUT');
		return record?.value;
	}

	async function scheduledRuns(scheduleId: string): Promise<RunRecord[]> {
		const runs = await getRegistries().runs.list();
		return runs.filter((run) => run.meta.scheduleId === scheduleId);
	}

	it('creates a schedule with the platform defaults and a generated name and title', async () => {
		const first = await server.client.schedules().create();
		expect(first).toMatchObject({
			name: 'my-schedule',
			title: 'My Schedule',
			cronExpression: '@daily',
			timezone: 'UTC',
			isEnabled: false,
			isExclusive: true,
			notifications: { email: true },
			nextRunAt: null,
			lastRunAt: null,
			actions: [],
		});
		const second = await server.client.schedules().create({ actions: [{ type: 'RUN_ACTOR', actorId }] } as never);
		expect(second.name).toBe('my-schedule-1');
		expect(second.actions).toEqual([{ id: expect.any(String), type: 'RUN_ACTOR', actorId }]);

		const { items, total } = await server.client.schedules().list();
		expect(total).toBe(2);
		expect(items.map((schedule) => schedule.name)).toEqual(['my-schedule', 'my-schedule-1']);
		expect(items[1]!.actions).toEqual([{ id: second.actions[0]!.id, type: 'RUN_ACTOR', actorId }]);
		expect((await server.client.schedule(first.id).get())?.id).toBe(first.id);
		expect(await server.client.schedule('nope').get()).toBeUndefined();
		expect(await server.client.schedule(first.id).getLog()).toEqual([]);
	});

	it('rejects what the platform rejects', async () => {
		await server.client.schedules().create({ name: 'taken' });
		const taken = await call('post', 'schedules', { name: 'TAKEN' });
		expect(taken.status).toBe(409);
		expect(taken.data.error.type).toBe('schedule-name-not-unique');

		const badName = await call('post', 'schedules', { name: '-x' });
		expect(badName.status).toBe(400);
		expect(badName.data.error.type).toBe('schema-validation');

		const badCron = await call('post', 'schedules', { cronExpression: 'every day' });
		expect(badCron.status).toBe(400);
		expect(badCron.data.error.type).toBe('cron-expression-invalid');
		expect(badCron.data.error.message).toMatch(/^Cron expression is not valid: /);

		const badTimezone = await call('post', 'schedules', { timezone: 'Mars/Olympus' });
		expect(badTimezone.status).toBe(400);
		expect(badTimezone.data.error.message).toBe('timezone is not an allowed value');

		const unknownActor = await call('post', 'schedules', { actions: [{ type: 'RUN_ACTOR', actorId: 'nope' }] });
		expect(unknownActor.status).toBe(404);
		expect(unknownActor.data.error).toEqual({
			type: 'schedule-actor-not-found',
			message: 'Actor with ID "nope" not found',
		});

		const unknownTask = await call('post', 'schedules', {
			actions: [{ type: 'RUN_ACTOR_TASK', actorTaskId: 'nope' }],
		});
		expect(unknownTask.status).toBe(404);
		expect(unknownTask.data.error.type).toBe('schedule-actor-task-not-found');

		const badInput = await call('post', 'schedules', {
			actions: [{ type: 'RUN_ACTOR', actorId, runInput: { body: '{oops', contentType: 'application/json' } }],
		});
		expect(badInput.status).toBe(400);
		expect(badInput.data.error.type).toBe('run-input-body-not-valid-json');

		const badType = await call('post', 'schedules', { actions: [{ type: 'RUN_WEBHOOK' }] });
		expect(badType.status).toBe(400);

		const tooMany = await call('post', 'schedules', {
			actions: Array.from({ length: 11 }, () => ({ type: 'RUN_ACTOR', actorId })),
		});
		expect(tooMany.status).toBe(403);
		expect(tooMany.data.error).toEqual({
			type: 'too-many-values',
			message: 'Schedule can have at most 10 Actors.',
		});

		expect((await server.client.schedules().list()).total).toBe(1);
	});

	it('updates, enables and deletes a schedule, computing its next run', async () => {
		const schedule = await server.client.schedules().create({
			name: 'hourly',
			cronExpression: '0 * * * *',
			actions: [{ type: 'RUN_ACTOR', actorId: '~my-actor', runOptions: { memoryMbytes: 512 } }],
		} as never);
		const actionId = schedule.actions[0]!.id;
		expect(schedule.actions[0]).toMatchObject({ actorId, runOptions: { memoryMbytes: 512 } });

		const before = Date.now();
		const enabled = await server.client.schedule(schedule.id).update({ isEnabled: true, description: 'on' });
		const nextRunAt = Date.parse(enabled.nextRunAt);
		expect(nextRunAt).toBeGreaterThanOrEqual(before);
		expect(nextRunAt - before).toBeLessThanOrEqual(60 * 60 * 1000);
		expect(new Date(nextRunAt).getUTCMinutes()).toBe(0);
		expect(enabled.description).toBe('on');

		// The platform's shortcut spread: @daily lands somewhere in the first six hours of a day.
		const daily = await server.client.schedule(schedule.id).update({ cronExpression: '@daily' });
		const dailyNext = new Date(daily.nextRunAt);
		expect(dailyNext.getUTCHours() * 60 + dailyNext.getUTCMinutes()).toBeGreaterThanOrEqual(5);
		expect(dailyNext.getUTCHours()).toBeLessThan(6);

		// Actions are replaced as a whole; a known id is kept, an unknown one is not.
		const task = await server.client.tasks().create({ actId: actorId } as never);
		const replaced = await server.client.schedule(schedule.id).update({
			actions: [
				{ id: actionId, type: 'RUN_ACTOR', actorId },
				{ id: 'madeUpId', type: 'RUN_ACTOR_TASK', actorTaskId: task.id },
			],
		} as never);
		expect(replaced.actions[0]!.id).toBe(actionId);
		expect(replaced.actions[1]!.id).not.toBe('madeUpId');
		const untouched = await server.client.schedule(schedule.id).update({ title: 'Hourly' });
		expect(untouched.actions).toHaveLength(2);

		const disabled = await server.client.schedule(schedule.id).update({ isEnabled: false });
		expect(disabled.nextRunAt).toBeNull();

		await server.client.schedule(schedule.id).delete();
		expect(await server.client.schedule(schedule.id).get()).toBeUndefined();
		expect((await call('delete', `schedules/${schedule.id}`)).status).toBe(404);
	});

	it('invoking runs every action as the scheduler would, and logs it', async () => {
		const task = await server.client
			.tasks()
			.create({ actId: actorId, input: { query: 'saved', maxPages: 2 } } as never);
		const schedule = await server.client.schedules().create({
			actions: [
				{ type: 'RUN_ACTOR', actorId, runInput: { body: '{"maxPages": 7}', contentType: 'application/json' } },
				{ type: 'RUN_ACTOR_TASK', actorTaskId: task.id, input: { maxPages: 9 } },
			],
		} as never);
		const [actorAction, taskAction] = schedule.actions;

		const invoked = await call('post', `schedules/${schedule.id}/invoke`);
		expect(invoked.status).toBe(201);
		expect(invoked.data).toEqual({});

		const runs = await waitFor(async () => {
			const started = await scheduledRuns(schedule.id);
			return started.length === 2 ? started : undefined;
		});
		const actorRun = runs.find((run) => !run.actorTaskId)!;
		const taskRun = runs.find((run) => run.actorTaskId === task.id)!;
		expect(actorRun.meta).toEqual({
			origin: 'SCHEDULER',
			scheduleId: schedule.id,
			scheduledAct2Id: actorAction!.id,
			scheduledAt: expect.any(String),
		});
		expect(taskRun.meta).toMatchObject({ origin: 'SCHEDULER', scheduledActorTaskId: taskAction!.id });
		expect(await runInput(actorRun.id)).toEqual({ maxPages: 7 });
		expect(await runInput(taskRun.id)).toEqual({ query: 'saved', maxPages: 9 });

		const last = await server.client
			.actor(actorId)
			.lastRun({ origin: 'SCHEDULER' } as never)
			.get();
		expect(last?.meta).toMatchObject({ origin: 'SCHEDULER', scheduleId: schedule.id });

		const log = await server.client.schedule(schedule.id).getLog();
		expect(log).toEqual([{ level: 'INFO', message: 'Schedule invoked manually', createdAt: expect.any(Date) }]);
		// A manual invocation leaves the schedule's own run times alone.
		expect(await server.client.schedule(schedule.id).get()).toMatchObject({ lastRunAt: null, nextRunAt: null });
	});

	it('an exclusive schedule skips an action whose previous run is still going', async () => {
		scripted.runUntilAborted();
		const schedule = await server.client.schedules().create({ actions: [{ type: 'RUN_ACTOR', actorId }] } as never);
		await call('post', `schedules/${schedule.id}/invoke`);
		await call('post', `schedules/${schedule.id}/invoke`);
		expect(await scheduledRuns(schedule.id)).toHaveLength(1);
		const log = (await server.client.schedule(schedule.id).getLog()) as unknown as Array<{ message: string }>;
		expect(log.map((entry) => entry.message)).toEqual([
			'Schedule invoked manually',
			`Skipping Actor "${actorId}", it must be exclusive but previous run is still running`,
			'Schedule invoked manually',
		]);

		await server.client.schedule(schedule.id).update({ isExclusive: false });
		await call('post', `schedules/${schedule.id}/invoke`);
		expect(await scheduledRuns(schedule.id)).toHaveLength(2);
		for (const run of await scheduledRuns(schedule.id)) await server.client.run(run.id).abort();
	});

	it('logs an action that cannot start, and drops the actions of a deleted Actor or task', async () => {
		const unbuilt = await server.client.actors().create({ name: 'unbuilt' });
		const task = await server.client.tasks().create({ actId: actorId } as never);
		const schedule = await server.client.schedules().create({
			actions: [
				{ type: 'RUN_ACTOR', actorId: unbuilt.id },
				{ type: 'RUN_ACTOR_TASK', actorTaskId: task.id },
			],
		} as never);
		await call('post', `schedules/${schedule.id}/invoke`);
		const log = (await server.client.schedule(schedule.id).getLog()) as unknown as Array<{ message: string }>;
		expect(log.map((entry) => entry.message)).toEqual([
			`Cannot start Actor "${unbuilt.id}": Actor has no build tagged "latest"`,
			'Schedule invoked manually',
		]);

		await server.client.actor(unbuilt.id).delete();
		expect((await server.client.schedule(schedule.id).get())?.actions).toEqual([
			{ id: schedule.actions[1]!.id, type: 'RUN_ACTOR_TASK', actorTaskId: task.id },
		]);
		await server.client.task(task.id).delete();
		expect((await server.client.schedule(schedule.id).get())?.actions).toEqual([]);
	});

	it('fires on its own at nextRunAt, then moves on to the next run', async () => {
		const schedule = await server.client.schedules().create({
			cronExpression: '*/10 * * * * *',
			isEnabled: true,
			actions: [{ type: 'RUN_ACTOR', actorId }],
		} as never);
		expect(schedule.nextRunAt).not.toBeNull();

		// Bring the run time forward instead of waiting for it; the scheduler re-arms on every write.
		const due = new Date(Date.now() + 50).toISOString();
		await getRegistries().schedules.update(schedule.id, (current) =>
			current ? { ...current, nextRunAt: due } : null,
		);

		const run = await waitFor(async () => (await scheduledRuns(schedule.id))[0]);
		expect(run.meta).toMatchObject({ origin: 'SCHEDULER', scheduleId: schedule.id, scheduledAt: due });

		const after = await waitFor(async () => {
			const current = await server.client.schedule(schedule.id).get();
			return current?.lastRunAt ? current : undefined;
		});
		expect(Date.parse(after.nextRunAt)).toBeGreaterThan(Date.parse(due));
		expect(Date.parse(after.nextRunAt) - Date.parse(after.lastRunAt)).toBeGreaterThanOrEqual(10_000);
		const log = (await server.client.schedule(schedule.id).getLog()) as unknown as Array<{ message: string }>;
		expect(log.map((entry) => entry.message)).toEqual(['Schedule invoked']);
	});
});

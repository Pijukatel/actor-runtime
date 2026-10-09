/** Covers `v2/actor-tasks/*` (`api.md`'s "Tasks") through a real `apify-client`. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import axios from 'axios';

import { capturingDriver, startTestServer, type TestServerHandle } from './helpers/test-server.js';
import { getRegistries } from '../../src/storage/registries.js';
import { generateId } from '../../src/storage/ids.js';
import { recordTaggedBuild, updateActor } from '../../src/services/actors.js';
import { openKeyValueStore } from '../../src/storage/open.js';
import type { Driver, RunContext, RunOutcome } from '../../src/driver/types.js';
import type { InputSchema } from '../../src/storage/entities.js';

const SCHEMA: InputSchema = {
	title: 'Input',
	type: 'object',
	schemaVersion: 1,
	properties: {
		query: { title: 'Query', type: 'string', editor: 'textfield', description: 'q', prefill: 'apify' },
		maxPages: { title: 'Max pages', type: 'integer', description: 'm', default: 3, minimum: 1 },
		mode: { title: 'Mode', type: 'string', editor: 'hidden', description: 'h', default: 'fast' },
	},
	required: [],
};

type RunBehaviour = (ctx: RunContext) => Promise<Omit<RunOutcome, 'timedOut'> & { timedOut?: boolean }>;

/** Runs do whatever the test sets as `behaviour`; an aborted run's container exits at once. */
function scriptedDriver() {
	let behaviour: RunBehaviour = async () => ({ exitCode: 0 });
	const envs: Array<Record<string, string>> = [];
	const releases = new Map<string, () => void>();
	const driver: Driver = {
		...capturingDriver().driver,
		async startRun(ctx) {
			envs.push(ctx.env);
			return { timedOut: false, ...(await behaviour(ctx)) };
		},
		async abortRun(runId) {
			releases.get(runId)?.();
		},
	};
	return {
		driver,
		envs,
		setBehaviour: (next: RunBehaviour) => (behaviour = next),
		/** Runs started from now on keep running until aborted. */
		runUntilAborted() {
			behaviour = (ctx) =>
				new Promise((resolve) => releases.set(ctx.env.ACTOR_RUN_ID!, () => resolve({ exitCode: 143 })));
		},
	};
}

describe('tasks', () => {
	let server: TestServerHandle;
	let scripted: ReturnType<typeof scriptedDriver>;
	let actorId: string;

	beforeEach(async () => {
		scripted = scriptedDriver();
		server = await startTestServer(scripted.driver);
		const actor = await server.client.actors().create({ name: 'my-actor' });
		actorId = actor.id;
		const buildId = generateId();
		await getRegistries().builds.set(buildId, {
			id: buildId,
			userId: actor.userId,
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

	function call(method: 'get' | 'post' | 'put', path: string, body?: unknown, contentType = 'application/json') {
		return axios.request({
			method,
			url: `${server.baseUrl}/v2/${path}`,
			data: body,
			headers: { Authorization: `Bearer ${server.token}`, 'Content-Type': contentType },
			validateStatus: () => true,
		});
	}

	async function runInput(runId: string): Promise<unknown> {
		const run = await server.client.run(runId).get();
		const record = await server.client.keyValueStore(run!.defaultKeyValueStoreId).getRecord('INPUT');
		return record?.value;
	}

	it('creates a task with a generated name, title and prefilled input, as the platform does', async () => {
		const first = await server.client.tasks().create({ actId: actorId } as never);
		expect(first).toMatchObject({
			actId: actorId,
			name: 'my-actor-task',
			title: 'My Actor Task',
			isPublic: false,
			options: null,
			input: { query: 'apify', mode: 'fast' },
			stats: { totalRuns: 0 },
		});
		const second = await server.client.tasks().create({ actId: 'my-actor' } as never);
		expect(second.name).toBe('my-actor-task-1');

		const { items } = await server.client.tasks().list();
		expect(items.map((task) => task.name)).toEqual(['my-actor-task', 'my-actor-task-1']);
		expect(items[0]).toMatchObject({ actName: 'my-actor', id: first.id });
	});

	it('rejects a taken or invalid name, an unknown Actor, invalid input and publishing', async () => {
		await server.client.tasks().create({ actId: actorId, name: 'taken' } as never);

		const taken = await call('post', 'actor-tasks', { actId: actorId, name: 'TAKEN' });
		expect(taken.status).toBe(409);
		expect(taken.data.error.type).toBe('actor-task-name-not-unique');

		const invalidName = await call('post', 'actor-tasks', { actId: actorId, name: '-bad name' });
		expect(invalidName.status).toBe(400);
		expect(invalidName.data.error.type).toBe('schema-validation');

		const unknownActor = await call('post', 'actor-tasks', { actId: 'nope' });
		expect(unknownActor.status).toBe(404);
		expect(unknownActor.data.error.type).toBe('record-not-found');

		const notObject = await call('post', 'actor-tasks', { actId: actorId, input: [1] });
		expect(notObject.status).toBe(403);
		expect(notObject.data.error.message).toBe('Actor task input must be object, got "array" instead.');

		const invalidInput = await call('post', 'actor-tasks', { actId: actorId, input: { maxPages: 0 } });
		expect(invalidInput.status).toBe(400);
		expect(invalidInput.data.error.type).toBe('invalid-input');

		const published = await call('post', 'actor-tasks', { actId: actorId, isPublic: true });
		expect(published.status).toBe(400);
		expect(published.data.error.type).toBe('cannot-publish-actor-task');

		expect((await server.client.tasks().list()).total).toBe(1);
	});

	it('reads, updates and deletes a task by id or by name', async () => {
		const task = await server.client.tasks().create({ actId: actorId, name: 'one' } as never);
		expect((await server.client.task('~one').get())?.id).toBe(task.id);

		const updated = await server.client.task(task.id).update({
			name: 'two',
			options: { memoryMbytes: 2048 },
			input: { query: 'crawlee' },
		});
		expect(updated).toMatchObject({ name: 'two', title: 'One', options: { memoryMbytes: 2048 } });
		expect(updated.input).toEqual({ query: 'crawlee' });
		expect(await server.client.task('~one').get()).toBeUndefined();

		const rejected = await call('put', `actor-tasks/${task.id}`, { input: { maxPages: 'x' } });
		expect(rejected.status).toBe(400);
		expect(rejected.data.error.type).toBe('invalid-input');

		await server.client.task(task.id).delete();
		expect(await server.client.task(task.id).get()).toBeUndefined();
	});

	it('reads the input bare and merges an input update into it', async () => {
		const task = await server.client.tasks().create({ actId: actorId, input: { query: 'a' } } as never);

		const read = await call('get', `actor-tasks/${task.id}/input`);
		expect(read.data).toEqual({ query: 'a' });

		expect(await server.client.task(task.id).updateInput({ maxPages: 5 })).toEqual({ query: 'a', maxPages: 5 });
		expect(await server.client.task(task.id).getInput()).toEqual({ query: 'a', maxPages: 5 });

		const invalid = await call('put', `actor-tasks/${task.id}/input`, { maxPages: 0 });
		expect(invalid.status).toBe(400);
		expect(await server.client.task(task.id).getInput()).toEqual({ query: 'a', maxPages: 5 });
	});

	it("runs the Actor with the task's input and options, the request's own merged over them", async () => {
		const task = await server.client.tasks().create({
			actId: actorId,
			input: { query: 'saved', maxPages: 2 },
			options: { memoryMbytes: 2048 },
		} as never);

		const saved = await server.client.task(task.id).call();
		expect(saved).toMatchObject({ status: 'SUCCEEDED', actorTaskId: task.id, actId: actorId });
		expect(saved.options.memoryMbytes).toBe(2048);
		expect(await runInput(saved.id)).toEqual({ query: 'saved', maxPages: 2, mode: 'fast' });
		expect(scripted.envs.at(-1)).toMatchObject({ ACTOR_TASK_ID: task.id, APIFY_ACTOR_TASK_ID: task.id });

		const overridden = await server.client.task(task.id).call({ maxPages: 7 }, { memory: 1024 });
		expect(overridden.options.memoryMbytes).toBe(1024);
		expect(await runInput(overridden.id)).toEqual({ query: 'saved', maxPages: 7, mode: 'fast' });

		const invalid = await call('post', `actor-tasks/${task.id}/runs`, { maxPages: 0 });
		expect(invalid.status).toBe(400);
		expect(invalid.data.error.type).toBe('invalid-input');
		const notJson = await call('post', `actor-tasks/${task.id}/runs`, 'x', 'text/plain');
		expect(notJson.status).toBe(403);
		const notObject = await call('post', `actor-tasks/${task.id}/runs`, [1]);
		expect(notObject.data.error.message).toBe('Provided input must be object, got "array" instead.');

		// A run of the Actor itself is not one of the task's.
		await server.client.actor(actorId).call();
		const taskRuns = await server.client.task(task.id).runs().list();
		expect(taskRuns.items.map((run) => run.id).sort()).toEqual([saved.id, overridden.id].sort());
		expect((await server.client.task(task.id).lastRun().get())?.id).toBe(overridden.id);
		expect((await server.client.task(task.id).get())?.stats).toMatchObject({ totalRuns: 2 });
	});

	it('serves run-sync for a task', async () => {
		scripted.setBehaviour(async (ctx) => {
			const store = await openKeyValueStore(ctx.env.APIFY_DEFAULT_KEY_VALUE_STORE_ID!);
			const input = await store.getValue<{ query: string }>('INPUT');
			await store.setValue('OUTPUT', { echoed: input?.query });
			return { exitCode: 0 };
		});
		const task = await server.client.tasks().create({ actId: actorId, name: 'sync' } as never);
		const response = await call('post', 'actor-tasks/~sync/run-sync', { query: 'now' });
		expect(response.status).toBe(201);
		expect(response.data).toEqual({ echoed: 'now' });
		expect((await server.client.task(task.id).lastRun().get())?.status).toBe('SUCCEEDED');
	});

	it('deleting a task aborts its unfinished runs and keeps them', async () => {
		const task = await server.client.tasks().create({ actId: actorId } as never);
		scripted.runUntilAborted();
		const run = await server.client.task(task.id).start();
		await server.client.task(task.id).delete();

		const aborted = await server.client.run(run.id).waitForFinish({ waitSecs: 5 });
		expect(aborted?.status).toBe('ABORTED');
		expect(aborted?.actorTaskId).toBe(task.id);
		const missing = await call('post', `actor-tasks/${task.id}/runs`);
		expect(missing.status).toBe(404);
	});
});

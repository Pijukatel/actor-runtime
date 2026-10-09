/** Covers `v2/webhooks/*` and `v2/webhook-dispatches/*` (`api.md`'s "Webhooks") through a real `apify-client`. */
import http, { type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import axios from 'axios';

import { capturingDriver, startTestServer, type TestServerHandle } from './helpers/test-server.js';
import { buildDto, runDto } from '../../src/api/dto/actors.js';
import { recordTaggedBuild, updateActor } from '../../src/services/actors.js';
import { transitionJobStatus } from '../../src/services/job-status.js';
import {
	setWebhookRetryBaseMillisForTests,
	startWebhookDispatcher,
	stopWebhookDispatcherForTests,
} from '../../src/services/webhook-dispatches.js';
import { generateId } from '../../src/storage/ids.js';
import { getRegistries } from '../../src/storage/registries.js';
import type { WebhookDispatchRecord } from '../../src/storage/entities.js';

interface Received {
	url: string;
	headers: IncomingHttpHeaders;
	body: Record<string, unknown>;
}

/** Records every request it gets and answers each with the next queued status (200 once they run out). */
async function startReceiver() {
	const received: Received[] = [];
	const statuses: number[] = [];
	const server: Server = http.createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on('data', (chunk: Buffer) => chunks.push(chunk));
		req.on('end', () => {
			received.push({ url: req.url!, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString()) });
			res.statusCode = statuses.shift() ?? 200;
			res.end(`answer ${received.length}`);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${port}/hook`,
		received,
		statuses,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
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

describe('webhooks', () => {
	let server: TestServerHandle;
	let receiver: Awaited<ReturnType<typeof startReceiver>>;
	let actorId: string;
	let userId: string;

	beforeEach(async () => {
		server = await startTestServer(capturingDriver().driver);
		receiver = await startReceiver();
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
		});
		await updateActor(actorId, (current) => recordTaggedBuild(current, 'latest', buildId, '0.0.1'));
	});

	afterEach(async () => {
		await server.close();
		await receiver.close();
	});

	function call(method: 'get' | 'post' | 'put', path: string, body?: unknown) {
		return axios.request({
			method,
			url: `${server.baseUrl}/v2/${path}`,
			data: body,
			headers: { Authorization: `Bearer ${server.token}`, 'Content-Type': 'application/json' },
			validateStatus: () => true,
		});
	}

	async function finishedDispatches(webhookId: string, count: number) {
		return waitFor(async () => {
			const { items } = await server.client.webhook(webhookId).dispatches().list();
			const finished = items.filter((dispatch) => dispatch.status !== 'ACTIVE');
			return finished.length >= count ? items : undefined;
		});
	}

	it('creates, reads, lists, updates and deletes a webhook with the platform defaults', async () => {
		const created = await server.client.webhooks().create({
			eventTypes: ['ACTOR.RUN.SUCCEEDED'],
			condition: { actorId },
			requestUrl: receiver.url,
		} as never);
		expect(created).toMatchObject({
			userId,
			isEnabled: true,
			isAdHoc: false,
			actionType: 'HTTP_REQUEST',
			ignoreSslErrors: false,
			doNotRetry: false,
			shouldInterpolateStrings: false,
			lastDispatch: null,
			stats: { totalDispatches: 0 },
		});
		expect(created.payloadTemplate).toContain('"resource": {{resource}}');

		expect(await server.client.webhook(created.id).get()).toMatchObject({ id: created.id });
		const { items } = await server.client.webhooks().list();
		expect(items).toHaveLength(1);
		expect(items[0]).not.toHaveProperty('payloadTemplate');
		const actorWebhooks = await server.client.actor(actorId).webhooks().list();
		expect(actorWebhooks.items.map((webhook) => webhook.id)).toEqual([created.id]);
		expect(actorWebhooks.items[0]).toHaveProperty('payloadTemplate');

		const updated = await server.client.webhook(created.id).update({ isEnabled: false, title: 'Mine' });
		expect(updated).toMatchObject({ isEnabled: false, title: 'Mine', requestUrl: receiver.url });

		await server.client.webhook(created.id).delete();
		expect(await server.client.webhook(created.id).get()).toBeUndefined();
	});

	it('rejects what the platform rejects', async () => {
		const valid = { eventTypes: ['ACTOR.RUN.SUCCEEDED'], condition: { actorId }, requestUrl: receiver.url };
		const cases: Array<[unknown, number, string]> = [
			[{ ...valid, condition: { actorId, actorTaskId: actorId } }, 400, "Webhook condition isn't valid."],
			[{ ...valid, eventTypes: [] }, 400, 'You must specify at least 1 values'],
			[{ ...valid, eventTypes: ['NOPE'] }, 400, 'NOPE is not an allowed value'],
			[{ ...valid, requestUrl: 'ftp://example.com' }, 400, 'Webhook URL must be a valid URL.'],
			[
				{ ...valid, payloadTemplate: '{"a": {{nope}}}' },
				400,
				'Invalid variable enclosed in double curly braces. See the docs for valid variables.',
			],
			[
				{ ...valid, payloadTemplate: '{"a": ' },
				400,
				'Aside from variables enclosed in double curly braces, the template must be valid JSON.',
			],
			[{ ...valid, isAdHoc: true }, 400, 'Ad hoc webhook can only be set for Actor runs.'],
		];
		for (const [body, status, message] of cases) {
			const response = await call('post', 'webhooks', body);
			expect(response.status, message).toBe(status);
			expect(response.data.error).toEqual({ type: 'schema-validation', message });
		}

		const slack = await call('post', 'webhooks', { ...valid, actionType: 'SLACK_MESSAGE' });
		expect(slack.status).toBe(400);
		expect(slack.data.error.type).toBe('invalid-request');

		const unknownActor = await call('post', 'webhooks', { ...valid, condition: { actorId: 'A'.repeat(17) } });
		expect(unknownActor.status).toBe(404);
		expect(unknownActor.data.error.type).toBe('record-not-found');
	});

	it('returns the existing webhook for a repeated idempotency key', async () => {
		const body = {
			eventTypes: ['ACTOR.RUN.SUCCEEDED'],
			condition: { actorId },
			requestUrl: receiver.url,
			idempotencyKey: 'once',
		};
		const first = await server.client.webhooks().create(body as never);
		const second = await server.client.webhooks().create(body as never);
		expect(second.id).toBe(first.id);
		expect((await server.client.webhooks().list()).total).toBe(1);
	});

	it("delivers an Actor's run events with the default payload and records each dispatch", async () => {
		const webhook = await server.client.webhooks().create({
			eventTypes: ['ACTOR.RUN.CREATED', 'ACTOR.RUN.SUCCEEDED'],
			condition: { actorId },
			requestUrl: receiver.url,
		} as never);
		const run = await server.client.actor(actorId).call();

		const dispatches = await finishedDispatches(webhook.id, 2);
		expect(receiver.received.map((request) => request.body.eventType)).toEqual([
			'ACTOR.RUN.CREATED',
			'ACTOR.RUN.SUCCEEDED',
		]);
		const succeeded = receiver.received[1]!;
		expect(succeeded.body).toMatchObject({
			userId,
			eventType: 'ACTOR.RUN.SUCCEEDED',
			eventData: { actorId, actorRunId: run.id },
			resource: { id: run.id, actId: actorId, status: 'SUCCEEDED' },
		});
		expect(succeeded.headers).toMatchObject({
			'content-type': 'application/json',
			'x-apify-webhook': 'yo',
			'x-apify-request-origin': 'WEBHOOK',
		});
		expect(succeeded.headers.authorization).toBeUndefined();

		expect(dispatches.map((dispatch) => dispatch.status)).toEqual(['SUCCEEDED', 'SUCCEEDED']);
		expect(dispatches[1]).toMatchObject({
			webhookId: webhook.id,
			eventType: 'ACTOR.RUN.SUCCEEDED',
			webhook: { requestUrl: receiver.url, isAdHoc: false, condition: { actorId } },
			calls: [{ responseStatus: 200, responseBody: 'answer 2', errorMessage: null }],
		});
		expect(succeeded.headers['x-apify-webhook-dispatch-id']).toBe(dispatches[1]!.id);
		expect(await server.client.webhookDispatch(dispatches[1]!.id).get()).toMatchObject({ id: dispatches[1]!.id });
		expect((await server.client.webhookDispatches().list()).total).toBe(2);
		expect(await server.client.webhook(webhook.id).get()).toMatchObject({
			stats: { totalDispatches: 2 },
			lastDispatch: { status: 'SUCCEEDED' },
		});
	});

	it('renders payload and headers templates, interpolating strings when asked', async () => {
		const webhook = await server.client.webhooks().create({
			eventTypes: ['ACTOR.RUN.SUCCEEDED'],
			condition: { actorId },
			requestUrl: `${receiver.url}?q=1`,
			payloadTemplate: '{"runId": {{resource.id}}, "text": "Run {{resource.id}} is {{resource.status}}"}',
			headersTemplate: '{"X-Custom": "abc", "X-Dataset": {{resource.defaultDatasetId}}}',
			shouldInterpolateStrings: true,
		} as never);
		const run = await server.client.actor(actorId).call();
		await finishedDispatches(webhook.id, 1);

		const [request] = receiver.received;
		expect(request!.url).toBe('/hook?q=1');
		expect(request!.body).toEqual({ runId: run.id, text: `Run ${run.id} is SUCCEEDED` });
		expect(request!.headers['x-custom']).toBe('abc');
		expect(request!.headers['x-dataset']).toBe(run.defaultDatasetId);
	});

	it('retries a failing endpoint with backoff, and gives up at once with doNotRetry', async () => {
		setWebhookRetryBaseMillisForTests(10);
		receiver.statuses.push(500, 503);
		const retried = await server.client.webhooks().create({
			eventTypes: ['ACTOR.RUN.SUCCEEDED'],
			condition: { actorId },
			requestUrl: receiver.url,
		} as never);
		await server.client.actor(actorId).call();
		const [dispatch] = await finishedDispatches(retried.id, 1);
		expect(dispatch!.status).toBe('SUCCEEDED');
		expect(dispatch!.calls.map((attempt) => attempt.responseStatus)).toEqual([500, 503, 200]);
		expect(dispatch!.calls[0]!.errorMessage).toBe('Endpoint responded with HTTP status code 500');

		await server.client.webhook(retried.id).delete();
		receiver.statuses.push(500);
		const once = await server.client.webhooks().create({
			eventTypes: ['ACTOR.RUN.SUCCEEDED'],
			condition: { actorId },
			requestUrl: receiver.url,
			doNotRetry: true,
		} as never);
		await server.client.actor(actorId).call();
		const [failed] = await finishedDispatches(once.id, 1);
		expect(failed).toMatchObject({ status: 'FAILED', calls: [{ responseStatus: 500 }] });
		expect(await server.client.webhook(once.id).get()).toMatchObject({ lastDispatch: { status: 'FAILED' } });
	});

	it("fires a task's webhook for that task's runs only", async () => {
		const task = await server.client.tasks().create({ actId: actorId, name: 'my-task' } as never);
		const webhook = await server.client.webhooks().create({
			eventTypes: ['ACTOR.RUN.SUCCEEDED'],
			condition: { actorTaskId: task.id },
			requestUrl: receiver.url,
		} as never);
		expect((await server.client.task(task.id).webhooks().list()).items.map((item) => item.id)).toEqual([
			webhook.id,
		]);

		await server.client.actor(actorId).call();
		const run = await server.client.task(task.id).call();
		await finishedDispatches(webhook.id, 1);
		expect(receiver.received).toHaveLength(1);
		expect(receiver.received[0]!.body.eventData).toEqual({ actorId, actorTaskId: task.id, actorRunId: run.id });

		await server.client.task(task.id).delete();
		expect(await server.client.webhook(webhook.id).get()).toBeUndefined();
	});

	it('does not fire a disabled webhook, but its test dispatch is delivered', async () => {
		const webhook = await server.client.webhooks().create({
			eventTypes: ['ACTOR.RUN.SUCCEEDED'],
			condition: { actorId },
			requestUrl: receiver.url,
			isEnabled: false,
		} as never);
		const run = await server.client.actor(actorId).call();

		const test = await server.client.webhook(webhook.id).test();
		expect(test).toMatchObject({ eventType: 'TEST', status: 'ACTIVE', eventData: null });
		await finishedDispatches(webhook.id, 1);
		expect(receiver.received).toHaveLength(1);
		expect(receiver.received[0]!.body).toMatchObject({ eventType: 'TEST', resource: { joke: expect.any(String) } });

		const withRun = await call('post', `webhooks/${webhook.id}/test`, { resourceId: run.id, resourceType: 'RUN' });
		expect(withRun.status).toBe(201);
		await finishedDispatches(webhook.id, 2);
		expect(receiver.received[1]!.body).toMatchObject({
			eventType: 'TEST',
			eventData: { actorId, actorRunId: run.id },
			resource: { id: run.id },
		});
	});

	it('removes an ad-hoc webhook its run can no longer fire', async () => {
		const run = await server.client.actor(actorId).start();
		const webhook = await server.client.webhooks().create({
			eventTypes: ['ACTOR.RUN.FAILED'],
			condition: { actorRunId: run.id },
			requestUrl: receiver.url,
			isAdHoc: true,
		} as never);
		await server.client.run(run.id).waitForFinish();
		await waitFor(async () => (await server.client.webhook(webhook.id).get()) === undefined);
		expect(receiver.received).toHaveLength(0);
	});

	it("authenticates a request to the runtime's own API as the webhook's owner", async () => {
		const webhook = await server.client.webhooks().create({
			eventTypes: ['ACTOR.RUN.SUCCEEDED'],
			condition: { actorId },
			requestUrl: `${server.baseUrl}/v2/key-value-stores?name=from-webhook`,
		} as never);
		await server.client.actor(actorId).call();
		const [dispatch] = await finishedDispatches(webhook.id, 1);
		expect(dispatch).toMatchObject({ status: 'SUCCEEDED', calls: [{ responseStatus: 201 }] });
		expect(await server.client.keyValueStores().getOrCreate('from-webhook')).toMatchObject({ userId });
	});

	it('delivers build events', async () => {
		const webhook = await server.client.webhooks().create({
			eventTypes: ['ACTOR.BUILD.CREATED', 'ACTOR.BUILD.FAILED'],
			condition: { actorId },
			requestUrl: receiver.url,
		} as never);
		const buildId = generateId();
		await getRegistries().builds.set(buildId, {
			id: buildId,
			userId,
			actorId,
			versionNumber: '0.0',
			buildNumber: '0.0.2',
			tag: 'latest',
			status: 'RUNNING',
			startedAt: new Date().toISOString(),
		});
		await transitionJobStatus(getRegistries().builds, buildId, 'FAILED', { finishedAt: new Date().toISOString() });
		await finishedDispatches(webhook.id, 2);
		expect(receiver.received.map((request) => [request.body.eventType, request.body.eventData])).toEqual([
			['ACTOR.BUILD.CREATED', { actorId, actorBuildId: buildId }],
			['ACTOR.BUILD.FAILED', { actorId, actorBuildId: buildId }],
		]);
		expect(receiver.received[1]!.body.resource).toMatchObject({ id: buildId, status: 'FAILED' });
	});

	it('deletes the webhooks of a deleted Actor', async () => {
		const webhook = await server.client.webhooks().create({
			eventTypes: ['ACTOR.RUN.SUCCEEDED'],
			condition: { actorId },
			requestUrl: receiver.url,
		} as never);
		await server.client.actor(actorId).delete();
		expect(await server.client.webhook(webhook.id).get()).toBeUndefined();
	});

	it('resumes an unfinished dispatch after a restart', async () => {
		const webhook = await server.client.webhooks().create({
			eventTypes: ['ACTOR.RUN.SUCCEEDED'],
			condition: { actorId },
			requestUrl: receiver.url,
		} as never);
		await stopWebhookDispatcherForTests();
		const now = new Date().toISOString();
		const dispatch: WebhookDispatchRecord = {
			id: generateId(),
			userId,
			webhookId: webhook.id,
			createdAt: now,
			finishedAt: null,
			status: 'ACTIVE',
			eventType: 'ACTOR.RUN.SUCCEEDED',
			eventData: { actorId, actorRunId: 'r'.repeat(17) },
			webhook: (await getRegistries().webhooks.get(webhook.id))!,
			resource: { id: 'r'.repeat(17) },
			callAt: now,
			calls: [],
		};
		await getRegistries().webhookDispatches.set(dispatch.id, dispatch);
		const port = Number(new URL(server.baseUrl).port);
		await startWebhookDispatcher({ apiPort: port, runResource: (run) => runDto(run), buildResource: buildDto });

		await finishedDispatches(webhook.id, 1);
		expect(receiver.received[0]!.body).toMatchObject({
			eventType: 'ACTOR.RUN.SUCCEEDED',
			resource: { id: 'r'.repeat(17) },
		});
	});
});

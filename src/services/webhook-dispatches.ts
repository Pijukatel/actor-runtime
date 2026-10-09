/**
 * Webhook dispatches (`api.md`'s "Webhooks"), after apify-core's `WebhookDispatchCreator`,
 * `WebhookDispatchSender` and `HttpWebhookHandler`: every run and build event creates one dispatch per
 * webhook it matches, and each dispatch is delivered as an HTTP POST, retried with exponential backoff.
 */
import http from 'node:http';
import https from 'node:https';

import { WebhookPayloadTemplate } from '@apify/utilities';

import { API_PORT, CONSOLE_BASE_URL } from '../config.js';
import type {
	BuildRecord,
	JobStatus,
	RunRecord,
	WebhookDispatchCall,
	WebhookDispatchRecord,
	WebhookDispatchStatus,
	WebhookRecord,
} from '../storage/entities.js';
import { generateId } from '../storage/ids.js';
import { getRegistries } from '../storage/registries.js';
import { isTerminalJobStatus } from './job-status.js';
import { getUserById } from './users.js';
import { deleteWebhook, getWebhookById, listAllWebhooks, updateWebhook } from './webhooks.js';

type Resource = Record<string, unknown>;
type EventData = Record<string, string>;

const RUN_TERMINAL_EVENTS: Partial<Record<JobStatus, string>> = {
	SUCCEEDED: 'ACTOR.RUN.SUCCEEDED',
	FAILED: 'ACTOR.RUN.FAILED',
	'TIMED-OUT': 'ACTOR.RUN.TIMED_OUT',
	ABORTED: 'ACTOR.RUN.ABORTED',
};
const BUILD_TERMINAL_EVENTS: Partial<Record<JobStatus, string>> = {
	SUCCEEDED: 'ACTOR.BUILD.SUCCEEDED',
	FAILED: 'ACTOR.BUILD.FAILED',
	'TIMED-OUT': 'ACTOR.BUILD.TIMED_OUT',
	ABORTED: 'ACTOR.BUILD.ABORTED',
};

/** The platform's retry schedule: 1 min, doubling, +-25%, at most 11 retries (3 for a test dispatch). */
const BACKOFF_VARIANCE_RATIO = 0.25;
const MAX_RETRIES = 11;
const MAX_TEST_RETRIES = 3;
const REQUEST_TIMEOUT_MILLIS = 2 * 60 * 1000;
const RESPONSE_BODY_MAX_BYTES = 2 * 1024;
let backoffBaseMillis = 60 * 1000;

/** The platform's test dispatches carry a joke instead of a run or build. */
const TEST_JOKES = [
	'Chuck Norris can unit test an entire application with a single assert.',
	'Chuck Norris does not need to retry webhooks. They arrive on the first attempt.',
	"Chuck Norris's code never needs a debugger. The bugs confess on their own.",
];

export interface WebhookDispatcherOptions {
	/** The port this process's own API listens on, to which a request addressed to the runtime is sent. */
	apiPort: number;
	runResource(run: RunRecord): Resource;
	buildResource(build: BuildRecord): Resource;
}

let options: WebhookDispatcherOptions | undefined;
let unsubscribers: Array<() => void> = [];
/** Events are turned into dispatches one at a time, in the order they happened. */
let eventQueue: Promise<void> = Promise.resolve();
const timers = new Map<string, NodeJS.Timeout>();
const inFlight = new Set<Promise<void>>();

export interface WebhookEvent {
	userId: string;
	eventType: string;
	eventData: EventData;
	resource: Resource;
}

function runEventData(run: RunRecord): EventData {
	return { actorId: run.actorId, ...(run.actorTaskId ? { actorTaskId: run.actorTaskId } : {}), actorRunId: run.id };
}

function buildEventData(build: BuildRecord): EventData {
	return { actorId: build.actorId, actorBuildId: build.id };
}

/** What one write to a job record means: creation, a resurrection, reaching a terminal status, or nothing. */
function jobEventTypes<T extends { status: JobStatus }>(
	previous: T | null,
	next: T,
	group: 'RUN' | 'BUILD',
	terminalEvents: Partial<Record<JobStatus, string>>,
): string[] {
	const events: string[] = [];
	if (!previous) events.push(`ACTOR.${group}.CREATED`);
	else if (group === 'RUN' && isTerminalJobStatus(previous.status) && !isTerminalJobStatus(next.status)) {
		events.push('ACTOR.RUN.RESURRECTED');
	}
	const terminal = terminalEvents[next.status];
	if (terminal && previous?.status !== next.status) events.push(terminal);
	return events;
}

export function runEventForDispatch(run: RunRecord, eventType: string, resource: Resource): WebhookEvent {
	return { userId: run.userId, eventType, eventData: runEventData(run), resource };
}

export function buildEventForDispatch(build: BuildRecord, eventType: string, resource: Resource): WebhookEvent {
	return { userId: build.userId, eventType, eventData: buildEventData(build), resource };
}

/** Subscribes to run and build writes and resumes the dispatches a previous process left unfinished. */
export async function startWebhookDispatcher(dispatcherOptions: WebhookDispatcherOptions): Promise<void> {
	options = dispatcherOptions;
	const registries = getRegistries();
	unsubscribers = [
		registries.runs.onChange((previous, next) => {
			if (!next) return;
			for (const eventType of jobEventTypes(previous, next, 'RUN', RUN_TERMINAL_EVENTS)) {
				enqueueEvent(runEventForDispatch(next, eventType, dispatcherOptions.runResource(next)));
			}
		}),
		registries.builds.onChange((previous, next) => {
			if (!next) return;
			for (const eventType of jobEventTypes(previous, next, 'BUILD', BUILD_TERMINAL_EVENTS)) {
				enqueueEvent(buildEventForDispatch(next, eventType, dispatcherOptions.buildResource(next)));
			}
		}),
	];
	for (const dispatch of await registries.webhookDispatches.list()) {
		if (dispatch.status === 'ACTIVE') scheduleAttempt(dispatch.id, Date.parse(dispatch.callAt) - Date.now());
	}
}

function enqueueEvent(event: WebhookEvent): void {
	eventQueue = eventQueue
		.then(() => createDispatches(event))
		.catch((error: unknown) => console.error('Creating webhook dispatches failed:', error));
}

function conditionMatches(webhook: WebhookRecord, eventData: EventData): boolean {
	const condition = webhook.condition as Record<string, string>;
	return Object.entries(condition).every(([key, id]) => eventData[key] === id);
}

/** As on the platform: once a run finishes one way, its ad-hoc webhooks waiting only for another way can
 * never fire. */
async function deleteObsoleteAdHocWebhooks(event: WebhookEvent, webhooks: WebhookRecord[]): Promise<void> {
	const terminal = Object.values(RUN_TERMINAL_EVENTS);
	if (!terminal.includes(event.eventType)) return;
	for (const webhook of webhooks) {
		if (!webhook.isAdHoc || !('actorRunId' in webhook.condition)) continue;
		if (webhook.condition.actorRunId !== event.eventData.actorRunId) continue;
		if (webhook.eventTypes.includes(event.eventType)) continue;
		if (webhook.eventTypes.some((eventType) => terminal.includes(eventType))) await deleteWebhook(webhook.id);
	}
}

async function createDispatches(event: WebhookEvent): Promise<void> {
	const owned = (await listAllWebhooks()).filter((webhook) => webhook.userId === event.userId);
	await deleteObsoleteAdHocWebhooks(event, owned);
	const matching = owned.filter(
		(webhook) =>
			webhook.isEnabled &&
			webhook.eventTypes.includes(event.eventType) &&
			conditionMatches(webhook, event.eventData),
	);
	for (const webhook of matching) {
		await insertDispatch(webhook, event);
		await updateWebhook(webhook.id, (current) => ({
			...current,
			stats: { ...current.stats, totalDispatches: current.stats.totalDispatches + 1 },
		}));
	}
}

async function insertDispatch(
	webhook: WebhookRecord,
	event: Omit<WebhookEvent, 'eventData'> & { eventData: EventData | null },
): Promise<WebhookDispatchRecord> {
	const now = new Date().toISOString();
	const dispatch: WebhookDispatchRecord = {
		id: generateId(),
		userId: event.userId,
		webhookId: webhook.id,
		createdAt: now,
		finishedAt: null,
		status: 'ACTIVE',
		eventType: event.eventType,
		eventData: event.eventData,
		webhook,
		resource: event.resource,
		callAt: now,
		calls: [],
	};
	await getRegistries().webhookDispatches.set(dispatch.id, dispatch);
	scheduleAttempt(dispatch.id, 0);
	return dispatch;
}

export async function listOwnedWebhookDispatches(userId: string): Promise<WebhookDispatchRecord[]> {
	return (await listAllWebhookDispatches()).filter((dispatch) => dispatch.userId === userId);
}

export async function getOwnedWebhookDispatch(userId: string, id: string): Promise<WebhookDispatchRecord | null> {
	const dispatch = await getRegistries().webhookDispatches.get(id);
	return dispatch && dispatch.userId === userId ? dispatch : null;
}

/** Cross-user listing, for the console only. */
export async function listAllWebhookDispatches(): Promise<WebhookDispatchRecord[]> {
	return getRegistries().webhookDispatches.list();
}

/** Cross-user lookup by id, for the console only. */
export async function getWebhookDispatchById(id: string): Promise<WebhookDispatchRecord | null> {
	return getRegistries().webhookDispatches.get(id);
}

/** `POST /v2/webhooks/:webhookId/test`: dispatched even while the webhook is disabled, as on the platform. */
export async function createTestDispatch(
	webhook: WebhookRecord,
	withResource?: { eventData: EventData; resource: Resource },
): Promise<WebhookDispatchRecord> {
	const joke = TEST_JOKES[Math.floor(Math.random() * TEST_JOKES.length)]!;
	return insertDispatch(webhook, {
		userId: webhook.userId,
		eventType: 'TEST',
		eventData: withResource?.eventData ?? null,
		resource: withResource?.resource ?? { joke },
	});
}

function scheduleAttempt(dispatchId: string, delayMillis: number): void {
	clearTimeout(timers.get(dispatchId));
	const timer = setTimeout(
		() => {
			timers.delete(dispatchId);
			const attempt = attemptDispatch(dispatchId)
				.catch((error: unknown) => console.error(`Webhook dispatch ${dispatchId} failed:`, error))
				.finally(() => inFlight.delete(attempt));
			inFlight.add(attempt);
		},
		Math.max(0, delayMillis),
	);
	timer.unref();
	timers.set(dispatchId, timer);
}

function newCall(): WebhookDispatchCall {
	return {
		startedAt: new Date().toISOString(),
		finishedAt: null,
		errorMessage: null,
		responseStatus: null,
		responseBody: null,
	};
}

async function attemptDispatch(dispatchId: string): Promise<void> {
	const dispatch = await getRegistries().webhookDispatches.get(dispatchId);
	if (!dispatch || dispatch.status !== 'ACTIVE') return;
	const call = newCall();
	const webhook = await getWebhookById(dispatch.webhookId);
	if (!webhook || (!webhook.isEnabled && dispatch.eventType !== 'TEST')) {
		call.errorMessage = `Webhook was ${webhook ? 'disabled' : 'removed'}.`;
		await finishAttempt(dispatch, call, 'FAILED');
		return;
	}
	await finishAttempt(dispatch, call, await deliver(dispatch, call));
}

async function finishAttempt(
	dispatch: WebhookDispatchRecord,
	call: WebhookDispatchCall,
	outcome: WebhookDispatchStatus,
): Promise<void> {
	const finishedAt = new Date().toISOString();
	call.finishedAt = finishedAt;
	let status = outcome;
	let callAt = dispatch.callAt;
	if (status === 'ACTIVE') {
		const maxRetries = dispatch.eventType === 'TEST' ? MAX_TEST_RETRIES : MAX_RETRIES;
		if (!dispatch.webhook.doNotRetry && dispatch.calls.length < maxRetries) {
			const delay = backoffBaseMillis * 2 ** dispatch.calls.length;
			const randomized = delay * (1 + (Math.random() * 2 - 1) * BACKOFF_VARIANCE_RATIO);
			callAt = new Date(Date.now() + randomized).toISOString();
		} else {
			status = 'FAILED';
		}
	}
	const final = status !== 'ACTIVE';
	await getRegistries().webhookDispatches.update(dispatch.id, (current) =>
		current
			? {
					...current,
					status,
					callAt,
					finishedAt: final ? finishedAt : null,
					calls: [...current.calls, call],
				}
			: null,
	);
	await updateWebhook(dispatch.webhookId, (current) => ({
		...current,
		lastDispatch: { status, finishedAt: final ? finishedAt : null },
	}));
	if (!final) scheduleAttempt(dispatch.id, Date.parse(callAt) - Date.now());
}

const OWN_API_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', 'apify-api']);

/** A URL naming this runtime's own API - as the host (`localhost:3333`), as Actor containers know it
 * (`apify-api:3333`) or through a standby address (`<label>.localhost:3333`). */
function isOwnApiUrl(url: URL): boolean {
	const hostname = url.hostname.toLowerCase();
	const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
	if (url.protocol !== 'http:' || port !== (options?.apiPort ?? API_PORT)) return false;
	return OWN_API_HOSTNAMES.has(hostname) || hostname.endsWith('.localhost');
}

/** The platform's `RunLinksGenerator`, pointed at this runtime's own console and API. */
function resourceLinks(resource: Resource): Record<string, unknown> {
	const apiBaseUrl = `http://localhost:${API_PORT}/v2`;
	const links =
		typeof resource.defaultDatasetId === 'string' && typeof resource.id === 'string'
			? {
					publicRunUrl: `${CONSOLE_BASE_URL}/runs/${resource.id}`,
					consoleRunUrl: `${CONSOLE_BASE_URL}/actors/${String(resource.actId)}/runs/${resource.id}`,
					apiRunUrl: `${apiBaseUrl}/actor-runs/${resource.id}`,
					apiDefaultDatasetUrl: `${apiBaseUrl}/datasets/${resource.defaultDatasetId}`,
					apiDefaultKeyValueStoreUrl: `${apiBaseUrl}/key-value-stores/${String(resource.defaultKeyValueStoreId)}`,
					containerRunUrl: resource.containerUrl,
				}
			: {};
	const storageIds = resource.storageIds as Record<string, Record<string, string>> | undefined;
	const storages: Record<string, Record<string, { id: string; apiUrl: string }>> = {};
	if (storageIds) {
		const paths = { datasets: 'datasets', keyValueStores: 'key-value-stores', requestQueues: 'request-queues' };
		for (const [kind, path] of Object.entries(paths)) {
			storages[kind] = Object.fromEntries(
				Object.entries(storageIds[kind] ?? {}).map(([alias, id]) => [
					alias,
					{ id, apiUrl: `${apiBaseUrl}/${path}/${id}` },
				]),
			);
		}
	}
	return { ...resource, links, storages };
}

function renderTemplate(template: string, dispatch: WebhookDispatchRecord): Record<string, unknown> {
	const createdAt = new Date(dispatch.createdAt);
	return WebhookPayloadTemplate.parse(
		template,
		null,
		{
			userId: dispatch.userId,
			eventType: dispatch.eventType,
			eventData: dispatch.eventData,
			createdAt: dispatch.createdAt,
			resource: resourceLinks(dispatch.resource),
			globals: { dateISO: createdAt.toISOString(), dateUnix: Math.floor(createdAt.getTime() / 1000) },
		},
		{ interpolateStrings: dispatch.webhook.shouldInterpolateStrings },
	);
}

/** One attempt. `ACTIVE` means it should be retried; a template or URL that can never work is `FAILED`. */
async function deliver(dispatch: WebhookDispatchRecord, call: WebhookDispatchCall): Promise<WebhookDispatchStatus> {
	const { webhook } = dispatch;
	let url: URL;
	let body: string;
	const headers: Record<string, string> = {};
	try {
		url = new URL(webhook.requestUrl);
		if (url.protocol !== 'http:' && url.protocol !== 'https:') {
			throw new Error('Webhook must use a valid http:// or https:// URL');
		}
		body = JSON.stringify(renderTemplate(webhook.payloadTemplate, dispatch));
		if (webhook.headersTemplate) {
			for (const [name, value] of Object.entries(renderTemplate(webhook.headersTemplate, dispatch))) {
				headers[name] = typeof value === 'string' ? value : JSON.stringify(value);
			}
		}
	} catch (error) {
		call.errorMessage = (error as Error).message;
		return 'FAILED';
	}

	Object.assign(headers, {
		Host: url.host,
		'Content-Type': 'application/json',
		'X-Apify-Webhook': 'yo',
		'X-Apify-Webhook-Dispatch-Id': dispatch.id,
		'X-Apify-Request-Origin': 'WEBHOOK',
	});
	const ownApi = isOwnApiUrl(url);
	// As on the platform, a request to the Apify API without a token is authenticated as the webhook's owner.
	if (ownApi && !url.searchParams.get('token')) {
		const user = await getUserById(dispatch.userId);
		if (user) headers.Authorization = `Bearer ${user.token}`;
	}

	try {
		const response = await post(url, headers, body, {
			ignoreSslErrors: webhook.ignoreSslErrors,
			connectTo: ownApi ? { hostname: '127.0.0.1', port: options?.apiPort ?? API_PORT } : undefined,
		});
		call.responseStatus = response.status;
		call.responseBody = response.body;
		if (response.status < 200 || response.status > 299) {
			call.errorMessage = `Endpoint responded with HTTP status code ${response.status}`;
			return 'ACTIVE';
		}
		return 'SUCCEEDED';
	} catch (error) {
		call.errorMessage = `Failed to handle dispatch: ${(error as Error).message}`;
		return 'ACTIVE';
	}
}

function post(
	url: URL,
	headers: Record<string, string>,
	body: string,
	{ ignoreSslErrors, connectTo }: { ignoreSslErrors: boolean; connectTo?: { hostname: string; port: number } },
): Promise<{ status: number; body: string | null }> {
	const client = url.protocol === 'https:' ? https : http;
	return new Promise((resolve, reject) => {
		const request = client.request(
			{
				method: 'POST',
				protocol: url.protocol,
				hostname: connectTo?.hostname ?? url.hostname.replace(/^\[(.*)\]$/, '$1'),
				port: connectTo?.port ?? url.port,
				path: `${url.pathname}${url.search}`,
				headers: { ...headers, 'Content-Length': String(Buffer.byteLength(body)) },
				timeout: REQUEST_TIMEOUT_MILLIS,
				...(url.protocol === 'https:'
					? { rejectUnauthorized: !ignoreSslErrors, servername: url.hostname }
					: {}),
			},
			(response) => {
				const chunks: Buffer[] = [];
				let length = 0;
				response.on('data', (chunk: Buffer) => {
					if (length < RESPONSE_BODY_MAX_BYTES) chunks.push(chunk);
					length += chunk.length;
				});
				response.on('end', () => {
					const received = Buffer.concat(chunks).subarray(0, RESPONSE_BODY_MAX_BYTES);
					resolve({
						status: response.statusCode ?? 0,
						body: received.length > 0 ? received.toString('utf8') : null,
					});
				});
				response.on('error', reject);
			},
		);
		request.on('timeout', () => request.destroy(new Error('timeout of 120000ms exceeded')));
		request.on('error', reject);
		request.end(body);
	});
}

/** Test-only: shortens the retry schedule. */
export function setWebhookRetryBaseMillisForTests(millis: number): void {
	backoffBaseMillis = millis;
}

/** Test-only: stops the dispatcher and waits for whatever it was doing. */
export async function stopWebhookDispatcherForTests(): Promise<void> {
	for (const unsubscribe of unsubscribers) unsubscribe();
	unsubscribers = [];
	for (const timer of timers.values()) clearTimeout(timer);
	timers.clear();
	await eventQueue;
	await Promise.all([...inFlight]);
	for (const timer of timers.values()) clearTimeout(timer);
	timers.clear();
	options = undefined;
	backoffBaseMillis = 60 * 1000;
}

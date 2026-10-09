/**
 * Webhook records (`api.md`'s "Webhooks"), after apify-core's `WebhookSchema` and `insertWebhook`. What
 * happens when an event fires is `services/webhook-dispatches.ts`.
 */
import { InvalidJsonError, InvalidVariableError, WebhookPayloadTemplate } from '@apify/utilities';

import { generateId } from '../storage/ids.js';
import { KeyedMutex } from '../storage/mutex.js';
import type { WebhookCondition, WebhookRecord } from '../storage/entities.js';
import { getRegistries } from '../storage/registries.js';

export const WEBHOOK_EVENT_TYPES = [
	'ACTOR.RUN.CREATED',
	'ACTOR.RUN.SUCCEEDED',
	'ACTOR.RUN.FAILED',
	'ACTOR.RUN.TIMED_OUT',
	'ACTOR.RUN.ABORTED',
	'ACTOR.RUN.RESURRECTED',
	'ACTOR.BUILD.CREATED',
	'ACTOR.BUILD.SUCCEEDED',
	'ACTOR.BUILD.FAILED',
	'ACTOR.BUILD.TIMED_OUT',
	'ACTOR.BUILD.ABORTED',
	'TEST',
] as const;

/** `@apify/consts`' `WEBHOOK_DEFAULT_PAYLOAD_TEMPLATE`. */
export const DEFAULT_PAYLOAD_TEMPLATE = `{
    "userId": {{userId}},
    "createdAt": {{createdAt}},
    "eventType": {{eventType}},
    "eventData": {{eventData}},
    "resource": {{resource}}
}`;

/** `@apify/consts`' `WEBHOOK_ALLOWED_PAYLOAD_VARIABLES`: the top-level names a template may use. */
const ALLOWED_PAYLOAD_VARIABLES = new Set(['userId', 'createdAt', 'eventType', 'eventData', 'resource']);

const ACTION_TYPES = ['HTTP_REQUEST', 'SLACK_MESSAGE', 'GOOGLE_MAIL', 'GOOGLE_DRIVE', 'GITHUB_ISSUE'];
const APIFY_ID_REGEX = /^[a-zA-Z0-9]{17}$/;
const CONDITION_KEYS = ['actorId', 'actorTaskId', 'actorRunId'] as const;

/** A request the platform's schema would reject; the message is the platform's own. */
export class WebhookValidationError extends Error {}

/** Only for the actions the runtime cannot perform (`unsupported.md`'s integrations). */
export class UnsupportedWebhookActionError extends Error {}

type JsonObject = Record<string, unknown>;

function fail(message: string): never {
	throw new WebhookValidationError(message);
}

function optionalBoolean(body: JsonObject, field: string): boolean | undefined {
	const value = body[field];
	if (value === undefined || value === null) return undefined;
	if (typeof value !== 'boolean') fail(`${field} must be of type Boolean`);
	return value;
}

function optionalString(body: JsonObject, field: string, min: number, max: number): string | undefined {
	const value = body[field];
	if (value === undefined || value === null) return undefined;
	if (typeof value !== 'string') fail(`${field} must be of type String`);
	if (value.length < min) fail(`${field} must be at least ${min} characters`);
	if (value.length > max) fail(`${field} cannot exceed ${max} characters`);
	return value;
}

function validateTemplate(template: string): void {
	try {
		WebhookPayloadTemplate.parse(template, ALLOWED_PAYLOAD_VARIABLES);
	} catch (error) {
		if (error instanceof InvalidJsonError) {
			fail('Aside from variables enclosed in double curly braces, the template must be valid JSON.');
		}
		if (error instanceof InvalidVariableError) {
			fail('Invalid variable enclosed in double curly braces. See the docs for valid variables.');
		}
		throw error;
	}
}

function isHttpUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname !== '';
	} catch {
		return false;
	}
}

/** Exactly one of `actorId`, `actorTaskId` or `actorRunId`, as the platform's condition schemas allow. */
export function parseWebhookCondition(value: unknown): WebhookCondition {
	const invalid = (): never => fail("Webhook condition isn't valid.");
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return invalid();
	const entries = Object.entries(value);
	if (entries.length !== 1) return invalid();
	const [key, id] = entries[0]!;
	if (!(CONDITION_KEYS as readonly string[]).includes(key)) return invalid();
	if (typeof id !== 'string' || !APIFY_ID_REGEX.test(id)) return invalid();
	return { [key]: id } as WebhookCondition;
}

/** The writable fields of a webhook, as given in a create or update body. */
export type WebhookFields = Omit<
	WebhookRecord,
	'id' | 'userId' | 'createdAt' | 'modifiedAt' | 'lastDispatch' | 'stats'
>;

/**
 * Checks `body` laid over `current` (or over the platform's defaults, when creating) the way the platform's
 * `WebhookSchema` does, and returns the merged fields. Fields the platform manages itself are ignored.
 */
export function mergeWebhookFields(body: JsonObject, current?: WebhookRecord): WebhookFields {
	const actionType = body.actionType ?? 'HTTP_REQUEST';
	if (typeof actionType !== 'string' || !ACTION_TYPES.includes(actionType)) {
		fail(`actionType must be one of: ${ACTION_TYPES.join(', ')}`);
	}
	if (actionType !== 'HTTP_REQUEST') {
		throw new UnsupportedWebhookActionError(
			`Webhook action "${actionType}" is not supported by this runtime; only HTTP_REQUEST is.`,
		);
	}

	let eventTypes = current?.eventTypes ?? [];
	if (body.eventTypes !== undefined) {
		if (!Array.isArray(body.eventTypes)) fail('eventTypes must be of type Array');
		for (const eventType of body.eventTypes) {
			if (!(WEBHOOK_EVENT_TYPES as readonly unknown[]).includes(eventType)) {
				fail(`${String(eventType)} is not an allowed value`);
			}
		}
		eventTypes = [...new Set(body.eventTypes as string[])];
	}
	if (eventTypes.length < 1) fail('You must specify at least 1 values');

	const condition = body.condition !== undefined ? parseWebhookCondition(body.condition) : current?.condition;
	if (!condition) fail('condition is required');

	const isAdHoc = optionalBoolean(body, 'isAdHoc') ?? current?.isAdHoc ?? false;
	if (current && isAdHoc !== current.isAdHoc) fail('isAdHoc cannot be changed');
	if (isAdHoc && !('actorRunId' in condition)) fail('Ad hoc webhook can only be set for Actor runs.');

	const requestUrl = optionalString(body, 'requestUrl', 1, 500) ?? current?.requestUrl;
	if (!requestUrl) fail('requestUrl is required');
	if (!isHttpUrl(requestUrl)) fail('Webhook URL must be a valid URL.');

	const payloadTemplate = optionalString(body, 'payloadTemplate', 2, 1000 * 1000) ?? current?.payloadTemplate;
	validateTemplate(payloadTemplate ?? DEFAULT_PAYLOAD_TEMPLATE);
	// An empty headers template clears it, as on the platform.
	const headersTemplate =
		body.headersTemplate !== undefined
			? (optionalString(body, 'headersTemplate', 0, 1000 * 1000) ?? undefined)
			: current?.headersTemplate;
	if (headersTemplate) validateTemplate(headersTemplate);

	const fields: WebhookFields = {
		isEnabled: optionalBoolean(body, 'isEnabled') ?? current?.isEnabled ?? true,
		isAdHoc,
		eventTypes,
		condition,
		requestUrl,
		payloadTemplate: payloadTemplate ?? DEFAULT_PAYLOAD_TEMPLATE,
		ignoreSslErrors: optionalBoolean(body, 'ignoreSslErrors') ?? current?.ignoreSslErrors ?? false,
		doNotRetry: optionalBoolean(body, 'doNotRetry') ?? current?.doNotRetry ?? false,
		shouldInterpolateStrings:
			optionalBoolean(body, 'shouldInterpolateStrings') ?? current?.shouldInterpolateStrings ?? false,
	};
	const title = body.title !== undefined ? optionalString(body, 'title', 0, 63) : current?.title;
	const description =
		body.description !== undefined ? optionalString(body, 'description', 0, 320) : current?.description;
	const idempotencyKey = optionalString(body, 'idempotencyKey', 1, 128) ?? current?.idempotencyKey;
	if (headersTemplate) fields.headersTemplate = headersTemplate;
	if (title !== undefined) fields.title = title;
	if (description !== undefined) fields.description = description;
	if (idempotencyKey !== undefined) fields.idempotencyKey = idempotencyKey;
	return fields;
}

/** Idempotency keys are unique per user, so creating a webhook is serialised per user. */
const createLocks = new KeyedMutex();

export async function listOwnedWebhooks(userId: string): Promise<WebhookRecord[]> {
	const all = await getRegistries().webhooks.list();
	return all.filter((webhook) => webhook.userId === userId);
}

/** Cross-user listing, for the console and the dispatcher only. */
export async function listAllWebhooks(): Promise<WebhookRecord[]> {
	return getRegistries().webhooks.list();
}

export async function getWebhookById(id: string): Promise<WebhookRecord | null> {
	return getRegistries().webhooks.get(id);
}

export async function getOwnedWebhook(userId: string, id: string): Promise<WebhookRecord | null> {
	const webhook = await getRegistries().webhooks.get(id);
	return webhook && webhook.userId === userId ? webhook : null;
}

/** A webhook with the same `idempotencyKey` is returned as it is instead of creating another, as on the
 * platform. */
export async function createWebhook(userId: string, fields: WebhookFields): Promise<WebhookRecord> {
	return createLocks.run(userId, async () => {
		if (fields.idempotencyKey !== undefined) {
			const existing = (await listOwnedWebhooks(userId)).find(
				(webhook) => webhook.idempotencyKey === fields.idempotencyKey,
			);
			if (existing) return existing;
		}
		const now = new Date().toISOString();
		const record: WebhookRecord = {
			...fields,
			id: generateId(),
			userId,
			createdAt: now,
			modifiedAt: now,
			lastDispatch: null,
			stats: { totalDispatches: 0 },
		};
		await getRegistries().webhooks.set(record.id, record);
		return record;
	});
}

export async function updateWebhook(
	id: string,
	mutator: (current: WebhookRecord) => WebhookRecord,
): Promise<WebhookRecord | null> {
	return getRegistries().webhooks.update(id, (current) => (current ? mutator(current) : null));
}

export async function deleteWebhook(id: string): Promise<void> {
	await getRegistries().webhooks.delete(id);
}

/** As on the platform, deleting an Actor or a task deletes the webhooks that fire for it. */
export async function deleteWebhooksWithCondition(condition: WebhookCondition): Promise<void> {
	const [[key, id]] = Object.entries(condition) as [[string, string]];
	for (const webhook of await listAllWebhooks()) {
		if ((webhook.condition as Record<string, string>)[key] === id) await deleteWebhook(webhook.id);
	}
}

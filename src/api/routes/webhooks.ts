/**
 * `v2/webhooks/*` and `v2/webhook-dispatches/*` (`api.md`'s "Webhooks"), after apify-core's
 * `routes/webhooks` and `routes/webhook_dispatches`, plus the per-Actor and per-task webhook lists.
 */
import type { Request, Response, Router } from 'express';

import { requireUser } from '../auth.js';
import { paginate, sendData, sortByTimestamp } from '../envelope.js';
import { idDoesNotMatch, invalidRequest, recordNotFound, schemaValidation } from '../errors.js';
import { h, jsonBody, optionalJsonBody, paginationParams } from '../handler.js';
import { resolveActorParam, resolveTaskParam } from '../resolve-reference.js';
import { buildDto, runDto } from '../dto/actors.js';
import { getOwnedActor } from '../../services/actors.js';
import { getOwnedBuild } from '../../services/builds.js';
import { getOwnedRun } from '../../services/runs.js';
import { getOwnedTask } from '../../services/tasks.js';
import {
	buildEventForDispatch,
	createTestDispatch,
	getOwnedWebhookDispatch,
	listOwnedWebhookDispatches,
	runEventForDispatch,
} from '../../services/webhook-dispatches.js';
import {
	createWebhook,
	deleteWebhook,
	getOwnedWebhook,
	listOwnedWebhooks,
	mergeWebhookFields,
	UnsupportedWebhookActionError,
	updateWebhook,
	WebhookValidationError,
	type WebhookFields,
} from '../../services/webhooks.js';
import type { WebhookCondition, WebhookDispatchRecord, WebhookRecord } from '../../storage/entities.js';

type JsonObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is JsonObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The platform's `API_PUBLISHED_WEBHOOK_FIELDS`; a list item leaves out `payloadTemplate`. */
function webhookDto(webhook: WebhookRecord, { listItem = false } = {}) {
	return {
		id: webhook.id,
		createdAt: webhook.createdAt,
		modifiedAt: webhook.modifiedAt,
		userId: webhook.userId,
		isEnabled: webhook.isEnabled,
		isAdHoc: webhook.isAdHoc,
		eventTypes: webhook.eventTypes,
		condition: webhook.condition,
		ignoreSslErrors: webhook.ignoreSslErrors,
		doNotRetry: webhook.doNotRetry,
		requestUrl: webhook.requestUrl,
		...(listItem ? {} : { payloadTemplate: webhook.payloadTemplate }),
		...(webhook.headersTemplate !== undefined ? { headersTemplate: webhook.headersTemplate } : {}),
		lastDispatch: webhook.lastDispatch,
		stats: webhook.stats,
		actionType: 'HTTP_REQUEST',
		shouldInterpolateStrings: webhook.shouldInterpolateStrings,
		...(webhook.title !== undefined ? { title: webhook.title } : {}),
		...(webhook.description !== undefined ? { description: webhook.description } : {}),
	};
}

/** The platform's `API_PUBLISHED_WEBHOOK_DISPATCH_FIELDS`. */
function dispatchDto(dispatch: WebhookDispatchRecord) {
	return {
		id: dispatch.id,
		userId: dispatch.userId,
		webhookId: dispatch.webhookId,
		createdAt: dispatch.createdAt,
		status: dispatch.status,
		eventType: dispatch.eventType,
		eventData: dispatch.eventData,
		calls: dispatch.calls,
		webhook: {
			actionType: 'HTTP_REQUEST',
			condition: dispatch.webhook.condition,
			requestUrl: dispatch.webhook.requestUrl,
			isAdHoc: dispatch.webhook.isAdHoc,
		},
	};
}

function fieldsOrThrow(body: JsonObject, current?: WebhookRecord): WebhookFields {
	try {
		return mergeWebhookFields(body, current);
	} catch (error) {
		if (error instanceof WebhookValidationError) throw schemaValidation(error.message);
		if (error instanceof UnsupportedWebhookActionError) throw invalidRequest(error.message);
		throw error;
	}
}

/** As on the platform, the Actor, task or run a new webhook names must exist; an ad-hoc webhook's run may
 * not have been created yet. */
async function assertConditionTargetExists(userId: string, condition: WebhookCondition, isAdHoc: boolean) {
	if ('actorId' in condition) {
		if (!(await getOwnedActor(userId, condition.actorId))) throw recordNotFound('Actor was not found');
	} else if ('actorTaskId' in condition) {
		if (!(await getOwnedTask(userId, condition.actorTaskId))) throw recordNotFound('Actor task was not found');
	} else if (!isAdHoc && !(await getOwnedRun(userId, condition.actorRunId))) {
		throw recordNotFound('Actor run was not found');
	}
}

async function resolveWebhookOrThrow(req: Request): Promise<WebhookRecord> {
	const webhook = await getOwnedWebhook(requireUser(req).id, req.params.webhookId as string);
	if (!webhook) throw recordNotFound('Webhook was not found');
	return webhook;
}

/** `GET /v2/webhooks` leaves out each `payloadTemplate`; the per-Actor and per-task lists keep it, as on
 * the platform. */
function sendWebhookList(req: Request, res: Response, webhooks: WebhookRecord[], { listItem = false } = {}) {
	const envelope = paginate(
		sortByTimestamp(webhooks, (webhook) => webhook.createdAt),
		paginationParams(req),
	);
	sendData(res, { ...envelope, items: envelope.items.map((webhook) => webhookDto(webhook, { listItem })) });
}

function sendDispatchList(req: Request, res: Response, dispatches: WebhookDispatchRecord[]) {
	const envelope = paginate(
		sortByTimestamp(dispatches, (dispatch) => dispatch.createdAt),
		paginationParams(req),
	);
	sendData(res, { ...envelope, items: envelope.items.map(dispatchDto) });
}

function hasCondition(webhook: WebhookRecord, key: string, id: string): boolean {
	return (webhook.condition as Record<string, string>)[key] === id;
}

/** The run or build a test dispatch is sent with, checked against the webhook's condition as on the platform. */
async function testResource(webhook: WebhookRecord, userId: string, body: JsonObject) {
	const { resourceId, resourceType } = body;
	if (resourceId === undefined || resourceId === null) return undefined;
	if (typeof resourceId !== 'string') throw schemaValidation('resourceId must be of type String');
	if (resourceType !== 'RUN' && resourceType !== 'BUILD') {
		throw schemaValidation('resourceType must be one of: BUILD, RUN');
	}
	const conditionId = Object.values(webhook.condition)[0] as string;
	if (resourceType === 'RUN') {
		const run = await getOwnedRun(userId, resourceId);
		if (!run) throw recordNotFound('Actor run was not found');
		const runOwnerId = 'actorTaskId' in webhook.condition ? run.actorTaskId : run.actorId;
		if (!('actorRunId' in webhook.condition) && runOwnerId !== conditionId) {
			throw idDoesNotMatch(resourceId, conditionId);
		}
		return runEventForDispatch(run, 'TEST', runDto(run));
	}
	const build = await getOwnedBuild(userId, resourceId);
	if (!build) throw recordNotFound('Actor build was not found');
	if ('actorId' in webhook.condition && build.actorId !== conditionId) throw idDoesNotMatch(resourceId, conditionId);
	return buildEventForDispatch(build, 'TEST', buildDto(build));
}

export function mountWebhooks(router: Router): void {
	router.get(
		'/webhooks',
		h(async (req, res) => {
			sendWebhookList(req, res, await listOwnedWebhooks(requireUser(req).id), { listItem: true });
		}),
	);

	router.post(
		'/webhooks',
		h(async (req, res) => {
			const user = requireUser(req);
			const body = jsonBody<unknown>(req);
			if (!isPlainObject(body)) throw invalidRequest('Request body must be a JSON object');
			const fields = fieldsOrThrow(body);
			await assertConditionTargetExists(user.id, fields.condition, fields.isAdHoc);
			const webhook = await createWebhook(user.id, fields);
			res.set('Location', `${req.protocol}://${req.get('host')}/v2/webhooks/${webhook.id}`);
			sendData(res, webhookDto(webhook), 201);
		}),
	);

	router.get(
		'/webhooks/:webhookId',
		h(async (req, res) => {
			sendData(res, webhookDto(await resolveWebhookOrThrow(req)));
		}),
	);

	router.put(
		'/webhooks/:webhookId',
		h(async (req, res) => {
			const webhook = await resolveWebhookOrThrow(req);
			const body = jsonBody<unknown>(req);
			if (!isPlainObject(body)) throw invalidRequest('Request body must be a JSON object');
			const fields = fieldsOrThrow(body, webhook);
			const updated = await updateWebhook(webhook.id, (current) => {
				const next: WebhookRecord = { ...current, ...fields, modifiedAt: new Date().toISOString() };
				for (const field of ['headersTemplate', 'title', 'description'] as const) {
					if (fields[field] === undefined) delete next[field];
				}
				return next;
			});
			if (!updated) throw recordNotFound('Webhook was not found');
			sendData(res, webhookDto(updated));
		}),
	);

	router.delete(
		'/webhooks/:webhookId',
		h(async (req, res) => {
			const webhook = await resolveWebhookOrThrow(req);
			await deleteWebhook(webhook.id);
			res.status(204).end();
		}),
	);

	router.post(
		'/webhooks/:webhookId/test',
		h(async (req, res) => {
			const user = requireUser(req);
			const webhook = await resolveWebhookOrThrow(req);
			const body = optionalJsonBody<unknown>(req) ?? {};
			if (!isPlainObject(body)) throw invalidRequest('Request body must be a JSON object');
			const dispatch = await createTestDispatch(webhook, await testResource(webhook, user.id, body));
			sendData(res, dispatchDto(dispatch), 201);
		}),
	);

	router.get(
		'/webhooks/:webhookId/dispatches',
		h(async (req, res) => {
			const webhook = await resolveWebhookOrThrow(req);
			const dispatches = await listOwnedWebhookDispatches(webhook.userId);
			sendDispatchList(
				req,
				res,
				dispatches.filter((dispatch) => dispatch.webhookId === webhook.id),
			);
		}),
	);

	router.get(
		'/webhook-dispatches',
		h(async (req, res) => {
			sendDispatchList(req, res, await listOwnedWebhookDispatches(requireUser(req).id));
		}),
	);

	router.get(
		'/webhook-dispatches/:dispatchId',
		h(async (req, res) => {
			const dispatch = await getOwnedWebhookDispatch(requireUser(req).id, req.params.dispatchId as string);
			if (!dispatch) throw recordNotFound('Webhook dispatch was not found');
			sendData(res, dispatchDto(dispatch));
		}),
	);

	router.get(
		'/actors/:actorId/webhooks',
		h(async (req, res) => {
			const actor = await resolveActorParam(req);
			if (!actor) throw recordNotFound('Actor was not found');
			const webhooks = await listOwnedWebhooks(actor.userId);
			sendWebhookList(
				req,
				res,
				webhooks.filter((webhook) => hasCondition(webhook, 'actorId', actor.id)),
			);
		}),
	);

	router.get(
		'/actor-tasks/:actorTaskId/webhooks',
		h(async (req, res) => {
			const task = await resolveTaskParam(req);
			if (!task) throw recordNotFound('Actor task was not found');
			const webhooks = await listOwnedWebhooks(task.userId);
			sendWebhookList(
				req,
				res,
				webhooks.filter((webhook) => hasCondition(webhook, 'actorTaskId', task.id)),
			);
		}),
	);
}

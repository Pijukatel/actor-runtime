/**
 * `v2/schedules/*` (`api.md`'s "Schedules"), after apify-core's `routes/schedules`: a schedule saves a cron
 * expression and the Actor and task runs it starts; `services/scheduler.ts` runs them.
 */
import type { Request, Response, Router } from 'express';

import { requireUser } from '../auth.js';
import { paginate, sendData, sortByTimestamp } from '../envelope.js';
import {
	cronExpressionInvalid,
	invalidRequest,
	recordNotFound,
	runInputBodyNotValidJson,
	scheduleNameExists,
	schemaValidation,
	scheduleTargetNotFound,
	scheduleTooManyValues,
} from '../errors.js';
import { h, jsonBody, optionalJsonBody, paginationParams } from '../handler.js';
import { invokeScheduleManually } from '../../services/scheduler.js';
import {
	createSchedule,
	CronExpressionInvalidError,
	deleteSchedule,
	getOwnedSchedule,
	listOwnedSchedules,
	mergeScheduleFields,
	parseScheduleActions,
	RunInputBodyNotJsonError,
	ScheduleNameTakenError,
	ScheduleTargetNotFoundError,
	ScheduleValidationError,
	TooManyActionsError,
	updateSchedule,
} from '../../services/schedules.js';
import type { ScheduleAction, ScheduleRecord } from '../../storage/entities.js';

type JsonObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is JsonObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The platform's `API_PUBLISHED_SCHEDULE_FIELDS`, with the actions as `getScheduleActions` returns them. */
function scheduleDto(schedule: ScheduleRecord) {
	return {
		id: schedule.id,
		userId: schedule.userId,
		name: schedule.name,
		title: schedule.title,
		cronExpression: schedule.cronExpression,
		timezone: schedule.timezone,
		isEnabled: schedule.isEnabled,
		isExclusive: schedule.isExclusive,
		...(schedule.description !== undefined ? { description: schedule.description } : {}),
		createdAt: schedule.createdAt,
		modifiedAt: schedule.modifiedAt,
		nextRunAt: schedule.nextRunAt,
		lastRunAt: schedule.lastRunAt,
		notifications: schedule.notifications,
		actions: schedule.actions,
	};
}

/** The platform's list item: each action reduced to what it runs. */
function scheduleListItemDto(schedule: ScheduleRecord) {
	const { actions, ...rest } = scheduleDto(schedule);
	delete rest.description;
	return {
		...rest,
		actions: actions.map((action: ScheduleAction) =>
			action.type === 'RUN_ACTOR'
				? { id: action.id, type: action.type, actorId: action.actorId }
				: { id: action.id, type: action.type, actorTaskId: action.actorTaskId },
		),
	};
}

/** The service's rejections as the platform's error responses. */
function asApiError(error: unknown): never {
	if (error instanceof ScheduleValidationError) throw schemaValidation(error.message);
	if (error instanceof CronExpressionInvalidError) throw cronExpressionInvalid(error.message);
	if (error instanceof ScheduleNameTakenError) throw scheduleNameExists(error.scheduleName);
	if (error instanceof TooManyActionsError) throw scheduleTooManyValues(error.message);
	if (error instanceof ScheduleTargetNotFoundError) throw scheduleTargetNotFound(error.target, error.message);
	if (error instanceof RunInputBodyNotJsonError) throw runInputBodyNotValidJson();
	throw error;
}

function withApiErrors<T>(promise: Promise<T>): Promise<T> {
	return promise.catch(asApiError);
}

async function resolveScheduleOrThrow(req: Request): Promise<ScheduleRecord> {
	const schedule = await getOwnedSchedule(requireUser(req).id, req.params.scheduleId as string);
	if (!schedule) throw recordNotFound('Schedule was not found');
	return schedule;
}

/** An absent body is an empty one, as `apify-client`'s `schedules().create()` sends. */
function requestBody(req: Request, { optional = false } = {}): JsonObject {
	const body = optional ? (optionalJsonBody<unknown>(req) ?? {}) : jsonBody<unknown>(req);
	if (!isPlainObject(body)) throw invalidRequest('Request body must be a JSON object');
	return body;
}

function sendSchedule(res: Response, schedule: ScheduleRecord, status = 200): void {
	sendData(res, scheduleDto(schedule), status);
}

export function mountSchedules(router: Router): void {
	router.get(
		'/schedules',
		h(async (req, res) => {
			const schedules = sortByTimestamp(await listOwnedSchedules(requireUser(req).id), (s) => s.createdAt);
			const envelope = paginate(schedules, paginationParams(req));
			sendData(res, { ...envelope, items: envelope.items.map(scheduleListItemDto) });
		}),
	);

	router.post(
		'/schedules',
		h(async (req, res) => {
			const user = requireUser(req);
			const body = requestBody(req, { optional: true });
			const schedule = await withApiErrors(
				(async () => {
					const fields = mergeScheduleFields(body);
					// As on the platform, a schedule may be created with no actions at all.
					const actions = body.actions !== undefined ? await parseScheduleActions(user, body.actions) : [];
					return createSchedule(user.id, { ...fields, actions });
				})(),
			);
			res.set('Location', `${req.protocol}://${req.get('host')}/v2/schedules/${schedule.id}`);
			sendSchedule(res, schedule, 201);
		}),
	);

	router.get(
		'/schedules/:scheduleId',
		h(async (req, res) => {
			sendSchedule(res, await resolveScheduleOrThrow(req));
		}),
	);

	router.put(
		'/schedules/:scheduleId',
		h(async (req, res) => {
			const user = requireUser(req);
			const schedule = await resolveScheduleOrThrow(req);
			const body = requestBody(req);
			const updated = await withApiErrors(
				(async () => {
					const fields = mergeScheduleFields(body, schedule);
					// An absent `actions` keeps the current ones; a present one replaces them all.
					const actions =
						body.actions !== undefined
							? await parseScheduleActions(user, body.actions, schedule)
							: undefined;
					return updateSchedule(schedule, (current) => {
						const next: ScheduleRecord = {
							...current,
							...fields,
							name: fields.name ?? current.name,
							title: fields.title ?? current.title,
							...(actions ? { actions } : {}),
						};
						if (fields.description === undefined) delete next.description;
						return next;
					});
				})(),
			);
			if (!updated) throw recordNotFound('Schedule was not found');
			sendSchedule(res, updated);
		}),
	);

	router.delete(
		'/schedules/:scheduleId',
		h(async (req, res) => {
			const schedule = await resolveScheduleOrThrow(req);
			await deleteSchedule(schedule.id);
			res.status(204).end();
		}),
	);

	router.get(
		'/schedules/:scheduleId/log',
		h(async (req, res) => {
			const schedule = await resolveScheduleOrThrow(req);
			sendData(res, schedule.log);
		}),
	);

	// Answers a bare `{}` with `201`, as on the platform.
	router.post(
		'/schedules/:scheduleId/invoke',
		h(async (req, res) => {
			const schedule = await resolveScheduleOrThrow(req);
			await invokeScheduleManually(schedule);
			res.status(201).json({});
		}),
	);
}

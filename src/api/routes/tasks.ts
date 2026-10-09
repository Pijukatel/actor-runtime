/**
 * `v2/actor-tasks/*` (`api.md`'s "Tasks"), after apify-core's `routes/actor_tasks`: a task is a saved run
 * input and run options of one of the caller's own Actors, and a task run is that Actor's run started
 * from them.
 */
import type { Request, Router } from 'express';

import { requireUser } from '../auth.js';
import { paginate, sendData, sortByTimestamp } from '../envelope.js';
import {
	actorTaskInputNotJson,
	actorTaskInputNotObject,
	actorTaskNameExists,
	cannotPublishActorTask,
	invalidInput,
	invalidInputSchema,
	invalidRequest,
	providedInputNotObject,
	providedInputNotValidJson,
	recordNotFound,
	schemaValidation,
	unknownBuildTag,
} from '../errors.js';
import { h, jsonBody, paginationParams, queryNumber, rawBody } from '../handler.js';
import { resolveTaskParam } from '../resolve-reference.js';
import { runDto } from '../dto/actors.js';
import type { ApiServerDeps } from '../server.js';
import { runOptionsFromQuery, startActorRun } from './actors.js';
import { getOwnedActor, resolveOwnedActor } from '../../services/actors.js';
import { defaultRunOptionsOf } from '../../services/default-run-options.js';
import { pinRequestToLocal } from '../../services/api-fallback.js';
import { resolveTaggedBuild } from '../../services/builds.js';
import { inputSchemaPrefill, isJsonContentType, resolveBuildInput } from '../../services/input-schema.js';
import { isTerminalJobStatus } from '../../services/job-status.js';
import { parseResourceReference } from '../../services/resource-reference.js';
import { abortRun, listOwnedRuns, waitForRunFinish } from '../../services/runs.js';
import {
	mergeTaskStandbyUpdate,
	standbyUrl,
	standbyUrlAudienceOf,
	type StandbyUrlAudience,
} from '../../services/standby-config.js';
import {
	createTask,
	deleteTask,
	invalidTaskNameReason,
	listOwnedTasks,
	TaskNameTakenError,
	updateTask,
} from '../../services/tasks.js';
import { deleteWebhooksWithCondition } from '../../services/webhooks.js';
import { removeScheduleActionsFor } from '../../services/schedules.js';
import type {
	ActorRecord,
	BuildRecord,
	RunRecord,
	TaskRecord,
	TaskRunOptions,
	TaskStandbyRecord,
} from '../../storage/entities.js';

type JsonObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is JsonObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function taskStats(userId: string, task: TaskRecord) {
	const runs = await listOwnedRuns(userId, { actorTaskId: task.id });
	const lastRunStartedAt = runs.reduce<string | undefined>(
		(latest, run) => (!latest || run.startedAt > latest ? run.startedAt : latest),
		undefined,
	);
	return { totalRuns: runs.length, ...(lastRunStartedAt ? { lastRunStartedAt } : {}) };
}

async function taskDto(task: TaskRecord, username: string, audience: StandbyUrlAudience) {
	const actor = await getOwnedActor(task.userId, task.actorId);
	return {
		id: task.id,
		userId: task.userId,
		actId: task.actorId,
		name: task.name,
		title: task.title,
		description: task.description,
		username,
		createdAt: task.createdAt,
		modifiedAt: task.modifiedAt,
		isPublic: false,
		stats: await taskStats(task.userId, task),
		options: task.options ?? null,
		input: task.input ?? null,
		...(task.actorStandby ? { actorStandby: task.actorStandby } : {}),
		// As on the platform, a task is served whenever its Actor's Standby is on.
		standbyUrl: actor?.actorStandby?.isEnabled ? standbyUrl(task, username, audience) : null,
	};
}

/** The platform's list item: no `options`/`input`, but the Actor's name. */
async function taskListItemDto(task: TaskRecord, username: string, actor: ActorRecord | null) {
	return {
		id: task.id,
		userId: task.userId,
		actId: task.actorId,
		name: task.name,
		title: task.title,
		username,
		actName: actor?.name ?? null,
		actUsername: actor ? username : null,
		createdAt: task.createdAt,
		modifiedAt: task.modifiedAt,
		isPublic: false,
		stats: await taskStats(task.userId, task),
	};
}

async function resolveTaskOrThrow(req: Request): Promise<TaskRecord> {
	const task = await resolveTaskParam(req);
	if (!task) throw recordNotFound('Actor task was not found');
	return task;
}

/** Misses only once the Actor was deleted. Pinned first: the platform knows nothing about a local task. */
async function taskActorOrThrow(req: Request, task: TaskRecord): Promise<ActorRecord> {
	pinRequestToLocal(req);
	const actor = await getOwnedActor(task.userId, task.actorId);
	if (!actor) throw recordNotFound('Actor was not found');
	return actor;
}

function optionalString(body: JsonObject, field: string): string | undefined {
	const value = body[field];
	if (value === undefined || value === null) return undefined;
	if (typeof value !== 'string') throw schemaValidation(`"${field}" must be a string`);
	return value;
}

function nameFromBody(body: JsonObject): string | undefined {
	const name = optionalString(body, 'name');
	if (name === undefined) return undefined;
	const reason = invalidTaskNameReason(name);
	if (reason) throw schemaValidation(reason);
	return name;
}

const OPTION_TYPES: Record<keyof TaskRunOptions, 'string' | 'number' | 'boolean'> = {
	build: 'string',
	timeoutSecs: 'number',
	memoryMbytes: 'number',
	maxTotalChargeUsd: 'number',
	maxItems: 'number',
	restartOnError: 'boolean',
};

/** `null` for a body that clears the options (or saves none); `undefined` when it does not mention them. */
function optionsFromBody(body: JsonObject): TaskRunOptions | null | undefined {
	const raw = body.options;
	if (raw === undefined) return undefined;
	if (raw === null) return null;
	if (!isPlainObject(raw)) throw schemaValidation('"options" must be an object');
	const options: Record<string, unknown> = {};
	for (const [key, type] of Object.entries(OPTION_TYPES)) {
		const value = raw[key];
		if (value === undefined || value === null) continue;
		if (typeof value !== type || (type === 'number' && !Number.isFinite(value))) {
			throw schemaValidation(`"options.${key}" must be a ${type}`);
		}
		if (type === 'number' && (value as number) < 0) throw schemaValidation(`"options.${key}" must be >= 0`);
		options[key] = value;
	}
	// As on the platform, saving no options means every run option falls back to its default.
	return Object.keys(options).length > 0 ? (options as TaskRunOptions) : null;
}

/** `null` for a body that clears the input; `undefined` when it does not mention it. */
function inputFromBody(body: JsonObject): JsonObject | null | undefined {
	const raw = body.input;
	if (raw === undefined) return undefined;
	if (raw === null) return null;
	if (!isPlainObject(raw)) throw actorTaskInputNotObject(raw);
	return raw;
}

/** `null` for a body that clears the settings; `undefined` when it does not mention them. Merged over
 * `current`, or over the defaults. */
function actorStandbyFromBody(body: JsonObject, current?: TaskStandbyRecord): TaskStandbyRecord | null | undefined {
	if (body.actorStandby === undefined) return undefined;
	if (body.actorStandby === null) return null;
	const result = mergeTaskStandbyUpdate(body.actorStandby, current);
	if (result.kind === 'invalid') throw invalidRequest(result.message);
	return result.actorStandby;
}

function rejectPublication(body: JsonObject): void {
	if (body.isPublic === true || (body.publicConfig !== undefined && body.publicConfig !== null)) {
		throw cannotPublishActorTask();
	}
}

/** The build the task's runs use, which the platform requires to exist whenever it creates a task or
 * saves its input. */
async function taskBuildOrThrow(actor: ActorRecord, options: TaskRunOptions | null | undefined): Promise<BuildRecord> {
	const tag = options?.build ?? defaultRunOptionsOf(actor).build;
	const lookup = await resolveTaggedBuild(actor, tag);
	if (!lookup.found) throw unknownBuildTag(tag);
	return lookup.build;
}

/** Validates `input` against the input schema of `build`, as the platform does on every save. */
function validateTaskInput(build: BuildRecord, input: JsonObject): void {
	const processed = resolveBuildInput(build, {
		body: Buffer.from(JSON.stringify(input), 'utf8'),
		contentType: 'application/json',
	});
	if (processed.kind === 'invalid-input') throw invalidInput(processed.message);
	if (processed.kind === 'invalid-input-schema') throw invalidInputSchema(processed.message);
}

function withNameTakenAsApiError<T>(promise: Promise<T>): Promise<T> {
	return promise.catch((error: unknown) => {
		if (error instanceof TaskNameTakenError) throw actorTaskNameExists(error.taskName);
		throw error;
	});
}

/** The platform's `runActorTask`: the request's input is merged over the task's, key by key, and its
 * query options over the task's options. */
function taskRunInput(req: Request, task: TaskRecord): { body: Buffer; contentType: string } | undefined {
	const body = rawBody(req);
	if (body.length === 0) {
		return task.input
			? { body: Buffer.from(JSON.stringify(task.input), 'utf8'), contentType: 'application/json' }
			: undefined;
	}
	const contentType = req.header('content-type');
	if (!contentType || !isJsonContentType(contentType)) throw actorTaskInputNotJson();
	if (!task.input) return { body, contentType };

	let provided: unknown;
	try {
		provided = JSON.parse(body.toString('utf8'));
	} catch (error) {
		throw providedInputNotValidJson(error as Error);
	}
	if (provided !== null && !isPlainObject(provided)) throw providedInputNotObject(provided);
	const merged = { ...task.input, ...(provided ?? {}) };
	return { body: Buffer.from(JSON.stringify(merged), 'utf8'), contentType: 'application/json' };
}

function savedRunOptions(options: TaskRunOptions | undefined) {
	const { build, timeoutSecs, memoryMbytes, maxTotalChargeUsd, restartOnError } = options ?? {};
	const saved = { build, timeoutSecs, memoryMbytes, maxTotalChargeUsd, restartOnError };
	return Object.fromEntries(Object.entries(saved).filter(([, value]) => value !== undefined));
}

/** Starts a run the way `POST /actor-tasks/:actorTaskId/runs` does - shared with the `run-sync` endpoints. */
export async function startTaskRunFromRequest(req: Request, deps: ApiServerDeps): Promise<RunRecord> {
	const task = await resolveTaskOrThrow(req);
	const actor = await taskActorOrThrow(req, task);
	const queryOptions = runOptionsFromQuery(req);
	const input = taskRunInput(req, task);
	return startActorRun(req, deps, actor, {
		...savedRunOptions(task.options),
		...queryOptions,
		input,
		actorTaskId: task.id,
	});
}

export function mountTasks(router: Router, deps: ApiServerDeps): void {
	router.get(
		'/actor-tasks',
		h(async (req, res) => {
			const user = requireUser(req);
			const tasks = sortByTimestamp(await listOwnedTasks(user.id), (task) => task.createdAt);
			const envelope = paginate(tasks, paginationParams(req));
			const items = await Promise.all(
				envelope.items.map(async (task) =>
					taskListItemDto(task, user.username, await getOwnedActor(user.id, task.actorId)),
				),
			);
			sendData(res, { ...envelope, items });
		}),
	);

	router.post(
		'/actor-tasks',
		h(async (req, res) => {
			const user = requireUser(req);
			const body = jsonBody<unknown>(req);
			if (!isPlainObject(body)) throw invalidRequest('Request body must be a JSON object');
			const actId = optionalString(body, 'actId');
			if (!actId) throw schemaValidation('"actId" is required');
			rejectPublication(body);
			const name = nameFromBody(body);
			const title = optionalString(body, 'title');
			const description = optionalString(body, 'description');
			const options = optionsFromBody(body);
			const providedInput = inputFromBody(body);
			const actorStandby = actorStandbyFromBody(body);

			const reference = parseResourceReference(actId);
			const actor = reference.kind === 'empty-name' ? null : await resolveOwnedActor(user, reference);
			if (!actor) throw recordNotFound('Actor was not found');

			const build = await taskBuildOrThrow(actor, options);
			if (providedInput) validateTaskInput(build, providedInput);
			// Without input, a new task starts from its input schema's prefill values, as on the platform.
			const input = providedInput ?? (build.inputSchema ? inputSchemaPrefill(build.inputSchema) : {});
			const task = await withNameTakenAsApiError(
				createTask(
					{
						userId: user.id,
						actorId: actor.id,
						...(name !== undefined ? { name } : {}),
						...(title !== undefined ? { title } : {}),
						...(description !== undefined ? { description } : {}),
						...(options ? { options } : {}),
						input,
						...(actorStandby ? { actorStandby } : {}),
					},
					actor.name,
				),
			);
			sendData(res, await taskDto(task, user.username, standbyUrlAudienceOf(req.headers.host)), 201);
		}),
	);

	router.get(
		'/actor-tasks/:actorTaskId',
		h(async (req, res) => {
			const task = await resolveTaskOrThrow(req);
			sendData(res, await taskDto(task, requireUser(req).username, standbyUrlAudienceOf(req.headers.host)));
		}),
	);

	router.put(
		'/actor-tasks/:actorTaskId',
		h(async (req, res) => {
			const task = await resolveTaskOrThrow(req);
			const body = jsonBody<unknown>(req);
			if (!isPlainObject(body)) throw invalidRequest('Request body must be a JSON object');
			rejectPublication(body);
			const name = nameFromBody(body);
			const title = optionalString(body, 'title');
			const description = optionalString(body, 'description');
			const options = optionsFromBody(body);
			const input = inputFromBody(body);
			const actorStandby = actorStandbyFromBody(body, task.actorStandby);

			if (input) {
				const actor = await taskActorOrThrow(req, task);
				validateTaskInput(await taskBuildOrThrow(actor, options === undefined ? task.options : options), input);
			}
			const updated = await withNameTakenAsApiError(
				updateTask(task, (current) => {
					const next: TaskRecord = {
						...current,
						...(name !== undefined ? { name } : {}),
						...(title !== undefined ? { title } : {}),
						...(description !== undefined ? { description } : {}),
						...(options ? { options } : {}),
						...(input ? { input } : {}),
						...(actorStandby ? { actorStandby } : {}),
					};
					if (options === null) delete next.options;
					if (input === null) delete next.input;
					if (actorStandby === null) delete next.actorStandby;
					return next;
				}),
			);
			if (!updated) throw recordNotFound('Actor task was not found');
			sendData(res, await taskDto(updated, requireUser(req).username, standbyUrlAudienceOf(req.headers.host)));
		}),
	);

	router.delete(
		'/actor-tasks/:actorTaskId',
		h(async (req, res) => {
			const task = await resolveTaskOrThrow(req);
			// As on the platform, deleting a task aborts its unfinished runs; the runs themselves stay.
			const runs = await listOwnedRuns(task.userId, { actorTaskId: task.id });
			for (const run of runs) {
				if (!isTerminalJobStatus(run.status)) await abortRun(deps.driver, run);
			}
			await deleteTask(task.id);
			await deleteWebhooksWithCondition({ actorTaskId: task.id });
			await removeScheduleActionsFor({ actorTaskId: task.id });
			res.status(204).end();
		}),
	);

	// Both answer the bare input object, never `{data}`-wrapped, as on the platform.
	router.get(
		'/actor-tasks/:actorTaskId/input',
		h(async (req, res) => {
			const task = await resolveTaskOrThrow(req);
			res.status(200).json(task.input ?? {});
		}),
	);

	router.put(
		'/actor-tasks/:actorTaskId/input',
		h(async (req, res) => {
			const task = await resolveTaskOrThrow(req);
			const body = jsonBody<unknown>(req);
			if (!isPlainObject(body)) throw invalidRequest('Input must be a JSON object');
			const actor = await taskActorOrThrow(req, task);
			// Merged key by key over the saved input, not replacing it.
			const merged = { ...task.input, ...body };
			validateTaskInput(await taskBuildOrThrow(actor, task.options), merged);
			const updated = await updateTask(task, (current) => ({ ...current, input: { ...current.input, ...body } }));
			if (!updated) throw recordNotFound('Actor task was not found');
			res.status(200).json(updated.input ?? {});
		}),
	);

	router.get(
		'/actor-tasks/:actorTaskId/runs',
		h(async (req, res) => {
			const task = await resolveTaskOrThrow(req);
			const runs = await listOwnedRuns(requireUser(req).id, { actorTaskId: task.id });
			const sorted = sortByTimestamp(runs, (run) => run.startedAt);
			const envelope = paginate(sorted, paginationParams(req));
			const audience = standbyUrlAudienceOf(req.headers.host);
			sendData(res, { ...envelope, items: envelope.items.map((run) => runDto(run, audience)) });
		}),
	);

	router.post(
		'/actor-tasks/:actorTaskId/runs',
		h(async (req, res) => {
			const run = await startTaskRunFromRequest(req, deps);
			const waitSecs = queryNumber(req, 'waitForFinish');
			const finalRun = waitSecs ? ((await waitForRunFinish(run.id, waitSecs)) ?? run) : run;
			sendData(res, runDto(finalRun, standbyUrlAudienceOf(req.headers.host)), 201);
		}),
	);
}

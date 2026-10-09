import { generateId } from '../storage/ids.js';
import { KeyedMutex } from '../storage/mutex.js';
import type { TaskRecord, UserRecord } from '../storage/entities.js';
import { getRegistries } from '../storage/registries.js';
import { isCallerOwner, normalizeName, type ResolvableReference } from './resource-reference.js';

/** The platform's `DNS_SAFE_NAME_MAX_LENGTH` and `DNS_SAFE_NAME_REGEX`, which task names must match. */
export const TASK_NAME_MAX_LENGTH = 63;
const TASK_NAME_MIN_LENGTH = 3;
const DNS_SAFE_NAME_REGEX = /^([a-zA-Z0-9]|[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9])$/;

/** Names are unique per user, so creating or renaming a task is serialised per user. */
const nameLocks = new KeyedMutex();

export class TaskNameTakenError extends Error {
	constructor(public readonly taskName: string) {
		super(`Some other Actor task already has this name ("${taskName}").`);
	}
}

/** `undefined` for a valid name, otherwise why it is not. */
export function invalidTaskNameReason(name: string): string | undefined {
	if (name.length < TASK_NAME_MIN_LENGTH || name.length > TASK_NAME_MAX_LENGTH) {
		return `Task name must be between ${TASK_NAME_MIN_LENGTH} and ${TASK_NAME_MAX_LENGTH} characters long`;
	}
	if (!DNS_SAFE_NAME_REGEX.test(name)) {
		return 'Task name can only contain letters, digits and dashes, and cannot start or end with a dash';
	}
	return undefined;
}

/** The platform's `generateHumanName`: `my-task` becomes `My Task`. */
export function taskTitleFromName(name: string): string {
	return name
		.split('-')
		.map((chunk) => chunk.charAt(0).toUpperCase() + chunk.slice(1))
		.join(' ');
}

/** The platform's `generateUniqueName`: `<actor-name>-task`, then `-1`, `-2`, ... until it is free. */
function uniqueTaskName(actorName: string, taken: ReadonlySet<string>): string {
	const base = `${actorName}-task`;
	for (let suffix = 0; ; suffix++) {
		const ending = suffix ? `-${suffix}` : '';
		const name = `${base.slice(0, TASK_NAME_MAX_LENGTH - ending.length)}${ending}`;
		if (!taken.has(normalizeName(name))) return name;
	}
}

export async function listOwnedTasks(userId: string): Promise<TaskRecord[]> {
	const all = await getRegistries().tasks.list();
	return all.filter((task) => task.userId === userId);
}

/** Cross-user listing, for the console only (see `services/actors.ts: listAllActors`). */
export async function listAllTasks(): Promise<TaskRecord[]> {
	return getRegistries().tasks.list();
}

export async function getOwnedTask(userId: string, id: string): Promise<TaskRecord | null> {
	const record = await getRegistries().tasks.get(id);
	if (!record || record.userId !== userId) return null;
	return record;
}

async function findOwnedTaskByName(userId: string, name: string): Promise<TaskRecord | null> {
	const wanted = normalizeName(name);
	const owned = await listOwnedTasks(userId);
	return owned.find((task) => normalizeName(task.name) === wanted) ?? null;
}

/** Unlike an Actor, a bare segment is only ever an id, as on the platform. */
export async function resolveOwnedTask(user: UserRecord, reference: ResolvableReference): Promise<TaskRecord | null> {
	if (reference.kind === 'id') return getOwnedTask(user.id, reference.id);
	if (!isCallerOwner(user, reference.owner)) return null;
	return findOwnedTaskByName(user.id, reference.name);
}

export type CreateTaskInput = Omit<TaskRecord, 'id' | 'name' | 'title' | 'createdAt' | 'modifiedAt'> & {
	name?: string;
	title?: string;
};

/** Throws `TaskNameTakenError` for a name the user already has. */
export async function createTask(input: CreateTaskInput, actorName: string): Promise<TaskRecord> {
	return nameLocks.run(input.userId, async () => {
		const taken = new Set((await listOwnedTasks(input.userId)).map((task) => normalizeName(task.name)));
		if (input.name !== undefined && taken.has(normalizeName(input.name))) throw new TaskNameTakenError(input.name);
		const name = input.name ?? uniqueTaskName(actorName, taken);
		const now = new Date().toISOString();
		const record: TaskRecord = {
			...input,
			id: generateId(),
			name,
			title: input.title ?? taskTitleFromName(name),
			createdAt: now,
			modifiedAt: now,
		};
		await getRegistries().tasks.set(record.id, record);
		return record;
	});
}

/** Throws `TaskNameTakenError` when the update renames the task to a name the user already has. */
export async function updateTask(
	task: TaskRecord,
	mutator: (current: TaskRecord) => TaskRecord,
): Promise<TaskRecord | null> {
	return nameLocks.run(task.userId, async () => {
		const others = (await listOwnedTasks(task.userId)).filter((other) => other.id !== task.id);
		return getRegistries().tasks.update(task.id, (current) => {
			if (!current) return null;
			const next = mutator(current);
			if (others.some((other) => normalizeName(other.name) === normalizeName(next.name))) {
				throw new TaskNameTakenError(next.name);
			}
			return { ...next, modifiedAt: new Date().toISOString() };
		});
	});
}

export async function deleteTask(id: string): Promise<void> {
	await getRegistries().tasks.delete(id);
}

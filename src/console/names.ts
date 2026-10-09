import { getActorById } from '../services/actors.js';
import { getScheduleById } from '../services/schedules.js';
import { getTaskById } from '../services/tasks.js';
import { getUserById } from '../services/users.js';
import type { LinkedCell } from './templates.js';

/** Human-readable names for the ids the console shows (`console.md`). Memoised per page render, since a
 * list repeats the same owner or Actor on many rows. An id whose record is gone is shown as the id. */
export interface NameResolver {
	userName(userId: string): Promise<string>;
	/** `username~actorname`, linked to the Actor's detail view. */
	actorLink(actorId: string): Promise<LinkedCell>;
	/** `username~taskname`, linked to the task's detail view. */
	taskLink(taskId: string): Promise<LinkedCell>;
	/** `username~schedulename`, linked to the schedule's detail view. */
	scheduleLink(scheduleId: string): Promise<LinkedCell>;
}

export function createNameResolver(): NameResolver {
	const users = new Map<string, Promise<string>>();
	const actors = new Map<string, Promise<string>>();

	const userName = (userId: string): Promise<string> => {
		let name = users.get(userId);
		if (!name) {
			name = getUserById(userId).then((user) => user?.username ?? userId);
			users.set(userId, name);
		}
		return name;
	};

	const actorName = (actorId: string): Promise<string> => {
		let name = actors.get(actorId);
		if (!name) {
			name = getActorById(actorId).then(async (actor) =>
				actor ? `${await userName(actor.userId)}~${actor.name}` : actorId,
			);
			actors.set(actorId, name);
		}
		return name;
	};

	const taskName = async (taskId: string): Promise<string> => {
		const task = await getTaskById(taskId);
		return task ? `${await userName(task.userId)}~${task.name}` : taskId;
	};

	const scheduleName = async (scheduleId: string): Promise<string> => {
		const schedule = await getScheduleById(scheduleId);
		return schedule ? `${await userName(schedule.userId)}~${schedule.name}` : scheduleId;
	};

	return {
		userName,
		scheduleLink: async (scheduleId) => ({
			text: await scheduleName(scheduleId),
			href: `/schedules/${encodeURIComponent(scheduleId)}`,
		}),
		taskLink: async (taskId) => ({ text: await taskName(taskId), href: `/tasks/${encodeURIComponent(taskId)}` }),
		actorLink: async (actorId) => ({
			text: await actorName(actorId),
			href: `/actors/${encodeURIComponent(actorId)}`,
		}),
	};
}

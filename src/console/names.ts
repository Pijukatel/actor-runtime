import { getActorById } from '../services/actors.js';
import { getUserById } from '../services/users.js';
import type { LinkedCell } from './templates.js';

/** Human-readable names for the ids the console shows (`console.md`). Memoised per page render, since a
 * list repeats the same owner or Actor on many rows. An id whose record is gone is shown as the id. */
export interface NameResolver {
	userName(userId: string): Promise<string>;
	/** `username~actorname`, linked to the Actor's detail view. */
	actorLink(actorId: string): Promise<LinkedCell>;
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

	return {
		userName,
		actorLink: async (actorId) => ({
			text: await actorName(actorId),
			href: `/actors/${encodeURIComponent(actorId)}`,
		}),
	};
}

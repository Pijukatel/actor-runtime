import { generateId } from '../storage/ids.js';
import type { ActorRecord, ActorVersionRecord } from '../storage/entities.js';
import { getRegistries } from '../storage/registries.js';

export interface CreateActorInput {
	name: string;
	title?: string;
	versions?: ActorVersionRecord[];
}

export async function createActor(userId: string, input: CreateActorInput): Promise<ActorRecord> {
	const now = new Date().toISOString();
	const record: ActorRecord = {
		id: generateId(),
		userId,
		name: input.name,
		title: input.title,
		createdAt: now,
		modifiedAt: now,
		versions: input.versions ?? [],
		taggedBuilds: {},
	};
	await getRegistries().actors.set(record.id, record);
	return record;
}

export async function listOwnedActors(userId: string): Promise<ActorRecord[]> {
	const all = await getRegistries().actors.list();
	return all.filter((actor) => actor.userId === userId);
}

export async function getOwnedActor(userId: string, id: string): Promise<ActorRecord | null> {
	const record = await getRegistries().actors.get(id);
	if (!record || record.userId !== userId) return null;
	return record;
}

/**
 * Cross-user listing, for the console only (`console.md`: the console is an unauthenticated, view-only
 * local dev tool with no login of its own, so with multiple users it shows every user's objects rather
 * than scoping to one - see `console/server.ts`). The API's own `listOwnedActors` above stays strictly
 * per-user; nothing here is reachable from `api/routes/*`.
 */
export async function listAllActors(): Promise<ActorRecord[]> {
	return getRegistries().actors.list();
}

/** Cross-user lookup by id, for the console only (see `listAllActors`) - no ownership check, since the
 * console's detail pages show any user's object. */
export async function getActorById(id: string): Promise<ActorRecord | null> {
	return getRegistries().actors.get(id);
}

/**
 * Resolves the CLI-friendly identifiers real Apify accepts as `:actorId`: the actual id, the plain
 * Actor `name`, or the `username~name` form (`storage.md`/`api.md` amendment) - useful for
 * `apify push`'s "does this Actor already exist" probe, which looks the Actor up by name before an id
 * has ever been minted.
 */
export async function resolveOwnedActor(
	userId: string,
	idOrName: string,
	username: string,
): Promise<ActorRecord | null> {
	const byId = await getOwnedActor(userId, idOrName);
	if (byId) return byId;

	// Single-user POC: a `username~name` reference is only ever this bootstrap user's own username,
	// so a mismatched prefix can never resolve - same outcome as a real multi-user platform would give
	// for someone else's username.
	if (idOrName.includes('~')) {
		const [prefix, ...rest] = idOrName.split('~');
		if (prefix !== username) return null;
		return resolveOwnedActor(userId, rest.join('~'), username);
	}

	const all = await listOwnedActors(userId);
	return all.find((actor) => actor.name === idOrName) ?? null;
}

export async function updateActor(
	id: string,
	mutator: (current: ActorRecord) => ActorRecord,
): Promise<ActorRecord | null> {
	return getRegistries().actors.update(id, (current) => {
		if (!current) return null;
		return { ...mutator(current), modifiedAt: new Date().toISOString() };
	});
}

export async function deleteActor(id: string): Promise<void> {
	await getRegistries().actors.delete(id);
}

export function addOrReplaceVersion(actor: ActorRecord, version: ActorVersionRecord): ActorRecord {
	const versions = actor.versions.filter((v) => v.versionNumber !== version.versionNumber);
	versions.push(version);
	return { ...actor, versions };
}

export function findVersion(actor: ActorRecord, versionNumber: string): ActorVersionRecord | undefined {
	return actor.versions.find((v) => v.versionNumber === versionNumber);
}

/** Record a successful build against its tag - stock `apify push` polls `taggedBuilds[<tag>]`. */
export function recordTaggedBuild(actor: ActorRecord, tag: string, buildId: string, buildNumber: string): ActorRecord {
	return { ...actor, taggedBuilds: { ...actor.taggedBuilds, [tag]: { buildId, buildNumber } } };
}

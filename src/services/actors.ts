import { generateId } from '../storage/ids.js';
import type { ActorRecord, ActorStandbyRecord, ActorVersionRecord, UserRecord } from '../storage/entities.js';
import { getRegistries } from '../storage/registries.js';
import { validatePricingInfosUpdate, type InvalidPricingInfos } from './pricing.js';
import { isCallerOwner, normalizeName, type ResolvableReference } from './resource-reference.js';
import { sealActorSecrets } from './secrets.js';

/** The tag a build/run resolves to when the caller names none. `api/routes/actors.ts` and
 * `services/runs.ts` both import this instead of declaring their own `'latest'` literal. */
export const DEFAULT_BUILD_TAG = 'latest';

export interface CreateActorInput {
	name: string;
	title?: string;
	versions?: ActorVersionRecord[];
	actorStandby?: ActorStandbyRecord;
}

export async function createActor(userId: string, input: CreateActorInput): Promise<ActorRecord> {
	const now = new Date().toISOString();
	const record: ActorRecord = sealActorSecrets({
		id: generateId(),
		userId,
		name: input.name,
		title: input.title,
		createdAt: now,
		modifiedAt: now,
		versions: input.versions ?? [],
		taggedBuilds: {},
		...(input.actorStandby ? { actorStandby: input.actorStandby } : {}),
	});
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
 * Cross-user listing, for the console only (`console.md`: the console is an unauthenticated local dev
 * tool with no login of its own, and every route is a read except the dev-folder registration form, so
 * with multiple users it shows every user's objects rather than scoping to one - see
 * `console/server.ts`). The API's own `listOwnedActors` above stays strictly per-user; nothing here is
 * reachable from `api/routes/*`.
 */
export async function listAllActors(): Promise<ActorRecord[]> {
	return getRegistries().actors.list();
}

/** Cross-user lookup by id, for the console only (see `listAllActors`) - no ownership check, since the
 * console's detail pages show any user's object. */
export async function getActorById(id: string): Promise<ActorRecord | null> {
	return getRegistries().actors.get(id);
}

/** Case-insensitive, like the platform (`normalizeName`). */
export async function findOwnedActorByName(userId: string, name: string): Promise<ActorRecord | null> {
	const wanted = normalizeName(name);
	const owned = await listOwnedActors(userId);
	return owned.find((actor) => normalizeName(actor.name) === wanted) ?? null;
}

/**
 * The one rule Actors do not share with storages: a bare segment is tried as an id and then as a name,
 * because the platform accepts a plain Actor name there too - that is how `apify push` finds an
 * existing Actor before an id has ever been minted.
 */
export async function resolveOwnedActor(user: UserRecord, reference: ResolvableReference): Promise<ActorRecord | null> {
	if (reference.kind === 'id') {
		return (await getOwnedActor(user.id, reference.id)) ?? findOwnedActorByName(user.id, reference.id);
	}
	if (!isCallerOwner(user, reference.owner)) return null;
	return findOwnedActorByName(user.id, reference.name);
}

export async function updateActor(
	id: string,
	mutator: (current: ActorRecord) => ActorRecord,
): Promise<ActorRecord | null> {
	return getRegistries().actors.update(id, (current) => {
		if (!current) return null;
		return sealActorSecrets({ ...mutator(current), modifiedAt: new Date().toISOString() });
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

export type SetActorPricingResult = { kind: 'ok'; actor: ActorRecord } | InvalidPricingInfos;

/**
 * Shared by the API and the console's form, so the two cannot drift apart. Unlike the `local*` toggles
 * this goes through `updateActor`: pricing is a real Actor field, so bumping `modifiedAt` is right.
 */
export async function setActorPricingInfos(actor: ActorRecord, raw: unknown): Promise<SetActorPricingResult> {
	const result = validatePricingInfosUpdate(raw, actor.pricingInfos);
	if (result.kind === 'invalid') return result;
	const updated = await updateActor(actor.id, (current) => ({ ...current, pricingInfos: result.pricingInfos }));
	return { kind: 'ok', actor: updated ?? { ...actor, pricingInfos: result.pricingInfos } };
}

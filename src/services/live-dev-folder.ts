/** Off by default: `apify push` registers a dev folder on its own, so mounting it must be an explicit opt-in. */
import type { ActorRecord } from '../storage/entities.js';
import { getRegistries } from '../storage/registries.js';

export type SetLiveDevFolderResult = { kind: 'ok'; actor: ActorRecord } | { kind: 'invalid'; message: string };

function validate(body: unknown): { enabled: boolean } | { message: string } {
	if (typeof body !== 'object' || body === null || Array.isArray(body)) {
		return { message: 'Request body must be a JSON object: {"enabled": true} or {"enabled": false}' };
	}
	const unknownKey = Object.keys(body).find((key) => key !== 'enabled');
	if (unknownKey) return { message: `Unknown field "${unknownKey}" - the only allowed field is "enabled".` };
	const { enabled } = body as { enabled?: unknown };
	if (typeof enabled !== 'boolean') return { message: '"enabled" must be a boolean' };
	return { enabled };
}

/** Writes bypass `updateActor`, so toggling never bumps `modifiedAt`. */
export async function setLiveDevFolder(actor: ActorRecord, rawBody: unknown): Promise<SetLiveDevFolderResult> {
	const parsed = validate(rawBody);
	if ('message' in parsed) return { kind: 'invalid', message: parsed.message };

	const localDevFolderEnabled = parsed.enabled ? (true as const) : undefined;
	if (actor.localDevFolderEnabled === localDevFolderEnabled) return { kind: 'ok', actor };
	const updated = await getRegistries().actors.update(actor.id, (current) =>
		current ? { ...current, localDevFolderEnabled } : current,
	);
	return { kind: 'ok', actor: updated ?? { ...actor, localDevFolderEnabled } };
}

export function liveDevFolderStatus(actor: Pick<ActorRecord, 'localDevFolderEnabled'>): { enabled: boolean } {
	return { enabled: actor.localDevFolderEnabled === true };
}

import { generateId } from '../storage/ids.js';
import type { ActorRecord, ActorVersionRecord, BuildRecord } from '../storage/entities.js';
import { getRegistries } from '../storage/registries.js';
import type { Driver, DevFolderProbeOutcome } from '../driver/types.js';

/** The tag a build/run resolves to when the caller names none. `api/routes/actors.ts` imports this
 * constant directly (aliased to its own local `DEFAULT_TAG` name) instead of declaring a second
 * `'latest'` literal, and `services/runs.ts` does the same for its `DEFAULT_BUILD_TAG` - one exported
 * value, three import sites, so the three can no longer drift apart the way three independent literals
 * could. */
export const DEFAULT_BUILD_TAG = 'latest';

/**
 * Resolves the tag `tag` on this Actor to its `BuildRecord`, or a reason it couldn't be resolved - the
 * exact lookup `POST /actors/:actorId/runs` performs (`actor.taggedBuilds[tag]`, then load that build
 * by id), extracted here so the registration probe below can resolve an image the identical way a real
 * run does, instead of re-implementing it. The two failure shapes are kept distinguishable rather than
 * both collapsing to one generic "not found": `no-such-tag` when `tag` has never been recorded on this
 * Actor at all, and `build-deleted` when the tag *is* recorded but the `BuildRecord` it points at is
 * gone (builds are deletable via `DELETE /actor-builds/:buildId` - `services/builds.ts`'s `deleteBuild`
 * does not clear any tag that pointed at it). Callers that only care about "did this resolve" can check
 * `result.found`; callers that need an accurate error message (like the run-start route) can tell the
 * two failure shapes apart instead of reporting "no build tagged" for a tag that does, in fact, exist.
 * No fallback to any other tag in either failure case.
 */
export type TaggedBuildLookup =
	{ found: false; reason: 'no-such-tag' | 'build-deleted' } | { found: true; build: BuildRecord };

export async function resolveTaggedBuild(actor: ActorRecord, tag: string): Promise<TaggedBuildLookup> {
	const tagged = actor.taggedBuilds[tag];
	if (!tagged) return { found: false, reason: 'no-such-tag' };
	const build = await getRegistries().builds.get(tagged.buildId);
	if (!build) return { found: false, reason: 'build-deleted' };
	return { found: true, build };
}

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

// --- Local dev-folder registration (`actor-driver.md`'s "Bind mount volumes with Actor source code") ---
//
// One validate-and-persist entry point, `setDevFolder`, shared by the API's
// `POST /actor-runtime/dev-folder/:actorId` (`api/routes/dev-folder.ts`) and the console's single-field
// form (`console/server.ts`) - neither route talks to the registry or the driver's probe directly. Both
// callers pass an already-unwrapped, already-trimmed string: the API unwraps its JSON-string body, the
// console reads its urlencoded form field.

/** Upper bound `validateDevFolderPathShape` rejects a path past - generous enough that no genuine host
 * path would ever hit it, just a guard against pathological input. */
const MAX_DEV_FOLDER_PATH_LENGTH = 4096;

/** Cheap shape pre-filter, run before the host-side existence check, never instead of it (see
 * `actor-driver.md`'s "Registration validates the path in two layers" bullet). `~` is not expanded - this codebase never
 * shells out (see `docker-driver.ts`'s class doc comment), so there is no shell to expand it, and
 * expanding it here would require guessing which host user's home directory this runtime process
 * should assume. Returns `null` for a shape-valid non-empty path, or a human-readable rejection reason.
 * Exported for direct unit testing as a pure function; the empty-string "clear" case is handled by
 * `setDevFolder` before this is ever called, not inside it. */
export function validateDevFolderPathShape(path: string): string | null {
	if (path.length > MAX_DEV_FOLDER_PATH_LENGTH) {
		return `Path is too long (max ${MAX_DEV_FOLDER_PATH_LENGTH} characters)`;
	}
	if (!path.startsWith('/')) {
		return 'Path must be an absolute POSIX path (starting with "/")';
	}
	if (path.includes('\n') || path.includes('\r') || path.includes('\0')) {
		return 'Path must not contain a newline or a NUL byte';
	}
	return null;
}

/**
 * Resolves the image id `setDevFolder` hands to `driver.probeDevFolder` - via `resolveTaggedBuild` at
 * `DEFAULT_BUILD_TAG` ('latest'), the exact same resolution `POST /actors/:actorId/runs` performs when
 * a run's caller names no `?build=` tag (`api/routes/actors.ts`'s own default). There is deliberately
 * no fallback to some other tag when `latest` is absent: an Actor whose only successful build(s) are
 * tagged something else is exactly the Actor a tag-less real run would also 404 against, so the probe
 * must refuse it the same way, not silently succeed against a build a real run could not reach without
 * an explicit tag. `taggedBuilds` is only ever populated by `recordTaggedBuild`, itself only called
 * after a build transitions to `SUCCEEDED` (`services/builds.ts: runBuildInBackground`), so a resolved
 * build is always proof of a genuine past success. Returns `null` when the Actor has never had a
 * `latest`-tagged successful build - the build-first precondition.
 */
async function resolveProbeImageId(actor: ActorRecord): Promise<string | null> {
	const lookup = await resolveTaggedBuild(actor, DEFAULT_BUILD_TAG);
	// Both `resolveTaggedBuild` failure reasons ("no such tag" and "tag exists but its build was
	// deleted") collapse to the same `null` here - either way there is no build to probe against, so the
	// caller reports the same "no successful build" precondition failure for both.
	return lookup.found ? (lookup.build.imageId ?? null) : null;
}

/** Every way `setDevFolder` can end, `ok` included - a discriminated union so both the API route and the
 * console form can map each failure to their own presentation (a JSON error envelope vs. an inline page
 * message) from the same classification, via `describeDevFolderError`. */
export type SetDevFolderResult =
	| { kind: 'ok'; actor: ActorRecord }
	| { kind: 'invalid-path'; message: string }
	| { kind: 'no-successful-build' }
	| { kind: 'unreachable' }
	| { kind: 'image-missing' }
	| { kind: 'not-found' }
	| { kind: 'unknown' };

/**
 * The one validate-and-persist path both the API endpoint and the console form funnel through - see
 * this file's own module comment above ("Local dev-folder registration"). `path` is already unwrapped
 * from its transport encoding and trimmed by the caller.
 *
 * An empty `path` is a first-class "clear" operation - it always succeeds, never runs the shape check,
 * the build-first check, or the existence probe (`actor-driver.md`: "Submitting the empty string clears
 * the registration and never runs either validation layer"). A non-empty `path` must pass the shape
 * pre-filter, then requires the Actor to have at least one successful build (so there is an image to
 * probe against at all), then must pass the host-side existence probe - in that order, each one
 * short-circuiting the next on failure. A rejected call never touches `updateActor` at all, so a
 * previously-registered value survives untouched across a later failed registration attempt.
 */
export async function setDevFolder(driver: Driver, actor: ActorRecord, path: string): Promise<SetDevFolderResult> {
	if (path === '') {
		const updated = await updateActor(actor.id, (current) => ({ ...current, localDevFolder: undefined }));
		return { kind: 'ok', actor: updated ?? { ...actor, localDevFolder: undefined } };
	}

	const shapeError = validateDevFolderPathShape(path);
	if (shapeError) return { kind: 'invalid-path', message: shapeError };

	const imageId = await resolveProbeImageId(actor);
	if (!imageId) return { kind: 'no-successful-build' };

	const probe: DevFolderProbeOutcome = driver.probeDevFolder
		? await driver.probeDevFolder(path, imageId)
		: { ok: false, reason: 'unreachable' };
	if (!probe.ok) return { kind: probe.reason };

	const updated = await updateActor(actor.id, (current) => ({ ...current, localDevFolder: path }));
	return { kind: 'ok', actor: updated ?? { ...actor, localDevFolder: path } };
}

export interface DevFolderErrorInfo {
	status: number;
	type: string;
	message: string;
}

/** Maps every non-`ok` `SetDevFolderResult` to the status/type/message the API route wraps in an
 * `ApiError` and the console form renders inline - one mapping, two presentations of the error
 * classification `actor-driver.md` documents (most specific first: unreachable/image-missing/
 * not-found/unknown). */
export function describeDevFolderError(result: Exclude<SetDevFolderResult, { kind: 'ok' }>): DevFolderErrorInfo {
	switch (result.kind) {
		case 'invalid-path':
			return { status: 400, type: 'invalid-request', message: result.message };
		case 'no-successful-build':
			return {
				status: 400,
				type: 'dev-folder-not-buildable',
				message: 'This Actor has no successful build yet - push and build it before registering a dev folder.',
			};
		case 'not-found':
			return {
				status: 400,
				type: 'dev-folder-path-not-found',
				message: 'The submitted path does not exist on the host.',
			};
		case 'unreachable':
			return {
				status: 503,
				type: 'dev-folder-check-unavailable',
				message: 'Could not verify the path - Docker is unreachable.',
			};
		case 'image-missing':
			return {
				status: 500,
				type: 'internal-error',
				message: 'Could not verify the path - internal error (the build image is missing).',
			};
		case 'unknown':
			return {
				status: 400,
				type: 'dev-folder-check-failed',
				message: 'Could not verify this path.',
			};
	}
}

export interface DevFolderStatus {
	localDevFolder: string | null;
	imageWorkingDirectory: string | null;
	/** Whether `startRun` will actually add the bind mount on this Actor's next run - `true` only when
	 * both fields are present and non-empty (`actor-driver.md`: "The mount is conditional, applied only
	 * when both fields are present and non-empty"). Shown separately from the two raw fields so the
	 * console/API caller never has to re-derive this condition themselves. */
	mountWillApply: boolean;
}

/** The three values both the API's registration response and the console detail page show - one
 * derivation, so they can never drift apart. */
export function devFolderStatus(actor: ActorRecord): DevFolderStatus {
	const localDevFolder = actor.localDevFolder ?? null;
	const imageWorkingDirectory = actor.imageWorkingDirectory ?? null;
	return {
		localDevFolder,
		imageWorkingDirectory,
		mountWillApply: Boolean(localDevFolder) && Boolean(imageWorkingDirectory),
	};
}

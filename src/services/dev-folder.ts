/**
 * Local dev-folder registration (`actor-driver.md`'s "Bind mount volumes with Actor source code"): one
 * validate-and-persist entry point, `setDevFolder`, shared by the API's
 * `POST /actor-runtime/dev-folder/:actorId` (`api/routes/dev-folder.ts`) and the console's single-field
 * form (`console/server.ts`). Neither caller talks to the registry or the driver's probe directly.
 *
 * This is its own module, separate from `services/actors.ts`, so `resolveProbeImageId` below can resolve
 * the probe's image via `services/builds.ts`'s `resolveTaggedBuild`/`getBuildById` without creating an
 * import cycle: `builds.ts` already imports `recordTaggedBuild`/`updateActor` from `actors.ts`, so
 * `actors.ts` importing back from `builds.ts` would cycle. This module imports both `actors.ts` and
 * `builds.ts`; nothing imports it back.
 */
import type { ActorRecord } from '../storage/entities.js';
import { getRegistries } from '../storage/registries.js';
import type { Driver } from '../driver/types.js';
import { DEFAULT_BUILD_TAG } from './actors.js';
import { resolveTaggedBuild } from './builds.js';

/** Upper bound on a candidate path's length - generous enough that no genuine host path would ever hit
 * it, just a guard against pathological input. */
const MAX_DEV_FOLDER_PATH_LENGTH = 4096;

/** Cheap shape pre-filter, run before the host-side existence check, never instead of it. `~` is not
 * expanded - this codebase never shells out, so there is no shell to expand it. Returns `null` for a
 * shape-valid non-empty path, or a human-readable rejection reason. */
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

/** Resolves the image id the probe checks the candidate path against: the Actor's `DEFAULT_BUILD_TAG`
 * ('latest') build, the same resolution a tag-less real run performs. No fallback to any other tag - an
 * Actor whose only successful build is tagged something else is rejected the same way a tag-less run
 * would be. Both `resolveTaggedBuild` failure reasons collapse to `null` here: either way there is no
 * image to probe against. */
async function resolveProbeImageId(actor: ActorRecord): Promise<string | null> {
	const lookup = await resolveTaggedBuild(actor, DEFAULT_BUILD_TAG);
	return lookup.found ? (lookup.build.imageId ?? null) : null;
}

/** Every way `setDevFolder` can end, `ok` included - a discriminated union both the API route and the
 * console form switch on to produce their own presentation. */
export type SetDevFolderResult =
	| { kind: 'ok'; actor: ActorRecord }
	| { kind: 'invalid-path'; message: string }
	| { kind: 'no-successful-build' }
	| { kind: 'unreachable' }
	| { kind: 'image-missing' }
	| { kind: 'not-found' }
	| { kind: 'unknown' };

/** Writes `localDevFolder` directly on the `__ACTORS__` registry, bypassing `services/actors.ts:
 * updateActor` - deliberately, so registering or clearing a dev folder never bumps `modifiedAt`.
 * `modifiedAt` (unlike `localDevFolder`/`imageWorkingDirectory`) *is* exposed on `/v2`, so touching it
 * here would leak this local-only feature into the emulated API through a side channel. */
async function writeLocalDevFolder(actorId: string, localDevFolder: string | undefined): Promise<ActorRecord | null> {
	return getRegistries().actors.update(actorId, (current) => (current ? { ...current, localDevFolder } : current));
}

/**
 * The one validate-and-persist path both the API endpoint and the console form funnel through. `rawPath`
 * is the caller's value exactly as received (unwrapped from its transport encoding, but not trimmed) -
 * trimming happens here, after distinguishing an explicit clear from a merely-blank submission.
 *
 * Only the literal empty string is a clear: it always succeeds, is a no-op (no registry write at all)
 * when the Actor has nothing registered already, and never runs the shape check, build-first check, or
 * existence probe. A whitespace-only, non-empty string is not a clear - it is trimmed and then rejected
 * by the shape check below (an empty string after trimming still fails "must start with /"), so
 * `--body '"   "'` 400s instead of silently clearing a registration.
 *
 * A non-empty path must pass the shape pre-filter, then requires the Actor to have at least one
 * successful build, then must pass the host-side existence probe - in that order, each one
 * short-circuiting the next. A rejected call never writes to the registry, so a previously-registered
 * value survives untouched across a later failed attempt.
 */
export async function setDevFolder(driver: Driver, actor: ActorRecord, rawPath: string): Promise<SetDevFolderResult> {
	if (rawPath === '') {
		if (!actor.localDevFolder) return { kind: 'ok', actor };
		const updated = await writeLocalDevFolder(actor.id, undefined);
		return { kind: 'ok', actor: updated ?? { ...actor, localDevFolder: undefined } };
	}

	const path = rawPath.trim();
	const shapeError = validateDevFolderPathShape(path);
	if (shapeError) return { kind: 'invalid-path', message: shapeError };

	const imageId = await resolveProbeImageId(actor);
	if (!imageId) return { kind: 'no-successful-build' };

	const probe = await driver.probeDevFolder(path, imageId);
	if (!probe.ok) return { kind: probe.reason };

	const updated = await writeLocalDevFolder(actor.id, path);
	return { kind: 'ok', actor: updated ?? { ...actor, localDevFolder: path } };
}

/** Maps every non-`ok` `SetDevFolderResult` to the message text both surfaces show - the console
 * inline, the API route wrapped in an `ApiError` alongside a status/type it (not this module) owns. */
export function describeDevFolderFailure(result: Exclude<SetDevFolderResult, { kind: 'ok' }>): string {
	switch (result.kind) {
		case 'invalid-path':
			return result.message;
		case 'no-successful-build':
			return 'This Actor has no successful build yet - push and build it before registering a dev folder.';
		case 'not-found':
			return 'The submitted path does not exist on the host.';
		case 'unreachable':
			return 'Could not verify the path - Docker is unreachable.';
		case 'image-missing':
			return 'Could not verify the path - internal error (the build image is missing).';
		case 'unknown':
			return 'Could not verify this path.';
	}
}

export interface DevFolderStatus {
	localDevFolder: string | null;
	imageWorkingDirectory: string | null;
	/** Whether `startRun` will actually add the bind mount on this Actor's next run - `true` only when
	 * both fields are present and non-empty. */
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

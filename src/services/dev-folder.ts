/**
 * Local dev-folder registration (`actor-driver.md`'s "Bind mount volumes with Actor source code"): one
 * validate-and-persist entry point, `setDevFolder`, shared by the API's
 * `POST /actor-runtime/dev-folder/:actorId` (`api/routes/dev-folder.ts`) and the console's single-field
 * form (`console/server.ts`). Neither caller talks to the registry or the driver's probe directly.
 *
 * Registration needs no build of the Actor's own: the host-side existence check runs against the
 * driver's own probe image (`Driver.ensureProbeImage`), never one of the Actor's builds - nothing about
 * a probe image's contents matters, only that Docker will accept it, so there is nothing here to resolve
 * off the Actor record at all. That is also why this module needs no import from `services/builds.ts`.
 */
import type { ActorRecord } from '../storage/entities.js';
import { getRegistries } from '../storage/registries.js';
import type { Driver } from '../driver/types.js';

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

/** Every way `setDevFolder` can end, `ok` included - a discriminated union both the API route and the
 * console form switch on to produce their own presentation. */
export type SetDevFolderResult =
	| { kind: 'ok'; actor: ActorRecord }
	| { kind: 'invalid-path'; message: string }
	| { kind: 'unreachable' }
	| { kind: 'image-missing' }
	| { kind: 'not-found' }
	| { kind: 'not-a-directory' }
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
 * when the Actor has nothing registered already, and never runs the shape check or existence probe. A
 * whitespace-only, non-empty string is not a clear - it is trimmed and then rejected
 * by the shape check below (an empty string after trimming still fails "must start with /"), so
 * `--body '"   "'` 400s instead of silently clearing a registration.
 *
 * A non-empty path must pass the shape pre-filter, then must pass the host-side existence probe - in
 * that order, short-circuiting on failure. There is no build-first precondition: the probe runs against
 * the driver's own probe image (`Driver.ensureProbeImage`), never the Actor's, so registration works
 * for an Actor that has never been built at all. A rejected call never writes to the registry, so a
 * previously-registered value survives untouched across a later failed attempt.
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

	let imageId: string;
	try {
		imageId = await driver.ensureProbeImage();
	} catch {
		return { kind: 'unreachable' };
	}

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
		case 'not-found':
			return 'The submitted path does not exist on the host.';
		case 'not-a-directory':
			return 'The submitted path exists but is a file, not a directory - only a directory can be registered.';
		case 'unreachable':
			return 'Could not verify the path - Docker is unreachable.';
		case 'image-missing':
			return 'Could not verify the path - internal error (the probe image is missing).';
		case 'unknown':
			return 'Could not verify this path.';
	}
}

export interface DevFolderStatus {
	/** `null` when nothing is registered for this Actor. */
	localDevFolder: string | null;
}

/**
 * The one value both the API's registration response and the console detail page show. Deliberately
 * just the registered folder, nothing about any build: whether a mount actually applies is a per-run
 * question - it depends on which build that particular run resolves, which this Actor-level status has
 * no way to know in advance - so it never claims a mount "will apply" for a build a given run might not
 * even use. `services/runs.ts`'s own `devMount` derivation, computed fresh from the run's own resolved
 * build at run start, is the only place that claim is actually made.
 */
export function devFolderStatus(actor: ActorRecord): DevFolderStatus {
	return { localDevFolder: actor.localDevFolder ?? null };
}

/** Domain record shapes stored in the `__*__` internal registries (see `storage.md`). */

export type StorageType = 'dataset' | 'keyValueStore' | 'requestQueue';

export interface StorageRecord {
	id: string;
	type: StorageType;
	userId: string;
	/** Human-facing name; distinct from the Crawlee storage name, which is always `id`. */
	name?: string;
	createdAt: string;
	modifiedAt: string;
	accessedAt: string;
}

/**
 * One record per token, created ad-hoc by `services/users.ts: getOrCreateUserForToken()` on the first
 * request that ever carries a given token (`cli.md`'s User bootstrap) - there is no startup-created
 * default user any more. `id`/`username` are the user's real identity outright, not an overlay on some
 * other fixed internal id: for a token that resolves against the real platform they are that account's
 * actual `id`/`username`; otherwise they are the fabricated `local-user-{n}` / `0000000000000000{n}`
 * pair. Every ownership filter (`actor.userId`, `run.userId`, ...) is keyed off `id` directly. Plain
 * per storage.md - no display-preference/overlay fields.
 */
export interface UserRecord {
	id: string;
	username: string;
	token: string;
	createdAt: string;
	/** Real Apify Proxy password for this account, harvested from the upstream `/v2/users/me` response
	 * at creation time when the token resolved against the real platform (see
	 * `services/identity-resolution.ts`). Absent for a fabricated user, or a real one whose upstream
	 * response carried none. */
	proxyPassword?: string;
}

export type SourceType = 'SOURCE_FILES';

export interface SourceFile {
	name: string;
	format: 'TEXT' | 'BASE64';
	content: string;
}

export interface ActorVersionRecord {
	versionNumber: string;
	buildTag: string;
	sourceType: SourceType;
	sourceFiles: SourceFile[];
	envVars?: Array<{ name: string; value: string }>;
}

/** Caller-facing language selector for the debug toggle (`api.md`'s `/actor-runtime/debug/:actorId`) -
 * `'auto'` (the default) means "resolve from the built image at run start"
 * (`services/debug-mode.ts: resolveDebugPlan`); `'node'`/`'python'` is an explicit override that always
 * wins over whatever the image's own command/env would otherwise suggest. */
export type DebugLanguagePreference = 'auto' | 'node' | 'python';
/** A run's actually-resolved debug language - never `'auto'`, since by the time a run starts (or is
 * shown on its own record) the language question has always been settled one way or the other, either
 * by an explicit override or by `resolveDebugPlan`'s own detection. */
export type DebugLanguage = 'node' | 'python';

/** The per-Actor debug toggle (`actor-driver.md`'s "Debug mode" section). Set or cleared only through
 * `services/debug-mode.ts: setDebugMode`, via a direct registry write that deliberately bypasses
 * `updateActor` - same `modifiedAt`-preserving precedent `localDevFolder` below already established. */
export interface ActorLocalDebug {
	language: DebugLanguagePreference;
	/** An explicit port override; absent means "use the resolved language's own default port at run
	 * start" (5678 Python / 9229 Node, `services/debug-mode.ts`) - deliberately never persisted as a
	 * concrete language-specific default at toggle time, since the language itself may still be
	 * `'auto'` (unresolved) until a build actually exists to inspect. */
	port?: number;
}

export interface ActorRecord {
	id: string;
	userId: string;
	name: string;
	title?: string;
	createdAt: string;
	modifiedAt: string;
	versions: ActorVersionRecord[];
	/** tag -> latest successful build for that tag; `apify push` polls this after a build. */
	taggedBuilds: Record<string, { buildId: string; buildNumber: string }>;
	/** Host path bind-mounted over the image's working directory at run start (`actor-driver.md`). Set or
	 * cleared only through `services/dev-folder.ts: setDevFolder` - via a direct registry write that
	 * deliberately bypasses `updateActor`, so registering/clearing never bumps `modifiedAt` (which, unlike
	 * this field, *is* exposed on `/v2`). Never touched by any other Actor write. Optional and never
	 * exposed on `/v2` itself either (`dto/actors.ts: actorDto` is explicit field-by-field). */
	localDevFolder?: string;
	/** The per-Actor debug-mode toggle (`actor-driver.md`'s "Debug mode" section). Absent means debug
	 * mode has never been turned on (or was explicitly cleared) for this Actor. Set or cleared only
	 * through `services/debug-mode.ts: setDebugMode`, the same `modifiedAt`-preserving, never-`/v2`-
	 * exposed pattern `localDevFolder` above uses. */
	localDebug?: ActorLocalDebug;
}

export type JobStatus = 'READY' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'ABORTING' | 'ABORTED' | 'TIMED-OUT';

/** Matches the real platform's `RUN_GENERAL_ACCESS` enum (`@apify/consts`, `apify-core`'s
 * `packages/consts/src/iam.ts`-adjacent run-access constant) - `FOLLOW_USER_SETTING` is the default a
 * freshly-started run gets (`actor_jobs.server.ts`'s `startRun`), matched here in `services/runs.ts`. */
export type RunGeneralAccess = 'FOLLOW_USER_SETTING' | 'RESTRICTED' | 'ANYONE_WITH_ID_CAN_READ';

export interface BuildRecord {
	id: string;
	userId: string;
	actorId: string;
	versionNumber: string;
	buildNumber: string;
	tag: string;
	status: JobStatus;
	startedAt: string;
	finishedAt?: string;
	imageId?: string;
	/** This build's own image's `Config.WorkingDir`, captured right after the build succeeds
	 * (`docker-driver.ts`'s `inspectWorkingDirectory`) and written in the same status-transition write
	 * that records `SUCCEEDED` (`services/builds.ts`). Build-specific, not Actor-specific: a run derives
	 * its dev-folder mount target from *this build's own* value (`services/runs.ts`), never from some
	 * other tag's most-recently-built image - the human-directed fix for the cross-tag staleness a
	 * single Actor-level field could not avoid (a differently-tagged, more-recently-built image could
	 * silently overwrite the value a same-run, different-tag mount was built from). Unset when the
	 * inspect failed or the working directory was empty/`/` (mounting over `/` would destroy the
	 * container) - never present on a non-`SUCCEEDED` build. */
	imageWorkingDirectory?: string;
	exitCode?: number;
	statusMessage?: string;
}

export interface RunRecord {
	id: string;
	userId: string;
	actorId: string;
	buildId: string;
	buildNumber: string;
	status: JobStatus;
	startedAt: string;
	finishedAt?: string;
	defaultDatasetId: string;
	defaultKeyValueStoreId: string;
	defaultRequestQueueId: string;
	options: {
		memoryMbytes: number;
		timeoutSecs: number;
		/** Which build tag or build number this run used - the real platform's `options.build`
		 * (`apify-core`'s `ActorRunOptions.build`). Optional here (unlike the always-populated real
		 * platform field) purely so pre-existing directly-seeded test fixtures keep compiling without
		 * change; `startRun` always sets it for real runs, and `runDto` backfills `'latest'` for any
		 * record that predates this field. */
		build?: string;
		/** In MB - the real platform's `options.diskMbytes` (`apify-core`'s `CheckedActorRunOptions`),
		 * required by the Apify API contract (`apify-client`'s `RunOptions` pydantic model has no
		 * default). Optional here for the same test-fixture-compatibility reason as `build`; `startRun`
		 * always sets it for real runs, and `runDto` backfills a sensible default when absent. */
		diskMbytes?: number;
	};
	exitCode?: number;
	statusMessage?: string;
	meta: { origin: string };
	/** Required by the real Apify API contract (`Run.generalAccess`) but optional here for the same
	 * test-fixture-compatibility reason as `options.build`/`options.diskMbytes` above; `startRun` always
	 * sets it for real runs (`FOLLOW_USER_SETTING`, the platform's run-creation default), and `runDto`
	 * backfills the same default when absent. */
	generalAccess?: RunGeneralAccess;
	/** This run's own resolved debug plan (`services/debug-mode.ts: resolveDebugPlan`), written once the
	 * plan is resolved, before the container starts - local-only, so the console run page can show an
	 * attach address after the fact even for a run started by someone else's `apify call`. Absent for
	 * every non-debug run (the overwhelming majority), and for a debug run that failed before a plan
	 * could be resolved (the refusal paths in `services/runs.ts`). Deliberately a **top-level** field,
	 * not nested under `options` - keeps it out of the emulated `/v2` run object automatically, the same
	 * containment `ActorRecord.localDevFolder` already relies on (`dto/actors.ts: runDto` is explicit
	 * field-by-field). */
	localDebug?: { language: DebugLanguage; port: number };
}

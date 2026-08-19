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
	/**
	 * The host path bind-mounted over the image's working directory at run start, for rapid local dev
	 * without a rebuild (`actor-driver.md`'s "Bind mount volumes with Actor source code"). Set/cleared
	 * only through `services/actors.ts: setDevFolder` (the API's `POST /actor-runtime/dev-folder/:actorId`
	 * and the console's dev-folder form both funnel through it) - never touched by any other Actor write
	 * (`storage.md`). Absent (never registered) and present-but-empty are not distinguished on this type;
	 * `setDevFolder` always stores either a non-empty absolute path or clears the key entirely via
	 * `undefined` (which a JSON round-trip through the KV store drops), so in practice this is only ever
	 * "absent" or "a real path" - never an empty string at rest. Optional and never exposed on `/v2`
	 * (`dto/actors.ts: actorDto` is explicit field-by-field).
	 */
	localDevFolder?: string;
	/**
	 * The Actor's most recently successfully-built image's `Config.WorkingDir`, captured by the driver
	 * right after that build (`docker-driver.ts`'s `startBuild`) and persisted in the same `updateActor`
	 * call that records the tagged build (`services/builds.ts`). Optional: unset until at least one build
	 * has succeeded and its image could be inspected, and left unset (not overwritten) by a build whose
	 * inspect failed or whose image's working directory was empty/`/` (mounting over `/` would destroy
	 * the container). Reflects the *most recent* successful build only - running an older, differently
	 * tagged build whose image had a different working directory is a known staleness gap, accepted for
	 * the POC (`actor-driver.md`'s "`imageWorkingDirectory` is captured by the driver itself" bullet).
	 * Optional and never exposed on `/v2`, same as `localDevFolder`.
	 */
	imageWorkingDirectory?: string;
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
}

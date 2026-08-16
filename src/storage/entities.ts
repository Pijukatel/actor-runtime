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

export interface UserRecord {
	id: string;
	username: string;
	token: string;
	createdAt: string;
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

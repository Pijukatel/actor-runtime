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
	};
	exitCode?: number;
	statusMessage?: string;
	meta: { origin: string };
}

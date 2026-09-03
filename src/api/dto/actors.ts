import type { ActorRecord, BuildRecord, RunRecord } from '../../storage/entities.js';

/** Matches `services/actors.ts`'s `DEFAULT_BUILD_TAG` - backfilled here only for run records that
 * predate `options.build` (directly-seeded test fixtures); every real run always has it set already. */
const DEFAULT_RUN_BUILD_TAG = 'latest';
/** Matches `services/runs.ts`'s `DISK_MBYTES_PER_MEMORY_MBYTE` - backfilled here only for run records
 * that predate `options.diskMbytes`; every real run always has it set already. */
const DISK_MBYTES_PER_MEMORY_MBYTE = 2;

export function actorDto(actor: ActorRecord, username: string) {
	return {
		id: actor.id,
		userId: actor.userId,
		name: actor.name,
		username,
		title: actor.title,
		isPublic: false,
		createdAt: actor.createdAt,
		modifiedAt: actor.modifiedAt,
		stats: { totalRuns: 0, totalUsers: 1 },
		versions: actor.versions,
		defaultRunOptions: { build: 'latest', timeoutSecs: 300, memoryMbytes: 1024 },
		deploymentKey: actor.id,
		taggedBuilds: Object.fromEntries(
			Object.entries(actor.taggedBuilds).map(([tag, info]) => [
				tag,
				{ buildId: info.buildId, buildNumber: info.buildNumber },
			]),
		),
	};
}

export function buildDto(build: BuildRecord) {
	return {
		id: build.id,
		userId: build.userId,
		actId: build.actorId,
		actorId: build.actorId,
		buildNumber: build.buildNumber,
		status: build.status,
		startedAt: build.startedAt,
		finishedAt: build.finishedAt,
		meta: { origin: 'API' },
		stats: {},
		options: { useCache: true },
		buildTag: build.tag,
		exitCode: build.exitCode,
		statusMessage: build.statusMessage,
	};
}

export function runDto(run: RunRecord) {
	return {
		id: run.id,
		userId: run.userId,
		actId: run.actorId,
		actorId: run.actorId,
		actorTaskId: undefined,
		status: run.status,
		startedAt: run.startedAt,
		finishedAt: run.finishedAt,
		buildId: run.buildId,
		buildNumber: run.buildNumber,
		exitCode: run.exitCode,
		defaultDatasetId: run.defaultDatasetId,
		defaultKeyValueStoreId: run.defaultKeyValueStoreId,
		defaultRequestQueueId: run.defaultRequestQueueId,
		// `build`/`diskMbytes` and top-level `generalAccess` are required by the real Apify API contract
		// (`apify-client`'s `RunOptions`/`Run` pydantic models have no default for any of the three) -
		// every real run already has them (`services/runs.ts`'s `startRun`); the fallbacks here only cover
		// directly-seeded test fixtures that predate these fields.
		options: {
			build: run.options.build ?? DEFAULT_RUN_BUILD_TAG,
			memoryMbytes: run.options.memoryMbytes,
			timeoutSecs: run.options.timeoutSecs,
			diskMbytes: run.options.diskMbytes ?? run.options.memoryMbytes * DISK_MBYTES_PER_MEMORY_MBYTE,
		},
		generalAccess: run.generalAccess ?? 'FOLLOW_USER_SETTING',
		meta: run.meta,
		// The platform's restart-bookkeeping stats (see `RunRecord.stats`); zeros backfill old fixtures.
		stats: {
			migrationCount: run.stats?.migrationCount ?? 0,
			rebootCount: run.stats?.rebootCount ?? 0,
			restartCount: run.stats?.restartCount ?? 0,
			resurrectCount: run.stats?.resurrectCount ?? 0,
		},
		statusMessage: run.statusMessage,
		containerUrl: undefined,
	};
}

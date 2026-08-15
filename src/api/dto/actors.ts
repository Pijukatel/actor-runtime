import type { ActorRecord, BuildRecord, RunRecord } from '../../storage/entities.js';

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
		options: run.options,
		meta: run.meta,
		stats: {},
		statusMessage: run.statusMessage,
		containerUrl: undefined,
	};
}

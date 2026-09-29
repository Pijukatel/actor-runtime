import type { ActorRecord, ActorVersionRecord, BuildRecord, RunRecord } from '../../storage/entities.js';
import { publicEnvVar } from '../../services/env-vars.js';
import { getRunTelemetry } from '../../services/events-channel.js';
import { computeRunUsage } from '../../services/run-usage.js';
import { standbyUrl, type StandbyUrlAudience } from '../../services/standby-config.js';

/** Matches `services/actors.ts`'s `DEFAULT_BUILD_TAG` - backfilled here only for run records that
 * predate `options.build` (directly-seeded test fixtures); every real run always has it set already. */
const DEFAULT_RUN_BUILD_TAG = 'latest';
/** Matches `services/runs.ts`'s `DISK_MBYTES_PER_MEMORY_MBYTE` - backfilled here only for run records
 * that predate `options.diskMbytes`; every real run always has it set already. */
const DISK_MBYTES_PER_MEMORY_MBYTE = 2;

/** Every version the API returns goes through here, so a secret env var's value never leaves the runtime. */
export function versionDto(version: ActorVersionRecord) {
	return version.envVars
		? { ...version, envVars: version.envVars.map((envVar) => publicEnvVar(envVar, true)) }
		: version;
}

export function actorDto(actor: ActorRecord, username: string, audience: StandbyUrlAudience = 'host') {
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
		versions: actor.versions.map(versionDto),
		defaultRunOptions: { build: 'latest', timeoutSecs: 300, memoryMbytes: 1024 },
		deploymentKey: actor.id,
		pricingInfos: actor.pricingInfos ?? [],
		...(actor.actorStandby ? { actorStandby: actor.actorStandby } : {}),
		standbyUrl: actor.actorStandby?.isEnabled ? standbyUrl(actor, username, audience) : null,
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
	// The accumulators outlive the run, and a run turns terminal a moment before they are copied onto its
	// record, so reading them for a finished run too is what keeps its figures from briefly disappearing.
	// Only a run whose figures were accumulated by an earlier process falls back to the record.
	const usage = computeRunUsage(run, getRunTelemetry(run.id));
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
			...(run.options.maxTotalChargeUsd !== undefined
				? { maxTotalChargeUsd: run.options.maxTotalChargeUsd }
				: {}),
		},
		generalAccess: run.generalAccess ?? 'FOLLOW_USER_SETTING',
		meta: run.meta,
		...(run.meta.origin === 'STANDBY' ? { standby: { deployment: 'SINGLE_TENANT' } } : {}),
		stats: usage.stats,
		usage: usage.usage,
		usageUsd: usage.usageUsd,
		usageTotalUsd: usage.usageTotalUsd,
		...(usage.eventUsage ? { eventUsage: usage.eventUsage } : {}),
		// Omitted, not nulled, on a run without pricing - the SDKs key their "is this pay-per-event" check
		// off the field's presence.
		...(run.pricingInfo ? { pricingInfo: run.pricingInfo } : {}),
		...(run.chargedEventCounts ? { chargedEventCounts: run.chargedEventCounts } : {}),
		...(run.chargingStoppedAt ? { chargingStoppedAt: run.chargingStoppedAt } : {}),
		statusMessage: run.statusMessage,
		containerUrl: undefined,
	};
}

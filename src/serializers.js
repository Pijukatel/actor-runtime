/** Serialize domain records into public-Apify-API-shaped JSON payloads. */
import { isRunStorageId, storageNameFromId } from './constants.js';

export function userDict(user) {
    return {
        id: user.username,
        username: user.username,
        token: user.token ?? null,
        createdAt: user.createdAt,
    };
}

export function storageDict(storage) {
    // `name` comes from the single shared helper (`storageNameFromId`, also
    // used by the per-storage metadata GET) so a type-qualified
    // `username~{type}~name` id derives the same bare `name` everywhere.
    return {
        id: storage.id,
        name: storageNameFromId(storage.id, storage.type),
        type: storage.type,
        createdAt: storage.createdAt,
        named: !isRunStorageId(storage.id),
    };
}

export function versionDict(version) {
    const out = {
        versionNumber: version.versionNumber,
        buildTag: version.buildTag,
        sourceType: version.sourceType,
        sourceFiles: version.sourceFiles,
    };
    if (version.tarballUrl) out.tarballUrl = version.tarballUrl;
    return out;
}

export function actorDict(actor, versions, taggedBuilds, settings) {
    const out = {
        id: actor.id,
        userId: actor.username,
        name: actor.name,
        username: actor.username,
        createdAt: actor.createdAt,
        modifiedAt: actor.modifiedAt,
        defaultRunOptions:
            actor.defaultRunOptions && Object.keys(actor.defaultRunOptions).length
                ? actor.defaultRunOptions
                : { build: 'latest', timeoutSecs: 300, memoryMbytes: 1024 },
        versions: versions.map(versionDict),
        taggedBuilds,
        // `isPublic`/`stats` are required (no default) by apify-client's own
        // Actor response model -- `client.actor(id).get()` re-validates every
        // GET through that model, so a response missing either field fails
        // the call itself before an Actor even sees the result. This runtime
        // never marks anything public, and tracks none of the platform's
        // aggregate usage stats, so both are synthesized.
        isPublic: false,
        stats: {},
    };
    // `standbyUrl` is present only for a standby-enabled actor (matching the
    // real platform: a non-standby actor has no such field at all, not a
    // null one).
    if ((actor.actorStandby ?? {}).isEnabled) {
        out.standbyUrl = `${settings.containerApiBaseUrl}/v2/actor-standby/${actor.id}`;
    }
    return out;
}

export function buildDict(build) {
    return {
        id: build.id,
        actId: build.actorId,
        userId: build.username,
        username: build.username,
        status: build.status,
        buildNumber: build.buildNumber,
        buildTag: build.buildTag,
        startedAt: build.startedAt,
        finishedAt: build.finishedAt ?? null,
    };
}

export function runDict(run) {
    const options = { ...(run.options ?? {}) };
    options.build ??= 'latest';
    options.timeoutSecs ??= 300;
    options.memoryMbytes ??= 1024;
    // `diskMbytes` is required (no default) by apify-client's own RunOptions
    // sub-model (nested under Run.options).
    options.diskMbytes ??= 2048;
    return {
        id: run.id,
        actId: run.actorId,
        actorId: run.actorId,
        userId: run.username,
        username: run.username,
        status: run.status,
        buildId: run.buildId,
        buildNumber: run.buildNumber,
        exitCode: run.exitCode ?? null,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt ?? null,
        options,
        containerUrl: `http://localhost/${run.id}`,
        defaultKeyValueStoreId: run.kvStoreId,
        defaultDatasetId: run.datasetId,
        defaultRequestQueueId: run.requestQueueId,
        // `meta`/`stats` are required (no default) by apify-client's own Run
        // response model: the SDK's `Actor.init()` re-validates
        // `client.run(runId).get()` through that model whenever the Actor is
        // running "at home" (this runtime always sets APIFY_IS_AT_HOME=1), so
        // a response missing either field would crash `Actor.init()` itself
        // before an Actor even reaches its own code. `origin` mirrors the
        // same STANDBY-vs-API distinction `buildEnvironment` sets as
        // APIFY_META_ORIGIN; the other stats fields have no local equivalent
        // to source, so they're synthesized as zero.
        meta: { origin: run.isStandby ? 'STANDBY' : 'API' },
        stats: { restartCount: 0, resurrectCount: 0, computeUnits: 0.0 },
        // `generalAccess` is likewise required (no default) by the same
        // model; FOLLOW_USER_SETTING is the real platform's own default
        // general access level when nothing overrides it.
        generalAccess: 'FOLLOW_USER_SETTING',
    };
}

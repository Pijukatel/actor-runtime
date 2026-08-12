/** Actor, version and build-trigger endpoints (Apify /v2/acts + /v2/actors), plus /v2/users/me. */
import { resolveUser } from '../auth.js';
import { STORAGE_DS, STORAGE_KV, STORAGE_RQ } from '../constants.js';
import { data, notFound, readJson } from '../http.js';
import { paginate, parsePage } from '../pagination.js';
import { actorDict, buildDict, runDict, storageDict, versionDict } from '../serializers.js';

function actorPayload(svc, actor) {
    const versions = svc.listVersions(actor.id);
    const tagged = svc.taggedBuilds(actor.id);
    return actorDict(actor, versions, tagged, svc.settings);
}

async function myStorages(ctx, storageType) {
    const svc = ctx.service;
    const user = await resolveUser(ctx);
    const items = svc.listStoragesForUser(user, storageType).map(storageDict);
    const { limit, offset } = parsePage(ctx);
    const page = limit !== null || offset !== null ? paginate(items, limit, offset) : items;
    return data({ total: items.length, count: page.length, items: page });
}

export function registerMeRoutes(router) {
    router.add('GET', '/v2/users/me', async (ctx) => {
        const user = await resolveUser(ctx);
        const row = ctx.service.getUser(user);
        return data({ id: user, username: user, token: row?.token ?? null });
    });

    router.add('GET', '/v2/users/me/actors', async (ctx) => {
        const svc = ctx.service;
        const user = await resolveUser(ctx);
        const items = svc.listActors(user).map((a) => actorPayload(svc, a));
        return data({ total: items.length, count: items.length, items });
    });

    router.add('GET', '/v2/users/me/builds', async (ctx) => {
        const user = await resolveUser(ctx);
        const items = ctx.service.listBuildsForUser(user).map(buildDict);
        return data({ total: items.length, count: items.length, items });
    });

    router.add('GET', '/v2/users/me/runs', async (ctx) => {
        const user = await resolveUser(ctx);
        const items = ctx.service.listRunsForUser(user).map(runDict);
        return data({ total: items.length, count: items.length, items });
    });

    router.add('GET', '/v2/users/me/key-value-stores', (ctx) => myStorages(ctx, STORAGE_KV));
    router.add('GET', '/v2/users/me/datasets', (ctx) => myStorages(ctx, STORAGE_DS));
    router.add('GET', '/v2/users/me/request-queues', (ctx) => myStorages(ctx, STORAGE_RQ));

    // Public profile lookup for ANY user, by id or username. Id and username
    // are the same value in this runtime, so one lookup serves both. Response
    // is always the public shape (no `token`), even for self-lookups.
    // `resolveUser` here is just the bootstrap-or-reject auth guard, not
    // identity resolution. Registered AFTER every `/v2/users/me*` route so
    // `me` never resolves as a username.
    router.add('GET', '/v2/users/:userIdOrUsername', async (ctx, { userIdOrUsername }) => {
        await resolveUser(ctx);
        const row = ctx.service.getUser(userIdOrUsername);
        if (!row) return notFound(`User '${userIdOrUsername}' was not found.`);
        return data({ id: row.username, username: row.username });
    });
}

/** Registered under both /v2/acts and /v2/actors (the CLI uses /v2/actors). */
export function registerActorRoutes(router, prefix) {
    router.add('GET', prefix, async (ctx) => {
        const svc = ctx.service;
        const user = await resolveUser(ctx);
        const items = svc.listActors(user).map((a) => actorPayload(svc, a));
        return data({ total: items.length, count: items.length, items });
    });

    router.add('POST', prefix, async (ctx) => {
        const svc = ctx.service;
        const user = await resolveUser(ctx);
        const body = await readJson(ctx);
        const actor = svc.createActor({
            name: body.name ?? 'actor',
            defaultRunOptions: body.defaultRunOptions ?? {},
            versions: body.versions ?? [],
            username: user,
            actorStandby: body.actorStandby ?? null,
        });
        return data(actorPayload(svc, actor), 201);
    });

    router.add('GET', `${prefix}/:actorId`, async (ctx, { actorId }) => {
        const svc = ctx.service;
        const user = await resolveUser(ctx);
        const actor = svc.getActor(actorId, user);
        if (!actor) return notFound(`Actor '${actorId}' was not found.`);
        return data(actorPayload(svc, actor));
    });

    router.add('PUT', `${prefix}/:actorId`, async (ctx, { actorId }) => {
        const svc = ctx.service;
        const user = await resolveUser(ctx);
        const body = await readJson(ctx);
        const payload = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
        const actor = svc.updateActor(actorId, payload, user);
        if (!actor) return notFound(`Actor '${actorId}' was not found.`);
        return data(actorPayload(svc, actor));
    });

    // Resolve the actor's input schema for the console's Input tab. Resolved
    // from the SAME version a default (`build=latest`) run would actually
    // execute -- the version behind the actor's most recent successful
    // build, falling back to its latest-tagged version only when no build
    // exists yet. Returns `data(null)` -- not a 404 -- whenever no schema can
    // be resolved (no versions, no manifest/schema file, a TARBALL version,
    // or a malformed schema file), matching `.actor/actor.json`'s own
    // fail-soft inference contract. Only an unknown/inaccessible actor id is
    // a 404.
    router.add('GET', `${prefix}/:actorId/input-schema`, async (ctx, { actorId }) => {
        const svc = ctx.service;
        const user = await resolveUser(ctx);
        const actor = svc.getActor(actorId, user);
        if (!actor) return notFound(`Actor '${actorId}' was not found.`);
        return data(svc.getInputSchema(actorId));
    });

    router.add('GET', `${prefix}/:actorId/versions/:versionNumber`, async (ctx, { actorId, versionNumber }) => {
        const svc = ctx.service;
        const user = await resolveUser(ctx);
        if (!svc.getActor(actorId, user)) return notFound(`Actor '${actorId}' was not found.`);
        const version = svc.getVersion(actorId, versionNumber);
        if (!version) return notFound(`Version '${versionNumber}' was not found.`);
        return data(versionDict(version));
    });

    router.add('POST', `${prefix}/:actorId/versions`, async (ctx, { actorId }) => {
        const svc = ctx.service;
        const user = await resolveUser(ctx);
        if (!svc.getActor(actorId, user)) return notFound(`Actor '${actorId}' was not found.`);
        const body = await readJson(ctx);
        const version = svc.upsertVersion(actorId, body);
        return data(versionDict(version), 201);
    });

    router.add('PUT', `${prefix}/:actorId/versions/:versionNumber`, async (ctx, { actorId, versionNumber }) => {
        const svc = ctx.service;
        const user = await resolveUser(ctx);
        if (!svc.getActor(actorId, user)) return notFound(`Actor '${actorId}' was not found.`);
        const body = await readJson(ctx);
        body.versionNumber ??= versionNumber;
        const version = svc.upsertVersion(actorId, body);
        return data(versionDict(version));
    });

    router.add('GET', `${prefix}/:actorId/builds`, async (ctx, { actorId }) => {
        const svc = ctx.service;
        const user = await resolveUser(ctx);
        const items = svc.listBuilds(actorId, user).map(buildDict);
        return data({ total: items.length, count: items.length, items });
    });

    router.add('POST', `${prefix}/:actorId/builds`, async (ctx, { actorId }) => {
        const svc = ctx.service;
        const user = await resolveUser(ctx);
        const actor = svc.getActor(actorId, user);
        if (!actor) return notFound(`Actor '${actorId}' was not found.`);
        const versionNumber = ctx.query.get('version') || '0.0';
        const tag = ctx.query.get('tag') || 'latest';
        const version = svc.getVersion(actorId, versionNumber);
        const buildTag = version ? version.buildTag : tag;
        const build = svc.startBuild(actorId, versionNumber, buildTag);
        return data(buildDict(build), 201);
    });
}

/**
 * Runtime-global upstream-fallback toggle: GET/PUT /v2/runtime-config.
 *
 * A single in-memory boolean on the shared `Service` instance
 * (`Service.upstreamFallbackEnabled`) -- not persisted, resets to false on
 * every restart. `PUT` takes effect immediately for every user and both
 * ports, since both serve the same Service instance.
 *
 * `GET` is token-free (no bootstrap side effect), like `GET /v2/users`:
 * merely reading the runtime-wide switch is not per-user data and must never
 * claim a token as a side effect. `PUT` is NOT token-free: it validates the
 * presented credential and discards the result purely as a token-validity
 * check, resolving an absent token to the default user (never rejected for
 * lacking a credential), same as every other mutating endpoint. Unlike every
 * other mutating endpoint, though, it resolves a PRESENT token via
 * `resolveUser(ctx, {bootstrap: false})` -- a PURE lookup -- rather than the
 * bootstrap-or-reject every other handler uses: a token matching no existing
 * user is `401 invalid-token` with NO state mutation, never a silent
 * bootstrap of the default user's credential. See `resolveUser`'s own
 * docstring for why this one endpoint must never let an unrecognized token
 * get bound as the default user's credential.
 */
import { resolveUser } from '../auth.js';
import { badRequest, data, readJson } from '../http.js';

function payload(svc) {
    return { upstreamFallbackEnabled: svc.upstreamFallbackEnabled };
}

export function registerRuntimeConfigRoutes(router) {
    router.add('GET', '/v2/runtime-config', async (ctx) => data(payload(ctx.service)));

    router.add('PUT', '/v2/runtime-config', async (ctx) => {
        const svc = ctx.service;
        // Token-validity check only, never a bootstrap; see module docstring.
        await resolveUser(ctx, { bootstrap: false });
        const body = await readJson(ctx);
        const enabled =
            body && typeof body === 'object' && !Array.isArray(body) ? body.upstreamFallbackEnabled : null;
        if (typeof enabled !== 'boolean') {
            return badRequest("Body must include 'upstreamFallbackEnabled' as a boolean.");
        }
        svc.upstreamFallbackEnabled = enabled;
        return data(payload(svc));
    });
}

/**
 * Resolve the acting user from the request's `Authorization: Bearer` token.
 *
 * There is no real authentication. Identity (a username) and credential (a
 * token) are decoupled: the token is only ever used to look up which stored
 * user is acting and is never turned into a username.
 *
 * Three variants of that resolution live here side by side, deliberately
 * co-located so they can be diffed by eye:
 *
 * - `resolveUser` -- the default bootstrap-or-reject resolution, used by
 *   every registered handler that needs identity.
 * - `resolveStandbyCaller` -- the standby-forwarding variant, which never
 *   falls back to the default user for a missing credential.
 * - `resolveForwardableToken` -- the pure lookup used by the upstream
 *   fallback proxy, which never binds, bootstraps, or forwards a credential
 *   the caller didn't themselves present.
 */
import { DEFAULT_USERNAME } from './config.js';

/** Raised when a present bearer token matches no user after bootstrap. */
export class InvalidTokenError extends Error {}

export function tokenFromRequest(ctx) {
    const header = ctx.headers.authorization ?? '';
    if (!header) return '';
    const parts = header.split(/\s+/, 2);
    if (parts.length === 2 && parts[0].toLowerCase() === 'bearer') {
        return header.slice(header.toLowerCase().indexOf('bearer') + 'bearer'.length).trim();
    }
    return header.trim();
}

/**
 * Return the acting username for the request's credential.
 *
 * No token -> the default user. A token matching a stored user -> that user.
 * A token matching no user, with `bootstrap` true (the default, used by
 * every registered handler that needs identity) -> bootstrap the (still
 * unclaimed) default user with it, else reject.
 *
 * `bootstrap: false` is used only by the runtime-config `PUT` handler: a
 * token matching no user is rejected outright, with NO state mutation --
 * `bindDefaultToken` is never called. That distinction matters specifically
 * there because that switch, once on, causes the runtime to forward the
 * caller's own real Apify credential to the public internet on a local 404:
 * binding an unrecognized token to the default user's credential on that one
 * endpoint would both hand whoever presented it control over every future
 * anonymous fallback attempt AND permanently lock out the operator's own
 * later, real login.
 */
export async function resolveUser(ctx, { bootstrap = true } = {}) {
    const token = tokenFromRequest(ctx);
    const service = ctx.service;
    if (!token) {
        service.ensureDefaultUser();
        return DEFAULT_USERNAME;
    }
    const username = service.userForToken(token);
    if (username !== null) return username;
    if (bootstrap && service.bindDefaultToken(token)) {
        return DEFAULT_USERNAME;
    }
    throw new InvalidTokenError();
}

/**
 * Resolve the standby-forwarding caller's username from `?token=` or bearer.
 *
 * Differs from `resolveUser` in exactly one respect: a request presenting no
 * credential at all is rejected (401) rather than falling back to the
 * default user, since forwarding into (and possibly starting) an Actor
 * container must never happen anonymously. A token that IS present goes
 * through the exact same bootstrap-or-reject resolution as everywhere else.
 */
export async function resolveStandbyCaller(ctx) {
    const token = ctx.query.get('token') || tokenFromRequest(ctx);
    if (!token) throw new InvalidTokenError();
    const service = ctx.service;
    const username = service.userForToken(token);
    if (username !== null) return username;
    if (service.bindDefaultToken(token)) return DEFAULT_USERNAME;
    throw new InvalidTokenError();
}

/**
 * Return the caller's own bound token to forward upstream, or `null`.
 *
 * Used only by `src/upstream.js`'s fallback proxy. Differs from
 * `resolveUser` in two respects: it is a PURE lookup (never binds or
 * bootstraps), and a request presenting NO credential at all is never
 * resolved to the default user -- it returns `null` outright. Forwarding a
 * credential the caller never presented would mean any anonymous,
 * cross-origin request could spend the operator's own real Apify token; the
 * fallback attempt must instead be abandoned before it ever considers
 * forwarding anything.
 *
 * Three outcomes are NOT the same and callers must not conflate them:
 * - `null` from NO presented token, OR a PRESENT token matching no existing
 *   user. Either way there is nothing to forward; the caller must abandon
 *   the attempt entirely.
 * - `''` (empty string) -- a PRESENT token resolved to a known user who
 *   simply has no bound `token` yet. The attempt must proceed, forwarding no
 *   `Authorization` header, rather than abort.
 *
 * A present token resolves through `service.getUser`, NOT the presented
 * token directly: `userForToken` matches either a user's bound `token` OR
 * their `containerToken` (so an Actor container's own injected `APIFY_TOKEN`
 * also resolves here), and the row's own `token` -- the user's real bound
 * credential -- is what must be forwarded, never the container token that
 * happened to resolve it.
 */
export async function resolveForwardableToken(ctx) {
    const token = tokenFromRequest(ctx);
    if (!token) return null;
    const service = ctx.service;
    const username = service.userForToken(token);
    if (username === null) return null;
    const row = service.getUser(username);
    return row?.token ? row.token : '';
}

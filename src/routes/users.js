/**
 * User management endpoints: list all users and create a user by name.
 *
 * Both are deliberately open (no per-user guard, tokens returned in
 * plaintext) -- consistent with the tool's local, no-auth ethos. Tokens are
 * the mechanism the console uses to reveal and switch the acting user.
 * `GET /v2/users` is token-free with NO bootstrap side effect: it never
 * calls the token->user resolver, so presenting a bearer token to it (stale,
 * unknown or valid) neither resolves nor claims a user.
 */
import { resolveUser } from '../auth.js';
import { badRequest, conflict, data, readJson } from '../http.js';
import { userDict } from '../serializers.js';

// A username is the load-bearing owner segment of the `username~name` id
// scheme (Actors and storages) and of storage id namespacing, so it must
// exclude `~` and `/` at minimum. Restrict to the safe charset identity was
// always confined to, and require at least one alphanumeric so a "safe" name
// can't be all-punctuation (`.`, `..`, `---`); reject anything else rather
// than mutate (the name is also the token, so silent mutation would break
// login).
const SAFE_NAME = /^(?=.*[A-Za-z0-9])[A-Za-z0-9_.-]+$/;

export function registerUserRoutes(router) {
    router.add('GET', '/v2/users', async (ctx) => {
        const items = ctx.service.listUsers().map(userDict);
        return data({ total: items.length, count: items.length, items });
    });

    router.add('POST', '/v2/users', async (ctx) => {
        const svc = ctx.service;
        await resolveUser(ctx);
        const body = await readJson(ctx);
        const name = body && typeof body === 'object' && !Array.isArray(body) ? body.name : null;
        if (typeof name !== 'string' || !name || !SAFE_NAME.test(name)) {
            return badRequest(
                "User name must be a non-empty string, contain only letters, digits, '_', '.' or '-' " +
                "(no '~', '/', spaces or other characters), and include at least one letter or digit.",
            );
        }
        const user = svc.createUser(name);
        if (user === null) {
            // Distinguish a taken username from a name that collides with
            // another user's (unique) token, so the 409 message reflects the
            // actual cause.
            if (svc.getUser(name)) {
                return conflict(`A user named '${name}' already exists.`);
            }
            return conflict(`The name '${name}' is already in use as another user's token.`);
        }
        return data(userDict(user), 201);
    });
}

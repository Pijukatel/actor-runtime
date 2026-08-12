/**
 * Shared Actor-provisioning and storage read/write harness for the decoupled
 * multi-user test suites (`multi-user.test.js`, `storage-sharing.test.js`).
 *
 * Deliberately a plain helper module rather than a global setup file: its
 * helpers only take effect where a test module imports them, so `seedUsers`
 * stays scoped to its two callers (each calls it from its own `beforeEach`)
 * instead of applying to every suite under `tests/unit/`.
 */
import { authHeaders } from '../helpers.js';

export const KV = 'key-value-stores';
export const DS = 'datasets';
export const RQ = 'request-queues';

export function auth(token) {
    return authHeaders(token);
}

/**
 * Create a user (username == token == name) via the open, token-less endpoint.
 *
 * Sent without an Authorization header so it never bootstraps the default
 * user's token; token-based resolution then treats `name` as a known user's
 * token.
 */
export async function createUser(client, name) {
    await client.post('/v2/users', { json: { name } });
}

/**
 * Pre-create the users whose tokens the tests present as bearer credentials.
 *
 * Under the decoupled model an unknown present token is bootstrap-or-reject,
 * so `alice`/`bob` must exist as real users before their tokens resolve.
 * Created token-less, leaving the default user unclaimed for the bootstrap
 * tests. Call from each suite's `beforeEach` (the port of the Python
 * `_seed_users` autouse fixture).
 */
export async function seedUsers(client) {
    for (const name of ['alice', 'bob']) {
        await createUser(client, name);
    }
}

export async function push(client, name, token) {
    await createUser(client, token);
    await client.post('/v2/acts', {
        json: { name, versions: [{ versionNumber: '0.0', buildTag: 'latest' }] },
        headers: auth(token),
    });
    const actorId = `${token}~${name}`;
    await client.post(`/v2/actors/${actorId}/versions`, {
        json: {
            versionNumber: '0.0',
            sourceType: 'SOURCE_FILES',
            sourceFiles: [{ name: 'main.py', format: 'TEXT', content: "print('hi')\n" }],
        },
        headers: auth(token),
    });
    return actorId;
}

/** Push, build and run an Actor under `token`; return `{actorId, build, run}`. */
export async function provision(client, service, token, { name = 'sample-actor', greeting = 'hi' } = {}) {
    const actorId = await push(client, name, token);
    const build = (await client.post(`/v2/acts/${actorId}/builds?version=0.0`, { headers: auth(token) }))
        .json().data;
    await service.waitIdle();
    let run = (
        await client.post(`/v2/acts/${actorId}/runs`, {
            body: JSON.stringify({ greeting }),
            headers: { ...auth(token), 'content-type': 'application/json' },
        })
    ).json().data;
    await service.waitIdle();
    run = (await client.get(`/v2/actor-runs/${run.id}`, { headers: auth(token) })).json().data;
    return { actorId, build, run };
}

export function storageId(run, storageType) {
    return {
        [KV]: run.defaultKeyValueStoreId,
        [DS]: run.defaultDatasetId,
        [RQ]: run.defaultRequestQueueId,
    }[storageType];
}

export function readPaths(storageType, sid) {
    if (storageType === KV) {
        return [`/v2/${KV}/${sid}`, `/v2/${KV}/${sid}/keys`, `/v2/${KV}/${sid}/records/OUTPUT`];
    }
    if (storageType === DS) {
        return [`/v2/${DS}/${sid}`, `/v2/${DS}/${sid}/items`];
    }
    return [`/v2/${RQ}/${sid}`, `/v2/${RQ}/${sid}/requests`];
}

/** Perform the write-shaped op for the storage type; return the response. */
export async function write(client, storageType, sid, token) {
    if (storageType === KV) {
        return client.put(`/v2/${KV}/${sid}/records/GRANTEE`, {
            body: JSON.stringify({ from: token }),
            headers: { ...auth(token), 'content-type': 'application/json' },
        });
    }
    if (storageType === DS) {
        return client.post(`/v2/${DS}/${sid}/items`, {
            body: JSON.stringify({ from: token }),
            headers: { ...auth(token), 'content-type': 'application/json' },
        });
    }
    return client.post(`/v2/${RQ}/${sid}/requests`, {
        body: JSON.stringify({ url: `https://example.com/${token}`, uniqueKey: token }),
        headers: { ...auth(token), 'content-type': 'application/json' },
    });
}

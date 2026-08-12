/**
 * Coverage for the actor input-schema resolver and its
 * `GET /{actor_id}/input-schema` endpoint.
 *
 * All run Docker-free through `wire()` (in-process app + StubDriver, see
 * `tests/helpers.js`). Mirrors `api.test.js`'s `pushActor` two-call push
 * shape (create, then set the version's source), extended with the extra
 * knobs (version number/tag, source type) these tests need that the plain
 * helper doesn't expose.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveInputSchema } from '../../src/input-schema.js';
import { wire } from '../helpers.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SAMPLE_ACTOR_DIRS = [
    'sample_actor',
    'sample_actor_caller',
    'sample_actor_isathome',
    'sample_actor_standby',
    'sample_actor_crawler',
];

const NOT_FOUND = 'record-not-found';

// A minimal-but-real input schema shared by most tests below; asserted via
// `toEqual` against the endpoint's response, which proves shape/content
// equality only. `toEqual` is order-insensitive (`{a: 1, b: 2}` equals
// `{b: 2, a: 1}`), so none of the `toEqual(INPUT_SCHEMA)` assertions below
// prove key order survives resolution -- see the
// 'schema property key order is preserved' test for a genuine,
// serialization-based order check.
const INPUT_SCHEMA = {
    title: 'Test schema',
    type: 'object',
    properties: {
        greeting: { title: 'Greeting', type: 'string', default: 'hi' },
    },
    required: ['greeting'],
};

let ctx;

beforeEach(async () => {
    ctx = await wire();
});

afterEach(async () => {
    await ctx.close();
});

/**
 * Create an Actor, then upsert its version with the given inline source
 * files (or, for a `TARBALL` version, a `tarballUrl`). Returns the actor id.
 */
async function pushActor(
    client,
    name,
    sourceFiles,
    { versionNumber = '0.0', buildTag = 'latest', sourceType = 'SOURCE_FILES', tarballUrl = null } = {},
) {
    const created = await client.post('/v2/acts', {
        json: { name, versions: [{ versionNumber, buildTag }] },
    });
    const actorId = created.json().data.id;
    const payload = { versionNumber, buildTag, sourceType };
    if (sourceType === 'TARBALL') {
        payload.tarballUrl = tarballUrl;
    } else {
        payload.sourceFiles = sourceFiles;
    }
    await client.post(`/v2/actors/${actorId}/versions`, { json: payload });
    return actorId;
}

describe('input schema', () => {
    // -- Resolution order: .actor/input_schema.json --------------------------
    it('resolves inline input_schema.json', async () => {
        const { client } = ctx;
        const actorId = await pushActor(client, 'schema-actor', [
            { name: 'main.py', format: 'TEXT', content: "print('hi')\n" },
            { name: '.actor/input_schema.json', format: 'TEXT', content: JSON.stringify(INPUT_SCHEMA) },
        ]);
        const resp = await client.get(`/v2/acts/${actorId}/input-schema`);
        expect(resp.status).toBe(200);
        expect(resp.json().data).toEqual(INPUT_SCHEMA);
    });

    it('input-schema endpoint is mounted under the /v2/actors prefix too', async () => {
        // The router is registered under both /v2/acts and /v2/actors
        // (src/app.js) -- the CLI uses /v2/actors, the console has
        // historically used /v2/acts.
        const { client } = ctx;
        const actorId = await pushActor(client, 'schema-actor-actors-prefix', [
            { name: '.actor/input_schema.json', format: 'TEXT', content: JSON.stringify(INPUT_SCHEMA) },
        ]);
        const resp = await client.get(`/v2/actors/${actorId}/input-schema`);
        expect(resp.status).toBe(200);
        expect(resp.json().data).toEqual(INPUT_SCHEMA);
    });

    it('schema property key order is preserved, not just shape', async () => {
        // Every other test in this file compares via `toEqual`, which is
        // order-insensitive and so proves shape/content equality only (see
        // the comment on INPUT_SCHEMA above). This test uses a schema with
        // multiple, deliberately non-alphabetical property keys and compares
        // the response's *serialized* key order (both directly via
        // `Object.keys(...)` and via a full `JSON.stringify` string
        // comparison) to genuinely prove resolution/response does not reorder
        // schema properties.
        const { client } = ctx;
        const orderedSchema = {
            title: 'Order-sensitive schema',
            type: 'object',
            properties: {
                zeta: { type: 'string' },
                alpha: { type: 'string' },
                middle: { type: 'string' },
            },
            required: [],
        };
        const actorId = await pushActor(client, 'order-actor', [
            { name: '.actor/input_schema.json', format: 'TEXT', content: JSON.stringify(orderedSchema) },
        ]);
        const resp = await client.get(`/v2/acts/${actorId}/input-schema`);
        expect(resp.status).toBe(200);
        const data = resp.json().data;
        expect(data).toEqual(orderedSchema); // shape (order-insensitive, as above)
        expect(Object.keys(data.properties)).toEqual(['zeta', 'alpha', 'middle']); // order, genuinely
        expect(JSON.stringify(data)).toBe(JSON.stringify(orderedSchema)); // belt-and-suspenders full-order match
    });

    // -- Resolution order: .actor/actor.json's `input` field -----------------
    it("resolves actor.json's `input` field as a relative path", async () => {
        // `input` as a string co-located with actor.json inside `.actor/` --
        // resolved via the ".actor/"-context candidate.
        const { client } = ctx;
        const manifest = JSON.stringify({
            actorSpecification: 1,
            name: 'x',
            version: '0.0',
            buildTag: 'latest',
            input: './input_schema.json',
        });
        const actorId = await pushActor(client, 'relpath-actor', [
            { name: '.actor/actor.json', format: 'TEXT', content: manifest },
            { name: '.actor/input_schema.json', format: 'TEXT', content: JSON.stringify(INPUT_SCHEMA) },
        ]);
        const resp = await client.get(`/v2/acts/${actorId}/input-schema`);
        expect(resp.json().data).toEqual(INPUT_SCHEMA);
    });

    it("resolves actor.json's `input` field relative to the project root", async () => {
        // `input` as a string pointing at a file outside `.actor/` entirely
        // -- resolved via the as-given (no ".actor/" prefix) candidate.
        const { client } = ctx;
        const manifest = JSON.stringify({
            actorSpecification: 1,
            name: 'x',
            version: '0.0',
            buildTag: 'latest',
            input: 'schemas/input.json',
        });
        const actorId = await pushActor(client, 'rootpath-actor', [
            { name: '.actor/actor.json', format: 'TEXT', content: manifest },
            { name: 'schemas/input.json', format: 'TEXT', content: JSON.stringify(INPUT_SCHEMA) },
        ]);
        const resp = await client.get(`/v2/acts/${actorId}/input-schema`);
        expect(resp.json().data).toEqual(INPUT_SCHEMA);
    });

    it("resolves actor.json's `input` field as an inline object", async () => {
        const { client } = ctx;
        const manifest = JSON.stringify({
            actorSpecification: 1,
            name: 'x',
            version: '0.0',
            buildTag: 'latest',
            input: INPUT_SCHEMA,
        });
        const actorId = await pushActor(client, 'inline-actor', [
            { name: '.actor/actor.json', format: 'TEXT', content: manifest },
        ]);
        const resp = await client.get(`/v2/acts/${actorId}/input-schema`);
        expect(resp.json().data).toEqual(INPUT_SCHEMA);
    });

    it('an `input` field pointing at a missing file falls back to the default schema file', async () => {
        // An `input` string that resolves to no pushed file is a soft miss
        // for step 1 -- resolution then falls through to
        // `.actor/input_schema.json` (step 2), it does not give up entirely.
        const { client } = ctx;
        const manifest = JSON.stringify({
            actorSpecification: 1,
            name: 'x',
            version: '0.0',
            buildTag: 'latest',
            input: 'does-not-exist.json',
        });
        const actorId = await pushActor(client, 'fallback-actor', [
            { name: '.actor/actor.json', format: 'TEXT', content: manifest },
            { name: '.actor/input_schema.json', format: 'TEXT', content: JSON.stringify(INPUT_SCHEMA) },
        ]);
        const resp = await client.get(`/v2/acts/${actorId}/input-schema`);
        expect(resp.json().data).toEqual(INPUT_SCHEMA);
    });

    // -- Encoding -------------------------------------------------------------
    it('resolves a BASE64-encoded schema file', async () => {
        const { client } = ctx;
        const encoded = Buffer.from(JSON.stringify(INPUT_SCHEMA)).toString('base64');
        const actorId = await pushActor(client, 'b64-actor', [
            { name: '.actor/input_schema.json', format: 'BASE64', content: encoded },
        ]);
        const resp = await client.get(`/v2/acts/${actorId}/input-schema`);
        expect(resp.json().data).toEqual(INPUT_SCHEMA);
    });

    // -- Fail-soft / fallback cases --------------------------------------------
    it('no schema returns null', async () => {
        const { client } = ctx;
        const actorId = await pushActor(client, 'no-schema-actor', [
            { name: 'main.py', format: 'TEXT', content: "print('hi')\n" },
        ]);
        const resp = await client.get(`/v2/acts/${actorId}/input-schema`);
        expect(resp.status).toBe(200);
        expect(resp.json().data).toBeNull();
    });

    it('a TARBALL version falls back to null', async () => {
        // A TARBALL version's archive isn't inspectable pre-build (see
        // `Service.getInputSchema`'s doc comment) -- always `null`,
        // regardless of what the (unread) archive might contain.
        const { client } = ctx;
        const actorId = await pushActor(client, 'tarball-actor', [], {
            sourceType: 'TARBALL',
            tarballUrl: 'http://test/key-value-stores/store123/records/source.zip',
        });
        const resp = await client.get(`/v2/acts/${actorId}/input-schema`);
        expect(resp.status).toBe(200);
        expect(resp.json().data).toBeNull();
    });

    it('malformed schema JSON fails soft', async () => {
        const { client } = ctx;
        const actorId = await pushActor(client, 'malformed-actor', [
            { name: '.actor/input_schema.json', format: 'TEXT', content: '{not valid json' },
        ]);
        const resp = await client.get(`/v2/acts/${actorId}/input-schema`);
        expect(resp.status).toBe(200);
        expect(resp.json().data).toBeNull();
    });

    it('a schema file that is not a JSON object fails soft', async () => {
        // Valid JSON that isn't an object (e.g. a bare array) is not a valid
        // schema shape -- fails soft to `null`, same as unparseable JSON.
        const { client } = ctx;
        const actorId = await pushActor(client, 'list-schema-actor', [
            { name: '.actor/input_schema.json', format: 'TEXT', content: JSON.stringify([1, 2, 3]) },
        ]);
        const resp = await client.get(`/v2/acts/${actorId}/input-schema`);
        expect(resp.status).toBe(200);
        expect(resp.json().data).toBeNull();
    });

    it('an unknown actor returns record-not-found', async () => {
        const { client } = ctx;
        const resp = await client.get('/v2/acts/local-user~does-not-exist/input-schema');
        expect(resp.status).toBe(404);
        expect(resp.json().error.type).toBe(NOT_FOUND);
    });

    // -- Version resolution: the actor's latest-tagged version -----------------
    it('resolves the schema from the latest-tagged version, not an arbitrary one', async () => {
        // A higher version number tagged something other than "latest" must
        // NOT win over a lower-numbered version that IS tagged "latest" --
        // the resolver follows the tag, not push order or version-number size
        // alone.
        const { client } = ctx;
        const created = await client.post('/v2/acts', {
            json: { name: 'multi-version-actor', versions: [] },
        });
        const actorId = created.json().data.id;

        const oldSchema = { type: 'object', properties: { old: { type: 'string' } } };
        const newSchema = { type: 'object', properties: { new: { type: 'string' } } };

        // Pushed first, but tagged "beta" (not "latest") and numbered higher.
        await client.post(`/v2/actors/${actorId}/versions`, {
            json: {
                versionNumber: '2.0',
                buildTag: 'beta',
                sourceType: 'SOURCE_FILES',
                sourceFiles: [
                    { name: '.actor/input_schema.json', format: 'TEXT', content: JSON.stringify(newSchema) },
                ],
            },
        });
        // Pushed second, numbered lower, but tagged "latest" -- this is the
        // one a default `build=latest` run would use, so its schema must win.
        await client.post(`/v2/actors/${actorId}/versions`, {
            json: {
                versionNumber: '1.0',
                buildTag: 'latest',
                sourceType: 'SOURCE_FILES',
                sourceFiles: [
                    { name: '.actor/input_schema.json', format: 'TEXT', content: JSON.stringify(oldSchema) },
                ],
            },
        });

        const resp = await client.get(`/v2/acts/${actorId}/input-schema`);
        expect(resp.json().data).toEqual(oldSchema);
    });

    it('the schema matches the build a default run actually executes', async () => {
        // Regression coverage: `Service.startRun`'s default (no explicit
        // build/version override) path never consults any version's
        // `buildTag` at all -- it calls `latestBuild()`, which returns the
        // most recently *started* successful build row, tag-blind. So the
        // schema endpoint must resolve from THAT build's version, not merely
        // whichever version currently carries the "latest" tag.
        //
        // Push v1.0 tagged "latest" (schema A) and build it; then push v2.0
        // tagged "beta" (schema B, NOT "latest") and build it LATER -- v2.0's
        // build is now the actor's `latestBuild()`, i.e. what a default
        // Start actually runs. The schema shown must be v2.0's, even though
        // v1.0 still carries the "latest" tag.
        const { client, service } = ctx;
        const created = await client.post('/v2/acts', {
            json: { name: 'build-vs-tag-actor', versions: [] },
        });
        const actorId = created.json().data.id;

        const schemaV1 = { type: 'object', properties: { v1: { type: 'string' } } };
        const schemaV2 = { type: 'object', properties: { v2: { type: 'string' } } };

        // v1.0, tagged "latest", pushed AND BUILT first.
        await client.post(`/v2/actors/${actorId}/versions`, {
            json: {
                versionNumber: '1.0',
                buildTag: 'latest',
                sourceType: 'SOURCE_FILES',
                sourceFiles: [
                    { name: '.actor/input_schema.json', format: 'TEXT', content: JSON.stringify(schemaV1) },
                ],
            },
        });
        await client.post(`/v2/acts/${actorId}/builds?version=1.0`);
        await service.waitIdle();

        // Before v2.0 is built, the resolved schema must still be v1.0's --
        // it is the only successful build that exists so far.
        let resp = await client.get(`/v2/acts/${actorId}/input-schema`);
        expect(resp.json().data).toEqual(schemaV1);

        // v2.0, tagged "beta" (NOT "latest"), pushed AND BUILT second -- now
        // the actor's `latestBuild()`, even though v1.0 still carries
        // "latest".
        await client.post(`/v2/actors/${actorId}/versions`, {
            json: {
                versionNumber: '2.0',
                buildTag: 'beta',
                sourceType: 'SOURCE_FILES',
                sourceFiles: [
                    { name: '.actor/input_schema.json', format: 'TEXT', content: JSON.stringify(schemaV2) },
                ],
            },
        });
        await client.post(`/v2/acts/${actorId}/builds?version=2.0`);
        await service.waitIdle();

        resp = await client.get(`/v2/acts/${actorId}/input-schema`);
        expect(
            resp.json().data,
            'schema endpoint must follow the build a default Start actually runs ' +
                "(v2.0's, the more recently built one), not the version still tagged " +
                '"latest" (v1.0)',
        ).toEqual(schemaV2);
    });

    it('falls back to the highest version when none is tagged latest', async () => {
        const { client } = ctx;
        const created = await client.post('/v2/acts', {
            json: { name: 'no-latest-actor', versions: [] },
        });
        const actorId = created.json().data.id;

        const schemaV1 = { type: 'object', properties: { v1: { type: 'string' } } };
        const schemaV2 = { type: 'object', properties: { v2: { type: 'string' } } };

        for (const [versionNumber, schema] of [['1.0', schemaV1], ['2.0', schemaV2]]) {
            await client.post(`/v2/actors/${actorId}/versions`, {
                json: {
                    versionNumber,
                    buildTag: 'beta',
                    sourceType: 'SOURCE_FILES',
                    sourceFiles: [
                        { name: '.actor/input_schema.json', format: 'TEXT', content: JSON.stringify(schema) },
                    ],
                },
            });
        }

        const resp = await client.get(`/v2/acts/${actorId}/input-schema`);
        expect(resp.json().data).toEqual(schemaV2);
    });

    // -- The run-start endpoint stays permissive --------------------------------
    it('start-run stays permissive despite a required schema field', async () => {
        // A schema `required` property is enforced client-side only: the
        // server keeps accepting a body missing it, and even an unknown extra
        // key, exactly as before -- no new server-side schema
        // validation/rejection.
        const { client, service } = ctx;
        const actorId = await pushActor(client, 'permissive-actor', [
            { name: 'main.py', format: 'TEXT', content: "print('hi')\n" },
            { name: '.actor/input_schema.json', format: 'TEXT', content: JSON.stringify(INPUT_SCHEMA) },
        ]);
        const resp = await client.post(`/v2/acts/${actorId}/runs`, {
            // missing required "greeting"; unknown key present
            body: JSON.stringify({ unexpectedKey: 'nope' }),
            headers: { 'content-type': 'application/json' },
        });
        expect(resp.status).toBe(201);
        expect(resp.json().data.status).toBe('RUNNING');
        // Let the spawned run finish before the teardown closes the app, so
        // a background task doesn't outlive the test (mirrors api.test.js's
        // own full-flow test).
        await service.waitIdle();
    });

    // -- Re-push regression: a schema added later shows up without a rebuild ----
    it('re-pushing the same version updates the schema without a new build', async () => {
        // The exact mechanism behind "an Actor pushed before it had a schema
        // keeps showing plain JSON until re-pushed": the service's version
        // upsert overwrites a version's `sourceFiles` IN PLACE, and
        // `getInputSchema` always re-reads that version row live -- so
        // pushing the SAME version number again, now with a schema, changes
        // what `GET /input-schema` returns without triggering, or needing,
        // any new build. A plain `apify push --force` is enough.
        const { client, service } = ctx;
        const actorId = await pushActor(client, 'repush-actor', [
            { name: 'main.py', format: 'TEXT', content: "print('hi')\n" },
        ]);

        // No schema yet -- confirm the pre-schema baseline (plain-JSON fallback).
        let resp = await client.get(`/v2/acts/${actorId}/input-schema`);
        expect(resp.json().data).toBeNull();

        await client.post(`/v2/acts/${actorId}/builds?version=0.0`);
        await service.waitIdle();

        const buildsBefore = (await client.get(`/v2/acts/${actorId}/builds`)).json().data;
        expect(buildsBefore.total).toBe(1);

        // Re-push the SAME version number, now including a schema -- a plain
        // `apify push` from the CLI, not a new version and not a new build.
        await client.post(`/v2/actors/${actorId}/versions`, {
            json: {
                versionNumber: '0.0',
                buildTag: 'latest',
                sourceType: 'SOURCE_FILES',
                sourceFiles: [
                    { name: 'main.py', format: 'TEXT', content: "print('hi')\n" },
                    { name: '.actor/input_schema.json', format: 'TEXT', content: JSON.stringify(INPUT_SCHEMA) },
                ],
            },
        });

        resp = await client.get(`/v2/acts/${actorId}/input-schema`);
        expect(resp.json().data).toEqual(INPUT_SCHEMA);

        const buildsAfter = (await client.get(`/v2/acts/${actorId}/builds`)).json().data;
        expect(buildsAfter.total, 're-pushing the same version must not trigger a new build').toBe(1);
    });
});

// -- Every on-disk sample Actor tree resolves a real schema --------------------
/**
 * Read every file under `actorDir/.actor` -- the only tree
 * `resolveInputSchema` ever looks at -- into the same source-file shape
 * (`name`/`format`/`content`) the tests above build by hand, with `name`
 * rooted the way a real push roots it: relative to the Actor project
 * directory, e.g. `.actor/actor.json`, `.actor/input_schema.json`.
 */
function sourceFilesFromActorTree(actorDir) {
    const actorSubdir = path.join(actorDir, '.actor');
    const sourceFiles = [];
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(full);
            } else if (entry.isFile()) {
                const name = `.actor/${path.relative(actorSubdir, full).split(path.sep).join('/')}`;
                sourceFiles.push({ name, format: 'TEXT', content: fs.readFileSync(full, 'utf8') });
            }
        }
    };
    walk(actorSubdir);
    return sourceFiles;
}

describe('sample actor trees', () => {
    it.each(SAMPLE_ACTOR_DIRS)('resolves a schema for the on-disk %s tree', (actorDirName) => {
        // Every `sample_actor*` tree actually checked into this repo -- not
        // just `sample_actor` -- must resolve a real, non-null input schema
        // from its actual on-disk `.actor/actor.json` +
        // `.actor/input_schema.json`. Reads the real files from the repo
        // checkout (no synthetic content), so a malformed or misnamed schema
        // file in any of the SAMPLE_ACTOR_DIRS trees fails this test
        // directly, with no Docker build involved.
        const sourceFiles = sourceFilesFromActorTree(path.join(REPO, actorDirName));
        const schema = resolveInputSchema(sourceFiles);
        expect(schema).not.toBeNull();
        expect(typeof schema).toBe('object');
        expect(Array.isArray(schema)).toBe(false);
    });
});

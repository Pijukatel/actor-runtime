/** Integration tests for the API using an in-process app + stub driver. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { wire } from '../helpers.js';

let ctx;

beforeEach(async () => {
    ctx = await wire();
});

afterEach(async () => {
    await ctx.close();
});

async function pushActor(client) {
    // Mirrors what apify-cli's push does: create actor, then upload source
    // files.
    await client.post('/v2/acts', {
        json: { name: 'sample-actor', versions: [{ versionNumber: '0.0', buildTag: 'latest' }] },
    });
    await client.post('/v2/actors/local-user~sample-actor/versions', {
        json: {
            versionNumber: '0.0',
            sourceType: 'SOURCE_FILES',
            sourceFiles: [{ name: 'main.js', format: 'TEXT', content: "console.log('hi');\n" }],
        },
    });
}

describe('api', () => {
    it('users/me without auth resolves the default user', async () => {
        const resp = await ctx.client.get('/v2/users/me');
        expect(resp.status).toBe(200);
        expect(resp.json().data.username).toBe('local-user');
    });

    it('missing actor returns record-not-found', async () => {
        const resp = await ctx.client.get('/v2/actors/local-user~nope');
        expect(resp.status).toBe(404);
        expect(resp.json().error.type).toBe('record-not-found');
    });

    it('full flow: push, build, run, fetch storages', async () => {
        const { client, service } = ctx;
        await pushActor(client);

        // Actor is listed.
        const listing = (await client.get('/v2/acts')).json().data;
        expect(listing.items.some((a) => a.name === 'sample-actor')).toBe(true);

        // Trigger build and wait for it to finish.
        let build = (await client.post('/v2/acts/local-user~sample-actor/builds?version=0.0')).json().data;
        await service.waitIdle();
        build = (await client.get(`/v2/actor-builds/${build.id}`)).json().data;
        expect(build.status).toBe('SUCCEEDED');

        // Start a run with input; wait for completion.
        let run = (
            await client.post('/v2/acts/local-user~sample-actor/runs', {
                body: JSON.stringify({ greeting: 'howdy' }),
                headers: { 'content-type': 'application/json' },
            })
        ).json().data;
        await service.waitIdle();
        run = (await client.get(`/v2/actor-runs/${run.id}`)).json().data;
        expect(run.status).toBe('SUCCEEDED');

        const kvId = run.defaultKeyValueStoreId;
        const dsId = run.defaultDatasetId;
        const rqId = run.defaultRequestQueueId;

        // Key-value store: OUTPUT echoes the input.
        const output = (await client.get(`/v2/key-value-stores/${kvId}/records/OUTPUT`)).json();
        expect(output.greeting).toBe('howdy');
        expect(output.receivedInput).toEqual({ greeting: 'howdy' });

        // Dataset: the pushed item is present.
        const items = (await client.get(`/v2/datasets/${dsId}/items`)).json();
        expect(items).toEqual([{ message: 'howdy world', index: 1 }]);

        // Request queue: the enqueued request is present.
        const meta = (await client.get(`/v2/request-queues/${rqId}`)).json().data;
        expect(meta.totalRequestCount).toBe(1);
        const requests = (await client.get(`/v2/request-queues/${rqId}/requests`)).json().data.items;
        expect(requests[0].url).toBe('https://example.com/from-actor');
    });

    it('console is served', async () => {
        const resp = await ctx.client.get('/');
        expect(resp.status).toBe(200);
        expect(resp.text()).toContain('Actor Runtime Console');
    });

    it('aborting a RUNNING build sticks and discards the result', async () => {
        // Aborting a RUNNING build is terminal: `docker build` cannot be
        // cancelled mid-flight, so when it eventually completes its
        // finalization must respect the ABORTED status (not clobber it) and
        // discard the unwanted image.
        const { client, service } = ctx;
        await pushActor(client);

        let release;
        const released = new Promise((resolve) => {
            release = resolve;
        });
        const realBuild = service.driver.build.bind(service.driver);
        const removed = [];
        service.driver.build = async (buildDir, imageTag, logSink) => {
            await released;
            return realBuild(buildDir, imageTag, logSink);
        };
        service.driver.removeImage = async (tag) => {
            removed.push(tag);
        };

        const build = (await client.post('/v2/acts/local-user~sample-actor/builds?version=0.0')).json().data;
        const aborted = (await client.post(`/v2/actor-builds/${build.id}/abort`)).json().data;
        expect(aborted.status).toBe('ABORTED');

        release();
        await service.waitIdle();

        const final = (await client.get(`/v2/actor-builds/${build.id}`)).json().data;
        expect(final.status).toBe('ABORTED');
        const log = (await client.get(`/v2/logs/${build.id}`)).text();
        expect(log).toContain('Build aborted by user.');
        expect(log).toContain('stub: built'); // docker output still appended for the record
        expect(removed.length, 'the completed-after-abort image must be discarded').toBeGreaterThan(0);
    });

    it('aborting a finished build returns it unchanged', async () => {
        const { client, service } = ctx;
        await pushActor(client);
        const build = (await client.post('/v2/acts/local-user~sample-actor/builds?version=0.0')).json().data;
        await service.waitIdle();

        const resp = (await client.post(`/v2/actor-builds/${build.id}/abort`)).json().data;
        expect(resp.status).toBe('SUCCEEDED');
    });

    it('console assets are served no-cache', async () => {
        // Regression: without an explicit Cache-Control browsers
        // heuristically cache the console's static files and keep rendering
        // a stale app.js for hours after the runtime image was rebuilt with
        // new console code.
        for (const urlPath of ['/', '/console/app.js', '/console/input_tab.js', '/console/storage_tab.js', '/actors']) {
            const resp = await ctx.client.get(urlPath);
            expect(resp.status, urlPath).toBe(200);
            expect(resp.headers.get('cache-control'), urlPath).toBe('no-cache');
        }
    });

    it('log endpoints are never cached', async () => {
        // Regression: a cacheable log response lets the browser queue a
        // re-opened log view behind a still-open earlier stream to the same
        // URL (endless for a warm standby run), rendering it empty forever.
        const { client, service } = ctx;
        await pushActor(client);
        const build = (await client.post('/v2/acts/local-user~sample-actor/builds?version=0.0')).json().data;
        await service.waitIdle();

        const oneShot = await client.get(`/v2/logs/${build.id}`);
        expect(oneShot.headers.get('cache-control')).toBe('no-store');
        const stream = await fetch(`${ctx.baseUrl}/v2/logs/${build.id}/stream`);
        expect(stream.headers.get('cache-control')).toBe('no-store');
        await stream.body.cancel();
    });
});

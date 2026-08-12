/**
 * Security and correctness regression tests: path traversal, symlink-following
 * storage-import disclosure, run/build terminal-status integrity, memory-limit
 * forwarding, binary KV round-tripping, malformed-body handling, and console
 * XSS-safety.
 *
 * Each test reproduces a specific bug and would fail against the pre-fix code.
 * All run without a Docker daemon, using `wire()` (in-process app +
 * StubDriver) or a small service built on the same Docker-free driver pattern.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Database } from '../../src/db.js';
import { BuildResult, RunResult, SourceFileNameError, writeSourceFiles } from '../../src/driver.js';
import { Service } from '../../src/service.js';
import { ACCESS_ALLOW } from '../../src/storage-access.js';
import { Storage } from '../../src/storage.js';
import { makeSettings, wire } from '../helpers.js';

/** Minimal Docker-free driver whose build/run always succeed. */
class OkDriver {
    async build(_buildDir, _imageTag, _logSink = null) {
        return new BuildResult(true, 'built\n');
    }

    async stop(_containerName) {}

    async removeImage(_imageTag) {}

    async run(_imageTag, _hostStorageDir, _environment, _timeoutSecs, _containerName = null, _memLimitMb = null, _logSink = null) {
        return new RunResult(0, 'ok\n');
    }
}

/** Build a Service over a temp data dir and the given Docker-free driver. */
async function makeService(tmpDir, driver) {
    const settings = makeSettings(tmpDir);
    await fsp.mkdir(settings.runsDir, { recursive: true });
    await fsp.mkdir(settings.buildsDir, { recursive: true });
    const db = new Database(settings.metaPath);
    const storage = new Storage(settings.storageDir);
    return new Service(settings, db, storage, driver);
}

let ctx;
let tmpDirs;

beforeEach(async () => {
    ctx = await wire();
    tmpDirs = [];
});

afterEach(async () => {
    await ctx.close();
    for (const dir of tmpDirs) {
        await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
});

async function makeTmpDir() {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'security-regressions-test-'));
    tmpDirs.push(dir);
    return dir;
}

describe('security and regressions', () => {
    // -- Blocker #1: path traversal in writeSourceFiles -----------------------
    it('writeSourceFiles rejects parent traversal', async () => {
        const tmpDir = await makeTmpDir();
        const dest = path.join(tmpDir, 'build');
        expect(() =>
            writeSourceFiles([{ name: '../../escape.py', format: 'TEXT', content: 'x = 1\n' }], dest),
        ).toThrow(SourceFileNameError);
        expect(fs.existsSync(path.join(tmpDir, 'escape.py'))).toBe(false);
    });

    it('writeSourceFiles rejects an absolute path', async () => {
        const tmpDir = await makeTmpDir();
        const dest = path.join(tmpDir, 'build');
        const target = path.join(tmpDir, 'pwned.py');
        expect(() =>
            writeSourceFiles([{ name: target, format: 'TEXT', content: 'evil\n' }], dest),
        ).toThrow(SourceFileNameError);
        expect(fs.existsSync(target)).toBe(false);
    });

    it('writeSourceFiles accepts a nested relative name', async () => {
        const tmpDir = await makeTmpDir();
        const dest = path.join(tmpDir, 'build');
        writeSourceFiles([{ name: 'src/main.py', format: 'TEXT', content: 'ok\n' }], dest);
        expect(fs.readFileSync(path.join(dest, 'src', 'main.py'), 'utf8')).toBe('ok\n');
    });

    // -- Major #2: symlink-following disclosure in importRunStorage -----------
    it('importRunStorage ignores a symlinked file', async () => {
        const tmpDir = await makeTmpDir();
        const storage = new Storage(path.join(tmpDir, 'backend'));

        const secret = path.join(tmpDir, 'secret.txt');
        fs.writeFileSync(secret, 'TOP SECRET RUNTIME SOURCE');

        const runDir = path.join(tmpDir, 'storage');
        const kv = path.join(runDir, 'key_value_stores', 'default');
        fs.mkdirSync(kv, { recursive: true });
        fs.mkdirSync(path.join(runDir, 'datasets', 'default'), { recursive: true });
        fs.mkdirSync(path.join(runDir, 'request_queues', 'default'), { recursive: true });
        // Malicious Actor plants a symlink pointing outside the storage dir.
        fs.symlinkSync(secret, path.join(kv, 'leak.txt'));

        await storage.importRunStorage(runDir, 'kvS', 'dsS', 'rqS');

        // The symlinked file must NOT have been imported as a record.
        expect(await storage.kvRecord('kvS', 'leak')).toBeNull();
        expect(await storage.kvKeys('kvS')).toEqual([]);
    });

    // -- Major #2 (reopened): symlinked DIRECTORY bypass in importRunStorage --
    // The earlier fix only rejected symlinked leaf *files*. A malicious Actor
    // (RW on the bind-mounted storage) can instead replace an intermediate
    // directory (`default`, `key_value_stores`, or the storage root) with a
    // symlink to an arbitrary location; every regular file under the target
    // then passed the old per-file check. These tests would import the
    // target's files against the old per-file-only check and import nothing
    // once the directory-chain check guards every ancestor too.
    it('import ignores a symlinked `default` directory', async () => {
        const tmpDir = await makeTmpDir();
        const storage = new Storage(path.join(tmpDir, 'backend'));

        const secret = path.join(tmpDir, 'secret');
        fs.mkdirSync(secret);
        fs.writeFileSync(path.join(secret, 'stolen.json'), '{"leaked": true}');

        const runDir = path.join(tmpDir, 'storage');
        fs.mkdirSync(path.join(runDir, 'key_value_stores'), { recursive: true });
        fs.mkdirSync(path.join(runDir, 'datasets', 'default'), { recursive: true });
        fs.mkdirSync(path.join(runDir, 'request_queues', 'default'), { recursive: true });
        // Swap the KV `default` directory for a symlink pointing outside the run.
        fs.symlinkSync(secret, path.join(runDir, 'key_value_stores', 'default'), 'dir');

        await storage.importRunStorage(runDir, 'kvS', 'dsS', 'rqS');

        expect(await storage.kvKeys('kvS')).toEqual([]);
        expect(await storage.kvRecord('kvS', 'stolen')).toBeNull();
    });

    it('import ignores a symlinked parent directory', async () => {
        const tmpDir = await makeTmpDir();
        const storage = new Storage(path.join(tmpDir, 'backend'));

        const secret = path.join(tmpDir, 'secret_ds');
        fs.mkdirSync(path.join(secret, 'default'), { recursive: true });
        fs.writeFileSync(path.join(secret, 'default', 'item.json'), '{"leaked": true}');

        const runDir = path.join(tmpDir, 'storage');
        fs.mkdirSync(path.join(runDir, 'key_value_stores', 'default'), { recursive: true });
        fs.mkdirSync(path.join(runDir, 'request_queues', 'default'), { recursive: true });
        // Swap the whole `datasets` directory for a symlink to attacker content.
        fs.symlinkSync(secret, path.join(runDir, 'datasets'), 'dir');

        await storage.importRunStorage(runDir, 'kvS', 'dsS', 'rqS');

        expect((await storage.datasetItems('dsS')).items).toEqual([]);
    });

    it('import uses the captured trusted root', async () => {
        // With an explicit captured anchor, a swapped directory imports nothing.
        const tmpDir = await makeTmpDir();
        const storage = new Storage(path.join(tmpDir, 'backend'));

        const secret = path.join(tmpDir, 'secret2');
        fs.mkdirSync(secret);
        fs.writeFileSync(path.join(secret, 'creds.txt'), 'api-key');

        const runDir = path.join(tmpDir, 'storage');
        fs.mkdirSync(path.join(runDir, 'key_value_stores'), { recursive: true });
        fs.mkdirSync(path.join(runDir, 'datasets', 'default'), { recursive: true });
        fs.mkdirSync(path.join(runDir, 'request_queues', 'default'), { recursive: true });
        const trustedRoot = fs.realpathSync(runDir); // captured before the "Actor" runs
        fs.symlinkSync(secret, path.join(runDir, 'key_value_stores', 'default'), 'dir');

        await storage.importRunStorage(runDir, 'kvS', 'dsS', 'rqS', trustedRoot);

        expect(await storage.kvKeys('kvS')).toEqual([]);
    });

    // -- Major #3: abortRun yields a terminal ABORTED not later clobbered -----
    it('abortRun is terminal and not overwritten by the natural finish', async () => {
        /** Build succeeds; run blocks until `stop` is called (as if killed). */
        class BlockingDriver extends OkDriver {
            constructor() {
                super();
                this.stopped = false;
                this.releasedPromise = new Promise((resolve) => {
                    this.release = resolve;
                });
            }

            async stop(_containerName) {
                this.stopped = true;
                this.release();
            }

            async run(_imageTag, _hostStorageDir, _environment, _timeoutSecs, _containerName = null, _memLimitMb = null, _logSink = null) {
                // Simulate a long-running container that only exits when
                // killed (10s safety valve so a broken abort can't hang the
                // suite).
                await Promise.race([
                    this.releasedPromise,
                    new Promise((resolve) => {
                        setTimeout(resolve, 10_000).unref();
                    }),
                ]);
                return new RunResult(0, 'would-have-succeeded\n'); // natural exit code 0
            }
        }

        const tmpDir = await makeTmpDir();
        const driver = new BlockingDriver();
        const svc = await makeService(tmpDir, driver);
        try {
            const actor = svc.createActor({ name: 'abortme', defaultRunOptions: {}, versions: [{ versionNumber: '0.0' }] });
            const build = svc.startBuild(actor.id, '0.0', 'latest');
            await svc.waitIdle();
            expect(svc.getBuild(build.id).status).toBe('SUCCEEDED');

            const run = await svc.startRun(actor.id, { x: 1 }, { timeoutSecs: 30 });
            const aborted = await svc.abortRun(run.id);
            expect(aborted.status).toBe('ABORTED');
            expect(driver.stopped).toBe(true); // the container was actually stopped

            await svc.waitIdle(); // let the (now unblocked) run task finish
            const final = svc.getRun(run.id);
            // Natural finish (exit 0) must NOT clobber the ABORTED status.
            expect(final.status).toBe('ABORTED');
        } finally {
            driver.release();
        }
    });

    // -- Major #4: memoryMbytes forwarded to the driver ------------------------
    it('the memory limit is forwarded to the driver', async () => {
        class CapturingDriver extends OkDriver {
            constructor() {
                super();
                this.runKwargs = {};
            }

            async run(_imageTag, _hostStorageDir, _environment, timeoutSecs, containerName = null, memLimitMb = null, _logSink = null) {
                this.runKwargs = { containerName, memLimitMb, timeoutSecs };
                return new RunResult(0, 'ok\n');
            }
        }

        const tmpDir = await makeTmpDir();
        const driver = new CapturingDriver();
        const svc = await makeService(tmpDir, driver);
        const actor = svc.createActor({ name: 'memcap', defaultRunOptions: {}, versions: [{ versionNumber: '0.0' }] });
        svc.startBuild(actor.id, '0.0', 'latest');
        await svc.waitIdle();
        const run = await svc.startRun(actor.id, {}, { memoryMbytes: 256, timeoutSecs: 30 });
        await svc.waitIdle();
        expect(driver.runKwargs.memLimitMb).toBe(256);
        expect(driver.runKwargs.containerName).toBe(svc.containerName(run.id));
    });

    // -- Major #5: binary KV records round-trip unchanged ----------------------
    it('a binary KV record round-trips unchanged', async () => {
        const { client } = ctx;
        const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0xff, 0xfe, 0x80]);
        const put = await client.put('/v2/key-value-stores/kvbin/records/shot.png', {
            body: png,
            headers: { 'content-type': 'image/png' },
        });
        expect(put.status).toBe(200);
        const got = await client.get('/v2/key-value-stores/kvbin/records/shot.png');
        expect(got.status).toBe(200);
        expect(got.body.equals(png)).toBe(true); // bytes unchanged, not UTF-8 mangled
    });

    // -- Minor #6: malformed bodies return 4xx not 500 -------------------------
    it('a malformed JSON body returns 4xx', async () => {
        const { client } = ctx;
        const resp = await client.post('/v2/acts', {
            body: Buffer.from('{not valid json'),
            headers: { 'content-type': 'application/json' },
        });
        expect(resp.status).toBe(400);
    });

    it('a bad gzip body returns 4xx', async () => {
        const { client } = ctx;
        const resp = await client.post('/v2/acts', {
            body: Buffer.from('this is not gzip'),
            headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
        });
        expect(resp.status).toBe(400);
    });

    it('a brotli-compressed body is transparently decompressed', async () => {
        // apify-client 3.x's own internal storage API client (and any
        // explicit `Actor.newClient()` caller) compresses request bodies with
        // `Content-Encoding: br` by default -- every SDK storage write
        // (setValue/pushData/addRequest/...) arrives this way under the SDK
        // v4 pin, so the runtime must decompress it exactly like the real
        // platform does, not just tolerate the older gzip encoding.
        const { client } = ctx;
        const body = zlib.brotliCompressSync(Buffer.from('{"name": "brotli-actor"}'));
        const resp = await client.post('/v2/acts', {
            body,
            headers: { 'content-type': 'application/json', 'content-encoding': 'br' },
        });
        expect(resp.status).toBe(201);
        expect(resp.json().data.name).toBe('brotli-actor');
    });

    it('a bad brotli body returns 4xx', async () => {
        const { client } = ctx;
        const resp = await client.post('/v2/acts', {
            body: Buffer.from('this is not brotli'),
            headers: { 'content-type': 'application/json', 'content-encoding': 'br' },
        });
        expect(resp.status).toBe(400);
    });

    // -- Minor #7: PUT /v2/acts/{id} actually applies the payload --------------
    it('updating an actor applies the payload', async () => {
        const { client } = ctx;
        await client.post('/v2/acts', { json: { name: 'updatable' } });
        const resp = await client.put('/v2/acts/local-user~updatable', {
            json: { defaultRunOptions: { timeoutSecs: 42, memoryMbytes: 512 } },
        });
        expect(resp.status).toBe(200);
        const actor = resp.json().data;
        expect(actor.defaultRunOptions.timeoutSecs).toBe(42);
        // Persisted, not just echoed.
        const again = (await client.get('/v2/acts/local-user~updatable')).json().data;
        expect(again.defaultRunOptions.timeoutSecs).toBe(42);
    });

    // -- Minor #8: a failing build reaches FAILED, never stuck RUNNING ---------
    it('a build with an illegal source name reaches FAILED', async () => {
        const tmpDir = await makeTmpDir();
        const svc = await makeService(tmpDir, new OkDriver());
        const actor = svc.createActor({
            name: 'badsrc',
            defaultRunOptions: {},
            versions: [
                { versionNumber: '0.0', sourceFiles: [{ name: '../evil.py', format: 'TEXT', content: 'x\n' }] },
            ],
        });
        const build = svc.startBuild(actor.id, '0.0', 'latest');
        await svc.waitIdle();
        const final = svc.getBuild(build.id);
        expect(final.status).toBe('FAILED'); // not stuck at RUNNING
        expect(final.finishedAt).not.toBeNull();
    });

    // -- Minor #9: startup reconciliation sweeps stale RUNNING rows ------------
    it('reconcile sweeps stale RUNNING jobs', async () => {
        const tmpDir = await makeTmpDir();
        const svc = await makeService(tmpDir, new OkDriver());

        svc.db.data.builds.push({
            id: 'b-stale',
            actorId: 'a',
            versionNumber: '0.0',
            buildNumber: '0.0.1',
            status: 'RUNNING',
            imageTag: 't',
        });
        svc.db.data.runs.push({
            id: 'r-stale',
            actorId: 'a',
            buildId: 'b-stale',
            buildNumber: '0.0.1',
            status: 'RUNNING',
            kvStoreId: 'k',
            datasetId: 'd',
            requestQueueId: 'q',
        });
        svc.db.save();

        await svc.reconcileStaleJobs();

        expect(svc.getBuild('b-stale').status).toBe('FAILED');
        expect(svc.getRun('r-stale').status).toBe('ABORTED');
    });

    // -- Nit #14: a real timeout produces TIMED-OUT, not FAILED ----------------
    it('a timeout sets the TIMED-OUT status', async () => {
        class TimeoutDriver extends OkDriver {
            async run(_imageTag, _hostStorageDir, _environment, _timeoutSecs, _containerName = null, _memLimitMb = null, _logSink = null) {
                return new RunResult(-1, 'timed out\n', true);
            }
        }

        const tmpDir = await makeTmpDir();
        const svc = await makeService(tmpDir, new TimeoutDriver());
        const actor = svc.createActor({ name: 'slow', defaultRunOptions: {}, versions: [{ versionNumber: '0.0' }] });
        svc.startBuild(actor.id, '0.0', 'latest');
        await svc.waitIdle();
        const run = await svc.startRun(actor.id, {}, { timeoutSecs: 1 });
        await svc.waitIdle();
        expect(svc.getRun(run.id).status).toBe('TIMED-OUT');
    });

    // -- Minor #3: bad run-start query params return 400, not a bare 500 -------
    it('a non-integer run-start query param returns 400', async () => {
        const { client } = ctx;
        await client.post('/v2/acts', { json: { name: 'qp', versions: [{ versionNumber: '0.0' }] } });
        for (const qs of ['memory=abc', 'timeout=abc', 'waitForFinish=abc']) {
            const resp = await client.post(`/v2/acts/local-user~qp/runs?${qs}`);
            expect(resp.status, `${qs} -> ${resp.status}`).toBe(400);
        }
    });

    // -- Nit #5: non-positive memory is rejected, never a silent uncapped run --
    it('zero or negative memory returns 400', async () => {
        const { client } = ctx;
        await client.post('/v2/acts', { json: { name: 'memz', versions: [{ versionNumber: '0.0' }] } });
        for (const qs of ['memory=0', 'memory=-1']) {
            const resp = await client.post(`/v2/acts/local-user~memz/runs?${qs}`);
            expect(resp.status, `${qs} -> ${resp.status}`).toBe(400);
        }
    });

    // -- Major #2 (console XSS): no untrusted string reaches an inline handler --
    // This unit suite has no browser dependency, so it cannot execute the
    // served JS in a real DOM to observe XSS dynamically; validate
    // structurally instead: the served console JS must not build inline
    // event-handler attributes at all -- behaviour is attached with
    // addEventListener over closures, so no interpolated string is ever
    // HTML-decoded back into an inline JS handler.
    it('the console has no inline event handlers', async () => {
        const { client } = ctx;
        const appJs = (await client.get('/console/app.js')).text();
        const inputTabJs = (await client.get('/console/input_tab.js')).text();
        const storageTabJs = (await client.get('/console/storage_tab.js')).text();
        const index = (await client.get('/')).text();
        for (const [src, label] of [
            [appJs, 'app.js'],
            [inputTabJs, 'input_tab.js'],
            [storageTabJs, 'storage_tab.js'],
            [index, 'index.html'],
        ]) {
            for (const handler of ['onclick=', 'onload=', 'onerror=', 'onmouseover=']) {
                expect(src.toLowerCase().includes(handler), `${label} contains inline ${handler}`).toBe(false);
            }
        }
        // Positive check: behaviour is wired with addEventListener.
        expect(appJs).toContain('addEventListener');
        expect(inputTabJs).toContain('addEventListener');
        expect(storageTabJs).toContain('addEventListener');
    });

    it('prepareRunStorage makes the run storage world-writable', async () => {
        // Per-run storage dirs must be writable by a non-root Actor container
        // user.
        //
        // Regression: the runtime runs as root and created these dirs 0755,
        // so a real Apify Actor image (which runs as a non-root user, e.g.
        // uid 1000) could not write to the bind-mounted /apify_storage and
        // crashed on first write with a permission error. The dirs must be
        // world-writable so any container user can write; INPUT.json must
        // stay world-readable so the Actor can read its input.
        const { service } = ctx;
        const { storageDir } = await service.prepareRunStorage('perm-test-run', { greeting: 'hi' });

        for (const sub of ['key_value_stores/default', 'datasets/default', 'request_queues/default']) {
            const mode = fs.statSync(path.join(storageDir, sub)).mode & 0o777;
            expect(mode & 0o002, `${sub} is not world-writable (mode ${mode.toString(8)})`).toBeTruthy();
        }
        // The whole tree (including nested created dirs) must be writable by
        // others.
        const walkDirs = (dir) => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                if (!entry.isDirectory()) continue;
                const full = path.join(dir, entry.name);
                expect(fs.statSync(full).mode & 0o002, `${full} not world-writable`).toBeTruthy();
                walkDirs(full);
            }
        };
        walkDirs(storageDir);
        // Input stays readable by the (non-root) Actor.
        expect(fs.statSync(path.join(storageDir, 'key_value_stores/default/INPUT.json')).mode & 0o004).toBeTruthy();
    });

    it('INPUT is API-readable the moment a run starts', async () => {
        // Companion to the world-writable test's disk-INPUT assertion above:
        // an SDK Actor's `Actor.getInput()` reads INPUT over the `/v2`
        // key-value-store API (`GET .../records/INPUT`), not from disk, so
        // INPUT must also land in the storage-backed key-value store
        // synchronously as part of starting the run -- before the run's
        // container is even spawned, not only after the post-run disk-import
        // step. No build/container is needed to observe this: the record must
        // already be readable the instant `POST .../runs` returns
        // (`waitForFinish` defaults to 0, so the run is likely still RUNNING,
        // and there is no successful build at all here).
        //
        // Regression (red before this change): INPUT was only ever written to
        // disk in `prepareRunStorage`; the backing store had no `INPUT` key
        // until the post-run `importRunStorage` pass, so this same assertion
        // 404'd.
        const { client } = ctx;
        await client.post('/v2/acts', { json: { name: 'input-probe' } });
        const run = (
            await client.post('/v2/acts/local-user~input-probe/runs', { json: { greeting: 'howdy' } })
        ).json().data;

        const resp = await client.get(`/v2/key-value-stores/${run.defaultKeyValueStoreId}/records/INPUT`);
        expect(resp.status).toBe(200);
        expect(resp.json()).toEqual({ greeting: 'howdy' });
    });

    // -- Minor: a vanished storage row at the single-read guard yields 404, not 500 --
    it('a storage deleted between guard and refetch returns 404', async () => {
        // The KVS/dataset/queue metadata GETs each call `guard()`, which
        // performs ONE DB read (`Service.checkStorageAccess`) to both decide
        // access and hand back the row for the metadata body -- no separate
        // re-fetch. That single read is now the only place a row can vanish,
        // so this reproduces the "storage disappeared" edge case at that
        // point: stub `Service.checkStorageAccess` to report the access
        // decision as allowed while returning no row, simulating a `DELETE`
        // that lands inside that same read/decide step. Before the row was
        // threaded through `guard`, this same gap (between `guard`'s own read
        // and the route's separate re-fetch) let the metadata builder blow up
        // on the missing row -- an uncaught "cannot read property of null",
        // surfacing as a bare 500 instead of the `notFound()` (404) every
        // other "storage disappeared" path already returns (e.g.
        // `ownerOrForbidden`, `deleteStorage`).
        //
        // Green both before and after the read was consolidated: the routes'
        // explicit `if (!storage) return notFound()` guard is what this test
        // actually exercises, so it stays proof against the underlying crash
        // at whatever layer performs the read.
        const { client, service } = ctx;
        const kvs = (await client.post('/v2/key-value-stores', { json: { name: 'racey-kv' } })).json().data;
        const ds = (await client.post('/v2/datasets', { json: { name: 'racey-ds' } })).json().data;
        const rq = (await client.post('/v2/request-queues', { json: { name: 'racey-rq' } })).json().data;

        service.checkStorageAccess = (_storageId, _username, _need, _expectedType = null) => ({
            decision: ACCESS_ALLOW,
            storage: null,
        });

        for (const urlPath of [
            `/v2/key-value-stores/${kvs.id}`,
            `/v2/datasets/${ds.id}`,
            `/v2/request-queues/${rq.id}`,
        ]) {
            const resp = await client.get(urlPath);
            expect(resp.status, `${urlPath} -> ${resp.status}: ${resp.text()}`).toBe(404);
            expect(resp.json().error.type).toBe('record-not-found');
        }
    });
});

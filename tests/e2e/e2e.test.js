/**
 * Mandatory end-to-end test: real apify-cli against a real running runtime.
 *
 * Flow: scaffold sample Actor -> `apify push` (creates Actor + version and
 * builds it) -> `apify call` (runs it) -> fetch the run's key-value store,
 * dataset and request queue over the API and assert the Actor's written data
 * is present.
 *
 * Requires Docker and apify-cli; skips cleanly if either is unavailable so
 * the unit suite can still run in constrained environments.
 * `scripts/run-tests.sh` provides both.
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RUNTIME_IMAGE = process.env.RUNTIME_IMAGE ?? 'actor-runtime:test';

function freePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
    });
}

function have(cmd, args) {
    try {
        return spawnSync(cmd, args, { stdio: 'ignore' }).status === 0;
    } catch {
        return false;
    }
}

function run(cmd, args, { cwd, env, timeoutMs } = {}) {
    return spawnSync(cmd, args, {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
        timeout: timeoutMs,
        maxBuffer: 64 * 1024 * 1024,
    });
}

function sleep(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

async function waitReady(apiUrl, timeoutSecs = 60) {
    const deadline = Date.now() + timeoutSecs * 1000;
    while (Date.now() < deadline) {
        try {
            const resp = await fetch(`${apiUrl}/v2/users/me`, { signal: AbortSignal.timeout(2000) });
            if (resp.status === 200) return;
        } catch {
            // not up yet
        }
        await sleep(1000);
    }
    throw new Error('runtime did not become ready in time');
}

async function getJson(url) {
    const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    return resp.json();
}

/**
 * Environment for driving the stock apify-cli at the runtime. Per
 * requirements/cli.md, `apify push`/`call` present the CLI's STORED LOGIN
 * only (never the APIFY_TOKEN env var), so the acting credential is bound
 * with `apify login -t local-user` inside an isolated HOME (+
 * APIFY_DISABLE_KEYRING=1) that never touches the real ~/.apify profile.
 */
function apifyEnv(apiUrl, consoleUrl, cliHome) {
    return {
        ...process.env,
        APIFY_CLIENT_BASE_URL: apiUrl,
        APIFY_CONSOLE_URL: consoleUrl,
        HOME: cliHome,
        APIFY_DISABLE_KEYRING: '1',
        APIFY_CLI_DISABLE_TELEMETRY: '1',
        APIFY_CLI_SKIP_UPDATE_CHECK: '1',
    };
}

function apifyLogin(env) {
    // `apify login -t <token>` honours APIFY_CLIENT_BASE_URL, so this binds
    // "local-user" as the first-ever token the runtime sees (bootstrapping
    // the default user) and the hard-coded `local-user~<name>` ids resolve.
    const login = run('apify', ['login', '-t', 'local-user'], { env, timeoutMs: 60_000 });
    if (login.status !== 0) {
        throw new Error(`apify login failed:\n${login.stdout}\n${login.stderr}`);
    }
}

async function waitRunTerminal(api, runId, timeoutSecs = 120) {
    const deadline = Date.now() + timeoutSecs * 1000;
    let runRecord = {};
    while (Date.now() < deadline) {
        runRecord = (await getJson(`${api}/v2/actor-runs/${runId}`)).data;
        if (['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT'].includes(runRecord.status)) {
            return runRecord;
        }
        await sleep(2000);
    }
    return runRecord;
}

// Skip the whole file when the harness prerequisites are missing, mirroring
// pytest.mark.skipif on the Python original.
const HAVE_PREREQS = have('docker', ['version']) && have('apify', ['--version']);

describe.skipIf(!HAVE_PREREQS)(
    'e2e: full dev loop (requires Docker daemon and apify-cli on PATH)',
    () => {
        /** @type {{api: string, console: string, name: string, dataDir: string, env: object}} */
        let runtime;

        beforeAll(async () => {
            const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'actor-runtime-e2e-data-'));
            // World-writable so the sibling Actor containers can write their storage.
            fs.chmodSync(dataDir, 0o777);
            // Isolated CLI profile dir (see apifyEnv()).
            const cliHome = fs.mkdtempSync(path.join(os.tmpdir(), 'actor-runtime-e2e-home-'));
            const apiPort = await freePort();
            const consolePort = await freePort();
            const name = `actor-runtime-e2e-${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`;

            const started = run('docker', [
                'run', '-d', '--name', name,
                '-v', '/var/run/docker.sock:/var/run/docker.sock',
                '-v', `${dataDir}:${dataDir}`,
                '-e', `DATA_DIR=${dataDir}`,
                '-e', `HOST_DATA_DIR=${dataDir}`,
                '-p', `${apiPort}:3333`,
                '-p', `${consolePort}:3000`,
                RUNTIME_IMAGE,
            ]);
            if (started.status !== 0) {
                throw new Error(`docker run failed:\n${started.stdout}\n${started.stderr}`);
            }
            const apiUrl = `http://localhost:${apiPort}`;
            const consoleUrl = `http://localhost:${consolePort}`;
            // Register for cleanup before waiting, so a readiness failure
            // still tears the container down in afterAll.
            runtime = {
                api: apiUrl,
                console: consoleUrl,
                name,
                dataDir,
                env: apifyEnv(apiUrl, consoleUrl, cliHome),
            };
            await waitReady(apiUrl);
            apifyLogin(runtime.env);
        }, 180_000);

        afterAll(() => {
            if (!runtime) return;
            const logs = run('docker', ['logs', runtime.name]);
            console.log(logs.stdout + logs.stderr);
            run('docker', ['rm', '-f', runtime.name]);
        }, 60_000);

        it('startup prints two labelled URLs', () => {
            const result = run('docker', ['logs', runtime.name]);
            const logs = result.stdout + result.stderr;
            expect(logs).toContain('API URL:');
            expect(logs).toContain('Console URL:');
            expect(logs.split('http://localhost:').length - 1).toBeGreaterThanOrEqual(2);
        }, 60_000);

        it('console and API reachable without auth', async () => {
            const consoleResp = await fetch(`${runtime.console}/`, { signal: AbortSignal.timeout(5000) });
            expect(consoleResp.status).toBe(200);
            expect(await consoleResp.text()).toContain('Actor Runtime Console');
            const apiResp = await fetch(`${runtime.api}/v2/acts`, { signal: AbortSignal.timeout(5000) });
            expect(apiResp.status).toBe(200);
        }, 60_000);

        it('full dev loop: push, build, call, read back storages', async () => {
            const api = runtime.api;
            const env = runtime.env;

            const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'actor-runtime-e2e-proj-'));
            const project = path.join(workDir, 'sample-actor');
            fs.cpSync(path.join(REPO, 'sample_actor'), project, { recursive: true });

            // 1) push -> creates Actor + version and builds it (apify push triggers a build).
            const push = run('apify', ['push', '--force'], { cwd: project, env, timeoutMs: 300_000 });
            expect(push.status, `apify push failed:\n${push.stdout}\n${push.stderr}`).toBe(0);

            // 2) Actor and its source are present in the runtime.
            const actor = (await getJson(`${api}/v2/actors/local-user~sample-actor`)).data;
            expect(actor.name).toBe('sample-actor');
            const version = (await getJson(`${api}/v2/actors/local-user~sample-actor/versions/0.0`)).data;
            expect(version.sourceFiles.some((f) => f.name === 'main.js')).toBe(true);

            // 3) build reached SUCCEEDED and produced an image.
            const builds = (await getJson(`${api}/v2/acts/local-user~sample-actor/builds`)).data.items;
            expect(builds.length, `builds: ${JSON.stringify(builds)}`).toBeGreaterThan(0);
            expect(builds[0].status, `builds: ${JSON.stringify(builds)}`).toBe('SUCCEEDED');

            // 4) run via the CLI.
            const call = run('apify', ['call', '-i', JSON.stringify({ greeting: 'howdy' })], {
                cwd: project,
                env,
                timeoutMs: 300_000,
            });
            expect(call.status, `apify call failed:\n${call.stdout}\n${call.stderr}`).toBe(0);

            // 5) find the finished run.
            const runs = (await getJson(`${api}/v2/acts/local-user~sample-actor/runs`)).data.items;
            expect(runs.length, 'no runs recorded').toBeGreaterThan(0);
            const runRecord = await waitRunTerminal(api, runs[0].id);
            expect(runRecord.status, `run: ${JSON.stringify(runRecord)}`).toBe('SUCCEEDED');

            const kvId = runRecord.defaultKeyValueStoreId;
            const dsId = runRecord.defaultDatasetId;
            const rqId = runRecord.defaultRequestQueueId;

            // 6) fetch all three default storages and assert the Actor's data landed.
            const output = await getJson(`${api}/v2/key-value-stores/${kvId}/records/OUTPUT`);
            expect(output.greeting).toBe('howdy');
            expect(output.receivedInput).toEqual({ greeting: 'howdy' });

            const items = await getJson(`${api}/v2/datasets/${dsId}/items`);
            expect(items).toEqual([{ message: 'howdy world', index: 1 }]);

            const meta = (await getJson(`${api}/v2/request-queues/${rqId}`)).data;
            expect(meta.totalRequestCount).toBe(1);
            const reqs = (await getJson(`${api}/v2/request-queues/${rqId}/requests`)).data.items;
            expect(reqs[0].url).toBe('https://example.com/from-actor');
        }, 900_000);
    },
);

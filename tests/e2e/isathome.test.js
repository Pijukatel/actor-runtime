/**
 * End-to-end test verifying that the real `apify` SDK, driving the full
 * `Actor` lifecycle (`Actor.main`) *inside* a real actor container, reports
 * `isAtHome = true` the way `Actor.isAtHome()` itself computes it, calls
 * back into the runtime's own API through `Actor.newClient()` using its
 * injected `APIFY_TOKEN`, and writes its result into its own default dataset
 * via `Actor.pushData()` -- proving an API-based storage write against the
 * run's real dataset id, not a local-disk write.
 *
 * Requires Docker and apify-cli, exactly like `tests/e2e/e2e.test.js` (see
 * that file's header comment for the shared skip/harness pattern this
 * mirrors). Uses its OWN runtime instance rather than importing that file's
 * fixture, so the e2e files stay fully independent and neither `e2e.test.js`
 * nor `standby.test.js` needs any change -- mirroring how `standby.test.js`
 * already does this relative to `e2e.test.js` (see that file's header
 * comment).
 *
 * The fixture Actor (`sample_actor_isathome/`) npm-installs the real,
 * published `apify` SDK at image BUILD time, like every other
 * `sample_actor*` fixture now (see `sample_actor_isathome/main.js` for
 * exactly which SDK surface is used and why).
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
    'e2e: real apify SDK isAtHome (requires Docker daemon and apify-cli on PATH)',
    () => {
        /** @type {{api: string, console: string, name: string, dataDir: string, env: object}} */
        let runtime;

        beforeAll(async () => {
            const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'actor-runtime-isathome-e2e-data-'));
            // World-writable so the sibling Actor container can write its storage.
            fs.chmodSync(dataDir, 0o777);
            const cliHome = fs.mkdtempSync(path.join(os.tmpdir(), 'actor-runtime-isathome-e2e-home-'));
            const apiPort = await freePort();
            const consolePort = await freePort();
            const name = `actor-runtime-isathome-e2e-${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`;

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

        // Push/build/run `sample_actor_isathome`, then verify over the API
        // that its dataset item -- written THROUGH the real apify-client, not
        // local disk -- shows `is_at_home === true`, a `user` matching the
        // run's real owner, and a `dataset_id` matching the run's real
        // `defaultDatasetId`.
        it('real apify client reports isAtHome and writes via API', async () => {
            const api = runtime.api;
            const env = runtime.env;

            const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'actor-runtime-isathome-e2e-proj-'));
            const project = path.join(workDir, 'isathome-actor');
            fs.cpSync(path.join(REPO, 'sample_actor_isathome'), project, { recursive: true });

            // 1) push -> creates Actor + version and builds it (installs the
            // apify SDK at image build time, like every sample_actor* fixture
            // now, so allow extra headroom over a from-cache build).
            const push = run('apify', ['push', '--force'], { cwd: project, env, timeoutMs: 600_000 });
            expect(push.status, `apify push failed:\n${push.stdout}\n${push.stderr}`).toBe(0);

            // 2) run it via the CLI (no input needed).
            const call = run('apify', ['call'], { cwd: project, env, timeoutMs: 300_000 });
            expect(call.status, `apify call failed:\n${call.stdout}\n${call.stderr}`).toBe(0);

            // 3) find the finished run.
            const runs = (await getJson(`${api}/v2/acts/local-user~isathome-actor/runs`)).data.items;
            expect(runs.length, 'no runs recorded').toBeGreaterThan(0);
            const runRecord = await waitRunTerminal(api, runs[0].id);
            expect(runRecord.status, `run: ${JSON.stringify(runRecord)}`).toBe('SUCCEEDED');

            const dsId = runRecord.defaultDatasetId;

            // 4) read the run's default dataset back over the API -- proving the
            // Actor's write landed via the client's real API call, not local disk.
            const items = await getJson(`${api}/v2/datasets/${dsId}/items`);
            expect(items.length, `expected exactly one dataset item, got: ${JSON.stringify(items)}`).toBe(1);
            const item = items[0];

            // (a) the real apify-client/SDK, running inside the container,
            // reports isAtHome the way it computes it (Actor.isAtHome(),
            // sourced from APIFY_IS_AT_HOME) -- true for every actor-runtime
            // run.
            expect(item.is_at_home).toBe(true);

            // (b) it called back into the runtime's own API using its injected
            // APIFY_TOKEN and resolved to the run's real owner.
            expect(runRecord.username).toBe('local-user');
            expect(item.user).toBe(runRecord.username);

            // (c) it saw its real storage id -- this GET already proves the write
            // landed in the run's actual dataset, not a hardcoded/local one.
            expect(item.dataset_id).toBe(dsId);
        }, 1_200_000);
    },
);

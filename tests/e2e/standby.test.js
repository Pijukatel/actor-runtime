/**
 * Standby-actor end-to-end test: an on-demand Actor discovers and calls a
 * standby Actor's `standbyUrl` container-to-container, through a real
 * running runtime.
 *
 * Requires Docker and apify-cli, exactly like `tests/e2e/e2e.test.js` (see
 * that file's header comment for the shared skip/harness pattern this
 * mirrors). Uses its OWN runtime instance rather than importing that file's
 * fixture, so the two e2e files stay fully independent and `e2e.test.js`
 * itself needs no changes.
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

function push(project, env) {
    const result = run('apify', ['push', '--force'], { cwd: project, env, timeoutMs: 300_000 });
    expect(result.status, `apify push failed:\n${result.stdout}\n${result.stderr}`).toBe(0);
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
    'e2e: standby actors (requires Docker daemon and apify-cli on PATH)',
    () => {
        /** @type {{api: string, console: string, name: string, dataDir: string, env: object}} */
        let runtime;

        beforeAll(async () => {
            const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'actor-runtime-standby-e2e-data-'));
            fs.chmodSync(dataDir, 0o777);
            const cliHome = fs.mkdtempSync(path.join(os.tmpdir(), 'actor-runtime-standby-e2e-home-'));
            const apiPort = await freePort();
            const consolePort = await freePort();
            const name = `actor-runtime-standby-e2e-${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`;

            const started = run('docker', [
                'run', '-d', '--name', name,
                '-v', '/var/run/docker.sock:/var/run/docker.sock',
                '-v', `${dataDir}:${dataDir}`,
                '-e', `DATA_DIR=${dataDir}`,
                '-e', `HOST_DATA_DIR=${dataDir}`,
                // Near-instant idle reap so this test doesn't have to wait out the
                // 300s/5s-minimum production default to observe teardown.
                '-e', 'STANDBY_IDLE_OVERRIDE_SECS=8',
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

        it('on-demand actor discovers and calls standby actor', async () => {
            const api = runtime.api;
            const env = runtime.env;

            const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'actor-runtime-standby-e2e-proj-'));
            const standbyProject = path.join(workDir, 'standby-actor');
            fs.cpSync(path.join(REPO, 'sample_actor_standby'), standbyProject, { recursive: true });
            push(standbyProject, env);

            const callerProject = path.join(workDir, 'caller-actor');
            fs.cpSync(path.join(REPO, 'sample_actor_caller'), callerProject, { recursive: true });
            push(callerProject, env);

            const standbyActorId = 'local-user~standby-actor';
            const callerActorId = 'local-user~caller-actor';

            // Before any request: no run yet for the standby actor.
            const runsBefore = (await getJson(`${api}/v2/acts/${standbyActorId}/runs`)).data.items;
            expect(runsBefore).toEqual([]);

            const actor = (await getJson(`${api}/v2/actors/${standbyActorId}`)).data;
            expect(actor.standbyUrl, 'standby-enabled actor must expose standbyUrl').toBeTruthy();

            // Contract: input is the standby Actor's name only -- the caller resolves
            // its own username and builds the id itself (see sample_actor_caller/main.js).
            const call = run(
                'apify',
                ['call', '-i', JSON.stringify({ standbyActorName: 'standby-actor', greeting: 'howdy' })],
                { cwd: callerProject, env, timeoutMs: 300_000 },
            );
            expect(call.status, `apify call failed:\n${call.stdout}\n${call.stderr}`).toBe(0);

            const callerRuns = (await getJson(`${api}/v2/acts/${callerActorId}/runs`)).data.items;
            expect(callerRuns.length, 'no caller runs recorded').toBeGreaterThan(0);
            const callerRun = await waitRunTerminal(api, callerRuns[0].id);
            expect(callerRun.status, `caller run: ${JSON.stringify(callerRun)}`).toBe('SUCCEEDED');

            const output = await getJson(
                `${api}/v2/key-value-stores/${callerRun.defaultKeyValueStoreId}/records/OUTPUT`,
            );
            const received = output.receivedFromStandby;
            expect(received.method).toBe('GET');
            expect(received.path).toBe('/echo?greeting=howdy');
            expect(received.reply).toBe('Standby Actor served request #1');

            // The caller also pushed the standby actor's response into its own dataset.
            const callerItems = await getJson(`${api}/v2/datasets/${callerRun.defaultDatasetId}/items`);
            expect(callerItems).toEqual([received]);

            // The standby actor's own run is now warm and inspectable.
            const standbyRuns = (await getJson(`${api}/v2/acts/${standbyActorId}/runs`)).data.items;
            expect(standbyRuns.length, 'standby actor should have started a warm run').toBeGreaterThan(0);
            expect(standbyRuns[0].status).toBe('RUNNING');

            // The standby actor saved a record for the call it served into its own
            // (still-warm) run's dataset, through the runtime API.
            const standbyItems = await getJson(
                `${api}/v2/datasets/${standbyRuns[0].defaultDatasetId}/items`,
            );
            expect(standbyItems).toEqual([{ method: 'GET', path: '/echo?greeting=howdy', requestCount: 1 }]);

            // It tears itself down after the (overridden, short) idle timeout, with no
            // further request needed to trigger it.
            const standbyRun = await waitRunTerminal(api, standbyRuns[0].id, 60);
            expect(standbyRun.status, `standby run: ${JSON.stringify(standbyRun)}`).toBe('ABORTED');
        }, 1_200_000);
    },
);

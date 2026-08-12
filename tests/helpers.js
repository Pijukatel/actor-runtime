/**
 * Shared test helpers: an in-process app wired to a Docker-free stub driver,
 * served on a real loopback socket (port 0), plus the fake standby/upstream
 * HTTP servers the standby and upstream-fallback suites drive.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { createApp } from '../src/app.js';
import { Settings } from '../src/config.js';
import { BuildResult, RunResult } from '../src/driver.js';

function sleep(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

/**
 * In-process stand-in for a standby Actor's ACTOR_STANDBY_PORT listener.
 *
 * Serves the readiness probe and echoes everything else back as JSON
 * (method/path/headers/body plus a per-server request counter), so tests can
 * assert both exact forwarding and warm-container reuse across requests.
 * `/stream-slow` writes its body in several flushed chunks with a real delay
 * between them and closes the connection instead of declaring
 * Content-Length, so a test can prove the forwarding proxy genuinely streams.
 * `/multi-header` echoes received headers as an ORDERED list of [name, value]
 * PAIRS and replies with two Set-Cookie headers, pinning the multi-value
 * forwarding contract on both legs at once.
 */
export class FakeStandbyServer {
    constructor({ neverReady = false, readinessHangSecs = 0 } = {}) {
        this.neverReady = neverReady;
        this.readinessHangSecs = readinessHangSecs;
        this.requestCount = 0;
        this.server = http.createServer((req, res) => this.#handle(req, res));
    }

    async start() {
        await new Promise((resolve) => {
            this.server.listen(0, '127.0.0.1', resolve);
        });
        this.port = this.server.address().port;
        return this;
    }

    async #handle(req, res) {
        if (req.headers['x-apify-container-server-readiness-probe']) {
            if (this.readinessHangSecs) await sleep(this.readinessHangSecs * 1000);
            res.statusCode = this.neverReady ? 503 : 200;
            res.end();
            return;
        }
        if (req.url.startsWith('/stream-slow')) {
            res.statusCode = 200;
            res.setHeader('content-type', 'text/plain');
            for (const chunk of ['chunk-1\n', 'chunk-2\n', 'chunk-3\n']) {
                res.write(chunk);
                await sleep(300);
            }
            res.end();
            return;
        }
        if (req.url.startsWith('/multi-header')) {
            const pairs = [];
            for (let i = 0; i < req.rawHeaders.length; i += 2) {
                pairs.push([req.rawHeaders[i], req.rawHeaders[i + 1]]);
            }
            await drain(req);
            res.statusCode = 200;
            res.setHeader('content-type', 'application/json');
            res.setHeader('set-cookie', ['a=1', 'b=2']);
            res.end(JSON.stringify({ receivedHeaderPairs: pairs }));
            return;
        }
        const body = await drain(req);
        this.requestCount += 1;
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(
            JSON.stringify({
                method: req.method,
                path: req.url,
                headers: req.headers,
                body: body.toString('utf8'),
                requestCount: this.requestCount,
            }),
        );
    }

    stop() {
        this.server.close();
        this.server.closeAllConnections?.();
    }
}

/**
 * Stand-in for api.apify.com, for the upstream-fallback tests: records every
 * request it receives and replies with whatever `setResponse` was last
 * configured with (default 200/empty).
 */
export class FakeUpstreamServer {
    constructor() {
        this.requests = [];
        this.nextResponse = { status: 200, body: Buffer.alloc(0), headers: [] };
        this.stopped = false;
        this.server = http.createServer(async (req, res) => {
            const body = await drain(req);
            this.requests.push({ method: req.method, path: req.url, headers: req.headers, body });
            const { status, body: responseBody, headers } = this.nextResponse;
            res.statusCode = status;
            const grouped = new Map();
            for (const [name, value] of headers) {
                if (!grouped.has(name)) grouped.set(name, []);
                grouped.get(name).push(value);
            }
            for (const [name, values] of grouped) {
                res.setHeader(name, values.length === 1 ? values[0] : values);
            }
            res.end(responseBody);
        });
    }

    async start() {
        await new Promise((resolve) => {
            this.server.listen(0, '127.0.0.1', resolve);
        });
        this.port = this.server.address().port;
        return this;
    }

    /**
     * `headers` may be a plain object (the common case) or a list of
     * [name, value] pairs when a test needs more than one header with the
     * same name.
     */
    setResponse(status, body = Buffer.alloc(0), headers = null) {
        const pairs = headers === null ? [] : Array.isArray(headers) ? headers : Object.entries(headers);
        this.nextResponse = { status, body: Buffer.isBuffer(body) ? body : Buffer.from(body), headers: pairs };
    }

    get baseUrl() {
        return `http://127.0.0.1:${this.port}`;
    }

    /** Idempotent: also used mid-test to simulate a connect error. */
    stop() {
        if (this.stopped) return;
        this.stopped = true;
        this.server.close();
        this.server.closeAllConnections?.();
    }
}

/**
 * Driver replacement that needs no Docker daemon.
 *
 * `run` simulates the sample Actor: it reads INPUT and writes an OUTPUT
 * record, one dataset item and one queued request into the run's storage
 * dir, exactly as the real containerised Actor would.
 */
export class StubDriver {
    constructor() {
        // Records the environment passed to each run/start so tests can
        // assert what does (and does not) reach the Actor container.
        this.capturedEnvs = [];
        // Records the memLimitMb passed to each run/start call -- so tests
        // can assert the ACTUAL container memory cap matches the persisted
        // run.options.memoryMbytes.
        this.capturedMemLimits = [];
        // Records the materialized build directory handed to the most recent
        // build (before the service removes it) so tests can assert exactly
        // which source was unzipped/written.
        this.capturedBuildFiles = [];
        this.capturedBuildDirContents = {};
        // containerName -> FakeStandbyServer, so `reap` shuts down exactly
        // the in-process server `start` spun up as that "container"'s
        // stand-in.
        this.standbyServers = new Map();
        // When set, the NEXT `start` call's server answers the readiness
        // probe with 503 forever, simulating a standby Actor that never
        // becomes ready.
        this.nextStartNeverReady = false;
        // When set, the NEXT `start` call's server sleeps this long before
        // answering EVERY readiness probe.
        this.nextStartReadinessHangSecs = 0;
    }

    async ensureNetwork() {} // no Docker in the stub

    async build(buildDir, imageTag, _logSink = null) {
        const files = listFilesRecursive(buildDir);
        this.capturedBuildFiles = files.map((f) => path.relative(buildDir, f)).sort();
        this.capturedBuildDirContents = Object.fromEntries(
            files.map((f) => [path.relative(buildDir, f), fs.readFileSync(f)]),
        );
        return new BuildResult(true, `stub: built ${imageTag}\n`);
    }

    async stop(_containerName) {} // no Docker in the stub

    async removeImage(_imageTag) {} // no Docker in the stub

    /**
     * Non-blocking start stand-in: materialize storage immediately (like a
     * real container would eventually do) and spin up an in-process fake
     * HTTP server standing in for the container's ACTOR_STANDBY_PORT
     * listener.
     */
    async start(imageTag, hostStorageDir, environment, containerName, memLimitMb = null) {
        this.capturedEnvs.push({ ...environment });
        this.capturedMemLimits.push(memLimitMb);
        this.materialize(hostStorageDir);
        const server = await new FakeStandbyServer({
            neverReady: this.nextStartNeverReady,
            readinessHangSecs: this.nextStartReadinessHangSecs,
        }).start();
        this.nextStartNeverReady = false;
        this.nextStartReadinessHangSecs = 0;
        this.standbyServers.set(containerName, server);
        return `http://127.0.0.1:${server.port}`;
    }

    async reap(containerName) {
        const server = this.standbyServers.get(containerName);
        this.standbyServers.delete(containerName);
        server?.stop();
    }

    /**
     * Stand-in for a real container's captured stdout/stderr. Deterministic
     * per container name (rather than empty) so tests can assert it actually
     * lands in run.log at reap/teardown time.
     */
    async logs(containerName) {
        return `stub container log for ${containerName}\n`;
    }

    materialize(hostStorageDir) {
        const kv = path.join(hostStorageDir, 'key_value_stores', 'default');
        const inputPath = path.join(kv, 'INPUT.json');
        let actorInput = {};
        try {
            actorInput = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
        } catch {
            // no input file
        }
        const greeting = actorInput?.greeting ?? 'hello';

        fs.mkdirSync(kv, { recursive: true });
        fs.writeFileSync(path.join(kv, 'OUTPUT.json'), JSON.stringify({ greeting, receivedInput: actorInput }));

        const ds = path.join(hostStorageDir, 'datasets', 'default');
        fs.mkdirSync(ds, { recursive: true });
        fs.writeFileSync(path.join(ds, '000000001.json'), JSON.stringify({ message: `${greeting} world`, index: 1 }));

        const rq = path.join(hostStorageDir, 'request_queues', 'default');
        fs.mkdirSync(rq, { recursive: true });
        fs.writeFileSync(
            path.join(rq, 'request-1.json'),
            JSON.stringify({
                url: 'https://example.com/from-actor',
                uniqueKey: 'https://example.com/from-actor',
                method: 'GET',
            }),
        );
        return greeting;
    }

    async run(imageTag, hostStorageDir, environment, _timeoutSecs, _containerName = null, memLimitMb = null, _logSink = null) {
        this.capturedEnvs.push({ ...environment });
        this.capturedMemLimits.push(memLimitMb);
        const greeting = this.materialize(hostStorageDir);
        return new RunResult(0, `stub run of ${imageTag}: greeting=${greeting}\n`);
    }
}

/**
 * Docker-free driver that delivers its log in chunks over time via the log
 * sink, so the live-streaming buffer, endpoint, terminal-state handoff and
 * console wiring are unit-testable without Docker. The returned result's
 * `log` equals the exact concatenation of those chunks.
 */
export class StreamingStubDriver extends StubDriver {
    constructor({ chunks = null, delayMs = 600 } = {}) {
        super();
        this.chunks = chunks ?? ['chunk-1\n', 'chunk-2\n', 'chunk-3\n'];
        this.delayMs = delayMs;
    }

    async emit(logSink) {
        for (const chunk of this.chunks) {
            if (logSink) logSink(chunk);
            await sleep(this.delayMs);
        }
        return this.chunks.join('');
    }

    async run(imageTag, hostStorageDir, environment, _timeoutSecs, _containerName = null, memLimitMb = null, logSink = null) {
        this.capturedEnvs.push({ ...environment });
        this.capturedMemLimits.push(memLimitMb);
        this.materialize(hostStorageDir);
        return new RunResult(0, await this.emit(logSink));
    }

    async build(_buildDir, _imageTag, logSink = null) {
        return new BuildResult(true, await this.emit(logSink));
    }
}

export function makeSettings(tmpDir, overrides = {}) {
    // Unit tests default to a short readiness-wait bound (production is 30s)
    // so a deliberately-never-ready fake standby server fails fast instead of
    // stalling the suite.
    return new Settings({
        dataDir: tmpDir,
        hostDataDir: tmpDir,
        portApi: 3333,
        portConsole: 3000,
        standbyReadyTimeoutSecs: 5.0,
        ...overrides,
    });
}

/** A tiny HTTP client bound to a base URL, returning parsed responses. */
export function makeClient(baseUrl) {
    async function call(method, urlPath, { headers = {}, body = null, json = null } = {}) {
        const options = { method, headers: { ...headers } };
        if (json !== null) {
            options.body = JSON.stringify(json);
            options.headers['content-type'] ??= 'application/json';
        } else if (body !== null) {
            options.body = body;
        }
        const response = await fetch(`${baseUrl}${urlPath}`, options);
        const buffer = Buffer.from(await response.arrayBuffer());
        return {
            status: response.status,
            headers: response.headers,
            body: buffer,
            text: () => buffer.toString('utf8'),
            json: () => JSON.parse(buffer.toString('utf8')),
        };
    }
    return {
        get: (urlPath, options) => call('GET', urlPath, options),
        post: (urlPath, options) => call('POST', urlPath, options),
        put: (urlPath, options) => call('PUT', urlPath, options),
        delete: (urlPath, options) => call('DELETE', urlPath, options),
        head: (urlPath, options) => call('HEAD', urlPath, options),
        baseUrl,
    };
}

export function authHeaders(token) {
    return token ? { authorization: `Bearer ${token}` } : {};
}

/**
 * Boot the app against a temp data dir and the given driver, served on a
 * real loopback socket. Returns `{client, service, baseUrl, app, close}`.
 */
export async function wire({ driver = null, settings = null, tmpDir = null } = {}) {
    tmpDir = tmpDir ?? (await fsp.mkdtemp(path.join(os.tmpdir(), 'actor-runtime-test-')));
    settings = settings ?? makeSettings(tmpDir);
    driver = driver ?? new StubDriver();
    const app = await createApp({ settings, driver });
    const server = http.createServer(app.handler);
    await new Promise((resolve) => {
        server.listen(0, '127.0.0.1', resolve);
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const client = makeClient(baseUrl);
    const close = async () => {
        server.close();
        server.closeAllConnections?.();
        await app.close();
        for (const fake of driver.standbyServers?.values?.() ?? []) {
            fake.stop();
        }
        await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    };
    return { client, service: app.service, settings, baseUrl, app, driver, tmpDir, close };
}

function listFilesRecursive(dir) {
    const out = [];
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return out;
    }
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...listFilesRecursive(full));
        else if (entry.isFile()) out.push(full);
    }
    return out;
}

async function drain(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    return Buffer.concat(chunks);
}

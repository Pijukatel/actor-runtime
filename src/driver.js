/**
 * Actor driver: builds Actor images and runs Actor containers via Docker.
 *
 * The driver surface is duck-typed (see the method set on `DockerDriver`) so
 * tests can substitute a stub that does not require a Docker daemon.
 * `DockerDriver` talks to the host daemon through the mounted socket using
 * dockerode.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ACTOR_STANDBY_PORT, NETWORK_ALIAS, NETWORK_NAME } from './config.js';

// Per-read (inactivity) bound on the Docker build. It bounds a *silently*
// hung build -- one that stops emitting output for this many seconds is
// aborted, so a build worker (and the build's RUNNING status) cannot block
// forever. It is NOT a hard wall-clock cap on total build duration: a slow
// build that keeps producing output can still run past this window.
export const BUILD_TIMEOUT_SECS = 600;
// Sane default resource caps for Actor run containers so a runaway Actor
// cannot starve the host / Docker daemon. Memory is overridden per-run.
export const DEFAULT_PIDS_LIMIT = 512;
export const DEFAULT_NANO_CPUS = 2_000_000_000; // 2 CPUs

export class SourceFileNameError extends Error {}

/**
 * Materialise pushed `sourceFiles` (inline TEXT/BASE64) into `dest`.
 *
 * `name` is fully attacker-controlled (it comes straight from the request
 * body of `apify push`). Each name is validated to stay strictly inside
 * `dest`: absolute paths and any `..` traversal that would resolve outside
 * the build directory are rejected before anything is written to disk.
 */
export function writeSourceFiles(sourceFiles, dest) {
    fs.mkdirSync(dest, { recursive: true });
    const destResolved = path.resolve(dest);
    for (const entry of sourceFiles ?? []) {
        const name = entry?.name;
        if (!name) continue;
        if (path.isAbsolute(name)) {
            throw new SourceFileNameError(`Illegal absolute source file name: ${JSON.stringify(name)}`);
        }
        const target = path.resolve(dest, name);
        if (target !== destResolved && !target.startsWith(destResolved + path.sep)) {
            throw new SourceFileNameError(`Source file name escapes build directory: ${JSON.stringify(name)}`);
        }
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const content = entry.content ?? '';
        if (entry.format === 'BASE64') {
            fs.writeFileSync(target, Buffer.from(content, 'base64'));
        } else {
            fs.writeFileSync(target, content);
        }
    }
}

/**
 * Unzip `zipBytes` into `dest` with the same traversal safety as
 * `writeSourceFiles`.
 *
 * Zip entry names are fully attacker-controlled (the archive is uploaded by
 * `apify push`), so each name is validated to stay strictly inside `dest`
 * BEFORE anything is written: absolute names and any `..` traversal resolving
 * outside the build directory are rejected. Symlink entries are never
 * materialised as links.
 */
export async function extractZip(zipBytes, dest) {
    const { default: AdmZip } = await import('adm-zip');
    const zip = new AdmZip(Buffer.isBuffer(zipBytes) ? zipBytes : Buffer.from(zipBytes));
    const entries = zip.getEntries();
    fs.mkdirSync(dest, { recursive: true });
    const destResolved = path.resolve(dest);
    const S_IFLNK = 0o120000;
    for (const entry of entries) {
        const name = entry.entryName;
        if (!name || name.endsWith('/')) continue;
        if (path.isAbsolute(name)) {
            throw new SourceFileNameError(`Illegal absolute zip entry name: ${JSON.stringify(name)}`);
        }
        const target = path.resolve(dest, name);
        if (target !== destResolved && !target.startsWith(destResolved + path.sep)) {
            throw new SourceFileNameError(`Zip entry name escapes build directory: ${JSON.stringify(name)}`);
        }
    }
    for (const entry of entries) {
        const name = entry.entryName;
        if (!name || name.endsWith('/')) continue;
        const mode = (entry.header.attr >>> 16) & 0xffff;
        if ((mode & 0o170000) === S_IFLNK) continue;
        const target = path.resolve(dest, name);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, entry.getData());
    }
}

/** Return the Dockerfile path relative to `buildDir`, Apify conventions. */
export function resolveDockerfile(buildDir) {
    for (const candidate of ['.actor/Dockerfile', 'Dockerfile']) {
        try {
            if (fs.statSync(path.join(buildDir, candidate)).isFile()) return candidate;
        } catch {
            // keep looking
        }
    }
    return null;
}

export class BuildResult {
    constructor(ok, log) {
        this.ok = ok;
        this.log = log;
    }
}

export class RunResult {
    constructor(exitCode, log, timedOut = false) {
        this.exitCode = exitCode;
        this.log = log;
        this.timedOut = timedOut;
    }
}

/** Real driver using the host Docker daemon via the mounted socket. */
export class DockerDriver {
    constructor({ client = null, networkName = NETWORK_NAME } = {}) {
        this.clientPromise = client ? Promise.resolve(client) : null;
        this.networkName = networkName;
        // Set true only once `ensureNetwork()` has confirmed the shared
        // network actually exists (found or freshly created). Both `run()`
        // and `start()` below key off this instead of blindly assuming the
        // named network is there.
        this.networkAvailable = false;
    }

    async #client() {
        if (!this.clientPromise) {
            this.clientPromise = import('dockerode').then(({ default: Docker }) => new Docker());
        }
        return this.clientPromise;
    }

    /**
     * Create the shared user-defined network (idempotent) and self-attach.
     *
     * Actor containers only get embedded DNS (resolving each other, and the
     * runtime, by name) on a user-defined network -- the default bridge has
     * none. Self-attach needs the runtime to actually be a container whose id
     * is discoverable via its own hostname; when it is not (e.g. running
     * directly on a host), self-attach is skipped -- Actor containers still
     * join the network, but the runtime itself stays unreachable by name from
     * inside them.
     *
     * If the network itself cannot be found OR created, `networkAvailable`
     * stays false: `run()` then falls back to the default bridge network and
     * `start()` raises a clear, actionable error instead of referencing a
     * network that does not exist.
     */
    async ensureNetwork() {
        const docker = await this.#client();
        try {
            await docker.getNetwork(this.networkName).inspect();
        } catch (err) {
            if (err?.statusCode !== 404) {
                console.warn(`Could not look up Docker network '${this.networkName}'.`);
                return;
            }
            try {
                await docker.createNetwork({ Name: this.networkName, Driver: 'bridge' });
            } catch {
                console.warn(`Could not create Docker network '${this.networkName}'.`);
                return;
            }
        }
        this.networkAvailable = true;
        try {
            const selfContainer = docker.getContainer(os.hostname());
            await selfContainer.inspect(); // throws when not running as a container
            await docker.getNetwork(this.networkName).connect({
                Container: os.hostname(),
                EndpointConfig: { Aliases: [NETWORK_ALIAS] },
            });
        } catch (err) {
            const message = String(err?.message ?? err).toLowerCase();
            // Already connected (e.g. a restarted, not recreated, container)
            // is the common, harmless case -- only warn for anything else.
            if (!message.includes('already exists') && !message.includes('already connected')) {
                console.warn(
                    `Could not self-attach to network '${this.networkName}' under alias ` +
                    `'${NETWORK_ALIAS}' (not running as a container?); APIFY_API_BASE_URL ` +
                    'will not be reachable from Actor containers.',
                );
            }
        }
    }

    async build(buildDir, imageTag, logSink = null) {
        const dockerfile = resolveDockerfile(buildDir);
        if (dockerfile === null) {
            return new BuildResult(false, 'No Dockerfile found (looked for .actor/Dockerfile, Dockerfile).\n');
        }
        const docker = await this.#client();
        const lines = [];
        const push = (line) => {
            lines.push(line);
            if (logSink) logSink(line);
        };
        try {
            const files = await fsp.readdir(buildDir);
            const stream = await docker.buildImage(
                { context: buildDir, src: files },
                { t: imageTag, dockerfile, rm: true, forcerm: true },
            );
            await new Promise((resolve, reject) => {
                // Inactivity bound: a build that stops emitting output for
                // BUILD_TIMEOUT_SECS is aborted (see the constant above).
                let timer = null;
                const resetTimer = () => {
                    if (timer) clearTimeout(timer);
                    timer = setTimeout(() => {
                        stream.destroy(new Error(`Build produced no output for ${BUILD_TIMEOUT_SECS}s.`));
                    }, BUILD_TIMEOUT_SECS * 1000);
                };
                resetTimer();
                docker.modem.followProgress(
                    stream,
                    (err, output) => {
                        if (timer) clearTimeout(timer);
                        if (err) return reject(err);
                        const errorItem = output?.find?.((item) => item?.error);
                        if (errorItem) return reject(new Error(errorItem.error));
                        resolve(output);
                    },
                    (event) => {
                        resetTimer();
                        if (event?.stream) push(event.stream);
                        else if (event?.error) push(event.error);
                    },
                );
            });
        } catch (err) {
            push(`\nBUILD ERROR: ${err?.message ?? err}\n`);
            return new BuildResult(false, lines.join(''));
        }
        return new BuildResult(true, lines.join(''));
    }

    #containerConfig(imageTag, hostStorageDir, environment, containerName, memLimitMb) {
        const config = {
            Image: imageTag,
            Env: Object.entries(environment).map(([key, value]) => `${key}=${value}`),
            HostConfig: {
                Binds: [`${hostStorageDir}:/apify_storage:rw`],
                // Resource caps: enforce the caller's memory budget and apply
                // sane process/CPU ceilings so a runaway Actor cannot exhaust
                // the host.
                PidsLimit: DEFAULT_PIDS_LIMIT,
                NanoCpus: DEFAULT_NANO_CPUS,
            },
        };
        if (containerName) config.name = containerName;
        if (memLimitMb) config.HostConfig.Memory = Math.floor(memLimitMb) * 1024 * 1024;
        return config;
    }

    async run(imageTag, hostStorageDir, environment, timeoutSecs, containerName = null, memLimitMb = null, logSink = null) {
        const docker = await this.#client();
        const config = this.#containerConfig(imageTag, hostStorageDir, environment, containerName, memLimitMb);
        if (this.networkAvailable) {
            // The shared user-defined network (not the default bridge) so
            // this container can reach the runtime's APIFY_API_BASE_URL, and
            // be reached in turn, by name.
            config.HostConfig.NetworkMode = this.networkName;
        } else {
            // `ensureNetwork()` couldn't create/look up the shared network at
            // boot -- fall back to Docker's always-present default bridge so
            // on-demand runs keep working (network-name reachability and
            // standby forwarding simply won't work in this degraded case).
            config.HostConfig.NetworkMode = 'bridge';
        }
        const container = await docker.createContainer(config);
        let timedOut = false;
        let exitCode = 1;
        const chunks = [];
        let logStream = null;
        try {
            await container.start();
            // Stream logs while the timeout is enforced concurrently. Docker
            // multiplexes stdout/stderr on one stream; demux into a single
            // text accumulator. timestamps:true makes Docker prefix every
            // line with an RFC3339Nano timestamp, mirroring platform logs.
            logStream = await container.logs({
                follow: true,
                stdout: true,
                stderr: true,
                timestamps: true,
            });
            const collect = (chunk) => {
                const text = chunk.toString('utf8');
                chunks.push(text);
                if (logSink) logSink(text);
            };
            const sink = new (await import('node:stream')).Writable({
                write(chunk, _enc, cb) {
                    collect(chunk);
                    cb();
                },
            });
            docker.modem.demuxStream(logStream, sink, sink);

            const waitPromise = container.wait();
            let timer = null;
            const timeoutPromise = new Promise((resolve) => {
                timer = setTimeout(() => {
                    timedOut = true;
                    resolve(null);
                }, timeoutSecs * 1000);
            });
            const result = await Promise.race([waitPromise, timeoutPromise]);
            if (timer) clearTimeout(timer);
            if (timedOut) {
                try {
                    await container.kill();
                } catch {
                    // best effort
                }
                await waitPromise.catch(() => {});
            } else {
                exitCode = Number(result?.StatusCode ?? 1);
            }
            // Give the log stream a moment to drain the final chunks.
            await new Promise((resolve) => {
                logStream.once('end', resolve);
                logStream.once('close', resolve);
                setTimeout(resolve, 2000).unref();
            });
        } finally {
            try {
                await container.remove({ force: true });
            } catch {
                // best effort
            }
        }
        return new RunResult(exitCode, chunks.join(''), timedOut);
    }

    /**
     * Non-blocking start: launch a detached, long-lived container and return
     * immediately with its forwarding endpoint (no wait, no auto-remove --
     * that is `reap`'s job). Used for standby Actor runs.
     *
     * The container's name doubles as its DNS name on the shared network, so
     * the endpoint is known synchronously without inspecting the container.
     *
     * Throws with a clear, actionable message if the shared network is not
     * available (`ensureNetwork()` failed at boot) instead of attempting to
     * join a network that doesn't exist: unlike an on-demand `run()`, a
     * standby container is unreachable by anything but its network DNS name,
     * so there is no degraded-but-working fallback here.
     */
    async start(imageTag, hostStorageDir, environment, containerName, memLimitMb = null) {
        if (!this.networkAvailable) {
            throw new Error(
                `Cannot start a standby Actor container: the shared Docker network ` +
                `'${this.networkName}' is not available (network setup failed at runtime ` +
                `boot -- see the 'Could not create/look up Docker network' warning in the ` +
                `runtime's own logs). Standby actors require container-to-container ` +
                `networking by name; on-demand runs are unaffected and keep working via ` +
                `the default bridge network. Fix the daemon's network-creation permissions ` +
                `and restart the runtime to enable standby actors.`,
            );
        }
        const docker = await this.#client();
        const config = this.#containerConfig(imageTag, hostStorageDir, environment, containerName, memLimitMb);
        config.HostConfig.NetworkMode = this.networkName;
        const container = await docker.createContainer(config);
        await container.start();
        return `http://${containerName}:${ACTOR_STANDBY_PORT}`;
    }

    /** Kill and remove a container started via `start` (idempotent). */
    async reap(containerName) {
        const docker = await this.#client();
        try {
            await docker.getContainer(containerName).remove({ force: true });
        } catch {
            // already gone
        }
    }

    /** Best-effort kill of a run container (used by abort). */
    async stop(containerName) {
        const docker = await this.#client();
        try {
            await docker.getContainer(containerName).kill();
        } catch {
            // container may already be gone
        }
    }

    /**
     * Best-effort fetch of a still-alive container's accumulated
     * stdout/stderr. Standby runs have no live log sink the way the blocking
     * `run()` path does, so the service calls this at reap/teardown time to
     * populate `run.log`. Returns an empty string if the container is already
     * gone or logs can't be read; never throws.
     */
    async logs(containerName) {
        const docker = await this.#client();
        try {
            const container = docker.getContainer(containerName);
            const muxed = await container.logs({ follow: false, stdout: true, stderr: true, timestamps: true });
            return demuxLogBuffer(muxed);
        } catch {
            return '';
        }
    }

    /** Best-effort removal of a built image (used to clean up failed builds). */
    async removeImage(imageTag) {
        const docker = await this.#client();
        try {
            await docker.getImage(imageTag).remove({ force: true });
        } catch {
            // best effort
        }
    }
}

/**
 * Decode a non-TTY Docker log buffer (8-byte-header multiplexed frames) into
 * plain text; a buffer that doesn't look multiplexed is returned as-is.
 */
function demuxLogBuffer(buffer) {
    if (!Buffer.isBuffer(buffer)) return String(buffer ?? '');
    const parts = [];
    let offset = 0;
    while (offset + 8 <= buffer.length) {
        const streamType = buffer[offset];
        if (streamType > 2 || buffer[offset + 1] !== 0 || buffer[offset + 2] !== 0 || buffer[offset + 3] !== 0) {
            // Not a multiplexed frame -- treat the whole buffer as raw text.
            return buffer.toString('utf8');
        }
        const size = buffer.readUInt32BE(offset + 4);
        parts.push(buffer.subarray(offset + 8, offset + 8 + size).toString('utf8'));
        offset += 8 + size;
    }
    return parts.length ? parts.join('') : buffer.toString('utf8');
}

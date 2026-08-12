/** Runtime configuration, read from the environment with sensible defaults. */
import path from 'node:path';

// The default user, used when no Authorization token is presented. There is no
// real auth: the bearer token selects/creates the acting user, and its absence
// falls back to this single default user (preserving the original behaviour).
export const DEFAULT_USERNAME = 'local-user';

// The API and console ports are fixed and not configurable via the environment.
export const API_PORT = 3333;
export const CONSOLE_PORT = 3000;

// The shared user-defined Docker network every Actor container -- and the
// runtime itself, via DockerDriver.ensureNetwork() -- joins. Containers only
// get embedded DNS (resolving each other, and the runtime, by name) on a
// user-defined network; the default bridge network has none.
export const NETWORK_NAME = 'actor-runtime-net';
export const NETWORK_ALIAS = 'actor-runtime';

// Fixed port every standby Actor's HTTP server listens on inside its
// container (mirrors the real platform's ACTOR_STANDBY_PORT). Fixed rather
// than allocated per-run: containers are addressed by name on the shared
// network, so there is no host port to allocate or collide over.
export const ACTOR_STANDBY_PORT = 4321;

// Mirrors apify-core's actorStandby.idleTimeoutSecs: default 300s (5 min),
// enforced minimum 5s.
export const STANDBY_IDLE_TIMEOUT_DEFAULT_SECS = 300;
export const STANDBY_IDLE_TIMEOUT_MIN_SECS = 5;

export class Settings {
    /**
     * @param {object} options
     * @param {string} options.dataDir
     * @param {string} [options.hostDataDir] Absolute path of `dataDir` on the
     *   Docker host. When the runtime itself runs inside a container (sharing
     *   the host Docker socket), volume mounts for Actor containers must
     *   reference host paths, not runtime-container paths. Defaults to
     *   `dataDir` for the "runtime runs directly on the host" case.
     * @param {number} [options.portApi]
     * @param {number} [options.portConsole]
     * @param {string} [options.networkName]
     * @param {string} [options.networkAlias]
     * @param {number|null} [options.standbyIdleOverrideSecs] Global override
     *   for every actor's standby idle timeout: bypasses both the per-actor
     *   config AND the platform-mirrored 5s floor, so tests can reap in a
     *   fraction of a second. `null` means "use the per-actor config".
     * @param {number} [options.standbyReadyTimeoutSecs] How long
     *   ensureStandbyRun() polls a freshly-started container's readiness probe
     *   before giving up. A Settings field (not a constant) so tests can
     *   shrink it instead of waiting out the production default.
     * @param {string} [options.apifyUpstreamBaseUrl] Base URL the
     *   upstream-fallback layer (src/upstream.js) replays an allowlisted
     *   local-404 request against. A Settings field (not a plain constant)
     *   purely so tests can point it at a local stub server instead of the
     *   real platform.
     * @param {string} [options.apifyProxyPassword] Host-supplied Apify proxy
     *   password, forwarded into every Actor container's environment (see
     *   Service.buildEnvironment) so the SDK picks it up. Empty means "not
     *   configured" -- no APIFY_PROXY_PASSWORD is injected into Actor
     *   containers at all (see README.md's Apify Proxy section).
     */
    constructor(options) {
        this.dataDir = path.resolve(options.dataDir);
        this.hostDataDir = options.hostDataDir ?? this.dataDir;
        this.portApi = options.portApi ?? API_PORT;
        this.portConsole = options.portConsole ?? CONSOLE_PORT;
        this.networkName = options.networkName ?? NETWORK_NAME;
        this.networkAlias = options.networkAlias ?? NETWORK_ALIAS;
        this.standbyIdleOverrideSecs = options.standbyIdleOverrideSecs ?? null;
        this.standbyReadyTimeoutSecs = options.standbyReadyTimeoutSecs ?? 30.0;
        // Normalized here -- the one boundary every construction path goes
        // through -- so the upstream-fallback layer can keep concatenating
        // `apifyUpstreamBaseUrl` with the raw request target (which always
        // starts with its own `/`) without ever producing a double slash,
        // regardless of whether an operator's `APIFY_UPSTREAM_BASE_URL` env
        // var happens to end with one.
        this.apifyUpstreamBaseUrl = (options.apifyUpstreamBaseUrl ?? 'https://api.apify.com').replace(/\/+$/, '');
        this.apifyProxyPassword = options.apifyProxyPassword ?? '';
    }

    /** Copy of these settings with the given fields replaced (test helper). */
    with(overrides) {
        return new Settings({ ...this, ...overrides });
    }

    get storageDir() {
        // Root directory for the crawlee file-system storage backend (holds
        // `datasets/`, `key_value_stores/` and `request_queues/`).
        return path.join(this.dataDir, 'storage');
    }

    get metaPath() {
        return path.join(this.dataDir, 'meta.json');
    }

    get runsDir() {
        return path.join(this.dataDir, 'runs');
    }

    get hostRunsDir() {
        return path.join(this.hostDataDir, 'runs');
    }

    get buildsDir() {
        return path.join(this.dataDir, 'builds');
    }

    /**
     * The runtime's own API, reachable by name from any Actor container on
     * the shared network (see NETWORK_NAME/NETWORK_ALIAS).
     */
    get containerApiBaseUrl() {
        return `http://${this.networkAlias}:${this.portApi}`;
    }
}

export function loadSettings() {
    const dataDir = process.env.DATA_DIR || '/data';
    const overrideRaw = process.env.STANDBY_IDLE_OVERRIDE_SECS;
    return new Settings({
        dataDir,
        hostDataDir: process.env.HOST_DATA_DIR || undefined,
        portApi: API_PORT,
        portConsole: CONSOLE_PORT,
        standbyIdleOverrideSecs: overrideRaw ? Number(overrideRaw) : null,
        apifyProxyPassword: process.env.APIFY_PROXY_PASSWORD || '',
        apifyUpstreamBaseUrl: process.env.APIFY_UPSTREAM_BASE_URL || undefined,
    });
}

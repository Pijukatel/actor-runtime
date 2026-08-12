/**
 * Application service: orchestrates users, Actors, versions, builds and runs.
 *
 * Owns the metadata DB, the storage backend and the Actor driver. Builds and
 * runs execute asynchronously (fire-and-forget promises tracked for
 * `waitIdle`) while status transitions are persisted to the metadata DB.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';

import { DEFAULT_USERNAME } from './config.js';
import {
    TERMINAL_ABORTED,
    TERMINAL_FAIL,
    TERMINAL_OK,
    TERMINAL_TIMED_OUT,
    STORAGE_DS,
    STORAGE_KV,
    STORAGE_RQ,
    logStamp,
    shortId,
    utcNow,
} from './constants.js';
import { extractZip, writeSourceFiles } from './driver.js';
import { resolveInputSchema } from './input-schema.js';
import { StandbyManager, extractUsesStandbyMode, normalizeStandbyConfig } from './standby.js';
import { StorageAccessManager } from './storage-access.js';

function sanitize(text) {
    return text.toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'actor';
}

/**
 * Extract `{storeId, key}` from a tarball URL's path.
 *
 * The path segment `/key-value-stores/{storeId}/records/{key}` is parsed
 * verbatim; scheme, host and query string are ignored. The store id is used
 * as given (the id the CLI was handed at store creation), never recomputed.
 */
export function parseTarballUrl(url) {
    let pathname;
    try {
        pathname = new URL(url).pathname;
    } catch {
        pathname = String(url ?? '');
    }
    const match = pathname.match(/\/key-value-stores\/([^/]+)\/records\/(.+)$/);
    if (!match) {
        throw new Error(`Cannot parse store id and record key from tarballUrl: ${JSON.stringify(url)}`);
    }
    return { storeId: decodeURIComponent(match[1]), key: decodeURIComponent(match[2]) };
}

/**
 * Best-effort numeric ordering key of a dotted version number (so "1.2"
 * sorts after "0.9", unlike a plain string compare), falling back to the raw
 * string per-segment for anything that doesn't parse as an int. Only used to
 * break ties among versions with no other signal (see
 * `selectSchemaVersion`).
 */
function versionSortKey(version) {
    return (version.versionNumber ?? '').split('.').map((piece) => {
        const parsed = Number.parseInt(piece, 10);
        return Number.isNaN(parsed) || String(parsed) !== piece ? [1, piece] : [0, parsed];
    });
}

function compareSegments(a, b) {
    const length = Math.max(a.length, b.length);
    for (let index = 0; index < length; index += 1) {
        const [aKind, aValue] = a[index] ?? [0, -Infinity];
        const [bKind, bValue] = b[index] ?? [0, -Infinity];
        if (aKind !== bKind) return aKind - bKind;
        if (aValue < bValue) return -1;
        if (aValue > bValue) return 1;
    }
    return 0;
}

/**
 * Best-effort schema-version GUESS for an actor with NO successful build
 * yet: the version tagged `latest` (its own `buildTag`, not a build's), or
 * the highest-numbered one if several share that tag, else the
 * highest-numbered version overall when none carries the `latest` tag.
 *
 * This is only ever a fallback -- see `Service.getInputSchema`. Once an
 * actor has a successful build, that build's OWN version is the only thing
 * that determines what a default (`build=latest`) run actually executes.
 */
function selectSchemaVersion(versions) {
    if (!versions.length) return null;
    const taggedLatest = versions.filter((v) => (v.buildTag || 'latest') === 'latest');
    const pool = taggedLatest.length ? taggedLatest : versions;
    return pool.reduce((best, candidate) =>
        compareSegments(versionSortKey(candidate), versionSortKey(best)) > 0 ? candidate : best,
    );
}

export class Service {
    constructor(settings, db, storage, driver) {
        this.settings = settings;
        this.db = db;
        this.storage = storage;
        this.driver = driver;
        /** In-flight build/run promises, awaited by `waitIdle` (tests). */
        this.tasks = new Set();
        // Per-job live log buffers, keyed by run/build id. The driver's log
        // sink appends chunks; the streaming log endpoint snapshots them.
        this.logBuffers = new Map();
        // The standby-actor subsystem (warm-run state, per-actor locks, the
        // idle-reap watchdog) -- composed here so every Service, including
        // ones tests build directly, gets one automatically.
        this.standby = new StandbyManager(this);
        // Same composition for storage ownership/sharing.
        this.storageAccess = new StorageAccessManager(this);
        // Global runtime toggle for the upstream-fallback layer
        // (src/upstream.js): in-memory only, default off, resets on restart
        // -- no persistence. Shared across both ports/all users since they
        // all serve this same Service instance.
        this.upstreamFallbackEnabled = false;
    }

    /** Create the job's live log buffer and return an append sink. */
    makeLogSink(jobId) {
        this.logBuffers.set(jobId, []);
        return (chunk) => {
            this.logBuffers.get(jobId)?.push(chunk);
        };
    }

    discardLogBuffer(jobId) {
        this.logBuffers.delete(jobId);
    }

    /** Return the job's live log so far, or null if no live buffer exists. */
    readLogBuffer(jobId) {
        const buffer = this.logBuffers.get(jobId);
        return buffer === undefined ? null : buffer.join('');
    }

    spawn(promise) {
        const tracked = promise.catch((err) => {
            console.error('Background job failed:', err);
        });
        this.tasks.add(tracked);
        tracked.finally(() => this.tasks.delete(tracked));
    }

    /** Await all in-flight build/run tasks (used by tests). */
    async waitIdle() {
        while (this.tasks.size) {
            await Promise.allSettled([...this.tasks]);
        }
    }

    // -- users -------------------------------------------------------------
    /**
     * Ensure the default user exists (unclaimed, token is null; idempotent).
     * `containerToken` is minted immediately, unlike `token` -- it is never
     * claimed by an inbound request, only ever generated locally, so there is
     * nothing to wait to bind.
     */
    ensureDefaultUser() {
        if (this.db.getUser(DEFAULT_USERNAME)) return;
        this.db.addUser({ username: DEFAULT_USERNAME, containerToken: shortId() });
    }

    /**
     * Return the username whose `token` OR `containerToken` equals `token`,
     * else null. Resolving either is what makes a container's own injected
     * `APIFY_TOKEN` (always `containerToken`, never the bound `token`) a
     * working bearer credential against the runtime's own API.
     */
    userForToken(token) {
        return this.db.findUserByAnyToken(token)?.username ?? null;
    }

    /**
     * Return `username`'s `containerToken`, minting one lazily if absent.
     * Both known user-creation paths already mint this at insert time; the
     * lazy mint here is a defensive fallback so a run can never be started
     * with no container credential at all.
     */
    containerTokenFor(username) {
        const user = this.db.getUser(username);
        if (user?.containerToken) return user.containerToken;
        const token = shortId();
        if (!user) {
            this.db.addUser({ username, containerToken: token });
        } else {
            user.containerToken = token;
            this.db.save();
        }
        return token;
    }

    /**
     * Bootstrap: atomically claim the default user's credential with
     * `token`. A conditional set (only when the default user's token is
     * still null) -- Node's single-threaded execution makes this a real
     * compare-and-swap: exactly one caller can observe the unclaimed state.
     * Returns false when the token is already another user's credential.
     */
    bindDefaultToken(token) {
        this.ensureDefaultUser();
        if (this.db.findUserByAnyToken(token)) return false;
        const user = this.db.getUser(DEFAULT_USERNAME);
        if (user.token !== null && user.token !== undefined) return false;
        user.token = token;
        this.db.save();
        return true;
    }

    getUser(username) {
        return this.db.getUser(username);
    }

    listUsers() {
        return [...this.db.data.users];
    }

    /**
     * Create a user whose username and token both equal `name`.
     *
     * Returns the created user, or null if the username (or the token,
     * uniquely held by another user) already exists -- the caller renders a
     * 409. The token-equals-name convenience applies only to users created
     * here, never to the default user's bootstrap credential.
     */
    createUser(name) {
        if (this.db.getUser(name) || this.db.findUserByAnyToken(name)) return null;
        return this.db.addUser({ username: name, token: name, containerToken: shortId() });
    }

    // -- actors / versions -------------------------------------------------
    getActor(actorId, username = null) {
        const actor = this.db.getActor(actorId);
        if (!actor || (username !== null && actor.username !== username)) return null;
        return actor;
    }

    listActors(username = null) {
        return this.db.data.actors.filter((a) => username === null || a.username === username);
    }

    createActor({ name, defaultRunOptions, versions, username = null, actorStandby = null }) {
        username = username || DEFAULT_USERNAME;
        const actorId = `${username}~${name}`;
        // An explicit `actorStandby` field on THIS call always wins over
        // whatever `.actor/actor.json` inference the version pushes below
        // would otherwise apply (matches apify-core: "the payload from the
        // API takes precedence over actor.json").
        const explicitStandby = actorStandby !== null && actorStandby !== undefined;
        let actor = this.db.getActor(actorId);
        if (!actor) {
            actor = {
                id: actorId,
                name,
                username,
                createdAt: utcNow(),
                modifiedAt: utcNow(),
                defaultRunOptions: defaultRunOptions ?? {},
                actorStandby: explicitStandby ? normalizeStandbyConfig(actorStandby, { explicit: true }) : {},
            };
            this.db.data.actors.push(actor);
        } else if (explicitStandby) {
            actor.actorStandby = normalizeStandbyConfig(actorStandby, { explicit: true });
        }
        for (const version of versions ?? []) {
            this.#upsertVersionRecord(actorId, version, { inferStandby: !explicitStandby });
        }
        this.db.save();
        return actor;
    }

    #upsertVersionRecord(actorId, payload, { inferStandby = true } = {}) {
        const versionNumber = payload.versionNumber ?? '0.0';
        let version = this.db.getVersion(actorId, versionNumber);
        if (!version) {
            version = {
                actorId,
                versionNumber,
                buildTag: 'latest',
                sourceType: 'SOURCE_FILES',
                sourceFiles: [],
                tarballUrl: null,
            };
            this.db.data.versions.push(version);
        }
        version.buildTag = payload.buildTag ?? version.buildTag ?? 'latest';
        const sourceType = payload.sourceType ?? version.sourceType ?? 'SOURCE_FILES';
        version.sourceType = sourceType;
        // Replace source wholesale on every create/update so a re-push in the
        // other mode can never leave the previous shape's source behind: a
        // TARBALL push clears the inline files, an inline push clears the
        // tarball pointer.
        if (sourceType === 'TARBALL') {
            version.tarballUrl = payload.tarballUrl ?? null;
            version.sourceFiles = [];
        } else {
            version.sourceFiles = payload.sourceFiles ?? [];
            version.tarballUrl = null;
        }

        // Standby opt-in mirrors apify-core: parsed from the pushed
        // `.actor/actor.json`'s `usesStandbyMode`, unless this call's caller
        // already supplied an explicit `actorStandby` field
        // (`inferStandby: false`), which always takes precedence. Only a
        // SOURCE_FILES push carries an inspectable manifest at push time; a
        // TARBALL's manifest is inside the (not yet unzipped) archive.
        //
        // An explicit override from an EARLIER call must also survive a
        // later, plain actor.json-only push ("persists until the next call
        // that carries an explicit actorStandby field") -- so inference is
        // skipped entirely once the actor's persisted config already carries
        // the `explicitlySet` marker, regardless of what THIS call's own
        // `inferStandby` flag says.
        if (inferStandby && sourceType !== 'TARBALL') {
            const actor = this.db.getActor(actorId);
            if (actor && !(actor.actorStandby ?? {}).explicitlySet) {
                const usesStandby = extractUsesStandbyMode(version.sourceFiles);
                if (usesStandby !== null) {
                    actor.actorStandby = normalizeStandbyConfig({
                        ...(actor.actorStandby ?? {}),
                        isEnabled: usesStandby,
                    });
                }
            }
        }
        return version;
    }

    upsertVersion(actorId, payload) {
        const version = this.#upsertVersionRecord(actorId, payload);
        this.db.save();
        return version;
    }

    getVersion(actorId, versionNumber) {
        return this.db.getVersion(actorId, versionNumber);
    }

    listVersions(actorId) {
        return this.db.data.versions.filter((v) => v.actorId === actorId);
    }

    /**
     * Resolve the actor's input schema for the console's Input tab.
     *
     * Mirrors the SAME selection a default (`build=latest`) run actually
     * executes, not merely the version currently tagged `latest`:
     * `Service.startRun` calls `latestBuild(actorId)`, which returns the
     * most recently *started* successful build -- tag-blind. This method
     * resolves that SAME build's version and reads its schema, so the schema
     * shown always matches what actually runs. Falls back to
     * `selectSchemaVersion` (the version tagged `latest`, else the
     * highest-numbered one) only when the actor has no successful build yet.
     *
     * A TARBALL version's pushed archive isn't inspectable until a build
     * unpacks it, so it always falls back to `null` here regardless of what
     * it contains. Fails soft to `null` for every other reason too (no
     * versions, no manifest/schema file, malformed JSON) -- never throws.
     */
    getInputSchema(actorId) {
        const build = this.latestBuild(actorId);
        const version = build
            ? this.getVersion(actorId, build.versionNumber)
            : selectSchemaVersion(this.listVersions(actorId));
        if (!version || version.sourceType === 'TARBALL') return null;
        return resolveInputSchema(version.sourceFiles);
    }

    /** Builds for `actorId`, most recently started first. */
    listBuilds(actorId, username = null) {
        return this.db.data.builds
            .map((build, index) => ({ build, index }))
            .filter(
                ({ build }) =>
                    build.actorId === actorId && (username === null || build.username === username),
            )
            .sort((a, b) =>
                b.build.startedAt === a.build.startedAt
                    ? b.index - a.index
                    : b.build.startedAt.localeCompare(a.build.startedAt),
            )
            .map(({ build }) => build);
    }

    latestBuild(actorId) {
        return this.listBuilds(actorId).find((b) => b.status === TERMINAL_OK) ?? null;
    }

    /**
     * Apply an in-place update (name / defaultRunOptions / actorStandby) to
     * an Actor. The id (`username~name`) is kept stable so existing
     * references remain valid.
     */
    updateActor(actorId, payload, username = null) {
        const actor = this.db.getActor(actorId);
        if (!actor || (username !== null && actor.username !== username)) return null;
        if (payload.name) actor.name = payload.name;
        if (payload.defaultRunOptions !== undefined && payload.defaultRunOptions !== null) {
            actor.defaultRunOptions = payload.defaultRunOptions;
        }
        if (payload.actorStandby !== undefined && payload.actorStandby !== null) {
            actor.actorStandby = normalizeStandbyConfig(payload.actorStandby, { explicit: true });
        }
        actor.modifiedAt = utcNow();
        this.db.save();
        return actor;
    }

    containerName(runId) {
        return `ar-run-${runId}`;
    }

    /**
     * On boot, sweep build/run rows left RUNNING by an unclean shutdown.
     *
     * After a `docker stop` mid-build/run there is no live task behind the
     * row, so it would otherwise stay RUNNING forever. Builds become FAILED,
     * runs become ABORTED, both with a terminal `finishedAt`.
     */
    async reconcileStaleJobs() {
        const standbyContainerNames = [];
        for (const build of this.db.data.builds) {
            if (build.status === 'RUNNING') {
                build.status = TERMINAL_FAIL;
                build.log = (build.log ?? '') + `\n${logStamp()} Build interrupted by runtime restart.\n`;
                build.finishedAt = utcNow();
            }
        }
        for (const run of this.db.data.runs) {
            if (run.status === 'RUNNING') {
                run.status = TERMINAL_ABORTED;
                run.finishedAt = utcNow();
                if (run.isStandby) standbyContainerNames.push(this.containerName(run.id));
            }
        }
        this.db.save();
        // Best-effort: unlike an on-demand run() container (whose blocking
        // driver.run() call died with the crashed process), a standby
        // container is long-lived and detached, so it can easily still be
        // running after the run row above is swept to ABORTED -- the
        // in-memory standby bookkeeping that tracked it was lost with the
        // previous process, but the container name is deterministic from the
        // run id, so it can still be reaped by name alone.
        for (const containerName of standbyContainerNames) {
            try {
                await this.driver.reap(containerName);
            } catch {
                // never block boot on this
            }
        }
    }

    // -- builds ------------------------------------------------------------
    startBuild(actorId, versionNumber, buildTag) {
        const actor = this.db.getActor(actorId);
        const owner = actor ? actor.username : DEFAULT_USERNAME;
        const count = this.db.data.builds.filter((b) => b.actorId === actorId).length;
        const build = {
            id: shortId(),
            actorId,
            username: owner,
            versionNumber,
            buildNumber: `0.0.${count + 1}`,
            buildTag,
            status: 'RUNNING',
            imageTag: `ar-${sanitize(actorId)}:0.0.${count + 1}`,
            log: '',
            startedAt: utcNow(),
            finishedAt: null,
        };
        this.db.data.builds.push(build);
        this.db.save();
        this.spawn(this.#runBuild(build.id));
        return build;
    }

    /**
     * Read the pushed source zip's raw bytes from local key-value storage.
     *
     * The store id and record key are parsed from the persisted `tarballUrl`
     * and read directly via `storage.kvRecord` (no self-HTTP). A missing
     * record raises, so the build worker's error handler marks the build
     * FAILED with the error in the log.
     */
    async #fetchTarballSource(tarballUrl) {
        if (!tarballUrl) {
            throw new Error('TARBALL version has no tarballUrl to fetch source from.');
        }
        const { storeId, key } = parseTarballUrl(tarballUrl);
        const record = await this.storage.kvRecord(storeId, key);
        if (record === null) {
            throw new Error(`Tarball source record not found (store '${storeId}', key '${key}').`);
        }
        return record.value;
    }

    async #runBuild(buildId) {
        const buildDir = path.join(this.settings.buildsDir, buildId);
        try {
            const build = this.db.getBuild(buildId);
            const version = this.db.getVersion(build.actorId, build.versionNumber);
            const sourceType = version?.sourceType ?? 'SOURCE_FILES';
            const sourceFiles = version?.sourceFiles ?? [];
            const tarballUrl = version?.tarballUrl ?? null;
            const imageTag = build.imageTag;
            // Materialize whichever source shape was pushed. Prep can throw
            // (bad base64, illegal name, missing/corrupt tarball); it runs
            // inside this guarded block so it transitions the build to FAILED
            // instead of leaving it stuck RUNNING. A TARBALL that resolves to
            // no usable source throws here rather than building an empty tree.
            if (sourceType === 'TARBALL') {
                const zipBytes = await this.#fetchTarballSource(tarballUrl);
                await extractZip(zipBytes, buildDir);
            } else {
                writeSourceFiles(sourceFiles, buildDir);
            }
            const logSink = this.makeLogSink(buildId);
            const result = await this.driver.build(buildDir, imageTag, logSink);
            const current = this.db.getBuild(buildId);
            // An abort can land while `docker build` is still running (it
            // cannot be cancelled mid-flight); the abort's terminal status
            // must win, so only finalize a build that is still RUNNING and
            // otherwise just append the docker output for the record.
            const aborted = current.status !== 'RUNNING';
            if (aborted) {
                current.log = (current.log ?? '') + result.log;
            } else {
                current.status = result.ok ? TERMINAL_OK : TERMINAL_FAIL;
                current.log = result.log;
                current.finishedAt = utcNow();
            }
            this.db.save();
            if (!result.ok || aborted) {
                // Best-effort cleanup: drop the image of a failed build, or of
                // one that completed after being aborted (its result is unwanted).
                await this.driver.removeImage(imageTag);
            }
        } catch (err) {
            // Never leave a build stuck RUNNING.
            const build = this.db.getBuild(buildId);
            if (build && build.status === 'RUNNING') {
                build.status = TERMINAL_FAIL;
                build.log = (build.log ?? '') + `\n${logStamp()} BUILD ERROR: ${err?.message ?? err}\n`;
                build.finishedAt = utcNow();
                this.db.save();
            }
        } finally {
            this.discardLogBuffer(buildId);
            // The per-build source tree is only needed during `docker build`;
            // remove it afterwards so builds don't accumulate unbounded copies.
            await fsp.rm(buildDir, { recursive: true, force: true }).catch(() => {});
        }
    }

    getBuild(buildId, username = null) {
        const build = this.db.getBuild(buildId);
        if (!build || (username !== null && build.username !== username)) return null;
        return build;
    }

    /**
     * Mark a RUNNING build ABORTED; a finished build is returned unchanged.
     *
     * The underlying `docker build` cannot be cancelled mid-flight -- it runs
     * to completion in the background, but `#runBuild`'s finalization
     * respects the already-terminal status and discards the resulting image,
     * so the abort is what sticks.
     */
    abortBuild(buildId, username = null) {
        const build = this.db.getBuild(buildId);
        if (!build || (username !== null && build.username !== username)) return null;
        if (build.status === 'RUNNING') {
            build.status = TERMINAL_ABORTED;
            build.log = (build.log ?? '') + `\n${logStamp()} Build aborted by user.\n`;
            build.finishedAt = utcNow();
            this.db.save();
        }
        return build;
    }

    listBuildsForUser(username) {
        return this.db.data.builds
            .map((build, index) => ({ build, index }))
            .filter(({ build }) => build.username === username)
            .sort((a, b) =>
                b.build.startedAt === a.build.startedAt
                    ? b.index - a.index
                    : b.build.startedAt.localeCompare(a.build.startedAt),
            )
            .map(({ build }) => build);
    }

    taggedBuilds(actorId) {
        const tagged = {};
        for (const build of this.listBuilds(actorId)) {
            if (build.status === TERMINAL_OK && !(build.buildTag in tagged)) {
                tagged[build.buildTag] = { buildId: build.id, buildNumber: build.buildNumber };
            }
        }
        return tagged;
    }

    // -- runs --------------------------------------------------------------
    async startRun(actorId, runInput, options) {
        const build = this.latestBuild(actorId);
        const runId = shortId();
        const kvStoreId = `kv_${runId}`;
        const datasetId = `ds_${runId}`;
        const requestQueueId = `rq_${runId}`;
        const actor = this.db.getActor(actorId);
        const owner = actor ? actor.username : DEFAULT_USERNAME;
        const run = {
            id: runId,
            actorId,
            username: owner,
            buildId: build?.id ?? '',
            buildNumber: build?.buildNumber ?? '0.0.0',
            status: 'RUNNING',
            exitCode: null,
            options,
            runInput: runInput !== null && typeof runInput === 'object' && !Array.isArray(runInput)
                ? runInput
                : { _raw: runInput },
            kvStoreId,
            datasetId,
            requestQueueId,
            isStandby: false,
            log: '',
            startedAt: utcNow(),
            finishedAt: null,
        };
        this.db.data.runs.push(run);
        // A run's default storages are first-class owned records: create one
        // row per storage now (synchronously, before the run task spawns) so
        // ownership and sharing are checkable independently of the run.
        for (const [id, type] of [
            [kvStoreId, STORAGE_KV],
            [datasetId, STORAGE_DS],
            [requestQueueId, STORAGE_RQ],
        ]) {
            this.db.data.storages.push({ id, type, owner, createdAt: utcNow() });
        }
        this.db.save();
        // Seed INPUT into the crawlee-backed key-value store too (alongside
        // the disk write in `prepareRunStorage`), before the run task is even
        // spawned -- so `GET .../records/INPUT` (what an SDK Actor's
        // `Actor.getInput()` calls) already sees it the moment the run
        // starts, not only after the run finishes and disk import runs.
        await this.storage.kvSet(kvStoreId, 'INPUT', runInput ?? {}, 'application/json');
        this.spawn(this.#runActor(runId, build?.imageTag ?? null, runInput));
        return run;
    }

    async prepareRunStorage(runId, runInput) {
        const storageDir = path.join(this.settings.runsDir, runId, 'storage');
        const kvDir = path.join(storageDir, 'key_value_stores', 'default');
        await fsp.mkdir(path.join(storageDir, 'datasets', 'default'), { recursive: true });
        await fsp.mkdir(path.join(storageDir, 'request_queues', 'default'), { recursive: true });
        await fsp.mkdir(kvDir, { recursive: true });
        await fsp.writeFile(path.join(kvDir, 'INPUT.json'), JSON.stringify(runInput ?? {}));
        // The runtime process is root, so these dirs are created root-owned.
        // Real Apify Actor images run as a NON-root user (e.g. uid 1000), and
        // the bind mount preserves host ownership -- so without this the
        // Actor cannot create files under /apify_storage and crashes on first
        // write. Make the whole per-run tree world-writable so any container
        // user can write; the runtime (root) can still read the results back
        // for import afterwards.
        const chmodAll = async (dir) => {
            await fsp.chmod(dir, 0o777).catch(() => {});
            for (const entry of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) await chmodAll(full);
                else await fsp.chmod(full, 0o666).catch(() => {});
            }
        };
        await chmodAll(storageDir);
        // Capture the real storage root ONCE, now, before the untrusted Actor
        // container runs and could swap a subdirectory for a symlink. This is
        // the trusted anchor every imported file is later validated against.
        const trustedRoot = await fsp.realpath(storageDir);
        return { storageDir, trustedRoot };
    }

    /**
     * The env dict every Actor container gets, on-demand or standby alike.
     *
     * Mirrors the real platform: `APIFY_IS_AT_HOME=1`, a working API callback
     * URL, real storage ids, and both the legacy `APIFY_`-prefixed and modern
     * unprefixed id vars. `APIFY_TOKEN` is always the owner's fabricated
     * `containerToken` -- never the bound `token` used to authenticate
     * inbound requests, which for local-user may be a real externally-issued
     * secret (see requirements/test.md's anti-leak guarantee).
     * `APIFY_META_ORIGIN` defaults to `API` (every local run arrives through
     * the API, apify-cli included); the standby manager overrides it to
     * `STANDBY`. `APIFY_PROXY_PASSWORD` is included only when
     * `settings.apifyProxyPassword` is non-empty -- otherwise the key is
     * absent entirely, never a placeholder value.
     */
    buildEnvironment({ owner, containerToken, actorId, runId, kvStoreId, datasetId, requestQueueId }) {
        const environment = {
            APIFY_IS_AT_HOME: '1',
            APIFY_META_ORIGIN: 'API',
            APIFY_API_BASE_URL: this.settings.containerApiBaseUrl,
            APIFY_TOKEN: containerToken,
            APIFY_USER_ID: owner,
            APIFY_ACTOR_ID: actorId,
            ACTOR_ID: actorId,
            APIFY_ACTOR_RUN_ID: runId,
            ACTOR_RUN_ID: runId,
            APIFY_DEFAULT_KEY_VALUE_STORE_ID: kvStoreId,
            APIFY_DEFAULT_DATASET_ID: datasetId,
            APIFY_DEFAULT_REQUEST_QUEUE_ID: requestQueueId,
            APIFY_INPUT_KEY: 'INPUT',
            CRAWLEE_STORAGE_DIR: '/apify_storage',
            APIFY_LOCAL_STORAGE_DIR: '/apify_storage',
            ACTOR_STORAGE_DIR: '/apify_storage',
        };
        if (this.settings.apifyProxyPassword) {
            environment.APIFY_PROXY_PASSWORD = this.settings.apifyProxyPassword;
        }
        return environment;
    }

    async #runActor(runId, imageTag, runInput) {
        // The whole body runs inside a guarded block: any unexpected error
        // (bad options, storage prep failure) transitions the run to a
        // terminal FAILED state instead of leaving the row stuck RUNNING.
        try {
            const { storageDir, trustedRoot } = await this.prepareRunStorage(runId, runInput);
            const hostStorageDir = path.join(this.settings.hostRunsDir, runId, 'storage');

            const run = this.db.getRun(runId);
            const timeoutSecs = Number(run.options?.timeoutSecs) || 300;
            const memLimitMb = Number(run.options?.memoryMbytes) || null;
            const actorId = run.actorId;
            const owner = run.username || DEFAULT_USERNAME;
            const { kvStoreId, datasetId, requestQueueId } = run;

            if (!imageTag) {
                this.finishRun(runId, {
                    exitCode: 1,
                    log: `${logStamp()} No successful build available to run.\n`,
                });
                return;
            }

            const containerToken = this.containerTokenFor(owner);
            const environment = this.buildEnvironment({
                owner,
                containerToken,
                actorId,
                runId,
                kvStoreId,
                datasetId,
                requestQueueId,
            });
            const logSink = this.makeLogSink(runId);
            let result;
            try {
                result = await this.driver.run(
                    imageTag,
                    hostStorageDir,
                    environment,
                    timeoutSecs,
                    this.containerName(runId),
                    memLimitMb,
                    logSink,
                );
            } catch (err) {
                this.finishRun(runId, { exitCode: 1, log: `${logStamp()} RUN ERROR: ${err?.message ?? err}\n` });
                return;
            }

            // Import whatever the Actor wrote into the runtime's storage.
            try {
                await this.storage.importRunStorage(
                    storageDir,
                    kvStoreId,
                    datasetId,
                    requestQueueId,
                    trustedRoot,
                );
            } catch (err) {
                result.log += `\n${logStamp()} STORAGE IMPORT ERROR: ${err?.message ?? err}\n`;
            }
            const status = result.timedOut ? TERMINAL_TIMED_OUT : null;
            this.finishRun(runId, { exitCode: result.exitCode, log: result.log, status });
        } catch (err) {
            // Never leave a run stuck RUNNING.
            this.finishRun(runId, { exitCode: 1, log: `${logStamp()} RUN ERROR: ${err?.message ?? err}\n` });
        }
    }

    finishRun(runId, { exitCode, log, status = null }) {
        try {
            const run = this.db.getRun(runId);
            // Only transition from RUNNING. A terminal status set out-of-band
            // (e.g. ABORTED via abortRun) must not be clobbered by the
            // natural finish path once the container exits.
            if (!run || run.status !== 'RUNNING') return;
            run.exitCode = exitCode;
            run.status = status ?? (exitCode === 0 ? TERMINAL_OK : TERMINAL_FAIL);
            run.log = log;
            run.finishedAt = utcNow();
            this.db.save();
        } finally {
            this.discardLogBuffer(runId);
        }
    }

    getRun(runId, username = null) {
        const run = this.db.getRun(runId);
        if (!run || (username !== null && run.username !== username)) return null;
        return run;
    }

    listRuns(actorId, username = null) {
        return this.db.data.runs
            .map((run, index) => ({ run, index }))
            .filter(
                ({ run }) => run.actorId === actorId && (username === null || run.username === username),
            )
            .sort((a, b) =>
                b.run.startedAt === a.run.startedAt
                    ? b.index - a.index
                    : b.run.startedAt.localeCompare(a.run.startedAt),
            )
            .map(({ run }) => run);
    }

    listRunsForUser(username) {
        return this.db.data.runs
            .map((run, index) => ({ run, index }))
            .filter(({ run }) => run.username === username)
            .sort((a, b) =>
                b.run.startedAt === a.run.startedAt
                    ? b.index - a.index
                    : b.run.startedAt.localeCompare(a.run.startedAt),
            )
            .map(({ run }) => run);
    }

    async abortRun(runId, username = null) {
        // A quick peek: only used to learn whether this run is a standby run
        // (and its actorId), so we know whether the per-actor standby lock
        // below is needed at all -- ordinary runs are unaffected and need no
        // lock. Both fields are fixed for a run's whole lifetime.
        const probe = this.db.getRun(runId);
        if (!probe || (username !== null && probe.username !== username)) return null;
        const { isStandby, actorId } = probe;

        if (isStandby) {
            // Acquire the SAME per-actor lock ensureStandbyRun()/
            // reapIdleStandbyRuns() use, across the whole check-and-commit,
            // so this abort and a concurrent readiness-timeout/reap teardown
            // are mutually exclusive: whichever happens first commits, and
            // the loser's own already-terminal check no-ops instead of
            // racing it.
            return this.standby.actorLock(actorId).runExclusive(() => this.#abortRunLocked(runId, username));
        }
        return this.#abortRunLocked(runId, username);
    }

    async #abortRunLocked(runId, username) {
        const run = this.db.getRun(runId);
        if (!run || (username !== null && run.username !== username)) return null;
        const wasRunning = run.status === 'RUNNING';
        if (wasRunning) {
            run.status = TERMINAL_ABORTED;
            run.finishedAt = utcNow();
            this.db.save();
        }
        if (wasRunning) {
            if (run.isStandby) {
                // A standby run has no in-flight driver.run() call whose
                // cleanup removes the container, so it needs the full
                // kill+remove reap; its warm-run bookkeeping must also be
                // dropped so the next standbyUrl request starts a fresh
                // container instead of forwarding into this now-dead one.
                await this.standby.teardownAbortedRun(run);
            } else {
                // Actually stop the container so it stops consuming
                // resources; the in-flight task's finishRun is now a no-op
                // (status != RUNNING), so the ABORTED state set above
                // survives the container's natural exit.
                try {
                    await this.driver.stop(this.containerName(runId));
                } catch {
                    // best effort
                }
            }
        }
        return run;
    }

    // -- standby (thin delegators, see src/standby.js) ----------------------
    async ensureStandbyRun(actorId) {
        return this.standby.ensureStandbyRun(actorId);
    }

    markStandbyRequestStarted(actorId) {
        this.standby.markStandbyRequestStarted(actorId);
    }

    markStandbyRequestFinished(actorId) {
        this.standby.markStandbyRequestFinished(actorId);
    }

    async reapIdleStandbyRuns() {
        return this.standby.reapIdleStandbyRuns();
    }

    startStandbyWatchdog(intervalSecs = 0.5) {
        this.standby.startStandbyWatchdog(intervalSecs);
    }

    stopStandbyWatchdog() {
        this.standby.stopStandbyWatchdog();
    }

    // -- storage ownership & sharing (thin delegators) -----------------------
    getStorage(storageId) {
        return this.storageAccess.getStorage(storageId);
    }

    ensureStorage(storageId, storageType, owner) {
        return this.storageAccess.ensureStorage(storageId, storageType, owner);
    }

    getOrCreateNamedStorage(name, storageType, owner) {
        return this.storageAccess.getOrCreateNamedStorage(name, storageType, owner);
    }

    checkStorageAccess(storageId, username, need, expectedType = null) {
        return this.storageAccess.checkStorageAccess(storageId, username, need, expectedType);
    }

    grantAccess(storageId, resourceType, grantee, level) {
        this.storageAccess.grantAccess(storageId, resourceType, grantee, level);
    }

    listAccess(storageId) {
        return this.storageAccess.listAccess(storageId);
    }

    revokeAccess(storageId, grantee) {
        return this.storageAccess.revokeAccess(storageId, grantee);
    }

    listStoragesForUser(username, type = null) {
        return this.storageAccess.listStoragesForUser(username, type);
    }

    async deleteStorage(storageId, username) {
        return this.storageAccess.deleteStorage(storageId, username);
    }
}

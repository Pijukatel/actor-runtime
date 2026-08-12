/**
 * Metadata persistence for users, Actors, versions, builds, runs, storages
 * and access rights.
 *
 * A deliberately simple JSON-file-backed store: all records live in memory
 * (plain objects in arrays) and every mutation is flushed to `meta.json`
 * with an atomic write (temp file + rename). This keeps the runtime's
 * metadata as file-based as its crawlee storage backend, with no SQL engine
 * or migrations -- appropriate for a single-process local dev tool. Node's
 * single-threaded execution makes each read-modify-write helper below
 * naturally atomic with respect to other requests (no awaits inside them).
 */
import fs from 'node:fs';
import path from 'node:path';

import { utcNow } from './constants.js';

const COLLECTIONS = ['users', 'actors', 'versions', 'builds', 'runs', 'storages', 'accessRights'];

export class Database {
    constructor(filePath) {
        this.filePath = filePath;
        this.data = Object.fromEntries(COLLECTIONS.map((name) => [name, []]));
        this.#load();
    }

    #load() {
        let raw;
        try {
            raw = fs.readFileSync(this.filePath, 'utf8');
        } catch {
            return; // no file yet -- fresh database
        }
        let parsed;
        try {
            parsed = JSON.parse(raw);
        } catch {
            // A corrupt metadata file is unrecoverable data either way; start
            // fresh rather than refusing to boot, but keep the corrupt file
            // aside for inspection.
            try {
                fs.renameSync(this.filePath, `${this.filePath}.corrupt`);
            } catch {
                // best effort
            }
            return;
        }
        for (const name of COLLECTIONS) {
            if (Array.isArray(parsed[name])) {
                this.data[name] = parsed[name];
            }
        }
    }

    /** Atomically flush the in-memory state to disk (temp file + rename). */
    save() {
        const tmp = path.join(
            path.dirname(this.filePath),
            `.${path.basename(this.filePath)}.tmp`,
        );
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        fs.writeFileSync(tmp, JSON.stringify(this.data));
        fs.renameSync(tmp, this.filePath);
    }

    // -- users ---------------------------------------------------------------
    getUser(username) {
        return this.data.users.find((u) => u.username === username) ?? null;
    }

    findUserByAnyToken(token) {
        return (
            this.data.users.find((u) => u.token === token || u.containerToken === token) ?? null
        );
    }

    findUserByToken(token) {
        return this.data.users.find((u) => u.token === token) ?? null;
    }

    addUser({ username, token = null, containerToken = null }) {
        const user = { username, token, containerToken, createdAt: utcNow() };
        this.data.users.push(user);
        this.save();
        return user;
    }

    // -- actors / versions ----------------------------------------------------
    getActor(actorId) {
        return this.data.actors.find((a) => a.id === actorId) ?? null;
    }

    getVersion(actorId, versionNumber) {
        return (
            this.data.versions.find(
                (v) => v.actorId === actorId && v.versionNumber === versionNumber,
            ) ?? null
        );
    }

    // -- builds / runs ---------------------------------------------------------
    getBuild(buildId) {
        return this.data.builds.find((b) => b.id === buildId) ?? null;
    }

    getRun(runId) {
        return this.data.runs.find((r) => r.id === runId) ?? null;
    }

    // -- storages / access rights ----------------------------------------------
    getStorage(storageId) {
        return this.data.storages.find((st) => st.id === storageId) ?? null;
    }

    getAccessRight(resourceId, grantee) {
        return (
            this.data.accessRights.find(
                (ar) => ar.resourceId === resourceId && ar.grantee === grantee,
            ) ?? null
        );
    }
}

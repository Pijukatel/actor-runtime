/**
 * Dependency-free leaf constants and helpers shared across the service layer.
 *
 * Kept in their own module (no imports from `./service.js`, `./standby.js`, or
 * `./storage-access.js`) so those modules can import them without creating
 * circular imports.
 */
import { randomUUID } from 'node:crypto';

export const TERMINAL_OK = 'SUCCEEDED';
export const TERMINAL_FAIL = 'FAILED';
export const TERMINAL_ABORTED = 'ABORTED';
export const TERMINAL_TIMED_OUT = 'TIMED-OUT';

export const TERMINAL_STATUSES = new Set([
    TERMINAL_OK,
    TERMINAL_FAIL,
    TERMINAL_ABORTED,
    TERMINAL_TIMED_OUT,
]);

export const STORAGE_KV = 'key-value-store';
export const STORAGE_DS = 'dataset';
export const STORAGE_RQ = 'request-queue';

// Ids minted by `startRun` for a run's default storages. These are internal to
// their run: never auto-created by an absent-write, and never surfaced in (or
// deletable through) the standalone top-level Storages view.
export const RUN_STORAGE_PREFIXES = ['kv_', 'ds_', 'rq_'];

export function isRunStorageId(storageId) {
    return RUN_STORAGE_PREFIXES.some((prefix) => storageId.startsWith(prefix));
}

/**
 * Derive a storage's public `name` field from its id and type.
 *
 * Three id shapes exist (see `requirements/api.md` "Top-level storages"): a
 * run-derived id (`kv_/ds_/rq_<runId>`, never contains `~`) has no meaningful
 * name and serializes as `""`; a standalone id is either the unqualified
 * `owner~name` (the first storage type to claim that owner+name), or -- once a
 * *different* type collides on the same owner+name -- the type-qualified
 * `owner~{storageType}~name`. Splitting on the first `~` alone is wrong for
 * the type-qualified shape: it yields `"{storageType}~name"` instead of
 * `"name"`, a string crawlee's own storage-name validation rejects (contains
 * `~`), which would crash any real SDK Actor that opens two storages of
 * different types under the same name. This is the single place every
 * serializer path must derive `name` from, so they never drift apart.
 */
export function storageNameFromId(storageId, storageType) {
    if (!storageId.includes('~')) {
        return '';
    }
    const rest = storageId.split('~').slice(1).join('~');
    const prefix = `${storageType}~`;
    return rest.startsWith(prefix) ? rest.slice(prefix.length) : rest;
}

export function shortId() {
    return randomUUID().replaceAll('-', '').slice(0, 17);
}

/**
 * UTC timestamp string in this runtime's canonical shape
 * (`YYYY-MM-DDTHH:MM:SS.mmmZ`), used for every persisted metadata timestamp.
 */
export function utcNow() {
    return new Date().toISOString();
}

/**
 * UTC timestamp prefix for runtime-written log lines.
 *
 * Container output gets per-line RFC3339Nano timestamps from Docker itself
 * (`timestamps: true`); this millisecond-precision variant of the same shape
 * is for the lines the runtime writes into a log on its own (RUN ERROR,
 * standby teardown notes, ...), so every `run.log` line starts with a
 * timestamp regardless of who wrote it.
 */
export function logStamp() {
    return new Date().toISOString();
}

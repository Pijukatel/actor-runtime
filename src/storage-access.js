/**
 * Storage ownership and access-rights: create-if-missing, owner/grant-based
 * authorization decisions, and sharing (grant/list/revoke).
 *
 * A self-contained, cohesive unit -- storage ownership/sharing decisions --
 * coupled to the rest of the app only through the `Service` instance it is
 * constructed with. `Service` keeps a thin delegation surface so routes and
 * tests keep going through `Service`.
 */
import { STORAGE_DS, STORAGE_KV, STORAGE_RQ, shortId, storageNameFromId, utcNow } from './constants.js';

export const LEVEL_READ = 'READ';
export const LEVEL_WRITE = 'WRITE';

export const ACCESS_ALLOW = 'allow';
export const ACCESS_NOT_FOUND = 'not_found';
export const ACCESS_FORBIDDEN = 'forbidden';
export const ACCESS_ABSENT = 'absent'; // no storage row exists for this id

// Mirrors crawlee's own client-side storage-name validation regex EXACTLY
// (letters, digits, and a hyphen -- but a hyphen only strictly BETWEEN two
// alphanumerics, never leading or trailing) -- the same constraint the real
// Apify API enforces server-side on dataset/KVS/RQ names. See
// `validateStorageName` for why this runtime must also enforce it
// server-side, not rely on crawlee's client-side check alone.
export const NAME_REGEX = /^([a-zA-Z0-9]|[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9])$/;

/**
 * A caller-supplied storage `name` (the create-storage query/body param, or
 * the presumptive name embedded in a write-auto-created namespaced id) fails
 * the platform's naming rule (see NAME_REGEX).
 *
 * Matters specifically because a name containing `~` -- the very separator
 * this runtime's own id-qualification scheme (unqualified `owner~name`,
 * type-qualified `owner~{type}~name`) uses to keep same-named
 * different-typed storages apart -- could otherwise deterministically collide
 * with another storage's literal id. A real SDK Actor can never trigger this
 * through the by-name create routes (crawlee validates storage names
 * client-side before ever sending one over the wire), but a raw HTTP caller
 * could -- either directly, or by writing to an absent, caller-chosen
 * namespaced id.
 */
export class InvalidStorageNameError extends Error {}

/**
 * `getOrCreateNamedStorage` resolved `name` to an id whose existing row is
 * not `storageType` -- defence in depth, kept for when that should be
 * structurally impossible. Once `validateStorageName` rejects every
 * `~`-containing name, neither the unqualified nor the type-qualified id can
 * collide with a DIFFERENT, validly-named storage's id, so this should never
 * actually throw in normal operation. It exists so a violation of that
 * invariant (pre-existing `~`-containing data written before validation
 * existed, or a future bug) fails loudly with a clear cause instead of
 * silently handing back an id that does not hold the type the caller asked
 * for.
 */
export class StorageTypeCollisionError extends Error {
    constructor(storageId, actualType, requestedType) {
        super(
            `Storage id '${storageId}' already exists as a '${actualType}' storage, ` +
            `not the requested '${requestedType}'.`,
        );
    }
}

/**
 * Reject a storage `name` that does not match NAME_REGEX.
 *
 * Two call sites, both validating a caller-influenced `name` before it can
 * be baked into a storage id: `getOrCreateNamedStorage` (the user-supplied
 * `name` param every named-storage create route funnels through) and the
 * storages routes' `canAutocreate` (the presumptive `name` embedded in any
 * namespaced id a write may auto-create). Never applied to a run-derived id
 * or a bare, non-namespaced id (no `~` at all, so there is no presumptive
 * name to extract).
 */
export function validateStorageName(name) {
    if (!NAME_REGEX.test(name)) {
        throw new InvalidStorageNameError(
            `Invalid storage name "${name}". Name can only contain letters "a" through "z", ` +
            `the digits "0" through "9", and the hyphen ("-") but only in the middle of the ` +
            `string (e.g. "my-value-1").`,
        );
    }
}

/**
 * Owner/grant-based access decisions and sharing for first-class storages.
 *
 * Constructed once by `Service`'s constructor; reaches the DB and the
 * physical storage backend through `this.service`. All metadata reads and
 * writes are synchronous over the in-memory JSON store, so each
 * read-decide-create sequence below is naturally atomic -- no per-(owner,
 * name) locks are needed the way the SQL-backed predecessor needed them.
 */
export class StorageAccessManager {
    constructor(service) {
        this.service = service;
    }

    get #db() {
        return this.service.db;
    }

    getStorage(storageId) {
        return this.#db.getStorage(storageId);
    }

    /**
     * Create-if-missing a first-class storage record; return its actual
     * owner. The `storages` collection is the single source of truth about
     * who owns the id.
     *
     * Type-blind by design: it creates/reads exactly the given `storageId`
     * and never inspects an existing row's type. That is safe for its two
     * call sites (the storages routes' absent-write auto-create, keyed on a
     * literal id named by the URL path; and the type-qualified id
     * `getOrCreateNamedStorage` has already computed) but NOT safe to call
     * directly with a caller-chosen, not-yet-type-qualified id derived from
     * a user-supplied name.
     */
    ensureStorage(storageId, storageType, owner) {
        const existing = this.#db.getStorage(storageId);
        if (existing) return existing.owner;
        this.#db.data.storages.push({ id: storageId, type: storageType, owner, createdAt: utcNow() });
        this.#db.save();
        return owner;
    }

    /**
     * Atomic get-or-create for a user-named storage; returns
     * `{storageId, actualOwner, created}`.
     *
     * The returned id is normally `owner~name`. Two *different* storage
     * types sharing the same owner+name would otherwise collide on that same
     * unqualified id (the `storages` collection has one row per id,
     * regardless of type) -- so whichever type claims the unqualified id
     * first keeps it; every other type sharing that owner+name gets its own
     * deterministic, type-qualified id (`owner~{storageType}~name`), so a KV
     * store and a dataset (etc.) can coexist under an identical name.
     *
     * `name` is validated before anything else: a caller-chosen name
     * containing `~` could deterministically -- no race needed -- make the
     * qualified-id scheme collide with an unrelated storage's literal id.
     * Even so, after re-fetching at the type-qualified id, its type is
     * checked before declaring success (`StorageTypeCollisionError` if it
     * disagrees) -- pure defence in depth.
     *
     * The whole read-decide-create sequence runs synchronously over the
     * in-memory store (no awaits), so concurrent requests cannot interleave
     * inside it -- the TOCTOU window the SQL-backed predecessor had to lock
     * against does not exist here.
     */
    getOrCreateNamedStorage(name, storageType, owner) {
        validateStorageName(name);
        let storageId = `${owner}~${name}`;
        let existing = this.getStorage(storageId);
        if (existing && existing.type !== storageType) {
            storageId = `${owner}~${storageType}~${name}`;
            existing = this.getStorage(storageId);
        }
        if (existing) {
            if (existing.type !== storageType) {
                throw new StorageTypeCollisionError(storageId, existing.type, storageType);
            }
            return { storageId, actualOwner: existing.owner, created: false };
        }
        this.ensureStorage(storageId, storageType, owner);
        return { storageId, actualOwner: owner, created: true };
    }

    /**
     * Decide access for `username` against `storageId` at `need` level.
     *
     * owner -> allow; a matching-or-stronger grant -> allow (WRITE satisfies
     * READ); a weaker grant than needed -> forbidden (grantee can see it but
     * may not act); no grant at all -> not_found (invisible). A storage id
     * with no row yet -> absent, which the caller resolves by direction (a
     * write auto-creates the storage owned by the writer; a read is a 404).
     *
     * Returns `{decision, storage}`: the row this method already read to
     * make the decision, alongside the decision itself, so a caller that
     * also needs the row (e.g. a metadata GET building its response body)
     * can reuse it instead of issuing a second, independent read.
     */
    checkStorageAccess(storageId, username, need, expectedType = null) {
        const storage = this.#db.getStorage(storageId);
        if (!storage) return { decision: ACCESS_ABSENT, storage: null };
        // The id exists, but not as the type this endpoint addresses -- as
        // that type it does not exist, so hide it exactly like a missing id.
        if (expectedType !== null && storage.type !== expectedType) {
            return { decision: ACCESS_NOT_FOUND, storage };
        }
        if (storage.owner === username) return { decision: ACCESS_ALLOW, storage };
        const grant = this.#db.getAccessRight(storageId, username);
        if (!grant) return { decision: ACCESS_NOT_FOUND, storage };
        if (grant.level === LEVEL_WRITE || need === LEVEL_READ) {
            return { decision: ACCESS_ALLOW, storage };
        }
        return { decision: ACCESS_FORBIDDEN, storage };
    }

    grantAccess(storageId, resourceType, grantee, level) {
        const existing = this.#db.getAccessRight(storageId, grantee);
        if (existing) {
            existing.level = level;
        } else {
            this.#db.data.accessRights.push({
                id: shortId(),
                resourceType,
                resourceId: storageId,
                grantee,
                level,
            });
        }
        this.#db.save();
    }

    listAccess(storageId) {
        return this.#db.data.accessRights.filter((ar) => ar.resourceId === storageId);
    }

    revokeAccess(storageId, grantee) {
        const index = this.#db.data.accessRights.findIndex(
            (ar) => ar.resourceId === storageId && ar.grantee === grantee,
        );
        if (index === -1) return false;
        this.#db.data.accessRights.splice(index, 1);
        this.#db.save();
        return true;
    }

    listStoragesForUser(username, type = null) {
        return this.#db.data.storages.filter(
            (st) => st.owner === username && (type === null || st.type === type),
        );
    }

    /**
     * Delete an owned storage: its row, its access-rights grants and its
     * data.
     *
     * Returns ACCESS_NOT_FOUND for an unknown id, ACCESS_FORBIDDEN for a
     * storage the caller does not own (the route maps cross-user to 404 to
     * keep existence hidden), or ACCESS_ALLOW on success. Access-right rows
     * are not FK-linked to storages, so matching grants are removed
     * explicitly to avoid dangling shares pointing at a deleted storage.
     *
     * The metadata (row + grants) is the source of truth for listings and
     * isolation, so it is removed authoritatively. The underlying crawlee
     * data is then dropped best-effort: a physical-cleanup failure is logged
     * but does not turn a successful logical delete into a 500 (the storage
     * is already gone from every listing/access path, and an orphaned data
     * blob is invisible and harmless).
     */
    async deleteStorage(storageId, username) {
        const storage = this.#db.getStorage(storageId);
        if (!storage) return ACCESS_NOT_FOUND;
        if (storage.owner !== username) return ACCESS_FORBIDDEN;
        const storageType = storage.type;
        this.#db.data.storages = this.#db.data.storages.filter((st) => st.id !== storageId);
        this.#db.data.accessRights = this.#db.data.accessRights.filter(
            (ar) => ar.resourceId !== storageId,
        );
        this.#db.save();
        try {
            if (storageType === STORAGE_KV) await this.service.storage.kvDrop(storageId);
            else if (storageType === STORAGE_DS) await this.service.storage.datasetDrop(storageId);
            else if (storageType === STORAGE_RQ) await this.service.storage.rqDrop(storageId);
        } catch (err) {
            console.error(`Best-effort data drop failed for storage ${storageId}:`, err);
        }
        return ACCESS_ALLOW;
    }
}

export { storageNameFromId };

# Storage backend

- All storage contents live on disk under the mounted data directory and survive a runtime restart (`system.md`).
- **Nothing is ever purged**: opening or reusing a dataset, key-value store, or request queue never deletes existing data, and no environment variable - whether set on the runtime itself or inside an Actor container - can enable purging.
- **A restart releases dangling request hand-outs immediately**: after a crash-and-restart, requests that were handed out and never resolved become available again at once, with no wall-clock lock expiry to wait out.
- Every runtime resource id is a 17-character Apify-style id. A storage's human-facing display `name` is metadata, settable via `PUT`, and independent of the id the storage is addressed by.

## Request queues

- `GET /head` is a non-consuming peek: it returns upcoming requests without reordering the queue or handing anything out.
- `POST /head/lock` hands requests out; a handed-out request stays unavailable until it is marked handled, reclaimed, or unlocked.
- Requests are also addressable by id (`GET /requests/:requestId`), with the same best-effort, this-process-only visibility as the `GET /requests` listing (see "Known differences" below).
- Peeks and hand-outs never corrupt the queue's ordering, deduplication, in-progress/handled state, or counts.

# Storage objects

- The system stores, in a single storage space, two kinds of objects: internal objects (system- and user-related records required for its own functioning) and user objects (created through the public API by users or their Actors).
- No internal objects can be accessed by the API.

## Internal objects

### Storage metadata

- The system has one internal key-value store called `__STORAGES__` to track all the storages and their metadata:
    - `key` is the id of the storage
    - `value` is the metadata of the storage
        - owner (`userId`)
        - statistics
- The system stores users in dedicated key-value store called `__USERS__`:
    - `key` is the `userId`
    - `value` is the metadata of the user
        - name
        - token
        - proxyPassword (optional)
- The system stores Actors in dedicated key-value store called `__ACTORS__`:
    - `key` is the id of the Actor `actorId`
    - `value` is the metadata of the Actor
        - owner (`userId`)
        - metadata
        - `localDevFolder` - **optional**. Absent means no dev folder has ever been registered for this
          Actor. Set or cleared only through `POST /actor-runtime/dev-folder/:actorId` or the console's
          equivalent form (`api.md`, `console.md`), never as a side effect of any other Actor write, and
          never bumping `modifiedAt` (`actor-driver.md`). Submitting the empty string clears it - the
          field is removed entirely, not stored as an empty string. When present, it is always an
          absolute host path that has passed registration validation (`actor-driver.md`).
        - There is **no `imageWorkingDirectory` field on the Actor record.** It lives on the `BuildRecord`
          instead (`__BUILDS__` below) - build-specific, not Actor-specific: the workdir a run mounts
          against must be the one for the build that run itself resolved, never whichever tag happened to
          build most recently.
        - `localDevFolder`, together with the resolved build's `imageWorkingDirectory`, are **absent (or
          empty) meaning no mount**: a run only adds the dev-folder bind mount when both are present and
          non-empty (`actor-driver.md`).
        - `localDebug` - **optional**. Absent means debug mode has never been turned on (or was
          explicitly cleared) for this Actor. Set or cleared only through
          `POST /actor-runtime/debug/:actorId` or the console's equivalent form (`api.md`, `console.md`),
          never as a side effect of any other Actor write, and never bumping `modifiedAt`
          (`actor-driver.md`). When present: `{ language: "auto" | "node" | "python", port?: number }` -
          `port` absent means "resolve the language's own default port at run start", never a stored
          literal (`actor-driver.md`).
        - Neither `localDevFolder`, `localDebug`, nor any build's `imageWorkingDirectory` is ever exposed
          on the public `/v2` API.
- The system stores Actor runs in dedicated key-value store called `__RUNS__`:
    - `key` is the id of the Actor run `runId`
    - `value` is the metadata of the Actor
        - owner (`userId`)
        - Actor (`actorId`)
        - metadata
        - `localDebug` - **optional**, specific to this one run. Present once this run's own debug plan
          has resolved (`actor-driver.md`'s "Debug mode" section): `{ language: "node" | "python", port:
number }`, both already resolved (never `"auto"`, never absent-meaning-default). Absent for
          every non-debug run, and for a debug run that was refused before a plan could be resolved.
          Never exposed on the emulated `/v2` run object.
- The system stores Actor builds in dedicated key-value store called `__BUILDS__`:
    - `key` is the id of the Actor build (`buildId`)
    - `value` is the metadata of the Actor
        - owner (`userId`)
        - Actor (`actorId`)
        - metadata
        - `imageWorkingDirectory` - **optional**, and specific to this one build. Absent unless this
          particular build succeeded and its own image's working directory could be captured (also
          absent when the captured value was empty or `/`) - never on any other build, and never derived
          from, or copied onto, the Actor record (see `localDevFolder`'s entry above).
- The system stores logs in dedicated key-value store called `__LOGS__`:
    - `key` is the id of the Actor build (`logId`)
    - `value` is the metadata of the Actor
        - owner (`userId`)
        - RunOrBuild (`buildId` or `runId`)
        - metadata
- The system stores all needed files in dedicated key-value store called `__FILES__`:
    - `key` is the id of the file (`fileId`)
    - `value` is the file
    - This key-value store is a flexible collection that can be referred by other internal object that needs to contain a file

### Users

- User can be created only by the system.
- Every API response is a restricted view: it contains only resources owned by the calling user.

# Known differences from the Apify platform

1. **No request-queue locking.** `head/lock` hands a request out but never expires the hand-out;
   `lockSecs`/`lockExpiresAt` are advisory echoes; `PUT /requests/:id/lock` is a no-op;
   `POST /requests/unlock` releases everything this runtime handed out and ignores `clientKey`. A
   request handed to a container that dies is released only by an explicit reclaim or a runtime
   restart (which relinquishes all dangling hand-outs).
2. **`GET /requests` is best-effort.** It lists the requests this runtime _process_ has seen (added,
   peeked via `GET /head`, or handed out), in insertion order; `filter` is ignored; after a restart
   the listing starts empty and refills as requests are touched again. Counts in
   `GET /request-queues/:id` remain authoritative.
3. **Request deletion is unsupported** - `DELETE /requests/:id` and `DELETE /requests/batch` (and their
   `actor-runs/:runId/request-queue/*` aliases) return `501`.
4. **`forefront` is honoured, but not against requests already buffered for hand-out** - a `forefront`
   add lands ahead of everything still in the queue but behind requests the runtime has already
   buffered for `GET /head` / `POST /head/lock`; that buffer holds at most the requested `limit`,
   hard-capped around 1000 entries.
5. **`hadMultipleClients` is always `false`; `stats` fields are zeroed** on every storage type.
   Dataset options `fields`/`omit`/`clean`/`skipHidden`/`skipEmpty`/`unwind` are applied after paging,
   so `total` always counts unfiltered items.
6. One runtime process per data directory; no usage/billing fields.

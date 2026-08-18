# Storage backend

- All persistence lives in Crawlee v4 storages, accessed exclusively through the `Dataset` /
  `KeyValueStore` / `RequestQueue` **frontend classes** of `@crawlee/core`. `FileSystemStorageBackend`
  is registered on the service locator behind those frontends and is never called directly anywhere
  else in the codebase - the only backend-level call in the whole system is `teardown()` at shutdown
  (flushing every open request queue's native state).
- The service-locator bootstrap runs once, at process start, before any storage is opened, in this
  order: a `Configuration` with `purgeOnStart: false` is set first, then the `FileSystemStorageBackend`
  (constructed with `requestQueueAccess: 'single'`), then an explicit `LocalEventManager` that is never
  `.init()`-ed.
    - **`purgeOnStart: false`** is the anti-purge switch: every purge path in Crawlee funnels through
      `purgeDefaultStorages()`, gated on `configuration.purgeOnStart`, and every `Dataset.open` /
      `KeyValueStore.open` / `RequestQueue.open` call this runtime makes passes `onlyPurgeOnce: true`, so
      with the option off the underlying `purge()` is never invoked. Constructor options take priority
      over `CRAWLEE_PURGE_ON_START` in the process environment, so nothing an Actor container or the
      runtime's own environment sets can re-enable purging. This matters specifically because the runtime
      is a long-lived server process, not a one-shot crawl - a run-scoped purge on the wrong storage would
      be silently destructive.
    - **`requestQueueAccess: 'single'`** is correct because this runtime is always the queue's one and
      only direct consumer (see "Request queues" below); it means a crash-and-restart relinquishes any
      dangling in-progress locks immediately rather than waiting for a wall-clock expiry, which is the
      behaviour `'shared'` is for (multiple _processes_ sharing one on-disk queue).
- Every runtime resource id is a 17-character Apify-style id, and each user storage is opened as a
  Crawlee storage **named by that id** (`{ name: id }`) - id-to-storage resolution is then free, and
  the human-facing display `name` (settable via `PUT`) lives only in the `__STORAGES__` registry,
  never in the Crawlee-level storage name.

## Request queues

- Request queues are served entirely from the `RequestQueue` frontend.
- The runtime adds only two thin, runtime-side layers on top of the frontend:
    1. A small **head buffer** per open queue, holding requests pulled out with `fetchNextRequest()` in
       one of two states: _staged_ (so a non-consuming `GET /head` peek can be answered without
       reordering the queue) or _handed out_ (returned by `POST /head/lock`, until marked handled,
       reclaimed, or unlocked).
    2. An in-process **id index** (`requestId -> uniqueKey`), because Crawlee's derived request id
       (`sha256(uniqueKey).base64`, `[+/=]` stripped, sliced to 15 chars) is one-way and the frontend has
       no id-based lookup of its own.
- Neither layer duplicates ordering, dedup, in-progress/handled state, or counts - those stay entirely
  in Crawlee's `RequestQueue`, single-sourced.

# Storage objects

- The system stores:
    - internal objects, that are needed for the functionality of the system.
    - user objects, that are created by public API by the user or user's actor
- The system uses single storage space for:
    - for internal system objects
    - for internal user objects
    - for user data
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
        - localDevFolder
        - imageWorkingDirectory
- The system stores Actor runs in dedicated key-value store called `__RUNS__`:
    - `key` is the id of the Actor run `runId`
    - `value` is the metadata of the Actor
        - owner (`userId`)
        - Actor (`actorId`)
        - metadata
- The system stores Actor builds in dedicated key-value store called `__BUILDS__`:
    - `key` is the id of the Actor build (`buildId`)
    - `value` is the metadata of the Actor
        - owner (`userId`)
        - Actor (`actorId`)
        - metadata
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
- The user data that can be accessed by the API is a restricted view only over the objects belonging to the user.
- The system filters all API responses to only contain user owned resources.

# Known differences from the Apify platform

1. **No request-queue locking.** `head/lock` hands a request out but never expires the hand-out;
   `lockSecs`/`lockExpiresAt` are advisory echoes; `PUT /requests/:id/lock` is a no-op;
   `POST /requests/unlock` releases everything this runtime handed out and ignores `clientKey`. A
   request handed to a container that dies is released only by an explicit reclaim or a runtime
   restart (which relinquishes all dangling locks, via `requestQueueAccess: 'single'`).
2. **`GET /requests` is best-effort.** It lists the requests this runtime _process_ has seen (added,
   staged or handed out), in insertion order; `filter` is ignored; after a restart the listing starts
   empty and refills as requests are touched again. Counts in `GET /request-queues/:id` remain
   authoritative (sourced from `RequestQueue.getInfo()`, not the listing).
3. **Request deletion is unsupported** - `DELETE /requests/:id` and `DELETE /requests/batch` (and their
   `actor-runs/:runId/request-queue/*` aliases) return `501`, because neither the `RequestQueue`
   frontend nor its backend expose a deletion primitive.
4. **`forefront` is honoured by the queue but not against already-staged requests** - a `forefront`
   add lands at the head of the underlying queue but behind whatever is already staged in the runtime's
   head buffer, so the buffer is kept small (topped up only to the requested `limit`, hard-capped
   around 1000 entries).
5. **`hadMultipleClients` is always `false`; `stats` fields are zeroed** on every storage type;
   key-value-store metadata (timestamps) is tracked in the `__STORAGES__` registry rather than derived
   from the storage itself (`KeyValueStore` has no `getInfo()`); dataset `fields`/`omit`/`clean`/
   `skipHidden`/`skipEmpty`/`unwind` are applied by the runtime after paging (the fs dataset backend
   ignores everything but `offset`/`limit`/`desc`), so `total` always counts unfiltered items.
6. One runtime process per data directory; no usage/billing fields.

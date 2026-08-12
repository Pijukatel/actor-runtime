# Storage backend
- The system uses crawlee v4's **default file-system storage backend** as its
  storage backend: `FileSystemStorageBackend` from `@crawlee/fs-storage` (the
  backend `@crawlee/core` creates when none is configured), pinned to
  `4.0.0-beta.118` from the crawlee v4 branch, rooted at `$DATA_DIR/storage/`.
  The native Rust extension (`@crawlee/fs-storage-native`) owns the on-disk
  format and the cursor paging.
- The storage is persistent within the container.
- **Datasets and key-value stores delegate to the crawlee backend directly**
  (`src/storage.js`). **Request queues do not**: crawlee's request-queue
  backend is the CONSUMER side of a crawl
  (`fetchNextRequest`/`markRequestAsHandled`/`reclaimRequest`) and exposes
  none of the server-side protocol this runtime's API needs — list requests,
  per-request get/put/delete, cooperative locks with caller-chosen `lockSecs`,
  unlock-all. (The Python predecessor hit the exact same mismatch and had to
  bypass its crawlee client into raw SQL rows for these operations.) So the
  runtime implements its request-queue store itself (`src/storage.js`'s
  `RequestQueueStore`), over the same file-per-request on-disk layout under
  the same `request_queues/` root, with request ids computed by the same
  SHA-256/base64 hash of `uniqueKey` the Apify SDK computes client-side.
  Locks are in-memory (cooperative and short-lived; a restart releases them —
  the requests themselves persist on disk). This is what lets the runtime
  satisfy `test.md`'s requirement to fetch the request queue, even though the
  `Actor Runtime API` tag referenced by `api.md` does not itself define
  request-queue endpoints (they are added by the local API; see `api.md`).
- Dataset `offset`/`limit` pagination is pushed all the way down to the
  backend's own `getData({offset, limit})`, which already reports
  `total`/`count`/`offset` — the API layer (`api.md`'s "Pagination" section)
  just wires optional query params through to it. Request-queue requests live
  in the runtime's own store above, which has no offset/limit-aware read, so
  their optional `offset`/`limit` slice is computed in JS over the full
  in-memory index (acceptable for this project's dev-tool-sized storages;
  pushing it down into the store is a documented follow-up, not a blocker).
- Key-value-store keys are genuinely pushed down too: the fs backend's own
  `listKeys(exclusiveStartKey=, limit=)` is natively cursor-paged (the native
  extension filters `key > exclusiveStartKey` in ascending key order, applies
  `limit`, and reports `isTruncated`/`nextExclusiveStartKey` itself), so a
  request naming `exclusiveStartKey` and/or `limit` (the cursor-pagination
  path — see `api.md`'s "Pagination" section) is pushed straight through to
  that instead of being sliced from an already-fetched full list:
  `Storage.kvKeysPage()` forwards the cursor and limit to one `listKeys` call
  and relays the backend's own truncation verdict and next cursor. `limit=0`
  is special-cased to return an empty, non-truncated page without probing at
  all (a zero-width window has nothing to truncate). The runtime's own
  `offset`-based console paging — which has no equivalent concept on the
  real API or on the crawlee backend — is untouched and still slices an
  already-fetched full list (`Storage.kvKeys()`, itself now just
  `kvKeysPage()`'s own no-cursor, no-limit case, which internally follows the
  backend's cursor pages to exhaustion) in JS, exactly like RQ
  requests above; the two mechanisms are independent query params on the
  same endpoint (a request naming both treats the cursor as authoritative
  and ignores `offset`).
- The router endpoint on top of `kvKeysPage()` (the keys route /
  `kvKeysCursorEnvelope` in `src/routes/storages.js`) implements the
  cursor-mode item shape and `total`-omission contract described in `api.md`'s
  "Pagination" section (no `total`, a percent-encoded `recordPublicUrl` built
  from the handling request's own origin) — see that section for the
  full rationale. The `offset`-sliced path keeps its `total` (it already
  holds the full list). `recordPublicUrl` itself is attached on EVERY path
  through this endpoint — bare, cursor-mode, and `offset`-sliced alike — via
  one shared helper (`withRecordPublicUrl`), matching the real API's own
  `ListOfKeys`, which always returns it; it is not a
  cursor-mode-only or client-compatibility-only addition.

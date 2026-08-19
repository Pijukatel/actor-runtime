# API specification

- The API is implementing subset of the OpenAPI specification `https://docs.apify.com/api/openapi.json`

# Response envelopes

- Every JSON response wraps its payload as `{ "data": ... }` (apify-client-js unwraps every response
  via its internal `pluckData` and would otherwise hand the CLI/SDK `undefined`).
- Every error response is `{ "error": { "type": "...", "message": "..." } }`. A request for a resource
  id that does not exist (or does not belong to the caller) answers HTTP `404` with error type
  `record-not-found` - apify-client-js keys its "return `undefined` instead of throwing" behaviour off
  that exact type, which `apify push`'s "does this Actor already exist" probe depends on. This applies
  uniformly to every `DELETE` in the Public API list below (Actors/builds/runs, datasets,
  key-value-stores, request queues) - a missing storage id 404s the same way a missing build/run id
  does, verified against `apify-core`'s own `getDatasetById` / `ensureStoreExists` /
  `ensureQueueExists` / `getActorRun` / `getActorBuild`, which all throw `record-not-found` before a
  delete is ever attempted. The one documented exception is deleting a key-value-store _record_ whose
  key does not exist inside an otherwise-existing store: that stays a `204` no-op, matching
  `apify-core`'s S3 delete swallowing a `NotFound` for the key
  (`src/packages/storages-server/src/key_value_store_handler.ts:328-333`).
- `DELETE /v2/actor-builds/:buildId` and `DELETE /v2/actor-runs/:runId` on a **non-terminal** build/run
  are rejected, not aborted-then-deleted: `400` with error type `deleting-unfinished-build` (builds) or
  `cannot-remove-running-run` (runs), matching `apify-core` exactly
  (`src/packages/errors/src/errors/api.ts:217-218`, `src/packages/errors/src/errors/runs.ts:10-15`).
  This also protects the runtime's own driver invariant: deleting the record first would permanently
  strand a running Docker container, since its only stop path (`POST .../abort`) requires the record to
  still resolve, and startup reconciliation only ever considers _existing_ run records.
- Two endpoints are exceptions to the `{data}` envelope:
    - `GET /v2/logs/:buildOrRunId` (and its `actor-builds`/`actor-runs` aliases): the body is plain text,
      never `{data}`-wrapped, matching apify-client-js's `log().get()`.
    - `GET /v2/datasets/:datasetId/items` (and its `actor-runs/:runId/dataset/items` alias): the body is
      a bare JSON array of items, never `{data}`-wrapped, with pagination metadata carried in
      `x-apify-pagination-*` response headers, matching apify-client-js's `_createPaginationList`.
- `*At` timestamp fields are ISO-8601 strings.

# Actor id encoding

- `:actorId` accepts the real id, the plain Actor `name`, or `username~name` (a literal `/` in a
  client-supplied identifier is rewritten to `~` by apify-client-js before the request is sent). This
  is how stock `apify push` finds an existing Actor by name before an id has ever been minted.

# 501 vs 404

- Which endpoints answer `501` (unimplemented spec path) instead of `404` (off-spec path entirely) is
  decided from a vendored, committed table of known Apify API v2 paths - nothing is fetched from
  `docs.apify.com` at runtime. See "Known differences from the Apify platform" in `storage.md` for the
  specific spec paths this runtime answers `501` on by design (request deletion) rather than because
  they are simply unbuilt.

# Public API

- It implements these API paths:
    - Actors
        - v2/actors
        - v2/actors/:actorId
        - v2/actors/:actorId/builds
        - v2/actors/:actorId/builds/default
        - v2/actors/:actorId/runs
        - v2/actors/:actorId/versions
        - v2/actors/:actorId/versions/:versionNumber
    - Builds
        - v2/actor-builds
        - v2/actor-builds/:buildId
        - v2/actor-builds/:buildId/abort
        - v2/actor-builds/:buildId/log
    - Runs
        - v2/actor-runs
        - v2/actor-runs/:runId
        - v2/actor-runs/:runId/abort
        - v2/actor-runs/:runId/log
    - Datasets
        - v2/datasets
        - v2/datasets/:datasetId
        - v2/datasets/:datasetId/items
        - v2/datasets/:datasetId/statistics
    - Key-value stores
        - v2/key-value-stores
        - v2/key-value-stores/:storeId
        - v2/key-value-stores/:storeId/keys
        - v2/key-value-stores/:storeId/records/:recordKey
    - Request queues
        - v2/request-queues
        - v2/request-queues/:queueId
        - v2/request-queues/:queueId/requests/batch
        - v2/request-queues/:queueId/requests
        - v2/request-queues/:queueId/requests/:requestId
        - v2/request-queues/:queueId/requests/:requestId/lock
        - v2/request-queues/:queueId/head
        - v2/request-queues/:queueId/head/lock
        - v2/request-queues/:queueId/requests/unlock
    - Logs
        - v2/logs/:buildOrRunId
    - Users
        - v2/users/me
        - v2/users/:userId
    - Default run storages
        - v2/actor-runs/:runId/dataset
        - v2/actor-runs/:runId/dataset/items
        - v2/actor-runs/:runId/dataset/statistics
        - v2/actor-runs/:runId/key-value-store
        - v2/actor-runs/:runId/key-value-store/keys
        - v2/actor-runs/:runId/key-value-store/records/:recordKey
        - v2/actor-runs/:runId/request-queue
        - v2/actor-runs/:runId/request-queue/requests/batch
        - v2/actor-runs/:runId/request-queue/requests
        - v2/actor-runs/:runId/request-queue/requests/:requestId
        - v2/actor-runs/:runId/request-queue/requests/:requestId/lock
        - v2/actor-runs/:runId/request-queue/head
        - v2/actor-runs/:runId/request-queue/head/lock
        - v2/actor-runs/:runId/request-queue/requests/unlock

- The implemented API paths implement all http methods mandated by the OpenAPI specification, with
  documented exceptions that are real spec paths this runtime deliberately cannot serve and answers
  `501` on instead of implementing:
    - `DELETE .../requests/:requestId` and `DELETE .../requests/batch` (both on
      `v2/request-queues/:queueId/*` and their `actor-runs/:runId/request-queue/*` aliases) - see
      `storage.md`'s "Known differences from the Apify platform".
    - `GET v2/key-value-stores/:storeId/records` (no `:recordKey`) and its
      `v2/actor-runs/:runId/key-value-store/records` alias - on the real platform this downloads every
      record in the store as a zip archive (`apify-core`'s `key_value_stores/records.ts` GET handler,
      mounted at `API_V2_SERVER_ROUTES.KEY_VALUE_STORES.RECORDS`; the `actor-runs` alias reaches the same
      handler through `ACTOR_RUNS.KEY_VALUE_STORE`'s wildcard route). Unrelated to
      `.../records/:recordKey` (single-record read/write/delete) just above, which this runtime does
      implement. Not built here; both paths are in the vendored spec table (`api/spec-table.ts`) as
      `implemented: false` so they answer `501`, not `404`.
- All endpoints from the specification that do not have implementation must return response `501 Not Implemented`
- All endpoints not present in specification must return `404 Not Found` - **except** the
  `/actor-runtime/*` namespace below, which is deliberately outside the Apify spec entirely and is
  never routed through the `501`/`404` classification this rule describes.

# Private API

- Not implemented

## Upstream fallback (opt-in, off by default, all HTTP methods)

- Not implemented

# `/actor-runtime/*` - a deliberately non-Apify, local-only namespace

- Everything under `/actor-runtime/*` is this runtime's own tooling surface, not part of the emulated
  Apify `/v2` API - it exists only because this runtime runs locally, and has no equivalent on the real
  platform. The "every off-spec path returns 404" rule above (and "501 vs 404") applies only to paths
  that are, or resemble, real Apify spec paths; `/actor-runtime/*` is carved out of that rule entirely,
  as a namespace, not as a one-off exception for a single route.
- It is mounted directly on the API app, outside the `v2` router, and registered before the
  `501`/`404` catch-all - so unlike every path under `/v2`, a route here is not classified against the
  vendored Apify spec table at all.
- **`POST /actor-runtime/dev-folder/:actorId`** - registers (or clears) the Actor's local dev folder for
  the bind-mount feature (`actor-driver.md`'s "Bind mount volumes with Actor source code"). `:actorId`
  accepts the same forms as the rest of the API (id, plain name, `username~name`).
    - **Authenticated** the same way as every `/v2` route (`Authorization: Bearer <token>` or `?token=`),
      even though it sits outside the `v2` router and so does not inherit that router's `auth()`
      middleware automatically - it applies its own. Ownership-scoped via the same `resolveOwnedActor`
      lookup `/v2` uses: a caller can only register a dev folder for their own Actor, and a mismatched
      or nonexistent `:actorId` answers `404` with error type `record-not-found`, exactly like the rest
      of the API.
    - **Request body**: a JSON string - `'"/abs/path/to/src"'` to set, `'""'` to clear. Only the literal
      empty string clears; a non-empty string is trimmed and then shape-checked, so a whitespace-only
      body (e.g. `'"   "'`) is rejected as a malformed path, not treated as a clear. This is deliberate,
      not merely convenient: `apify api`'s `--body` flag validates with `JSON.parse` and refuses anything
      that is not valid JSON, so a bare, unquoted path can never reach this route through the documented
      CLI invocation at all. A body that is not valid JSON, or is valid JSON but not a string (a bare
      number, an object, ...), is rejected with `400` / `invalid-request` - never silently coerced or
      stored verbatim.
    - **Response**: on success, `{ data: { localDevFolder, imageWorkingDirectory, mountWillApply } }` -
      the same three values the console detail page shows (`console.md`), doubling as the read-back this
      design has no separate `GET` for.
    - **Error responses**, by rejection reason (`actor-driver.md` has the full validation/classification
      detail):
        - `400` `invalid-request` - the body isn't a JSON string, or the string fails the absolute-path
          shape check.
        - `400` `dev-folder-not-buildable` - the Actor has no build tagged `latest`: either no build has
          ever succeeded, or its only successful build(s) are tagged something else, with no fallback to
          an arbitrary other tag.
        - `400` `dev-folder-path-not-found` - the host-side probe's daemon rejection contained the exact
          "bind source path does not exist" substring.
        - `400` `dev-folder-check-failed` - any other mount-validation-shaped rejection; reported as
          "could not verify", never as "does not exist".
        - `503` `dev-folder-check-unavailable` - Docker itself is unreachable.
        - `500` `internal-error` - the probe's own image is missing (a 404 from the daemon on an image
          that should exist) - an operational fault, not a bad submitted path.
    - These exact codes/types are an implementation choice, not a spec-level commitment the way the
      `/v2` envelope contract is - but the _distinctions themselves_ (does-not-exist vs. could-not-verify,
      build-first vs. bad-path) are load-bearing and must not collapse into one generic error.
    - The documented CLI invocation is
      `apify api POST ../actor-runtime/dev-folder/<actorId> --body '"/abs/path/to/src"'` - the CLI's
      `apify api` escape hatch, whose `../` resolves past its own configured `/v2`-suffixed base URL and
      lands on this route directly, carrying the same bearer token every other `apify` command sends.
- The console's own dev-folder form (`console.md`) does **not** go through this endpoint - it posts to a
  console-local, unauthenticated route on the console's own port, resolving the Actor cross-user by the
  id already in its page URL. Both routes funnel into the same underlying validate-and-persist service
  function, so the two surfaces can never drift apart in behavior, only in how they are reached.

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
- All endpoints not present in specification must return `404 Not Found` - **except** the `/actor-runtime/*`

# Actor runtime API

- `/actor-runtime/*` is API that control specifics function of the local Actor runtime
- **`POST /actor-runtime/dev-folder/:actorId`** - registers (or clears) the Actor's local dev folder for
  the bind-mount feature (`actor-driver.md`). `:actorId` accepts the same forms as the rest of the API
  (id, plain name, `username~name`).
    - **Authenticated** the same way as every `/v2` route, and scoped to the caller's own Actors.
    - **No build-first precondition** - registration works for an Actor that has never been built at all.
    - **Request body**: a JSON string - the absolute path to set, or `""` to clear.
    - **Response**: on success, `{ data: { localDevFolder } }` - the same value the console detail page
      shows (`console.md`), doubling as the read-back this design has no separate `GET` for.
    - **Error responses**, by rejection reason:
        - `400` `invalid-request` - the body isn't a JSON string, or the string isn't a valid absolute
          path.
        - `400` `dev-folder-path-not-found` - the path does not exist on the host.
        - `400` `dev-folder-not-a-directory` - the path exists but is not a directory.
        - `400` `dev-folder-check-failed` - the path could not be verified, for any other reason.
        - `503` `dev-folder-check-unavailable` - Docker itself is unreachable.
        - `500` `internal-error` - an operational fault unrelated to the submitted path.
- The console's own dev-folder form (`console.md`) does **not** go through this endpoint - it posts to a
  console-local, unauthenticated route on the console's own port. Both routes funnel into the same
  underlying validate-and-persist path, so the two surfaces can never drift apart in behavior, only in
  how they are reached.

## Upstream fallback (opt-in, off by default, all HTTP methods)

- Two independent booleans, `fallbackUnimplementedEnabled` and `fallbackNotFoundEnabled`, gate whether a
  request this runtime cannot satisfy locally is instead relayed to the real Apify platform. Both default
  to `false` on a fresh process and neither is persisted anywhere - a restart always brings both back to
  `false`, regardless of how they were last set. Either can be on without the other; all four
  combinations are valid.
- **`GET /actor-runtime/api-fallback`** (also reachable at `/v2/actor-runtime/api-fallback`, like every
  other endpoint in this namespace) returns
  `{ "data": { "fallbackUnimplementedEnabled": <bool>, "fallbackNotFoundEnabled": <bool>, "upstreamBaseUrl": <string> } }`.
  `upstreamBaseUrl` is the platform this runtime would relay to (default `https://api.apify.com`, or the
  value of `APIFY_UPSTREAM_API_BASE_URL` if set) - reported for visibility, but read-only: no request
  body can change it.
- **`POST /actor-runtime/api-fallback`** (same two mounts) accepts a **partial** body - either field, or
  both - and merges it into the existing state, leaving any field the body doesn't mention untouched. The
  response is the same shape `GET` returns, showing the state immediately after the merge.
    - **Authenticated** the same way as every other route in this namespace: no token is `401`
      `user-not-authenticated`, with no state change.
    - **Error responses**: a body that isn't a JSON object (a JSON array, scalar, or `null`), a body
      present but empty (`{}`), a body containing a key other than the two above, or a body where a
      present key's value isn't a boolean, is `400` `invalid-request`, with no state change.
- **Which local outcome each toggle covers** (exhaustive - every other error response is never eligible,
  under any toggle combination):
    - `fallbackUnimplementedEnabled` covers a request whose path/method this runtime does not serve at
      all - either an off-spec path (matches no entry in the vendored spec table, `501 vs 404` above) or a
      spec-known path this runtime hasn't built (the `501` case, same section). From the caller's point of
      view both are "nothing local answers this", so one toggle covers both.
    - `fallbackNotFoundEnabled` covers a request that reaches a route this runtime does serve, but whose
      specific record id doesn't exist locally (`record-not-found`, see "Response envelopes" above).
    - Every other error type - `invalid-request`, `user-not-authenticated`, `cannot-remove-running-run`,
      `deleting-unfinished-build`, any `dev-folder-*` type, `internal-error` - is never relayed, regardless
      of either toggle's state.
- **All HTTP methods are eligible for both toggles, writes included**: a `POST`/`PUT`/`DELETE` that would
  otherwise 404/501 locally is relayed exactly like a `GET` when its toggle is on - and, if the platform
  accepts it, becomes a real write against the caller's real account. This is a deliberate consequence of
  opting in, not an oversight.
- **What a successful relay looks like**: the platform's response status and body are returned to the
  caller unchanged. Response headers are relayed too, minus the standard hop-by-hop set
  (`Connection`, `Keep-Alive`, `Transfer-Encoding`, ...) plus `Content-Encoding`/`Content-Length` (the
  relayed body is re-framed, not streamed through byte-for-byte). `Set-Cookie` is always relayed as one
  header line per cookie the platform set - never merged into one, since a cookie's own value can contain
  a comma. Any other header name the platform repeats is relayed as a single, comma-joined value (the
  standard representation for a repeated header field), not as separate repeated lines. Two markers are
  added: `x-actor-runtime-fallback: <upstreamBaseUrl>` (which platform served it) and
  `x-actor-runtime-fallback-trigger: unimplemented` or `record-not-found` (which toggle let it through).
  Only a final `2xx` counts as successful.
- **Fail-closed guarantee**: anything else - a non-`2xx` response, a timeout, or the platform being
  unreachable - reproduces the exact response the caller would have gotten with both toggles off: the
  original local error, unchanged, with neither marker header present. The platform's own status or body
  is never surfaced to the caller. One attempt is made per request; nothing is retried.
- **Only the caller's own presented token is ever forwarded.** A relayed request's `Authorization` header
  is always the exact bearer token the caller themselves sent on that request - never a different or
  runtime-internal credential, and never sent at all for a request this runtime didn't authenticate.
  Enabling either toggle therefore means the caller's own Apify token reaches the configured
  `upstreamBaseUrl` on every eligible request; this is the risk being opted into.
- **Never enriches a call that already succeeds locally**: a collection/list endpoint (e.g.
  `GET /v2/datasets`) that already returns `200` from local data never consults either toggle and never
  gains platform objects. Fallback only ever resolves an otherwise-failing request; it does not make a
  local listing "complete".
- One line is logged per fallback attempt: a relayed request logs once at the informational level a
  successful relay happened; an abandoned attempt (any fail-closed case above) logs once at the warning
  level, including the platform's status or failure reason. Neither line appears when the relevant
  toggle is off.

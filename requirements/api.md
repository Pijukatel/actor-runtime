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
- Three endpoints are exceptions to the `{data}` envelope:
    - `GET /v2/logs/:buildOrRunId` (and its `actor-builds`/`actor-runs` aliases): the body is plain text,
      never `{data}`-wrapped, matching apify-client-js's `log().get()`.
    - `GET /v2/datasets/:datasetId/items` (and its `actor-runs/:runId/dataset/items` alias): the body is
      a bare JSON array of items, never `{data}`-wrapped, with pagination metadata carried in
      `x-apify-pagination-*` response headers, matching apify-client-js's `_createPaginationList`.
    - `GET /actor-runtime/events/:runId`: a websocket upgrade, not a JSON response at all - see "Actor
      runtime API" below.
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
- **`GET /actor-runtime/events/:runId`** - a websocket upgrade (never `/v2/actor-runtime/*` - reachable
  at exactly this one path, on the same fixed API port, `system.md`), the run's own platform events
  channel: `systemInfo` (`actor-driver.md`'s "Run resource telemetry") once a second, plus a one-off
  `aborting` frame under `?gracefully=` (below). Each frame is a single text message,
  `{"name": "...", "data": {...}}`, matching apify-sdk-js's/apify-sdk-python's own wire contract.
    - **No authentication at all** - a deliberate decision, not an oversight. `:runId` alone is what the
      connecting container can present, and also the only thing the server scopes on: a connection is
      subscribed only to _that run's own_ frames, and there is no broadcast/all-runs listener anywhere for
      a mis-scoped subscription to land in - per-run isolation is structural, not a permission check.
    - An unknown run id, or a run already in a terminal state, still gets a completed upgrade (never a
      non-101 HTTP status such as `401`) - the socket is then closed immediately with code `1008` and a
      descriptive reason. Completing the upgrade rather than refusing it matters because
      apify-sdk-python's event manager treats a failed first connection _attempt_ as fatal (raises out of
      `Actor.init()`); a post-upgrade `1008` instead leaves the Actor running (one error logged, no
      further reconnect attempt - `1008`/`POLICY_VIOLATION` is in its own non-retryable close-code set).
    - A connection to a live run stays open and receives frames until the run reaches a terminal state
      (including via either an immediate or a graceful abort), at which point the server closes it with
      code `1000`. The server never drops a healthy, still-live connection for any other reason - the JS
      SDK's own event manager has no client-side reconnect, so a server-initiated drop would permanently
      end that run's telemetry.
    - `persistState` is never sent over this channel, under any circumstance - both SDKs' own base event
      managers already generate it locally on their own timer; a second, server-originated one would
      double-fire it.

## Graceful abort (`?gracefully=`)

- `POST /actor-runs/:runId/abort` (and its `/v2` form) accepts an optional `?gracefully=` query
  parameter, parsed the same way every other boolean query parameter in this API is (`queryBoolean`),
  mirroring `apify-core`'s own abort route's parameter name and default.
- **Omitted, or `false`:** byte-for-byte identical to the endpoint's behavior without this parameter -
  the container is stopped immediately, no frame is sent on any open events socket, and there is no
  added wait.
- **`true`, and the run is currently `RUNNING` (a container actually exists):** the record still moves to
  `ABORTING` immediately (observable via the run's own status right away, well before anything below
  elapses); a best-effort `{"name": "aborting", "data": {}}` frame - a literal empty object, matching
  apify-sdk-js's own event-name doc table and crawlee-python's zero-field `EventAbortingData` - is
  published on that run's events socket (a no-op, not an error, if nobody is currently connected); then a
  fixed `30000ms` wall-clock window elapses before the container is actually stopped and the record
  finalized `ABORTED`. The window matches the real platform's own number (apify-sdk-python's
  `Actor.abort(gracefully=True)` docstring: force-stop after 30 seconds). `persistState` is never sent as
  part of this - see the events endpoint above.
- **`true`, but the run is not currently `RUNNING`** (e.g. still `READY`, no container created yet, or
  already terminal): behaves exactly as if `gracefully` had been omitted - there is no container for an
  `aborting` frame's SDK-side handler to react to, and no reason to hold the caller's request open for 30
  seconds against nothing running.
- A graceful abort's HTTP response is held open for the full window in the worst case (the response _is_
  the finalized record) - the longest any request in this API is held open, and a deliberate one, since
  it is opt-in and matches the real platform's own worst case.

## Upstream fallback (opt-in, off by default, all HTTP methods)

- Two independent booleans, `fallbackUnimplementedEnabled` and `fallbackNotFoundEnabled`, gate whether
  a request this runtime cannot satisfy locally is instead relayed to the real Apify platform. Both
  default to `false`, and a restart always brings both back to `false`, regardless of how they were
  last set. Either can be on without the other; all four combinations are valid.
- **`GET /actor-runtime/api-fallback`** (also reachable at `/v2/actor-runtime/api-fallback`, like every
  other endpoint in this namespace) returns
  `{ "data": { "fallbackUnimplementedEnabled": <bool>, "fallbackNotFoundEnabled": <bool>, "upstreamBaseUrl": <string> } }`.
  `upstreamBaseUrl` is the platform this runtime would relay to (default `https://api.apify.com`, or the
  value of `APIFY_UPSTREAM_API_BASE_URL` if set) - reported for visibility, but read-only: no request
  body can change it.
- **`POST /actor-runtime/api-fallback`** (same two mounts) accepts a body naming either field, or both;
  a field the body doesn't mention keeps its current value. The response is the same shape `GET`
  returns, showing the state immediately after the change.
    - **Authenticated** the same way as every other route in this namespace: no token is `401`
      `user-not-authenticated`, with no state change.
    - **Error responses**: a body that isn't a JSON object (a JSON array, scalar, or `null`), a body
      present but empty (`{}`), a body containing a key other than the two above, or a body where a
      present key's value isn't a boolean, is `400` `invalid-request`, with no state change.
- **Which local outcome each toggle covers** (exhaustive - every other error response is never
  eligible, under any toggle combination):
    - `fallbackUnimplementedEnabled` covers a request the runtime does not serve at all: a local `404`
      or `501` response (see "501 vs 404" above). From the caller's point of view both mean "nothing
      local answers this", so one toggle covers both.
    - `fallbackNotFoundEnabled` covers a request that reaches a route this runtime does serve, but
      whose specific record id doesn't exist locally (`record-not-found`, see "Response envelopes"
      above).
    - Every other error type - `invalid-request`, `user-not-authenticated`,
      `cannot-remove-running-run`, `deleting-unfinished-build`, any `dev-folder-*` type,
      `internal-error` - is never relayed, regardless of either toggle's state.
- **All HTTP methods are eligible for both toggles, writes included**: a `POST`/`PUT`/`DELETE` that
  would otherwise 404/501 locally is relayed exactly like a `GET` when its toggle is on - and, if the
  platform accepts it, becomes a real write against the caller's real account. This is a deliberate
  consequence of opting in, not an oversight. An eligible request reaches the platform at most once, so
  a relayed write is never duplicated.
- **A successful relay** returns the platform's response status and body to the caller unchanged,
  marked with two response headers: `x-actor-runtime-fallback: <upstreamBaseUrl>` naming which platform
  served it, and `x-actor-runtime-fallback-trigger: unimplemented` or `record-not-found` naming which
  toggle let it through. Only a final `2xx` status counts as successful.
- **Fail-closed guarantee**: anything else - a non-`2xx` response, a timeout, or the platform being
  unreachable - reproduces the exact response the caller would have gotten with both toggles off: the
  original local error, unchanged, with neither marker header present. The platform's own status or
  body is never surfaced to the caller.
- **Only the caller's own presented token is ever forwarded.** A relayed request's `Authorization`
  header is always the exact bearer token the caller themselves sent on that request - never a
  different or runtime-internal credential, and never sent at all for a request this runtime didn't
  authenticate. Enabling either toggle therefore means the caller's own Apify token reaches the
  configured `upstreamBaseUrl` on every eligible request; this is the risk being opted into.
- **Never enriches a call that already succeeds locally**: a collection/list endpoint (e.g.
  `GET /v2/datasets`) that already returns `200` from local data never consults either toggle and never
  gains platform objects. Fallback only ever resolves an otherwise-failing request; it does not make a
  local listing "complete".

# API specification

- The API implements a subset of the OpenAPI specification `https://docs.apify.com/api/openapi.json`

# Response envelopes

- Every JSON response wraps its payload as `{ "data": ... }` - apify-client-js unwraps every response
  and would otherwise hand the CLI/SDK `undefined`.
- Every error response is `{ "error": { "type": "...", "message": "..." } }`. A request for a resource
  id that does not exist (or does not belong to the caller) answers HTTP `404` with error type
  `record-not-found` - the exact type apify-client-js keys its "return `undefined` instead of
  throwing" behaviour off, which `apify push`'s "does this Actor already exist" probe depends on. This
  applies uniformly to every `DELETE` in the Public API list below (Actors/builds/runs, datasets,
  key-value-stores, request queues), matching the Apify platform. The one documented exception:
  deleting a key-value-store _record_ whose key does not exist inside an otherwise-existing store is a
  `204` no-op, matching the platform.
- `DELETE /v2/actor-builds/:buildId` and `DELETE /v2/actor-runs/:runId` on a **non-terminal** build/run
  are rejected, not aborted-then-deleted: `400` with error type `deleting-unfinished-build` (builds) or
  `cannot-remove-running-run` (runs), matching the Apify platform.
- Three endpoints are exceptions to the `{data}` envelope:
    - `GET /v2/logs/:buildOrRunId` (and its `actor-builds`/`actor-runs` aliases): the body is plain text,
      never `{data}`-wrapped, matching apify-client-js's `log().get()`.
    - `GET /v2/datasets/:datasetId/items` (and its `actor-runs/:runId/dataset/items` alias): the body is
      a bare JSON array of items, never `{data}`-wrapped, with pagination metadata carried in
      `x-apify-pagination-*` response headers, matching apify-client-js's pagination handling.
    - `GET /actor-runtime/events/:runId`: a websocket upgrade, not a JSON response at all - see "Actor
      runtime API" below.
- `*At` timestamp fields are ISO-8601 strings.
- Log content matches the Apify platform's log format: every log line starts with an ISO-8601 UTC
  timestamp with millisecond precision followed by a space (`2026-08-31T09:13:25.123Z `), exactly one
  timestamp per line regardless of how the output was chunked when produced. Apify clients' log
  redirection (e.g. `Actor.call` in the SDKs) relies on this prefix to recognize log messages.

# Actor id encoding

- `:actorId` accepts the real id, the plain Actor `name`, or `username~name` (a literal `/` in a
  client-supplied identifier is rewritten to `~` by apify-client-js before the request is sent). This
  is how stock `apify push` finds an existing Actor by name before an id has ever been minted.

# 501 vs 404

- Which endpoints answer `501` (unimplemented spec path) instead of `404` (off-spec path entirely) is
  decided from a fixed, built-in list of known Apify API v2 spec paths - nothing is fetched from
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
        - v2/actor-runs/:runId/reboot
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
      record in the store as a zip archive. Unrelated to `.../records/:recordKey` (single-record
      read/write/delete) just above, which this runtime does implement. Both paths answer `501`, not
      `404`.
- All endpoints from the specification that do not have implementation must return response `501 Not Implemented`
- All endpoints not present in specification must return `404 Not Found` - **except** the `/actor-runtime/*`

# Actor runtime API

- `/actor-runtime/*` is the API controlling functions specific to the local Actor runtime
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
  console-local, unauthenticated route on the console's own port - but the two surfaces accept and
  reject exactly the same inputs with the same outcomes.
- **`GET /actor-runtime/events/:runId`** - a websocket upgrade, reachable at exactly this one path on
  the fixed API port (`system.md`). It carries the run's platform events: `systemInfo` once a second
  (`actor-driver.md`), a one-off `aborting`-plus-`persistState` pair under `?gracefully=` (below), and a
  one-off `migrating` frame when a migration is triggered ("Migration emulation" below). Each frame is a
  single text message, `{"name": "...", "data": {...}}`.
    - The endpoint has no authentication. The run id in the path is the only thing it scopes on, and a
      connection only ever receives that run's own frames; one run never sees another's.
    - An unknown or already-terminal run id gets a completed upgrade followed immediately by a `1008`
      close with a reason, never a non-101 HTTP status - the Python SDK treats a refused first connection
      as fatal to the Actor.
    - A connection to a live run stays open until the run ends, when the server closes it with `1000`. It
      is never dropped while healthy, except that a graceful runtime shutdown terminates every open
      connection along with the rest of the server. A migration/reboot restart is not the run ending: the
      restarted container reconnects to the same path.
    - The _periodic_ `persistState` is never sent over this channel; both SDKs generate it themselves.
      The server sends `persistState` exactly once per graceful abort, alongside `aborting` (matching the
      platform), and never alongside `migrating` (the SDKs synthesize that one).

## Graceful abort (`?gracefully=`)

- `POST /v2/actor-runs/:runId/abort` accepts an optional `?gracefully=` boolean.
- Omitted or `false`: the run aborts immediately.
- `true` on a running run: the record moves to `ABORTING` at once, an `aborting` frame plus a
  `persistState {"isMigrating": false}` frame (in that order, matching the platform) are published on
  the run's events channel, and the container is stopped 30 seconds later. The request stays open until
  then.
- `true` on a run with no container (still `READY`, or already terminal): behaves as if omitted.
- A second abort arriving during an open window: another `?gracefully=true` joins that window and neither
  restarts it nor stops the container early; a non-graceful one escalates and stops the container at once.

## Migration emulation (`POST /actor-runtime/migrate/:runId`) and reboot

A platform migration is not a run status: the run stays `RUNNING` while its container is killed and a
new one starts for the same run - same run id, env vars, and default storages, in-memory state gone.
This runtime emulates that observable experience on demand:

- **`POST /actor-runtime/migrate/:runId`** (also at `/v2/actor-runtime/migrate/:runId`) - authenticated
  like the rest of this namespace, scoped to the caller's own runs. The console's run detail view
  exposes the same trigger as a Migrate button (`console.md`).
    - Publishes a `migrating` frame (empty payload) on the run's events channel immediately, stops the
      container 5 seconds later (the platform promises only "a few seconds"), then restarts the same
      run. Status stays `RUNNING`; `startedAt`, `finishedAt`, `exitCode`, the default storage ids, and
      the container env are unchanged. `stats.migrationCount` increments once per performed stop.
    - Responds immediately with the run object (same shape as `abort`/`reboot`). A second call during
      the open window joins it: same response, no second frame or window.
    - Errors: unknown/foreign run `404` `record-not-found`; finished run `403` `job-finished`;
      `READY`/`ABORTING` `400` `invalid-request`.
    - The timeout budget is per run, not per container: a restarted container gets only the remaining
      `timeoutSecs`.
    - An abort (graceful or hard) landing during the window or restart wins: the run ends `ABORTED`,
      never restarted.
- **`POST /v2/actor-runs/:runId/reboot`** - the real platform endpoint the SDKs call from their default
  `migrating` handler. Stops and restarts the run's container immediately (no warning frame), cancels an
  open migration window, and increments `stats.rebootCount`. A finished run is `403` `job-finished`; a
  non-terminal run with no container (`READY`, `ABORTING`) gets the count bump but no restart.
- The run object's `stats` carries `migrationCount`, `rebootCount`, `restartCount`, and `resurrectCount`
  (the latter two always `0` here), initialized to `0` at run creation like the platform.
- The run's log is cumulative across restarts, with a one-line marker between the incarnations' output.

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

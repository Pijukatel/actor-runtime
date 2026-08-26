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
- Four endpoints are exceptions to the `{data}` envelope:
    - `GET /v2/logs/:buildOrRunId` (and its `actor-builds`/`actor-runs` aliases): the body is plain text,
      never `{data}`-wrapped, matching apify-client-js's `log().get()`.
    - `GET /v2/datasets/:datasetId/items` (and its `actor-runs/:runId/dataset/items` alias): the body is
      a bare JSON array of items, never `{data}`-wrapped, with pagination metadata carried in
      `x-apify-pagination-*` response headers, matching apify-client-js's `_createPaginationList`.
    - `GET /actor-runtime/events/:runId`: a websocket upgrade, not a JSON response at all - see "Actor
      runtime API" below.
    - `POST /v2/actor-runs/:runId/charge`: a successful response body is raw `{}` on HTTP `201`, never
      `{data}`-wrapped - matching the real platform and apify-client-js's `run().charge()` byte for byte
      (see "Run cost estimation and PPE charging" under "Public API" below). Its error responses still use the ordinary
      `{error: {type, message}}` shape.
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
        - v2/actor-runs/:runId/charge
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

## Run cost estimation and PPE charging

- `GET /v2/actor-runs/:runId` and the list form `GET /v2/actor-runs` no longer return an empty,
  hard-coded `stats` object. `stats` is exactly apify-core's `ActorJobPublishedStats` allow-list -
  `inputBodyLen`,
  `migrationCount`, `rebootCount`, `restartCount`, `resurrectCount`, `durationMillis`, `runTimeSecs`,
  `metamorph`, `computeUnits`, `memAvgBytes`, `memMaxBytes`, `memCurrentBytes`, `cpuAvgUsage`,
  `cpuMaxUsage`, `cpuCurrentUsage`, `netRxBytes`, `netTxBytes`, `imageSizeBytes` - every key always
  present, with every field this runtime never measures set to `0` rather than omitted (the same
  convention `storage.md`'s storage `stats` already uses).
    - `computeUnits` is **derived, never accumulated**: `(memoryMbytes / 1024) x (durationMs /
3600000)`, computed at read time from the run's own `startedAt` and `finishedAt` (or `now` for a
      still-`RUNNING` run - its `computeUnits` figure grows on every poll, it is never frozen). This
      applies to any run carrying a `finishedAt` (`SUCCEEDED`, `FAILED`, `ABORTED`, `TIMED-OUT` alike) -
      an aborted run still shows the real compute it used, not a placeholder zero.
    - `memAvgBytes`/`cpuAvgUsage`/`cpuMaxUsage` are the only three fields that cannot be derived after
      the fact; they are snapshotted from the run's own events-channel sample accumulator
      (`actor-driver.md`'s "Run resource telemetry") onto the run record in the same write that sets
      `finishedAt`, so they read `0` for a run that never received a sample (e.g. one that failed before
      its container ever started).
    - `memMaxBytes` is **the run's granted memory limit** (`memoryMbytes x 1 MiB`), not an observed peak:
      this runtime does not sample a true memory high-water mark, so unlike `memAvgBytes` this field is
      always the same fixed value for the run's whole lifetime, not something to read as "the most memory
      it actually used" (same convention as the websocket resource-telemetry payload,
      `actor-driver.md`'s "Run resource telemetry").
    - `memCurrentBytes`/`cpuCurrentUsage` (instantaneous-at-read-time figures apify-core reports for a
      still-`RUNNING` job) and `netRxBytes`/`netTxBytes`/`imageSizeBytes`/`inputBodyLen`/
      `migrationCount`/`rebootCount`/`restartCount`/`resurrectCount`/`metamorph` are always `0` -
      genuinely unmeasured by this runtime.
- `usage`/`usageUsd` are `Partial<Record<"ACTOR_COMPUTE_UNITS" | "PAID_ACTORS_PER_EVENT", number>>`,
  computed at read time from persisted counters x a local price table (mirroring apify-core's own
  `CHARGEABLE_SERVICE_PRICING`: `ACTOR_COMPUTE_UNITS` at `$0.20`/CU, `PAID_ACTORS_PER_EVENT` at `$1` per
  USD-denominated unit) - **never stored**, so a charge landing after the run's terminal transition is
  still reflected on the next `GET`.
    - `ACTOR_COMPUTE_UNITS` is always present on any run carrying a `finishedAt`.
    - `PAID_ACTORS_PER_EVENT` (and `eventUsage`, `pricingInfo`, `chargedEventCounts` below) are present
      **only** for a PPE run (one whose owning Actor had pricing declared when it started) - absent
      entirely, never zeroed, for a plain run.
    - No `PROXY_SERPS`/`PROXY_RESIDENTIAL_TRANSFER_GBYTES`/`PROXY_UNBLOCKER_UNITS` key is ever emitted,
      zeroed or otherwise - proxy cost estimation is out of scope; this runtime cannot meter real proxy
      traffic locally (containers reach the real `proxy.apify.com` directly), and a fabricated number
      would assert something false. No `DATASET_*`/`KEY_VALUE_STORE_*`/`REQUEST_QUEUE_*` storage-usage
      key is emitted either - storage resource cost is likewise out of scope (`storage.md`).
    - Deliberate deviation from apify-core: there, an Actor's own owner is never billed for that Actor's
      events. This runtime always shows and sums PPE cost regardless of ownership, since the local user
      is always both author and renter of their own Actor - zeroing it here would zero PPE cost on every
      single local run.
- `eventUsage` (PPE runs only) breaks the PPE total down per event name: `{ "<eventName>": { eventTitle,
eventTotalUsd }, ... }`.
- `usageTotalUsd` is `usageUsd.ACTOR_COMPUTE_UNITS + (usageUsd.PAID_ACTORS_PER_EVENT ?? 0)`.
- `pricingInfo` (the run's own snapshot - see "Actor runtime API" below) and `chargedEventCounts` (see
  below) appear together, only on a PPE run.
- `options.maxTotalChargeUsd` echoes whatever value was supplied at run start (the `?maxTotalChargeUsd=`
  query param `apify-client` sends), or is absent when none was supplied. **It is not enforced
  server-side** - mirroring the real platform exactly, where the cap is enforced client-side by the
  SDK's `ChargingManager` (which deliberately overcharges by one event so the _platform_ terminates the
  run). Nothing in this runtime aborts or otherwise penalizes a run for exceeding its cap; the charge
  route below stays free of any run-lifecycle side effect.

### `POST /v2/actor-runs/:runId/charge`

- **Request**: body `{ eventName: string, count?: number }` (`count` defaults to `1`, matching
  apify-client-js); required header `idempotency-key`.
- **Response**: on success, HTTP `201` with a **raw `{}` body** - not the usual `{data: ...}` envelope
  (see "Response envelopes" above) - byte-identical to the real platform and to what apify-client-js's
  `run().charge()` itself sends/expects.
- **Authorization**: the same "owned record" check every other `/v2/actor-runs/:runId/*` route uses
  (`getOwnedRun`) - a run that doesn't exist, or belongs to someone else, is `404` `record-not-found`,
  **unless** `eventName` is `apify-`-prefixed, in which case that check (below) fires first and the
  answer is `405` regardless of whether the run exists. This is the one deliberate deviation from
  apify-core, which instead only allows the run's own run-scoped token to charge itself: this runtime
  hands the container the run owner's _own_ `APIFY_TOKEN` rather than minting a separate run-scoped
  identity, so there is no narrower token to check against.
- **Effect**: increments `chargedEventCounts[eventName]` by `count` and appends an entry to an
  idempotency audit log, all inside one atomic read-modify-write - concurrent charges on the same run
  are serialized, never racing. The audit log (`chargeLog`) is capped at 1000 entries (oldest evicted
  first) and is **never** exposed on any `/v2` response.
- **Idempotency**: replaying the identical `idempotency-key` on the same run any number of times is a
  no-op after the first application - `chargedEventCounts` is unaffected by a replay. This is
  file-backed (not an in-memory/Redis TTL), so it survives a runtime restart - a documented improvement
  over the real platform's 180-second Redis idempotency window. A replay of a key old enough to have
  been evicted from the 1000-entry log would double-charge; this is still stricter than the real
  platform's own window.
- **Errors**:
    - `404` `record-not-found` - the run doesn't exist/isn't owned by the caller, **or** `eventName`
      isn't a key in the run's own `pricingInfo.pricingPerEvent.actorChargeEvents` (an undeclared
      event).
    - `405` `cannot-charge-non-pay-per-event-actor` - the run's owning Actor has no PPE pricing declared
      at all (no `pricingInfo`, or a `pricingModel` other than `PAY_PER_EVENT`).
    - `405` `cannot-charge-apify-event` - `eventName` starts with the reserved `apify-` prefix (matching
      apify-core's own guard, `run_charging_service.ts:566-569` - checked before the run is even looked
      up here too, ahead of the `404`/other `405` above).
    - `400` `invalid-request` - a missing/malformed `idempotency-key` header, a missing/empty
      `eventName`, or a `count` that is not an integer in `[1, 10000000]` (matching apify-core's own
      `assertInteger(count, { min: 1, max: 10000000 })`, `run_charge.ts:23-24`).
- This is exactly the HTTP contract both official SDKs' `Actor.charge()` calls against
  (`apify-client`'s `run(id).charge({eventName, count})`, `POST` to this same path, same header, same
  body) - an unmodified SDK Actor run against this runtime with `pricingInfo` correctly declared
  beforehand charges successfully with no code changes and no shim.

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
- **`POST|GET /actor-runtime/pricing/:actorId`** - declares (or clears/reads back) the Actor's
  pay-per-event (PPE) pricing. Exactly one mechanism: there is no `.actor/pay_per_event.json` (or any
  other Actor-source-file) reading or fallback anywhere in this runtime - this endpoint is the only way
  PPE pricing is ever set. `:actorId` accepts the same forms as the rest of the API.
    - **Authenticated** the same way as every `/v2` route, and scoped to the caller's own Actors.
    - **`POST` request body**: a JSON object with just `{ pricingModel: "PAY_PER_EVENT",
pricingPerEvent: { actorChargeEvents: { "<eventName>": { eventTitle, eventDescription,
eventPriceUsd }, ... } } }` - or the JSON string `""` to clear, matching the dev-folder endpoint's
      clear convention exactly. `eventDescription` is required (not optional) on every event definition -
      mirroring apify-core's own pricing-info shape and the Python `apify` SDK's stricter parsing of it
      (below); a declaration omitting it is rejected as `400 invalid-request`, not silently accepted with
      a blank description.
    - **`createdAt`/`startedAt`/`apifyMarginPercentage` are stamped server-side**, never read from the
      request body: `createdAt`/`startedAt` are both set to the moment of declaration (this runtime has
      no future-dated/delayed-effect declaration window, so a declaration always takes effect
      immediately), and `apifyMarginPercentage` is fixed at `0.2` - apify-core's own real default for the
      `PAY_PER_EVENT` pricing model. A full `PricingInfo` (declared fields plus these three stamped ones)
      is what both the `POST`/`GET` response and the run's own snapshot (below) carry.
    - **`POST` response**: on success, `{ data: { pricingInfo } }` - `pricingInfo` is `null` when
      cleared/never declared. Doubles as the read-back the same way the dev-folder endpoint's response
      does.
    - **`GET` response**: `{ data: { pricingInfo } }`, same shape - reads the Actor's currently declared
      pricing without changing anything.
    - **Error responses**: `404` `record-not-found` for an unknown/not-owned Actor id; `400`
      `invalid-request` for a body that is neither `""` nor a well-shaped declaration (missing
      `pricingModel: "PAY_PER_EVENT"`, a non-object `pricingPerEvent.actorChargeEvents`, or an event
      definition missing a non-empty `eventTitle`/`eventDescription` or a non-negative numeric
      `eventPriceUsd`).
    - **Snapshotted onto the run, not resolved live**: the Actor's `pricingInfo` at the moment a run
      starts is copied onto that run's own record (`RunRecord.pricingInfo`) and never re-read afterward.
      Editing an Actor's declared pricing later never retroactively changes an already-started run's
      cost - each run keeps exactly the pricing that was current when it started. The synthetic
      `apify-actor-start` event (when declared) is additionally seeded into that run's
      `chargedEventCounts` at `Math.max(1, Math.floor(memoryMbytes / 1024))` - one charge per full GB of
      granted memory, minimum one - mirroring the real platform's own synthetic start charge; every
      other declared event starts at `0`. `maxTotalChargeUsd` arrives as the `?maxTotalChargeUsd=` query
      param on run start (where `apify-client` already sends it) and is echoed on the run's
      `options.maxTotalChargeUsd` - see "Run cost estimation and PPE charging" under "Public API" above.
- **`GET /actor-runtime/events/:runId`** - a websocket upgrade, reachable at exactly this one path on
  the fixed API port (`system.md`). It carries the run's platform events: `systemInfo` once a second
  (`actor-driver.md`), plus a one-off `aborting` frame under `?gracefully=` (below). Each frame is a
  single text message, `{"name": "...", "data": {...}}`.
    - The endpoint has no authentication. The run id in the path is the only thing it scopes on, and a
      connection only ever receives that run's own frames; one run never sees another's.
    - An unknown or already-terminal run id gets a completed upgrade followed immediately by a `1008`
      close with a reason, never a non-101 HTTP status - the Python SDK treats a refused first connection
      as fatal to the Actor.
    - A connection to a live run stays open until the run ends, when the server closes it with `1000`. It
      is never dropped while healthy, except that a graceful runtime shutdown terminates every open
      connection along with the rest of the server.
    - `persistState` is never sent over this channel; both SDKs generate it themselves.

## Graceful abort (`?gracefully=`)

- `POST /v2/actor-runs/:runId/abort` accepts an optional `?gracefully=` boolean.
- Omitted or `false`: the run aborts immediately, exactly as before this parameter existed.
- `true` on a running run: the record moves to `ABORTING` at once, an `aborting` frame with an empty
  payload is published on the run's events channel, and the container is stopped 30 seconds later. The
  request stays open until then, so it is the longest-held response in this API.
- `true` on a run with no container (still `READY`, or already terminal): behaves as if omitted.
- A second abort arriving during an open window: another `?gracefully=true` joins that window and neither
  restarts it nor stops the container early; a non-graceful one escalates and stops the container at once.

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

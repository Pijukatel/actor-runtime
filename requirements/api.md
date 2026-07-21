# API specification

- The API is a subset of the public Apify OpenAPI specification from
  `https://docs.apify.com/api/openapi.json`.
- The tag **`Actor Runtime API`** (added in the *draft, unmerged* PR
  https://github.com/apify/apify-docs/pull/2521, pinned to commit
  `1c2d459f47edbc696b0a0adf95970ae1d24e15c4`) only covers the **in-run SDK
  callback surface**: start run, run status/control (`/v2/actor-runs/*`),
  key-value store records (`/v2/key-value-stores/*`) and dataset items
  (`/v2/datasets/*`). It defines only a *portion* of the API this system needs -
  it has **no Actor build/push endpoints and no request-queue endpoints**.
- Because the mandatory e2e flow (see `test.md`) requires pushing source, building,
  and fetching the request queue, the local API is a **superset** of that tag. In
  addition to the tag above it implements, from the same public Apify spec:
  - Actor / version / build management (needed for `apify push` + build):
    - `GET /v2/users/me`, `GET /v2/users`, `POST /v2/users`
    - `GET|POST /v2/acts` and `/v2/actors` (list / create Actor; both spellings)
    - `GET|PUT /v2/acts/{actorId}` (get / update Actor)
    - `GET /v2/acts/{actorId}/input-schema` (local addition, not in the public
      spec: resolves the actor's input schema for the console's Input tab, from
      the version behind the actor's most recent successful build, falling back
      to its latest-tagged version when no build exists yet; `data(null)` -- not
      a 404 -- when no schema can be resolved: no schema file, a `TARBALL`
      version, or malformed JSON)
    - `GET /v2/acts/{actorId}/versions/{versionNumber}`,
      `POST /v2/acts/{actorId}/versions`,
      `PUT /v2/acts/{actorId}/versions/{versionNumber}` (upload source; see
      "Version source shapes" below)
    - `GET|POST /v2/acts/{actorId}/builds`, `GET /v2/actor-builds/{buildId}`
    - `GET /v2/logs/{buildId|runId}` (build / run log, one-shot full log)
    - `GET /v2/logs/{buildId|runId}/stream` (live-streamed log, see below)
  - Runs: `POST /v2/acts/{actorId}/runs`, `GET /v2/acts/{actorId}/runs`,
    `GET /v2/actor-runs/{runId}`, `POST /v2/actor-runs/{runId}/abort`
  - Builds can be aborted too: `POST /v2/actor-builds/{buildId}/abort` marks a
    RUNNING build terminal `ABORTED` (a finished build is returned unchanged).
    The underlying `docker build` cannot be cancelled mid-flight; it runs to
    completion in the background, but its finalization respects the aborted
    status (appending its output to the log for the record) and its image is
    discarded.
  - Request queues, the full `apify-client` request-queue surface (single- and
    shared-consumer alike), not just the single-consumer subset:
    `GET /v2/request-queues/{queueId}` (metadata),
    `GET /v2/request-queues/{queueId}/head` (unlocked head read),
    `POST /v2/request-queues/{queueId}/head/lock` (head read + lock),
    `GET /v2/request-queues/{queueId}/requests`
    (list) / `POST .../requests` (single add) /
    `POST .../requests/batch` (batch add) / `DELETE .../requests/batch`
    (batch delete) / `POST .../requests/unlock` (unlock every locked
    request), and per-request
    `GET|PUT|DELETE /v2/request-queues/{queueId}/requests/{requestId}` plus
    `PUT|DELETE .../requests/{requestId}/lock` (prolong / release a lock).
    Request ids are a deterministic hash of `uniqueKey` (matching the
    `apify` SDK's own client-side `unique_key_to_request_id`), not a raw
    row id, so a request resolves to the same id whichever side computed it.
  - Key-value stores also support per-record `DELETE /v2/key-value-stores/{storeId}/records/{key}`
    and `HEAD /v2/key-value-stores/{storeId}/records/{key}` (existence check,
    no body), alongside the existing `GET`/`PUT`.
  - Aggregate per-user listings (local additions, scoped to the acting user):
    `GET /v2/users/me/actors`, `GET /v2/users/me/builds`, `GET /v2/users/me/runs`,
    and the standalone-storage listings
    `GET /v2/users/me/key-value-stores`, `GET /v2/users/me/datasets`,
    `GET /v2/users/me/request-queues` (see "Top-level storages" below)
  - Standalone storage create / delete (local additions; `{type}` is one of
    `key-value-stores`, `datasets`, `request-queues`):
    `POST /v2/{type}` (create-by-name, namespaced `username~name`),
    `DELETE /v2/{type}/{storageId}` (owner-only delete, see below)
  - Storage access rights / sharing (local additions; `{type}` is one of
    `key-value-stores`, `datasets`, `request-queues`):
    `POST /v2/{type}/{storageId}/access-rights` (grant/update a share),
    `GET /v2/{type}/{storageId}/access-rights` (list grantees),
    `DELETE /v2/{type}/{storageId}/access-rights/{grantee}` (revoke)
  - Standby-actor request forwarding (local addition; see "Standby actors"
    below): `{GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS} /v2/actor-standby/{actorId}/{path}`
- Only the endpoints exercised by the mandatory e2e flow are implemented in this
  first draft; full coverage of the `Actor Runtime API` tag is deferred.

## Standby actors

- An Actor opts into standby mode exactly as on the real platform: a pushed
  `.actor/actor.json` containing `"usesStandbyMode": true` (parsed from the
  inline `sourceFiles` of a `SOURCE_FILES` push). An explicit `actorStandby`
  object in the same `POST /v2/acts` / `PUT /v2/acts/{actorId}` request body
  takes precedence over `.actor/actor.json` (matching apify-core), and
  persists until the next call that carries an explicit `actorStandby` field.
  The config mirrors apify-core's `actorStandby`: `isEnabled`,
  `idleTimeoutSecs` (default 300s, minimum 5s), `build`, `memoryMbytes`,
  `shouldPassActorInput`.
- A standby-enabled Actor's serialized object (`GET /v2/acts|actors/{actorId}`)
  exposes a `standbyUrl` field: `{APIFY_API_BASE_URL}/v2/actor-standby/{actorId}`
  — i.e. the runtime's own API, reachable from any Actor container on the
  shared Docker network. A non-standby Actor has no such field at all.
  **`standbyUrl` resolves only from inside another Actor container** on that
  shared network (the hostname it names is not registered anywhere else); a
  host-side caller must instead use
  `http://localhost:<published-api-port>/v2/actor-standby/{actorId}/...` — the
  same path, against the runtime's host-published API port.
- `{method} /v2/actor-standby/{actorId}/{path}` forwards the request to the
  Actor's warm container, starting one (lazily, on first request) if none is
  running yet: it waits for the container to answer a request carrying header
  `x-apify-container-server-readiness-probe` with `200` on `ACTOR_STANDBY_PORT`,
  then forwards method, path, query string, headers and body unchanged —
  including repeated header names in either direction (e.g. multiple `Cookie`
  headers from the caller, multiple `Set-Cookie` headers from the Actor) — and
  streams the response back. A subsequent request while the container is still
  warm reuses it (at most one warm run per Actor). The upstream connection has
  a bounded connect timeout (the container was already proven reachable by the
  readiness probe moments earlier) but an unbounded read/write timeout, so a
  legitimately long-lived or slowly-streamed response is never cut short.
- After `idleTimeoutSecs` with **no forwarded requests** — and never while a
  request is still actively being forwarded, no matter how long a single
  streamed response takes — the runtime stops and removes the container on its
  own and the run reaches a terminal status; no further request is needed to
  trigger this.
- Failure modes are distinguished by status code rather than collapsed into a
  single one: `404` for a genuinely missing thing (unknown/cross-user/
  non-standby actor id, or an actor with no successful build); `503` if the
  container never answers its readiness probe in time, or if it drops the
  connection mid-request after having been ready; `500` if launching the
  container itself fails for an infrastructure reason (e.g. the shared Docker
  network was unavailable at boot) — the build is fine, only the start failed,
  so this is never reported as the same 404 as "no successful build".
- Authorization accepts either a `?token=` query parameter (matching
  apify-core's own standby-URL convention) or the usual bearer header,
  resolved through the same token→user rules as the rest of the API — except a
  request with **no credential at all** is rejected `401` here (unlike the
  rest of the API, which falls back to the default user). Visibility follows
  the same rule as every other Actor endpoint: a cross-user request is `404`,
  identical to an unknown or non-standby actor id — never a silent on-demand
  run as a fallback, and never a container started before authorization
  succeeds.
- Aborting a standby run (`POST /v2/actor-runs/{runId}/abort`) stops and
  removes its container and imports whatever it had written to its default
  key-value store / dataset / request queue up to that point, exactly like an
  idle-timeout teardown does — an explicit abort is a routine way to stop a
  standby Actor (e.g. to push a new build) and must not discard its output.
- A warm (RUNNING) standby run's log is fetched **live from its container**
  by both `GET /v2/logs/{runId}` and its `/stream` variant — a standby run
  has no in-process log buffer, and its log is only persisted to the stored
  run log at teardown (same text plus a closing note), so without the live
  fetch it would read as empty for the run's whole warm lifetime.

## Environment variables in every Actor container (on-demand and standby)

- `APIFY_IS_AT_HOME=1` (mirrors the real platform; an SDK/client instantiated
  in the container reports `isAtHome`/`is_at_home = true`).
- `APIFY_META_ORIGIN` — `API` for ordinary runs (every local run arrives via
  the API, apify-cli included), `STANDBY` for standby-origin runs. This is the
  platform-documented way for a standby-capable Actor to detect which mode it
  was started in and, on a standard start, do its batch work (or exit) instead
  of binding `ACTOR_STANDBY_PORT`, which is only set on standby runs.
- `APIFY_API_BASE_URL` — the runtime's own API, reachable by name from any
  Actor container on the shared Docker network (see "Networking" in
  `actor-driver.md`).
- `APIFY_TOKEN` — the run owner's **`container_token`**: a second,
  runtime-fabricated credential distinct from the owner's bound `token` (the
  credential presented to authenticate inbound requests, which for
  `local-user` may be a real externally-issued secret). `container_token` is
  minted once per user at creation (including the default user, at bootstrap)
  and resolves through the same token→user lookup as the bound `token`, so a
  container's own `APIFY_TOKEN` is itself a working bearer credential against
  the runtime's API (e.g. for an on-demand Actor's standby lookup). It is
  never equal to the owner's bound `token` and is safe to leak (see
  `test.md`'s anti-leak guarantee for the precise, narrower scope of what is
  NOT safe to leak).
- `APIFY_DEFAULT_KEY_VALUE_STORE_ID` / `APIFY_DEFAULT_DATASET_ID` /
  `APIFY_DEFAULT_REQUEST_QUEUE_ID` — the run's real storage ids (as returned by
  the API), not a placeholder.
- `APIFY_ACTOR_ID` / `ACTOR_ID` and `APIFY_ACTOR_RUN_ID` / `ACTOR_RUN_ID` —
  both the legacy `APIFY_`-prefixed and the modern unprefixed spellings, equal
  in value.
- Standby runs additionally get `ACTOR_STANDBY_PORT` (the fixed port the
  Actor's own HTTP server must listen on) and have `timeoutSecs`/`build`/
  `memoryMbytes` forced from the Actor's `actorStandby` config rather than any
  caller-supplied value.

## Version source shapes

- A version create/update (`POST`/`PUT .../versions[...]`) carries the Actor's
  source in **one of two shapes**, selected by the `sourceType` field, matching the
  real Apify API:
  - **`SOURCE_FILES`** (the default): the source is uploaded **inline** as
    `sourceFiles`, a list of `{ name, format: "TEXT"|"BASE64", content }` entries.
    Used by `apify push` for small Actors (see `cli.md`).
  - **`TARBALL`**: the source is uploaded as a zip to a **key-value store record**
    (via the standard `POST /v2/key-value-stores` + `PUT .../records/{key}` path),
    and the version carries a **`tarballUrl`** pointing at that record
    (`.../key-value-stores/{storeId}/records/{key}`). Used by `apify push` for
    larger Actors.
- **Source is replaced wholesale on every push.** Each create/update stores only
  the incoming shape's source and clears the other shape's fields: a
  `SOURCE_FILES` push sets `sourceFiles` and clears `tarballUrl`; a `TARBALL` push
  sets `tarballUrl` and clears `sourceFiles`. The two shapes are never merged, so
  re-pushing an Actor in either mode fully supersedes the previous source — no
  stale source from an earlier push can survive. The serialized version echoes
  `sourceFiles` and, for a `TARBALL` version, `tarballUrl`.
- **The build materializes whichever shape was pushed.** A build of a
  `SOURCE_FILES` version writes the inline files into the build directory; a build
  of a `TARBALL` version reads the zip bytes from the referenced key-value store
  record (using the store id/key parsed from the stored `tarballUrl` verbatim) and
  unzips them into the build directory before the image is built. Zip extraction is
  traversal-safe (absolute and `..`-escaping entry names are rejected; symlink
  entries are not materialized). If the tarball record is missing or its bytes are
  not a valid archive, the build fails loudly (terminal `FAILED` with a clear log
  line) rather than building an empty or stale tree.

## Authentication, ownership and sharing

- **Decoupled identity and credential (placeholder auth).** There is no real
  authentication and no passwords, but **username (identity) and token
  (credential) are separate things**. A user is `{ username, token }`: the
  username is the public identity used everywhere an owner is named (Actor ids
  `username~name`, serialized `userId`/`username`, image tags, storage-id
  namespacing, the container's `APIFY_USER_ID`); the token is a private credential
  used **only** to look up which user is acting. The token is never turned into a
  username and never appears in any id, response body, image tag, storage id or
  container variable.
- **Token -> user resolution.** The `Authorization: Bearer <token>` header that
  `apify-client` always sends selects the acting user:
  - **No token** (absent header) -> the default user `local-user` (preserving the
    original single-user behaviour); an absent header is never rejected.
  - **A token matching a stored user's token** -> that user.
  - **A token matching no user** -> if the default user's credential is still
    unclaimed (no token has ever been presented), the token *bootstraps* the
    default user (it becomes `local-user`'s stored token) and the request acts as
    `local-user`; otherwise the token is **rejected with `401`** in the standard
    envelope `{"error": {"type": "invalid-token", "message": ...}}`. An unknown
    token is never auto-provisioned into a new user.
- **User management.**
  - `GET /v2/users/me` reflects the acting user: its `username`, `id` (= username)
    and `token`.
  - `GET /v2/users` lists every user with `username`, `token` and `createdAt`.
    Tokens are returned in plaintext deliberately — this is the mechanism the
    console uses to reveal and switch users. This endpoint is unguarded and must
    not be assumed safe on a shared network. **It is token-free and has no
    bootstrap side effect**: it never calls the token→user resolver, so presenting
    a bearer token to it (stale, unknown or valid) neither resolves nor claims a
    user. In particular an unknown token sent here is ignored and does **not**
    bootstrap the default user — merely listing users (e.g. a console page load or
    a periodic refresh) can never claim a token. First-token bootstrap happens only
    through the authenticated endpoints that genuinely need identity
    (`GET /v2/users/me` and its `/me/*` aggregates, and all Actor/build/run/storage
    work), whose behaviour is unchanged.
  - `POST /v2/users` with body `{"name": ...}` creates a user whose `username` and
    `token` both equal `name` (the token-equals-name convenience applies only to
    users created this way, never to the default user's bootstrap token). The name
    is restricted to the safe charset `[A-Za-z0-9_.-]` and must include at least one
    letter or digit (it becomes the load-bearing owner segment of `username~name`
    ids and storage-id namespacing, so `~`, `/`, spaces and other characters are
    forbidden, and an all-punctuation name like `..` or `---` is not a valid safe
    name); a non-string, empty, all-punctuation or otherwise invalid name is
    rejected `400 invalid-request` (the name is not silently mutated, since it is
    also the token). A name that collides with an existing user's `username` — or
    with another user's unique `token` — is a `409 resource-conflict`, with a
    message that reflects the actual cause.
- **Per-user ownership.** Every API-created object is owned by the acting user:
  Actors (`id` is `username~name`, so two users may hold identically named Actors),
  Builds, Runs, **and each run's default key-value store, dataset and request
  queue** (created as first-class owned records when the run starts). Standalone
  storages created via `POST /v2/key-value-stores` / `POST /v2/datasets` are owned
  by their creator too, and their id is **namespaced per user** exactly like
  Actors: `POST {"name":"foo"}` returns id `username~foo`, so two users creating
  the same name get distinct, independently-owned storages (never a shared global
  `default`). Clients must use the returned namespaced id for subsequent calls.
  Creating a storage the caller already owns is idempotent (returns it, `200`); an
  id that resolves to another owner's row is a conflict (`409`), never a
  misleading `201` that fails to grant ownership. A write to an absent id only
  ever auto-creates a storage owned by the writer under the writer's own space —
  a write to an absent id in another user's namespace (or a run-derived
  `kv_/ds_/rq_` id) is `404 record-not-found`, so no one can squat an id someone
  else would legitimately be assigned.
- **Isolation.** List endpoints return only the acting user's objects. Fetching or
  mutating another user's Actor/Build/Run/storage by id behaves as if it does not
  exist: **404 `record-not-found`**, identical to a genuinely missing id (existence
  is not leaked).
- **Storage sharing (per storage).** A storage's owner can share an individual
  key-value store, dataset or request queue with another user at one of two levels
  via the access-rights endpoints above:
  - `READ` ("can view") — the grantee can read the storage (metadata, listing,
    records/items/requests) with their own token.
  - `WRITE` ("can view and change") — the grantee can additionally write; `WRITE`
    implies `READ`.
  - Grant body is `{"grantee": "<username>", "level": "READ"|"WRITE"}`; at most one
    grant per `(grantee, storage)`. Re-granting updates the level; revoke removes it.
  - **Owner-only management.** Only the owner may grant, list or revoke; any
    non-owner (including a grantee) attempting management gets **403
    `insufficient-permissions`**. A grantee cannot re-share or escalate.
  - **Response distinction.** A caller with no access reading a storage gets 404
    `record-not-found` (it is invisible). A `READ`-level grantee who attempts a
    write gets **403 `insufficient-permissions`** — observably different from the
    404, because they can see the storage but may not change it. A caller with no
    access attempting a write still gets 404 (they cannot see it at all).

## Live-streamed logs

- `GET /v2/logs/{jobId}/stream` returns the same log as the one-shot
  `GET /v2/logs/{jobId}`, but as a **chunked `text/plain` `StreamingResponse`** that
  tails the job (build or run) live. While the job is in a non-terminal state it
  emits newly-produced output incrementally as the container/build produces it, in
  order; the stream closes once the job reaches a terminal state and its buffered
  output is drained (a client tailing right at the finish still receives the final
  chunk before close).
- For a job that is already terminal (or whose live buffer no longer exists, e.g.
  after a restart), the stream falls back to yielding the **complete stored log**
  once, so opening it for a finished job returns the full log exactly like the
  one-shot endpoint.
- The one-shot `GET /v2/logs/{jobId}` returns a single `PlainTextResponse` of
  the stored log, still valid for finished jobs and any non-streaming consumer
  — except a warm standby run, whose log both endpoints fetch live from its
  container (see the standby section).
- Ownership/isolation matches every other job endpoint: the stream is scoped to the
  acting user; an unknown or cross-user job id is **404**, indistinguishable from a
  missing id.
- The full log is still persisted at terminal exactly as before; streaming is
  additive and never drops or alters the stored log.

## Top-level storages (standalone list / create / delete)

- Every storage (a run's default key-value store / dataset / request queue, and any
  standalone one) is a first-class owned record. Three id shapes exist:
  **standalone** storages are namespaced `username~name`; if a *different* storage
  type later collides with an already-claimed owner+name, it instead gets a
  **type-qualified** id `username~{type}~name` (e.g. `username~key-value-store~name`)
  so the two types coexist under an identical name rather than colliding; **run-derived**
  storages are minted at run start as `kv_/ds_/rq_<runId>` and stay managed with their
  run.
- `GET /v2/users/me/key-value-stores`, `GET /v2/users/me/datasets`,
  `GET /v2/users/me/request-queues` each return **all** of the acting user's owned
  storages of that type in the standard envelope (each item has `id`, `name`
  [derived from the id], `type`, `createdAt`, and `named`). The `name` is the part
  after `~` for a standalone (`username~name`) storage, with any leading
  `{type}~` prefix stripped for a type-qualified id; a **run-derived**
  (`kv_/ds_/rq_<runId>`) storage has **no meaningful name and serializes `name`
  as the empty string `""`** (not its id), since it was never explicitly named.
  Run-derived storages are **included** alongside standalone ones (they also remain
  browsable via their run's detail view). Each item's `named` field is a boolean:
  `true` for a standalone storage, `false` for a run-derived one, so a client can
  tell the two apart from the listing response alone. Each listing is strictly
  scoped to the acting user — another user's storages never appear.
- `POST /v2/{type}` creates a standalone storage by name (namespaced `username~name`,
  idempotent for the owner; a `409` if the id resolves to another owner), for all
  three types.
- `DELETE /v2/{type}/{storageId}` is **owner-only** and performs a hard delete: it
  removes the `Storage` row, deletes every access-rights grant referencing the id
  (there is no FK cascade, so dangling shares are removed explicitly), and drops the
  underlying crawlee data (irreversible). Responses:
  - a cross-user or unknown id → **404 `record-not-found`** (existence is not
    leaked, identical to every other cross-user access);
  - a run-derived id (`kv_/ds_/rq_<runId>`) → **400 `invalid-request`**: it is
    managed with its run and cannot be deleted here (deleting it would orphan the
    run's storage references);
  - success → the standard envelope.

## Storage metadata (single-storage GET responses)

- `GET /v2/key-value-stores/{id}`, `GET /v2/datasets/{id}` and
  `GET /v2/request-queues/{id}` are field-complete, matching every field
  `apify-client`'s own response models require (non-optional, no default):
  `id`, `name`, `userId`, `createdAt`/`modifiedAt`/`accessedAt`, `consoleUrl`,
  plus dataset's `itemCount`/`cleanItemCount` and request-queue's
  `totalRequestCount`/`pendingRequestCount`/`handledRequestCount`/
  `hadMultipleClients`/`stats`. This isn't cosmetic: the `apify` SDK's own
  storage-client metadata models (crawlee's `DatasetMetadata`/
  `KeyValueStoreMetadata`/`RequestQueueMetadata`) re-validate this response on
  every `Actor.open_dataset()`/`Actor.get_input()`/`Actor.open_request_queue()`
  call, so a response missing any of these fields makes that call itself fail.
- `name` is the same value the "Top-level storages" section above describes
  (the part after `~` for a standalone storage, with any `{type}~` prefix
  stripped for a type-qualified one, empty for a run-derived one) — **never
  the raw id verbatim**: crawlee's own storage domain objects
  validate a non-empty `name` against
  `^[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9]$`, and every id this runtime mints
  contains `_` or `~`, so returning the id as `name` would make the very
  first SDK storage-open call raise.
- `consoleUrl` is a synthesized `{apiBaseUrl}/storage/{type}/{id}` URL (the
  runtime never sets a real public console host); `modifiedAt`/`accessedAt`
  are synthesized equal to `createdAt` (no separate modification/access
  tracking exists). `cleanItemCount` mirrors `itemCount` (no separate
  "clean" — non-empty/non-hidden-field — count is tracked).

## Console SPA serving (catch-all)

- The console is a History-API single-page app whose client routes are real paths
  (`/actors...`, `/storage...`, `/users`). So a deep link or a browser refresh to
  one of those paths renders correctly, the app is served by a **catch-all**
  registered **last** (after every `/v2/*` API route and after the explicit `/`,
  `/console`, `/console/app.js` and `/console/input_tab.js` routes): `GET
  /{full_path}` returns the console's `index.html` (HTTP 200) **only** when the
  first path segment is one the SPA owns — an **allowlist** of `actors`,
  `storage`, `users`. The shell is served even when the addressed resource does
  not exist (e.g. `/actors/no-such~actor`); "not found" is a client-side
  concern, not a server 404.
- The catch-all **never shadows the API**: any other unmatched path — including any
  unknown `/v2/...` path — returns a normal **404 `record-not-found`** in the Apify
  error envelope, not `index.html`. Because the catch-all is registered last and only
  matches paths no earlier route claimed, every real `/v2/*` endpoint and the
  literal `/console/app.js` and `/console/input_tab.js` assets keep their
  existing responses unchanged.
- The catch-all is defined once on the shared app instance, so it behaves identically
  on both the API and console ports.

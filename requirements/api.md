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
    - `GET /v2/acts/{actorId}/versions/{versionNumber}`,
      `POST /v2/acts/{actorId}/versions`,
      `PUT /v2/acts/{actorId}/versions/{versionNumber}` (upload source files)
    - `GET|POST /v2/acts/{actorId}/builds`, `GET /v2/actor-builds/{buildId}`
    - `GET /v2/logs/{buildId|runId}` (build / run log)
  - Runs: `POST /v2/acts/{actorId}/runs`, `GET /v2/acts/{actorId}/runs`,
    `GET /v2/actor-runs/{runId}`, `POST /v2/actor-runs/{runId}/abort`
  - Request queues: `GET /v2/request-queues/{queueId}`,
    `GET /v2/request-queues/{queueId}/requests`,
    `POST /v2/request-queues/{queueId}/requests`
  - Aggregate per-user listings (local additions, scoped to the acting user):
    `GET /v2/users/me/actors`, `GET /v2/users/me/builds`, `GET /v2/users/me/runs`
  - Storage access rights / sharing (local additions; `{type}` is one of
    `key-value-stores`, `datasets`, `request-queues`):
    `POST /v2/{type}/{storageId}/access-rights` (grant/update a share),
    `GET /v2/{type}/{storageId}/access-rights` (list grantees),
    `DELETE /v2/{type}/{storageId}/access-rights/{grantee}` (revoke)
- Only the endpoints exercised by the mandatory e2e flow are implemented in this
  first draft; full coverage of the `Actor Runtime API` tag is deferred.

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
    not be assumed safe on a shared network.
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

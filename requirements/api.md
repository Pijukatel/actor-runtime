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
    - `GET /v2/users/me`
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

- **Token -> user (placeholder auth).** There is no real authentication and no
  passwords. The `Authorization: Bearer <token>` header that `apify-client` always
  sends selects the acting user: the token is sanitized into a username and
  auto-provisioned on first use. A request with **no** token maps to the default
  user `local-user`, preserving the original single-user behaviour. Any non-empty
  token is accepted (an unknown token simply means "a new user"); there is no
  401/403 rejection path for unknown tokens.
- `GET /v2/users/me` reflects the acting user (its `username`/`id`), not a fixed
  constant.
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
- **Upgrade caveat.** Ownership adds new tables (`users`, `storages`,
  `access_rights`) and new `username` columns on the builds/runs tables. The
  runtime has no migrations (`create_all()` only creates missing tables, not new
  columns on existing ones), so upgrading an existing `$DATA_DIR` in place is not
  supported — use a fresh `DATA_DIR`.

# Actor build

- The system is capable of building Actor docker image, over the **host Docker socket** (via
  `dockerode`) rather than Docker-in-Docker - this keeps the host's image layer cache available and
  avoids running a nested, privileged Docker daemon.
- A build is produced by building a docker image from the Actor source that was
  pushed to the system.
- Build and run output streams are appended to an in-memory buffer that is flushed periodically into
  `__LOGS__` and fanned out live to any open `GET /v2/logs/:id?stream=true` response.
- **Status state machine**: `READY -> RUNNING -> SUCCEEDED | FAILED | TIMED-OUT | ABORTED`, with
  `RUNNING -> ABORTING -> ABORTED` while a stop is in flight (`ABORTING`/`ABORTED` are also reachable
  directly from `READY` - an abort issued before the build/run ever started).
- `TIMED-OUT` applies to **both** builds and runs apply the same `TIMED_OUT`/`ABORTED` outcomes to both `ACTOR_JOB_TYPES.BUILD`
  and `.RUN` off a `runtime.timeoutAt`deadline.
- a **run's** timeout is caller-configurable (`timeoutSecs` on `POST .../runs`, default **300s** if omitted)
- a **build's** timeout is a fixed internal default **1800s**
- Every write to a build/run's `status` field goes through one guarded transition helper
  (`services/job-status.ts`'s `transitionJobStatus`) that refuses to move a record out of a terminal
  status and only allows the edges drawn above - this is what makes `ABORTED` and `TIMED-OUT` reliable
  in the face of a completion write racing an in-flight abort, rather than a convention every call site has to remember
  to check for itself.
- **Abort and timeout are race-proof.** Both `POST /actor-builds/:id/abort` and
  `POST /actor-runs/:id/abort` move the record to `ABORTING` _before_ asking the driver to interrupt
  anything, then to `ABORTED` - from the moment `ABORTING` lands, the background build/run handler's own
  eventual completion write (whatever status it computes, whenever it lands) is refused by the guard
  above, never overwrites the abort. This also closes the "abort during `READY`" window: the background
  handler re-checks the record immediately before it would create a container / start a build, and if
  it is already `ABORTING`/`ABORTED`, it never starts one and finalises `ABORTED` itself.
- Aborting a **build** is genuine cancellation, not just a status flag: `dockerode`'s `buildImage()` accepts an
  `abortSignal`, which it forwards to Node's `http.request({ signal })` - aborting it destroys the
  in-flight HTTP request to the Docker daemon (verified by reading `docker-modem`'s and `dockerode`'s
  installed source; there is no Docker socket in this sandbox to exercise it against a real daemon, so
  this is covered by stub-driver tests, not an end-to-end one). Aborting a **run** stops the container
  (`container.stop()`, unchanged from before).
- On a successful build, the Actor's `taggedBuilds[<tag>]` is updated with the new build's id and
  number - stock `apify push` polls for exactly this field before returning.
- Actor build details are saved in `__BUILDS__` internal storage
- Actor build log is saved in `__LOGS__` internal storage
- Actor details are saved in `__ACTORS__` internal storage

# Networking

- On startup, the runtime detects its own container id, ensures a Docker network `apify-local`
  exists, and joins it under the fixed DNS alias `apify-api`. Every Actor container is started on that
  same network, so it can reach the runtime's API at `http://apify-api:3333` regardless of the host's
  own networking.

# Actor run

- The system is capable of running containerized Actor
- A run launches the Actor's built image as a container, with the Actor's input and its default
  storages (key-value store, dataset, request queue) wired in **entirely over HTTP** - the run's
  storages are reachable only through `APIFY_API_BASE_URL`.
- Actor run details are saved in `__RUNS__` internal storage
- Actor run log is saved in `__LOGS__` internal storage

# Users

- Users are created adhoc by the runtime for each new token used in the API call (`cli.md`'s User bootstrap).

# Environment variables in every Actor container

- The Actor version's own `envVars` (accepted and stored on `POST`/`PUT
.../actors/:actorId/versions`) are applied to the run's container
  environment. They are merged in first, so every platform-owned var listed
  below always takes precedence: a version cannot override `APIFY_TOKEN`,
  the default storage ids, or any other contract var the runtime itself sets.
- `APIFY_IS_AT_HOME=1` (mirrors the real platform; an SDK/client instantiated
  in the container reports `isAtHome`/`is_at_home = true`).
- `APIFY_META_ORIGIN` — `API` for ordinary runs (every local run arrives via
  the API, apify-cli included)
- `APIFY_API_BASE_URL` — the runtime's own API, reachable by name from any
  Actor container on the shared Docker network (see "Networking" above).
- `APIFY_TOKEN` — the run owner's token
- `APIFY_DEFAULT_KEY_VALUE_STORE_ID` / `APIFY_DEFAULT_DATASET_ID` /
  `APIFY_DEFAULT_REQUEST_QUEUE_ID` — the run's real storage ids (as returned by
  the API)
- `APIFY_ACTOR_ID` / `ACTOR_ID` and `APIFY_ACTOR_RUN_ID` / `ACTOR_RUN_ID` —
  both the legacy `APIFY_`-prefixed and the modern unprefixed spellings, equal
  in value.
- `APIFY_PROXY_PASSWORD` — included when a value is known from either of two sources, in this
  precedence order: (1) the runtime itself was started with `APIFY_PROXY_PASSWORD` set in its own
  environment (see README.md's "Apify Proxy" section) — always wins when set; otherwise (2) the proxy
  password harvested from the real Apify platform the one time the run owner's token successfully
  resolved against it (`cli.md`'s User bootstrap). If neither source has a value, the key is absent entirely — never a 
  placeholder value. One host-level password (source 1)
  or one harvested-per-account password (source 2) used specifically for each user.

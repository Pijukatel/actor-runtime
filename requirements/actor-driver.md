# Actor build
- The system is capable of building Actor docker image
- A build is produced by building a docker image from the Actor source that was
  pushed to the system
- Actor build details are saved in `__BUILDS__` internal storage
- Actor build log is saved in `__LOGS__` internal storage
- Actor details are saved in `__ACTORS__` internal storage

# Actor run
- The system is capable of running containerized Actor
- A run launches the Actor's built image as a container, with the Actor's input
  and its default storages (key-value store, dataset, request queue) wired in
- The Actor container runs as the user defined by its image, which for official
  Apify base images is a non-root user. The system must provision each run's
  storage so that this (possibly non-root) user can write to it, independent of
  the user the runtime itself runs as
- Actor run details are saved in `__RUNS__` internal storage
- Actor run log is saved in `__LOGS__` internal storage

# Users
- Currently only one default user is implemented.

# Environment variables in every Actor container

- `APIFY_IS_AT_HOME=1` (mirrors the real platform; an SDK/client instantiated
  in the container reports `isAtHome`/`is_at_home = true`).
- `APIFY_META_ORIGIN` — `API` for ordinary runs (every local run arrives via
  the API, apify-cli included)
- `APIFY_API_BASE_URL` — the runtime's own API, reachable by name from any
  Actor container on the shared Docker network (see "Networking" in
  `actor-driver.md`).
- `APIFY_TOKEN` — the run owner's token
- `APIFY_DEFAULT_KEY_VALUE_STORE_ID` / `APIFY_DEFAULT_DATASET_ID` /
  `APIFY_DEFAULT_REQUEST_QUEUE_ID` — the run's real storage ids (as returned by
  the API)
- `APIFY_ACTOR_ID` / `ACTOR_ID` and `APIFY_ACTOR_RUN_ID` / `ACTOR_RUN_ID` —
  both the legacy `APIFY_`-prefixed and the modern unprefixed spellings, equal
  in value.
- `APIFY_PROXY_PASSWORD` — included **only when** the runtime itself was
  started with `APIFY_PROXY_PASSWORD` set in its own environment (see
  README.md's "Apify Proxy" section); otherwise the key is absent entirely,
  never a placeholder value. One host-level password, shared unscoped across
  every user's Actor containers — there is no per-user proxy credential.

# Actor build

- The system builds an Actor's docker image over the **host Docker socket** rather than
  Docker-in-Docker, keeping the host's image layer cache available.
- A build is produced by building a docker image from the Actor source that was pushed to the system.
- Build and run output is persisted as the job's log and fanned out live to any open
  `GET /v2/logs/:id?stream=true` response.
- **Status state machine**: `READY -> RUNNING -> SUCCEEDED | FAILED | TIMED-OUT | ABORTED`, with
  `RUNNING -> ABORTING -> ABORTED` while a stop is in flight (`ABORTING`/`ABORTED` are also reachable
  directly from `READY` - an abort issued before the build/run ever started).
- Both builds and runs can end `TIMED-OUT` (timeout deadline reached) or `ABORTED`.
- a **run's** timeout is caller-configurable (`timeoutSecs` on `POST .../runs`, default **300s** if omitted)
- a **build's** timeout is a fixed internal default **1800s**
- **Abort and timeout are race-proof.** A build/run never moves out of a terminal status; only the
  transitions drawn above ever occur. `POST /actor-builds/:id/abort` and `POST /actor-runs/:id/abort`
  move the record to `ABORTING`, then `ABORTED`; once `ABORTING` is set, the job's own eventual
  completion - whatever status it computes, whenever it lands - never overwrites the abort. An abort
  issued while the record is still `READY` means no build or container is ever started; the record
  finalises as `ABORTED`.
- Aborting a **build** genuinely cancels the in-flight Docker build, not just the record's status;
  aborting a **run** stops the run's container.
- On a successful build, the Actor's `taggedBuilds[<tag>]` is updated with the new build's id and
  number - stock `apify push` polls for exactly this field before returning.
- Actor, build, and build-log details are kept in internal records that persist across runtime
  restarts (`storage.md`).
- **The Dockerfile to build is resolved from the Actor's pushed source**, not Docker's implicit default. `.actor/actor.json` is parsed as JSON5; an unparseable file fails the build with a "Could not parse .actor/actor.json" message. Resolution order, stopping at the first hit:
    1. the `dockerfile` field of `.actor/actor.json`, relative to `.actor/` - a path escaping the Actor root fails with "points outside the Actor root directory"; a non-string value fails with `"dockerfile" must be a string`; a value naming no pushed file (including empty) falls through instead of failing.
    2. `.actor/Dockerfile`
    3. `Dockerfile` at the Actor root
    4. the platform's bundled default Dockerfile, for that build only - the pushed source itself is unchanged.
    - Matching is case-insensitive, exact-case wins ties, and every outcome is stated in the build log.

# Bind mount volumes with Actor source code

- To let an Actor be re-run with source changes and no rebuild, the Actor's registered local dev
  folder is bind-mounted over the built image's working directory when the run's container starts:
  edit locally, recompile locally (`tsc`, or the language-appropriate equivalent), `apify call`
  again - no `apify push`/build in between. A running container never picks up a recompile; only the
  next run's container start does. Dependency or environment changes still require a real rebuild.
- `localDevFolder` is **registered explicitly**: the local-only endpoint
  `POST /actor-runtime/dev-folder/:actorId` (`api.md`) or a single-field form on the console's Actor
  detail view (`console.md`) sets or clears it, with identical outcomes for the same input on both
  surfaces.
- Registration validates that the submitted value is an absolute POSIX path and that the path exists
  **on the host** and is a directory.
    - Submitting the **empty string clears the registration** and skips validation.
    - Every non-success outcome is classified: unable to verify at all (e.g. Docker unreachable)
      reports "could not verify" - never "does not exist"; a path confirmed missing reports "path
      does not exist"; a path that exists but is a file reports "path is not a directory"; anything
      else unverifiable reports a generic "could not verify".
- **Registration has no build-first precondition** - it requires no build of the Actor to exist,
  succeeded or otherwise.
- The working directory the mount covers is recorded **per build**, never on the Actor
  (`storage.md`); the mount a run applies always uses the one from _that run's own resolved build_,
  never any other build the Actor happens to have.
- **The mount is applied only when both a registered dev folder and a known working directory exist**
  for the run's resolved build; either missing means the run starts exactly as if the feature did not
  exist.
- The registration status the console and API report is the registered folder alone - never that a
  mount "will apply", since that depends on which build a given run resolves.
- If the registered folder has since been deleted, moved, or made unreadable, the run must **fail
  visibly** - never silently mount an empty directory in its place.
- The Actor image's own installed dependencies (e.g. `node_modules`) must remain available to the Actor
  despite the mount covering the whole working directory.
- **Registering or clearing a dev folder never bumps the Actor's `modifiedAt`.**

# Networking

- On startup, the runtime ensures a Docker network `apify-local` exists and joins it under the fixed
  DNS alias `apify-api`. Every Actor container is started on that network, so it can reach the
  runtime's API at `http://apify-api:3333` regardless of the host's own networking.

# Actor run

- The system runs Actors as containers
- A run launches the Actor's built image as a container, with the Actor's input and its default
  storages (key-value store, dataset, request queue) wired in **entirely over HTTP** - the run's
  storages are reachable only through `APIFY_API_BASE_URL`.
- Run details and the run log are kept in internal records that persist across runtime restarts
  (`storage.md`).

## Resource limits

- Every run's container has a hard memory limit and a hard CPU limit. Memory is the run's `memoryMbytes`;
  CPU is derived from it at the platform's ratio of one core per 4096 MB, so a 1024 MB run gets 0.25 core.
- A derived CPU limit below what Docker accepts is raised to that minimum.
- Limits are applied exactly as requested, even when they exceed the host's own capacity. Such a run is
  warned about in its own log, naming the requested and the host figures; the limits still apply. When the
  host's capacity cannot be determined, no warning is produced.
- Disk is not limited. `diskMbytes` is reported but never enforced.

## Run resource telemetry

- While a run's container is up, its CPU and memory usage are measured once a second and published as
  `systemInfo` events on the run's events channel (`api.md`).
- Every event carries all eight fields - `memAvgBytes`, `memCurrentBytes`, `memMaxBytes`, `cpuAvgUsage`,
  `cpuMaxUsage`, `cpuCurrentUsage`, `isCpuOverloaded`, `createdAt` - or is not published at all. A
  measurement that cannot be read completely is skipped, leaving the run's running figures unaffected.
    - `cpuCurrentUsage` is percent of one CPU core, not of the run's own grant.
    - `memCurrentBytes` and `memAvgBytes` exclude reclaimable page cache, matching what `docker stats`
      reports for the same container.
    - `memMaxBytes` is the run's configured memory limit, constant for its lifetime.
    - `isCpuOverloaded` is true when used cores exceed 95% of the run's granted cores.
    - `memAvgBytes`, `cpuAvgUsage` and `cpuMaxUsage` cover every sample published for that run so far.
- Measurement lasts exactly as long as the container: it starts once the container is running and stops
  before the container is removed, and it never delays a run from reaching a terminal state.
- The bundled sample Actors log their granted resources and each `systemInfo` event they receive, so the
  contract is observable from a single `apify call`.

# Users

- Users are created adhoc by the runtime for each new token used in the API call (`cli.md`'s User bootstrap).

# Environment variables in every Actor container

- The Actor version's own `envVars` (accepted and stored on `POST`/`PUT
.../actors/:actorId/versions`) are applied to the run's container environment, but every
  platform-owned var listed below takes precedence: a version cannot override `APIFY_TOKEN`, the
  default storage ids, or any other contract var the runtime itself sets.
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
- `APIFY_PROXY_PASSWORD` — set when a value is known, from either of two sources in precedence order:
  (1) `APIFY_PROXY_PASSWORD` set in the runtime's own environment (README.md's "Apify Proxy" section) —
  always wins when set; otherwise (2) the proxy password obtained for the run owner's own account during
  User bootstrap (`cli.md`). If neither source has a value, the key is absent entirely — never a
  placeholder.
- `ACTOR_EVENTS_WEBSOCKET_URL` / `APIFY_ACTOR_EVENTS_WS_URL` — the run's own events channel
  (`api.md`), carrying no credential.
- `ACTOR_MEMORY_MBYTES` / `APIFY_MEMORY_MBYTES` — the run's requested `memoryMbytes`.
- `APIFY_DEDICATED_CPUS` — the run's granted CPU cores. No `ACTOR_`-prefixed counterpart; only the
  Python SDK reads it.
- Every `ACTOR_*`/`APIFY_*` pair above is set to an identical value (the two SDKs disagree on which name
  wins).

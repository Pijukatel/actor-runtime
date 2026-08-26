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
- **The Dockerfile to build is resolved from the Actor's pushed source**, not Docker's implicit default. `.actor/actor.json` is parsed as JSON5; an unparseable file fails the build with a "Could not parse .actor/actor.json" message. Resolution order, stopping at the first hit:
    1. the `dockerfile` field of `.actor/actor.json`, relative to `.actor/` - a path escaping the Actor root fails with "points outside the Actor root directory"; a non-string value fails with `"dockerfile" must be a string`; a value naming no pushed file (including empty) falls through instead of failing.
    2. `.actor/Dockerfile`
    3. `Dockerfile` at the Actor root
    4. the platform's bundled default Dockerfile, for that build only - the pushed source itself is unchanged.
    - Matching is case-insensitive, exact-case wins ties, and every outcome is stated in the build log.

# Bind mount volumes with Actor source code

- To enable rapid development of Actors, it is desired to avoid the need to rebuild the Actors for
  every source change. This is achieved by bind mounting the Actor's local development folder over the
  built image's working directory when starting the container - edit locally, recompile locally
  (`tsc`, or the language-appropriate equivalent), `apify call` again, with no `apify push`/build in
  between. A running container never picks up a recompile; only the next run's container start does.
  Dependency or environment changes still require a real rebuild.
- `localDevFolder` is **registered explicitly** on a new local-only endpoint,
  `POST /actor-runtime/dev-folder/:actorId` (see `api.md`), also exposed as a single-field form on the
  console's Actor detail view (`console.md`), sets or clears it. Both surfaces funnel through one
  shared validate-and-persist path, so they can never disagree.
- **Registration validates the path in two layers**, not shape alone:
    1. A cheap shape check: the submitted value must be an absolute POSIX path.
    2. A **host-side existence-and-directory check**. The runtime's own filesystem cannot be trusted to
       judge a host path - it is not necessarily the host's filesystem at all - so this must be verified
       some other way.
    - Submitting the **empty string clears the registration** and never runs either validation layer.
    - Every non-success outcome is classified rather than guessed: being unable to verify the path at
      all (e.g. Docker is unreachable) is reported as "could not verify", never as "does not exist"; a
      path confirmed missing is reported as "path does not exist"; a path that exists but is a file is
      reported as "path is not a directory"; anything else unverifiable is a generic "could not verify".
- **Registration has no build-first precondition.** It requires no build of the Actor's own to exist,
  succeeded or otherwise - the host-side check needs only something host-present to validate against,
  never a build a run would actually use.
- **`imageWorkingDirectory` is captured by the driver itself, right after a successful build, and is
  build-specific, not Actor-specific** - it is persisted on that build's own record (see `storage.md`),
  never on the Actor. The mount a run applies always reads it off _that run's own resolved build_, never
  off any other build the Actor happens to have.
- **The mount is applied only when both a registered dev folder and a known working directory exist**
  for the run's resolved build; either missing means the run starts exactly as if the feature did not
  exist.
- The registration status the console and API report is the registered folder alone - it never claims a
  mount "will apply", since that depends on which build a given run resolves, which an Actor-level status
  has no way to know in advance.
- If the registered folder has since been deleted, moved, or made unreadable, the run must **fail
  visibly** - never silently mount an empty directory in its place.
- The Actor image's own installed dependencies (e.g. `node_modules`) must remain available to the Actor
  despite the mount covering the whole working directory.
- **Registering or clearing a dev folder never bumps the Actor's `modifiedAt`.**

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
- **Persistence**: samples are accumulated in memory only, for the life of the process (lost on a
  restart, same as the `systemInfo` events themselves) - except for three aggregates,
  `memAvgBytes`/`cpuAvgUsage`/`cpuMaxUsage`, which are snapshotted onto the run's own record in the same
  write that sets `finishedAt` when the run reaches a terminal status, and from there are exposed as
  `stats.memAvgBytes`/`stats.cpuAvgUsage`/`stats.cpuMaxUsage` on `GET /v2/actor-runs/:runId` (`api.md`'s
  "Run cost estimation and PPE charging"). A run that never received a sample (e.g. one that failed
  before its container ever started) reports `0` for all three, not a missing field. Every other `stats`
  field on that same response - `computeUnits` in particular - is derived from `startedAt`/`finishedAt`
  x `memoryMbytes` at read time and needs no sampler data at all.

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
- `ACTOR_EVENTS_WEBSOCKET_URL` / `APIFY_ACTOR_EVENTS_WS_URL` — the run's own events channel
  (`api.md`), carrying no credential.
- `ACTOR_MEMORY_MBYTES` / `APIFY_MEMORY_MBYTES` — the run's requested `memoryMbytes`.
- `APIFY_DEDICATED_CPUS` — the run's granted CPU cores. No `ACTOR_`-prefixed counterpart; only the
  Python SDK reads it.
- Every `ACTOR_*`/`APIFY_*` pair above is set to an identical value: the two SDKs disagree on which name
  wins, so a divergent pair would size the same run differently depending on which one reads it.
- **Deliberately NOT set: `APIFY_ACTOR_PRICING_INFO` / `APIFY_CHARGED_ACTOR_EVENT_COUNTS`.** Both SDKs'
  `ChargingManager` read pricing/charge state exactly **once**, at `Actor.init()` - never again for the
  rest of the run (`ChargingManager.init()`/`__aenter__` is the sole caller of
  `fetchPricingInfo()`/`_fetch_pricing_info()`; `charge()` itself never reads the run record at all, it
  only mutates the in-memory charging state built from that one read, then `POST`s). Setting both env
  vars would not change that - a charge issued mid-run is invisible to nothing either way, because
  neither path re-reads. What the two env vars actually gate is _where that single read comes from_: set,
  `fetchPricingInfo()` parses them directly as a frozen snapshot and skips the network call entirely;
  unset (and `APIFY_IS_AT_HOME=1`, which this runtime always sets), it falls through to a real
  `run(id).get()` against `GET /v2/actor-runs/:runId` - the same route, and the same `runDto` shape, any
  other client of this run would see. Leaving both unset is what this runtime does, deliberately: it
  keeps the SDK's one pricing/charge read on the real, already-tested HTTP contract instead of adding a
  second, env-var-shaped serialization of the same `pricingInfo`/`chargedEventCounts`/
  `options.maxTotalChargeUsd` data that this runtime does not currently produce anywhere and would have
  to keep byte-for-byte in sync with `runDto` forever, for no behavioral gain: by the time `Actor.init()`
  runs, nothing has charged the run yet either way, so the values read would be identical.

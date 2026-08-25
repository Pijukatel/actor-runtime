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

- Every run's container carries a hard CPU limit alongside the existing memory limit (`HostConfig.Memory`,
  unchanged): the platform's own ratio, `cores = memoryMbytes / 4096`
  (`docs.apify.com/actors/running/usage-and-resources#cpu`), encoded as `HostConfig.CpuPeriod: 100000` and
  `HostConfig.CpuQuota: round(cores * 100000)` - e.g. `memoryMbytes: 1024` (0.25 core) is
  `CpuPeriod: 100000, CpuQuota: 25000`. The ratio has exactly one home, `services/resources.ts`'s
  `dedicatedCpusFor`/`cpuQuotaFor` - both the driver's `HostConfig` and the `APIFY_DEDICATED_CPUS` env var
  below derive from it, so the container's actual limit and what the Actor is told it got can never drift
  apart.
- **`CpuPeriod`/`CpuQuota`, never `NanoCpus`.** moby's own container-resource validation
  (`verifyPlatformContainerResources`, `daemon/daemon_unix.go`) hard-rejects a `NanoCpus` above the host's
  own CPU count ("Range of CPUs is from 0.01 to N.NN, as there are only N CPUs available"), but validates
  `CpuPeriod`/`CpuQuota` only for range (period 1000-1,000,000us, quota >= 1000us), with no host-capacity
  ceiling - the encoding that keeps "warn, never clamp" (below) actually possible for an over-capacity
  request, rather than turning it into "cannot run at all".
- If the computed quota would fall below Docker's own protocol minimum of 1000us (e.g. `memoryMbytes: 32`
  computes a raw 781.25us), it is raised to 1000us - a floor on the _encoding_, not a host-capacity clamp.
- **Warn, never clamp.** The driver's `init()` snapshots the host's own capacity once, from
  `docker.info()`'s `NCPU`/`MemTotal`. A run whose requested memory and/or derived CPU exceeds that
  snapshot still gets exactly the limits it asked for, applied verbatim to the created container - never a
  substituted, host-capped value for either `Memory` or the CPU fields. Instead, a warning naming both the
  requested and host figures for whichever resource(s) are over capacity, and stating that the limits are
  being applied anyway, is written through the run's own `onLog` callback (so it reaches `apify call`'s
  output, not only this process's own console) before the container is created. A missing or failing
  `docker.info()` (or one that omits `NCPU`/`MemTotal`) means capacity is _unknown_, which produces no
  warning at all - never treated as capacity being zero, which would warn on literally every run.
- **Disk is not limited.** No `HostConfig` disk-quota field is ever set; `diskMbytes` (`services/runs.ts`)
  stays a reported number only, matching the real platform field's presence in the API without this
  system enforcing it - out of scope by design.

## Run resource telemetry

- While a run's container is up, the driver samples that specific container's real CPU and memory once a
  second (`SAMPLE_INTERVAL_MS = 1000`, a fixed cadence, not tunable via env) over the Docker stats API
  (`stats({stream: false, 'one-shot': true})` - one round trip per tick. A plain `stream: false` call
  without `one-shot` would make the daemon wait two collection cycles to fill `precpu_stats`, adding
  roughly one to two seconds to every run's finalization; this sampler instead computes the CPU delta
  against its own previous sample, never against the response's own `precpu_stats`).
- Each sample is shaped into the platform's `systemInfo` envelope and pushed over the events websocket
  (`api.md`), with all eight fields present on every frame: `memAvgBytes`, `memCurrentBytes`,
  `memMaxBytes`, `cpuAvgUsage`, `cpuMaxUsage`, `cpuCurrentUsage`, `isCpuOverloaded`, `createdAt` - never a
  subset (apify-sdk-python's pydantic model declares every field required with no default, so a frame
  missing even one is silently dropped there).
    - `cpuCurrentUsage` is percent of **one** CPU core - the same convention `docker stats` itself uses -
      never percent of the run's own CPU grant.
    - `memMaxBytes` is the container's configured memory **limit** (`memoryMbytes * 1024 * 1024`),
      constant for the run's whole lifetime - never a genuinely observed peak, despite the field's name.
    - `isCpuOverloaded` is `usedCores / grantedCores > 0.95` (strict `>`, not `>=`), where `usedCores` is
      that same sample's `cpuCurrentUsage / 100` and `grantedCores` is the run's own
      `dedicatedCpusFor(memoryMbytes)` - a ratio-only test, with no CFS-throttling term.
    - `memAvgBytes`/`cpuAvgUsage`/`cpuMaxUsage` are running figures accumulated over every sample published
      for that run so far (this one included).
- The sampler's own lifetime is bounded by the container's: started right after `container.start()`,
  stopped (and awaited) in the same `finally` block that owns container removal, strictly _before_
  `container.remove()` is called - a stats call is never issued after the sampler has been asked to stop,
  and removal never races a still-in-flight stats call, the same class of cross-connection ordering hazard
  `LOG_DRAIN_GRACE_MS` already guards against for the log stream.
- The sampler measures only; it never writes to a run's status or log - shaping the raw sample into the
  wire envelope, and fanning it out to whoever is connected, is the events channel's job
  (`services/events-channel.ts`).

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
- `ACTOR_EVENTS_WEBSOCKET_URL` / `APIFY_ACTOR_EVENTS_WS_URL` — the run's own events-websocket URL,
  `ws://apify-api:3333/actor-runtime/events/<runId>` (`api.md`) — no `token` or any other query
  parameter, since that endpoint carries no authentication at all; the run id in the path is the only
  per-run element there is, and also the only thing the endpoint scopes on.
- `ACTOR_MEMORY_MBYTES` / `APIFY_MEMORY_MBYTES` — the run's own requested `memoryMbytes`.
- `APIFY_DEDICATED_CPUS` — `memoryMbytes / 4096` (`dedicatedCpusFor`, the same ratio the CPU limit above
  is encoded from) — no `ACTOR_`-prefixed counterpart: apify-sdk-js's `ENV_MAP` has no dedicated-CPU key
  at all; this exists solely so apify-sdk-python stops dividing its own CPU-overload ratio by an assumed
  `1` full core.
- **Every `ACTOR_*`/`APIFY_*` pair above is set byte-identical, deliberately** — apify-sdk-js's `ENV_MAP`
  and pydantic's `AliasChoices` resolve which of the two names wins, when both are set, in _opposite_
  precedence order; letting the pair ever diverge would size a run differently depending on which SDK
  happens to read it.

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
  between. Node does not hot-reload a running process, so the recompiled output is picked up by the
  **next run's container start**, not inside an already-running container - this matches the runtime
  exactly, since it creates a fresh container per run.
- `localDevFolder` is **registered explicitly**, not learned automatically from a build: a new
  local-only endpoint, `POST /actor-runtime/dev-folder/:actorId` (see `api.md`), also exposed as a
  single-field form on the console's Actor detail view (`console.md`), sets or clears it. Both surfaces
  funnel through one shared validate-and-persist service function. This is a deliberate correction of
  this section's original phrasing ("when building an Actor, get the location...") - nothing on the
  wire between `apify push` and this runtime ever carries a host filesystem path, so there is no
  build-time signal to "get" it from; the developer supplies it out-of-band, once, after their first
  successful push+build.
- **Registration requires a prior successful build.** The registration path verifies the candidate
  folder against the Actor's own latest successfully-built image (see below), so an Actor with no
  successful build at all is rejected with a clear error at registration time, telling the developer to
  build first - never a silent accept with nothing to check against.
- **Registration validates the path in two layers**, not shape alone:
    1. A cheap shape pre-filter: the submitted value must be an absolute POSIX path, contain no newline
       or NUL byte, and stay under a length cap. A leading `~` is never expanded - this runtime never
       shells out to interpret one.
    2. A **host-side existence check**. The runtime process's own filesystem is not the host's (this
       runtime always runs containerized itself, talking to the _host_ Docker socket - `fs.existsSync`
       here would test the wrong filesystem entirely). The only Docker Engine API surface that validates
       an arbitrary host path at all is the mount-validation the daemon runs inside `POST
/containers/create`, so the check is a **create-only probe container, never started**: a container
       is created with a single `Mounts` entry (`Type: 'bind'`, the candidate path as `Source`, read-only)
       against the Actor's own latest successfully-built image; success removes it immediately without
       ever calling `.start()`, and a rejection means creation itself failed, so there is nothing to clean
       up either way.
    - Submitting the **empty string clears the registration** and never runs either validation layer -
      there is no path to check, and clearing must always succeed, including when Docker itself is
      unreachable.
    - Errors are classified by shape, most specific first, and every non-success branch rejects rather
      than guessing: no HTTP response at all (Docker itself unreachable) is reported as "could not verify
        - Docker is unreachable", never as "does not exist"; the probe's own image returning 404 is an
          operational fault ("could not verify - internal error"), not a bad path; a mount-validation
          rejection whose message contains the exact substring `bind source path does not exist` is the one
          case reported as "path does not exist"; every other mount-validation-shaped rejection (not a
          directory, a permission error, Docker Desktop's file-sharing denial, or anything unrecognized) is
          reported as a generic "could not verify this path" - never a false "does not exist".
- **`imageWorkingDirectory` is captured by the driver itself**, right after a successful build:
  `docker.getImage(imageId).inspect()` over `dockerode`, reading `.Config.WorkingDir`, then persisted to
  `__ACTORS__` in the same write that records the tagged build. This corrects this section's original
  shelled-out-CLI phrasing for detecting an image's working directory - this codebase talks to the host
  Docker socket exclusively through `dockerode`, never by shelling out to a `docker` command-line
  invocation, matching every other Docker interaction in `actor-driver.md`. An inspect failure is logged
  and tolerated - it must
  never fail an otherwise-successful build - and an empty or `/` working directory is left unset the
  same way: mounting a dev folder over `/` would destroy the container. This field reflects the Actor's
  _most recent_ successful build; running an older, differently-tagged build whose image had a
  different working directory is a known staleness gap, accepted for the POC.
- **The mount is conditional, applied only when both fields are present and non-empty** -
  `localDevFolder` and a known, non-`/`, non-empty `imageWorkingDirectory`. An Actor that was never
  registered (or was cleared) starts exactly as if this feature did not exist: no mount-related entries
  at all in its container's configuration.
- **The mount uses `HostConfig.Mounts`, never the legacy `Binds` array or literal `-v` flags.** This
  corrects the section's original `-v {localDevFolder}:{imageWorkingDirectory} -v
{imageWorkingDirectory}/node_modules` phrasing: a plain `-v`/`Binds` bind **auto-creates** a missing
  host source directory silently, which would defeat the whole point of validating existence at
  registration and would let a folder that vanished between registration and a run start silently mount
  an empty directory over the image's working directory instead of failing the run. A `Mounts`-type
  bind **errors** on a missing source instead (unless `BindOptions.CreateMountpoint` is explicitly set,
  which this runtime never does), giving the same strictness at run start as at registration. One
  `HostConfig.Mounts` array carries both entries:
    - `{ Type: 'bind', Source: localDevFolder, Target: imageWorkingDirectory }` - read-write (no
      `ReadOnly`), matching this section's original plain, unsuffixed mount intent.
    - `{ Type: 'volume', Source: '', Target: '{imageWorkingDirectory}/node_modules' }` - the
      `Mounts`-array equivalent of the anonymous-volume, bare-container-path `-v` form. Docker copies the
      image's existing contents into an anonymous volume before mounting it, which is exactly what
      preserves the image's own installed `node_modules` underneath a bind that otherwise covers the
      whole working directory: a _named_ volume would start empty, and a plain bind would erase it
      entirely. Dependency changes therefore still require a real rebuild - a new package in
      `package.json` only lands in the image (and so in the preserved `node_modules`) after one.
- **Every run's container removal passes `{ v: true }`**, on both the normal per-run removal and
  startup's orphan reconciliation. Without it, the anonymous `node_modules` volume above would leak one
  volume per run, forever, silently filling the host's disk - introducing the anonymous volume without
  this fix is not safe.
- **Observability**: since a folder's existence is verified at registration, a folder that is later
  deleted, moved, or made unreadable before a run starts is now a residual, not the primary, risk - the
  run's log opens with an explicit line naming the host path and the container path being mounted, so a
  run that fails against a since-vanished folder explains why in its very first log line, and the
  daemon's own `Mounts`-type rejection (see above) fails that run loudly rather than silently mounting
  an empty auto-created directory.
- Neither `localDevFolder` nor `imageWorkingDirectory` is ever exposed on the public `/v2` API
  (`storage.md`).

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

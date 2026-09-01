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

# Debug mode

- Debug mode is a **persistent per-Actor toggle**, set and read through the local-only endpoint
  `POST /actor-runtime/debug/:actorId` (`api.md`) or a form on the console's Actor detail view
  (`console.md`), with identical outcomes for the same input on both surfaces - the exact same
  `/actor-runtime/*` split the dev-folder bind mount already uses. It is not a per-run flag: turning it
  on for an Actor pauses every subsequent run of that Actor until the toggle is cleared, and stock
  `apify call`'s invocation/flags/exit behavior never change - the workflow is: toggle once, then run
  normally.
- The toggle stores `enabled`, `language` (`auto` - the default - `node`, or `python`), and an optional
  `port` override. A `POST` fully replaces the prior state for that Actor (never a partial merge): a
  field the body omits resets to its own default rather than keeping whatever the previous call set.
  Submitting `{"enabled": false}` clears the whole toggle back to unset, regardless of what else the body
  names.
- **Language resolution happens at run start, not at toggle time**, since the toggle itself requires no
  build to exist yet. `language: "auto"` inspects the run's resolved build image's `Config.Cmd`/
  `Config.Entrypoint` (a shell-form `CMD` arrives pre-flattened by the daemon as
  `['/bin/sh', '-c', '...']`, needing no shell parsing here) for a `python`/`python3` or `node`/`tsx`/
  `ts-node` token; failing that, a package-manager launcher (`npm`/`yarn`/`pnpm`) is refused outright
  (see below) rather than misclassified via the base image's own `NODE_VERSION`/`PYTHON_VERSION` env
  fingerprint, which is consulted only once no argv token and no package-manager pattern matched. This
  fingerprint is a fallback for a custom base image, never a rung any current Apify base image actually
  reaches: `apify/actor-node`'s and `apify/actor-python`'s own images set neither var (verified via
  `docker image inspect`), so an unclassifiable Apify-based image reaches the "unclassifiable" refusal
  below instead - a safe failure, not a silent misclassification. An explicit `language: "node"`/`"python"`
  override always wins outright, skipping this detection (and therefore every refusal it could produce)
  entirely - it exists precisely for images the heuristic cannot classify.
- **Default debug ports are language-specific**: `5678` for Python, `9229` for Node, each ecosystem's own
  IDE-default convention - applied only once the run's language has actually resolved, never a
  toggle-time literal (the toggle's own read-back shows a nominal `5678` for an unresolved `language:
"auto"`, purely for display). An explicit `port` override always wins over the resolved language's own
  default.
- **Activation is env-var-only - the driver never touches the container's `Cmd`/`Entrypoint`.** A Node
  debug run adds `NODE_OPTIONS=--inspect-brk=0.0.0.0:<port>` (Node's own built-in inspector, nothing
  injected). A Python debug run adds `PYTHONPATH=<payload dir>` (prepended to, never replacing, the
  image's own `PYTHONPATH`) plus the port the payload's own `sitecustomize.py` reads its listen address
  from, in `APIFY_ACTOR_RUNTIME_DEBUG_PORT` - both are merged into the run's env _below_ every
  platform-owned var (`buildEnv`'s own precedence), so a debug run can never shadow a real platform
  contract var. The same prepend-not-replace discipline applies one level higher too: if the Actor's own
  version-level `envVars` (see "Environment variables in every Actor container" in `storage.md`/below)
  already sets `NODE_OPTIONS`/`PYTHONPATH`, the debug value is prepended onto _that_ value rather than
  clobbering it - a debug run never silently discards an Actor's own configured
  `NODE_OPTIONS`/`PYTHONPATH`. `APIFY_ACTOR_RUNTIME_DEBUG_PORT` is the one exception to this
  prepend-not-replace rule: it is a single opaque value, not a list of flags/paths with a join convention
  of its own (unlike the other two), so if a version's own `envVars` ever sets that exact name too, the
  debug run's value **replaces** it outright rather than prepending - this never actually collides in
  practice, since no version defines its own Apify-internal debug-port var. The `NODE_OPTIONS`/`PYTHONPATH`
  prepend steps themselves stack: for the rare custom base image that bakes its own
  `NODE_OPTIONS`/`PYTHONPATH` into `Config.Env` _and_ whose
  version-level `envVars` also sets the same key, a debug run's final value is
  `<debug value><separator><image's baked value><separator><version's envVars value>` - the debug prefix,
  then the image's own value, then the version's own value, each layer preserved rather than the later
  layer clobbering the earlier one. This can make a debug run's env differ from the same run's non-debug
  env in one more way than just the added debug flag: a non-debug run's version-level `envVars` entry
  replaces the image's baked value outright (ordinary container env precedence - the image's value never
  appears in the container's env at all), while a debug run's own prepend-onto-image-env step
  (`resolveDebugPlan`) resurrects it. This is a deliberate consequence of applying the same "prepend, never
  clobber" discipline at both layers independently, not a version-precedence bug: it only reaches a value
  no Apify base image ever sets for `NODE_OPTIONS`/`PYTHONPATH` on its own.
- **The Python debugpy payload is injected by the runtime, not the Actor.** A pinned, pure-Python
  (`py2.py3-none-any`) `debugpy` wheel, plus a generated `sitecustomize.py`, is pre-built into a tar at
  the runtime's own image-build time (`Dockerfile`'s `debugpy-payload` stage) and streamed into a Python
  debug run's container via `container.putArchive(tar, { path: '/' })`, between `createContainer` and
  `start()` - the runtime needs no network access at run time, and the Actor's own source, Dockerfile,
  and `requirements.txt` need zero changes. `sitecustomize.py` is what CPython's `site` module imports
  before any user module runs, for exec-form, shell-form, or a bash-wrapped `CMD` alike. Since it runs in
  **every** Python process the container ever spawns (not just the Actor's own - `pip`, a subprocess the
  Actor's own code starts), it guards itself so only the first such process starts the debugpy listener,
  and never lets an unexpected internal failure leave the Actor running silently undebugged: it prints
  its own "listening" line once `debugpy.listen()` succeeds (its absence from the log is what makes a
  broken injection diagnosable), and any other internal failure prints a loud message and exits non-zero
  rather than silently continuing. Because the injected payload dir is prepended to `PYTHONPATH`, it is
  always the first `sitecustomize.py` CPython's `site` module finds - if the Actor's own image ships a
  same-named `sitecustomize.py` anywhere else on `PYTHONPATH`, ours shadows it outright (no chaining or
  delegation) for the duration of the debug run.
- **No synthetic breakpoint.** `debugpy.wait_for_client()` (Python) / `--inspect-brk` (Node) pause before
  any user code runs; once a debugger attaches, execution proceeds to the developer's own first
  breakpoint - the runtime never sets one of its own.
- **A missing debugpy payload fails the run with a clear message, never a silent non-debug start** - this
  is what happens if the runtime process itself is not running from its own built image (e.g. `pnpm dev`
  during development of this runtime itself); Python debug mode only works when the runtime runs inside
  its own Docker image.
- **Port publishing is fixed, per-Actor-overridable, and bound to `127.0.0.1`**: `ExposedPorts` +
  `HostConfig.PortBindings` on `createContainer`, with `HostIp: '127.0.0.1'` - since Actor containers are
  created against the _host's own_ Docker daemon through the mounted socket, this binding lands on the
  developer's own host directly, regardless of whether the runtime process itself runs inside a
  container. A host port already in use fails the run, with a `statusMessage` naming the port and the
  `port` override as the fix.
- **The run log carries one line, before `createContainer`**, stating: that the run is paused waiting for
  a debugger; the resolved language; the debug tool and (for Python) its injected version; the listen
  address inside the container and the published host address; the attach action for the relevant IDE
  (PyCharm's "Attach to DAP" / VS Code's "Python: Remote Attach" for Python; VS Code's "Attach" / Chrome
  DevTools for Node); and that the run's timeout is unchanged and not extended for debugging.
- **The run's timeout is completely unaffected by debug mode.** The configured `timeoutSecs` (default
  300s) is measured from container start regardless of whether a debugger ever attaches - a paused-
  waiting session gets no extra grace period, and the run still finalises `TIMED-OUT` (with its container
  removed) exactly like any other run whose timeout elapses. Passing a larger `apify call --timeout` is
  the documented way to get more time; this is a deliberate, documented trade-off, not an oversight.
- **Non-debuggable images fail the run, loudly, before any container is created** - the driver's own
  "Cannot start run: ..." path, matching every other pre-container failure. A package-manager launcher
  (`npm start`, `yarn start`, `pnpm start`, ...) is refused by name, explaining that `--inspect-brk` would
  attach to the package manager's own node process rather than the Actor's, and naming both the CMD fix
  and how to clear debug mode. An unclassifiable `language: "auto"` image is refused the same way, naming
  the `language` override as the fix. Neither refusal ever leaves a container behind. **This is not a rare
  edge case**: `apify/actor-node`'s own images default to `CMD ["npm", "start", "--silent"]`, and this
  runtime's injected default Dockerfile (`services/default-dockerfile.ts`, used for any pushed Actor that
  names no `Dockerfile` of its own) is `FROM apify/actor-node:20` with no `CMD` of its own - so it inherits
  that `npm start` default and is refused by debug mode exactly like any other package-manager-launched
  image. The remedy is the same one named in the refusal: give the Actor a `Dockerfile` whose `CMD`
  invokes `node` directly (e.g. `CMD ["node", "dist/main.js"]`).
- **The resolved plan is persisted on the run record itself** (`RunRecord.localDebug`, local-only, never
  on `/v2` - see `storage.md`), written once the plan resolves, before the container starts - this is
  what lets the console show an attach address after the fact (`console.md`), even for a run started by
  someone else's `apify call`, and even after the run has finished.
- **Debug mode composes with the dev-folder bind mount** - the two features are independent and both
  apply to the same run when both are configured for an Actor, e.g. edit -> recompile -> `apify call` ->
  breakpoint, with no rebuild in between.

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

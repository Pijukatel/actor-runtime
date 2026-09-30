# Actor build

- The system builds an Actor's docker image over the **host Docker socket** rather than
  Docker-in-Docker, keeping the host's image layer cache available.
- A build is produced by building a docker image from the Actor source that was pushed to the system.
- Build and run output is persisted as the job's log and fanned out live to any open
  `GET /v2/logs/:id?stream=true` response.
- Every log line originating in the runtime itself (not in the Actor) opens with a blue
  `[actor-runtime]` prefix, so the two are distinguishable at a glance.
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
  aborting a **run** stops the run's container immediately.
- On a successful build, the Actor's `taggedBuilds[<tag>]` is updated with the new build's id and
  number - stock `apify push` polls for exactly this field before returning.
- Actor, build, and build-log details are kept in internal records that persist across runtime
  restarts (`storage.md`).
- A build runs for the host's architecture; one whose base image has no manifest for it is retried
  once for `linux/amd64`, the architecture the platform builds and runs on, with the reason logged.
- **The Dockerfile to build is resolved from the Actor's pushed source**, not Docker's implicit default. `.actor/actor.json` is parsed as JSON5; an unparseable file fails the build with a "Could not parse .actor/actor.json" message. Resolution order, stopping at the first hit:
    1. the `dockerfile` field of `.actor/actor.json`, relative to `.actor/` - a path escaping the Actor root fails with "points outside the Actor root directory"; a non-string value fails with `"dockerfile" must be a string`; a value naming no pushed file (including empty) falls through instead of failing.
    2. `.actor/Dockerfile`
    3. `Dockerfile` at the Actor root
    4. the platform's bundled default Dockerfile, for that build only - the pushed source itself is unchanged.
    - Matching is case-insensitive, exact-case wins ties, and every outcome is stated in the build log.

# Input schema, validation and defaults

- **Input schemas work as on the Apify platform**: the schema is read from the pushed source when the
  Actor is built - the `input` field of `.actor/actor.json`, else `.actor/INPUT_SCHEMA.json`, else
  `INPUT_SCHEMA.json` - a build whose schema cannot be read or is not a valid input schema fails with
  the reason in its log, and every run of a build is validated against that build's schema with its
  defaults applied, a rejected input starting nothing (`api.md`). A build with no input schema takes
  every input exactly as the caller sent it.
- **Differences**: Apify Proxy group availability is not checked, so any `apifyProxyGroups` selection
  is accepted, while the rest of a `proxy` field is still validated; encrypted secret input fields
  stay unsupported (`unsupported.md`).
- An Actor running from a registered dev folder uses its last build's schema: unlike a source edit,
  an edited input schema takes effect only after `apify push`.

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
    - Validation never creates anything on the host and follows symlinks.
    - Submitting the **empty string clears the registration** and skips validation.
    - Every non-success outcome is classified: unable to verify at all (e.g. Docker unreachable)
      reports "could not verify" - never "does not exist"; a path confirmed missing reports "path
      does not exist"; a path that exists but is a file reports "path is not a directory"; anything
      else unverifiable reports a generic "could not verify".
- **Registration has no build-first precondition** - it requires no build of the Actor to exist,
  succeeded or otherwise.
- An image that starts through a file inside its working directory still starts under the mount: the
  dev folder's copy of that file is used when it has one, the image's own copy otherwise.
- The working directory the mount covers is recorded **per build**, never on the Actor
  (`storage.md`); the mount a run applies always uses the one from _that run's own resolved build_,
  never any other build the Actor happens to have.
- **The mount is off by default**: it applies only after the live dev folder is enabled for the Actor
  (`POST /actor-runtime/live-dev-folder/:actorId` or the console's Actor detail view); until then, a run's
  log says the registered folder is not mounted.
- **The mount is applied only when both a registered dev folder and a known working directory exist**
  for the run's resolved build; either missing means the run starts exactly as if the feature did not
  exist.
- **A single run can opt out** of the mount (`?devFolder=false` on run start, `api.md`) without touching
  the registration. When a mount is skipped this way, the run's log says so.
- The registration status the console and API report is the registered folder alone - never that a
  mount "will apply", since that depends on which build a given run resolves.
- If the registered folder has since been deleted, moved, or made unreadable, the run must **fail
  visibly** - never silently mount an empty directory in its place. The status message names the folder,
  what is wrong with it, and how to clear the registration.
- The Actor image's own installed dependencies (e.g. `node_modules`) must remain available to the Actor
  despite the mount covering the whole working directory.
- **Registering or clearing a dev folder never bumps the Actor's `modifiedAt`.**

# Debug mode

- Debug mode is a **persistent per-Actor toggle**, set and read through the local-only endpoint
  `POST /actor-runtime/debug/:actorId` (`api.md`) or a form on the console's Actor detail view
  (`console.md`), with identical outcomes for the same input on both surfaces. It is not a per-run flag:
  turning it on for an Actor pauses every subsequent run of that Actor until the toggle is cleared, and
  stock `apify call`'s invocation/flags/exit behavior never change - the workflow is: toggle once, then
  run normally.
- The toggle stores `enabled`, `language` (`auto` - the default - `node`, or `python`), and an optional
  `port` override. A `POST` fully replaces the prior state for that Actor (never a partial merge): a
  field the body omits resets to its own default rather than keeping whatever the previous call set.
  Submitting `{"enabled": false}` clears the whole toggle back to unset, regardless of what else the body
  names.
- **Language resolution happens at run start**, not at toggle time, since the toggle itself requires no
  build to exist yet. `language: "auto"` detects Node vs. Python from the run's resolved build image; an
  image it cannot classify is refused (see below) rather than guessed at. An explicit `language:
"node"`/`"python"` override always wins, skipping detection (and any refusal it could produce)
  entirely - it exists for images the heuristic cannot classify.
- **Default debug ports are language-specific**: `5678` for Python, `9229` for Node, each ecosystem's own
  IDE-default convention - applied once the run's language has resolved (the toggle's own read-back
  shows a nominal `5678` for an unresolved `language: "auto"`, purely for display). An explicit `port`
  override always wins over the resolved language's own default.
- **Activation never touches the container's `Cmd`/`Entrypoint`** - a debug run starts paused, waiting
  for a debugger, with zero changes required to the Actor's own source, Dockerfile, or
  `requirements.txt`. For Python, the runtime injects a `debugpy` payload into the container; execution
  proceeds to the developer's own first breakpoint once a debugger attaches - the runtime never sets a
  breakpoint of its own.
- **If the runtime cannot supply the Python debugpy payload** (e.g. it is not running from its own built
  image), the run fails with a clear message rather than starting undebugged.
- **The debug port is published on the host, bound to `127.0.0.1`.** A host port already in use fails the
  run, naming the port and the `port` override as the fix.
- **The run log carries one line, before the container is created**, stating: that the run is paused
  waiting for a debugger; the resolved language; the debug tool and (for Python) its injected version;
  the listen address inside the container and the published host address; the attach action for the
  relevant IDE (PyCharm's "Attach to DAP" / VS Code's "Python: Remote Attach" for Python; VS Code's
  "Attach" / Chrome DevTools for Node); and that the run's timeout is unchanged and not extended for
  debugging.
- **The run's timeout is completely unaffected by debug mode.** The configured `timeoutSecs` (default
  300s) is measured from container start regardless of whether a debugger ever attaches - a
  paused-waiting session gets no extra grace period, and the run still finalises `TIMED-OUT` (with its
  container removed) exactly like any other run whose timeout elapses. Passing a larger
  `apify call --timeout` is the way to get more time.
- **Non-debuggable images fail the run, loudly, before any container is created**, the same way every
  other pre-container failure does. A package-manager launcher (`npm start`, `yarn start`, `pnpm
start`, ...) is refused by name, naming both the `CMD` fix and how to clear debug mode. An
  unclassifiable `language: "auto"` image is refused the same way, naming the `language` override as the
  fix. Neither refusal ever leaves a container behind. This includes any Actor pushed with no
  `Dockerfile` of its own: the runtime's injected default Dockerfile inherits its base image's own
  `npm start` default, so it is refused exactly like any other package-manager-launched image.
- **The resolved plan is persisted on the run record itself** (local-only, never on `/v2` - see
  `storage.md`), available before the container starts - this is what lets the console show an attach
  address after the fact (`console.md`), even for a run started by someone else's `apify call`, and even
  after the run has finished.
- **Debug mode composes with the dev-folder bind mount** - the two features are independent and both
  apply to the same run when both are configured for an Actor, e.g. edit -> recompile -> `apify call` ->
  breakpoint, with no rebuild in between.

# Browser view

- Browser view is a persistent per-Actor toggle. While it is on, every run of the Actor offers a live view
  of the display its browser draws on, reachable from the run's console page and from a URL printed in the
  run log.
- Two modes: **view-only** (the default) shows the display and sends nothing to it; **interactive** also
  delivers the viewer's mouse and keyboard input to the display. Nothing else ever crosses in either
  direction (no clipboard).
- Watching is not observable from inside the browser or by the sites it visits: the run's container,
  command, environment, network and ports are those of an ordinary run, and whether the view is on, off, or
  being watched changes nothing about the browser.
- The runtime never changes the browser's headless mode. A headless browser shows an empty display; an
  Actor that wants to be watched runs its browser headful (the bundled `samples/actor_playwright` and
  `samples/actor_playwright_py` do). The Actor image must provide an X display; the Apify Playwright and
  Puppeteer base images do.
- The view lives exactly as long as the run, survives a migration/reboot of the run, and is gone once the run
  ends. It composes with debug mode and the dev-folder bind mount.

# Networking

- Every Actor container reaches the runtime's API at `http://apify-api:<API port>`, whatever the host's own
  networking, whichever supported engine runs the containers, and however the runtime itself was started
  (as a container or not). The runtime provides the `apify-local` network with the DNS alias `apify-api`
  for this; when it has to reach the same goal another way, it says so at startup.
- A per-run resource limit the engine cannot enforce for the current user is left out rather than
  failing the run; the runtime says so at startup.
- A run the engine refuses to start fails with the engine's reason in both the run's status message and
  its log.

# Actor run

- The system runs Actors as containers
- A run launches the Actor's built image as a container, with the Actor's input and its default
  storages (key-value store, dataset, request queue) wired in **entirely over HTTP** - the run's
  storages are reachable only through `APIFY_API_BASE_URL`.
- Run details and the run log are kept in internal records that persist across runtime restarts
  (`storage.md`).

## Run memory

- Run memory follows the platform's `.actor/actor.json` rules (`defaultMemoryMbytes`, `minMemoryMbytes`,
  `maxMemoryMbytes`). Differences:
    - A `defaultMemoryMbytes` that fails to evaluate, and a memory changed by the min/max bounds, are
      noted in the run log.
    - `defaultMemoryMbytes` is not capped to a plan's maximum memory.
    - A memory field its schema forbids fails the build.

## Resource limits

- Every run's container has a hard memory limit and a hard CPU limit. Memory is the run's `memoryMbytes`;
  CPU is derived from it at the platform's ratio of one core per 4096 MB, so a 1024 MB run gets 0.25 core.
- A derived CPU limit below what Docker accepts is raised to that minimum.
- Limits are applied exactly as requested, even when they exceed the host's own capacity. Such a run is
  warned about in its own log, naming the requested and the host figures; the limits still apply. When the
  host's capacity cannot be determined, no warning is produced.

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

## Run usage estimate

- Every run reports its usage and what it would cost, as on the platform. It differs in two ways: only
  compute units are metered, so storage operations, data transfer and proxy usage are neither counted nor
  priced; and every price is the lowest paid subscription tier's.
- Nothing is billed anywhere. The figures exist so a developer can see what a run of their Actor would
  cost the user running it.

# Pay-per-event pricing

- An Actor can be given a pay-per-event pricing, and its runs are charged against it, as on the platform:
  the same pricing on the Actor, set only on an existing Actor and only ever appended to, the same events
  charged by the Actor and by the runtime on its behalf, the same per-run maximum total charge, which
  ends the run when reached.
- It differs in four ways: only the free and pay-per-event pricing models are accepted; an event priced
  per subscription tier is charged at the lowest paid tier; nothing is ever billed or paid out; and the
  rules tying a price change to payout details, notice periods and subscription tiers do not apply.
- An Actor's own charging code therefore runs here unchanged, with no local-testing switch.
- A run's log states what it was pre-charged for starting, so the count is visible where the platform
  leaves it to be discovered on the bill.
- The pricing can also be set from the console (`console.md`).

# Actor Standby

- Implemented as on the platform (settings, `usesStandbyMode`, scaling, readiness, idle shutdown, env vars).
- Differences: single-tenant, owner-only; a new build of the standby tag replaces older standby runs; a
  runtime restart aborts standby runs.

# Users

- Users are created adhoc by the runtime for each new token used in the API call (`cli.md`'s User bootstrap).

# Environment variables in every Actor container

- The Actor version's own `envVars` (accepted and stored on `POST`/`PUT
.../actors/:actorId/versions` and managed one by one under `.../versions/:versionNumber/env-vars`), secrets
  included, are applied to the run's container environment, but every
  platform-owned var listed below takes precedence: a version cannot override `APIFY_TOKEN`, the
  default storage ids, or any other contract var the runtime itself sets.
- A secret env var (`isSecret`) is stored encrypted and never returned by the API: version responses carry
  a short `valueHash` instead of its `value`, which changes whenever the secret is set again, and env-var
  responses omit the value. It is decrypted only for the builds and runs of its own Actor.
- Differences: encryption is simplified. Each Actor gets its own key pair, with its first secret or run,
  kept in the runtime's data directory next to the encrypted values rather than in a separately managed
  key store, so it protects against a secret being read by accident, not against anyone who can read the
  data directory.
- With the version's `applyEnvVarsToBuild` on, its `envVars`, secrets included, are passed to the image
  build as Docker build arguments, as on the platform. The build log names them, never their values.
- `APIFY_IS_AT_HOME=1` (mirrors the real platform; an SDK/client instantiated
  in the container reports `isAtHome`/`is_at_home = true`).
- `APIFY_META_ORIGIN` — `STANDBY` for a standby run, `API` for every other run
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
  placeholder. With the console's "Use Apify Proxy" setting off (`console.md`), it is set to an empty
  string. A run given a password has one warning line in its log saying the Actor can use the real
  Apify Proxy, billed to the Apify account, and that the Settings page can disable it.
- `ACTOR_EVENTS_WEBSOCKET_URL` / `APIFY_ACTOR_EVENTS_WS_URL` — the run's own events channel
  (`api.md`), carrying no credential.
- `ACTOR_MEMORY_MBYTES` / `APIFY_MEMORY_MBYTES` — the run's requested `memoryMbytes`.
- `APIFY_DEDICATED_CPUS` — the run's granted CPU cores. No `ACTOR_`-prefixed counterpart; only the
  Python SDK reads it.
- `APIFY_INPUT_SECRETS_PRIVATE_KEY_FILE` / `APIFY_INPUT_SECRETS_PRIVATE_KEY_PASSPHRASE` — the run's own
  Actor's private key (base64 of its passphrase-protected PEM) and passphrase, which the Apify SDKs use
  to decrypt secret input fields. Each Actor has its own key pair (see "Differences" above).
- `ACTOR_MAX_TOTAL_CHARGE_USD` — the run's maximum total charge; absent when it was started without one.
- Every `ACTOR_*`/`APIFY_*` pair above is set to an identical value (the two SDKs disagree on which name
  wins).

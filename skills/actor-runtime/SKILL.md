---
name: apify-actor-runtime
description: Drive the local Apify Actor runtime - a self-contained local Apify platform that emulates the Apify API and console so Actors can be developed, run and debugged without the cloud. Covers pointing the Apify CLI at it, the no-rebuild dev-folder loop, IDE debugging, watching a Playwright/Puppeteer browser, Actor Standby servers, migration testing, pay-per-event pricing and run cost estimates, and relaying unimplemented calls to the real platform.
---

# Local Apify Actor runtime

These are the operating instructions for the Actor runtime the reader is talking to: a local Apify
platform serving an Apify-compatible API on `http://localhost:3333` and a console UI on
`http://localhost:3000` (the defaults - see "Other ports" below). It emulates the subset of the Apify API needed to develop, run and debug
Actors locally, so no change needs a rebuild on the real platform to be tried out.

It is not the Apify platform. Actors, builds, runs and storages created here exist only in this
runtime's data directory, and disappear when that directory is removed.

## Point the Apify CLI at it

Everything below is done through `apify`. Two ways to aim it:

```sh
apify runtime connect      # every command, every terminal, until 'apify runtime disconnect'
```

or, for one shell only (these take precedence over `connect` wherever they are set):

```sh
export APIFY_CLIENT_BASE_URL=http://localhost:3333
export APIFY_CONSOLE_URL=http://localhost:3000
```

Unset both, or run `apify runtime disconnect`, to talk to the real Apify platform again. Check which
one the CLI is currently aimed at with `apify runtime status`.

Any non-empty token authenticates - `apify login --token local-dev-token` is enough. Set
`APIFY_DISABLE_KEYRING=1` first in a sandbox with no OS keyring. To act as a second user, pass a
different token on a single call: `apify api v2/datasets -H '{"authorization": "Bearer OTHER"}'`.

### Other ports

When 3333 or 3000 is taken on this machine, start the runtime on other ports:
`apify runtime start --api-port 4333 --console-port 4000`. The CLI remembers them for later starts and
for `apify runtime connect`; with a hand-started container, set `-e ACTOR_RUNTIME_API_PORT=4333
-e ACTOR_RUNTIME_CONSOLE_PORT=4000` and publish the same numbers (`-p 4333:4333 -p 4000:4000`). Every URL
in this document then uses those ports instead, `apify-api:3333` included.

## The normal loop

```sh
cd my-actor
apify push                      # upload + build, once
apify call --input '{"maxPages":3}'
apify runs ls --json
apify runs log <runId>
apify datasets get-items <datasetId> --format json
```

### Apple Silicon and other arm64 hosts

Builds run for the host's architecture. Some Apify base images are published for `linux/amd64` only -
both `apify/actor-node-playwright*` and `apify/actor-python-playwright*` are - and a build from one of
those is retried for `linux/amd64`, the architecture the Apify platform builds and runs on, with the
reason in the build log. The engine emulates it (Rosetta on Apple Silicon), so it works, just slower.

## Input schema: defaults and validation

If the Actor declares an input schema - the `input` field of `.actor/actor.json`, or
`.actor/INPUT_SCHEMA.json`, or `INPUT_SCHEMA.json` at its root - the runtime uses it the way the
platform does:

```sh
apify call                                  # no input: the run gets the schema's defaults
apify call --input '{"maxPages":0}'         # rejected before anything starts, if the schema forbids it
```

- Every field left out of `--input` is filled from the schema's `default`, and that filled-in input is
  what the run reads back as `INPUT`.
- An input the schema rejects fails the call with the same message the real API gives (`Input is not
valid: Field input.maxPages must be >= 1`); no run is created and no container starts.
- The schema comes from the **build**, so a locally edited `INPUT_SCHEMA.json` needs an `apify push` to
  take effect - unlike a source edit under a registered dev folder.
- A schema the Apify input-schema meta-schema rejects fails the **build**, with the defect in the build
  log, instead of being silently ignored.
- Two local differences: Apify Proxy groups are not checked (any `apifyProxyGroups` selection is
  accepted), and encrypted secret input fields are not supported.

## Run memory

With no `-m`/`--memory`, a run gets `defaultMemoryMbytes` from `.actor/actor.json` - a number or a
memory expression over the input, evaluated as the platform does - or 1024 MB. Any memory, explicit
or not, is then clamped to the Actor's `minMemoryMbytes` / `maxMemoryMbytes`, and the run log says so.
An expression that fails falls back to 1024 MB with a warning in the run log. The fields come from the
build, so changing them needs an `apify push`.

## Iterate without rebuilding (dev folder)

After that first `apify push`, the runtime registers the pushed directory as the Actor's **dev
folder** (the build log's `Registered live dev folder` line confirms it) and bind-mounts it into every
later run. Edit locally, recompile locally (`tsc`, or the
language equivalent), and `apify call` again - no `apify push`, no rebuild:

```sh
# edit src/main.ts
npm run build
apify call --input '{"maxPages":3}'   # picks up the new dist/
```

- A local recompile is picked up by the **next** run's container start, not by a run already going.
- `node_modules` still comes from the built image, so a new dependency in `package.json` does need a
  real `apify push`. Only source edits skip the rebuild.
- `apify call --no-dev-folder` runs once from the built image alone, leaving the registration alone.
- Register a different folder by hand with
  `apify api POST /actor-runtime/dev-folder/<actorId> --body '"/abs/path/to/src"'`; clear it with
  `--body '""'`. The path must be absolute and must exist on the machine the container engine runs
  on - the runtime rejects the call otherwise, and re-checks at every run start.

## Debug an Actor with a real IDE debugger

Turn debug mode on for the Actor once; every later `apify call` then starts paused, waiting for a
debugger, with the attach address in the run's log.

```sh
apify api POST /actor-runtime/debug/<actorId> --body '{"enabled": true}'
apify api POST /actor-runtime/debug/<actorId> --body '{"enabled": false}'   # back to normal
```

Add `"language": "node"` or `"python"` when auto-detection cannot classify the image, and `"port": <n>`
to override the default (`9229` Node, `5678` Python). Attach VS Code's "Attach" (Node) or PyCharm's
"Attach to DAP" / VS Code's "Python: Remote Attach" (Python) to `127.0.0.1:<port>`.

Two things that bite:

- **An Actor pushed with no `Dockerfile` of its own needs one.** The injected default inherits
  `CMD ["npm", "start", "--silent"]`, which debug mode refuses, because it would attach to npm rather
  than the Actor. Give the Actor a `Dockerfile` whose `CMD` invokes the interpreter directly, e.g.
  `CMD ["node", "dist/main.js"]`.
- The run's `--timeout` is not extended while you attach. Pass a larger one for a slow attach.

## Watch a Playwright/Puppeteer browser

```sh
apify api POST /actor-runtime/browser-view/<actorId> --body '{"enabled": true}'
```

Every later run prints a viewer URL, `http://localhost:3000/runs/<runId>/browser` - a live view of
the display the Actor's browser draws on. Add `"interactive": true` to also send mouse and keyboard
input. The browser must run **headful** to show anything; Apify's templates default to headless,
which shows as a black display. Disable with `{"enabled": false}`.

## Test pay-per-event pricing and see what a run costs

Give the Actor a pricing exactly the way the platform stores it - the `pricingInfos` array on the Actor
object, which only an update takes, never the call that creates the Actor. Only `FREE` and
`PAY_PER_EVENT` are emulated:

```sh
apify api PUT /v2/actors/<actorId> --body '{"pricingInfos":[{"pricingModel":"PAY_PER_EVENT",
  "pricingPerEvent":{"actorChargeEvents":{
    "page-scraped":{"eventTitle":"Page scraped","eventPriceUsd":0.002},
    "apify-actor-start":{"eventTitle":"Actor start","eventPriceUsd":0.005,"isOneTimeEvent":true}}}}]}'
```

Both bundled samples already charge `page-scraped` per page and `crawl-finished` once at the end, and
carry the matching pricing in `pricing.json` - including both synthetic events, so one run shows all
four being charged: `apify api PUT /v2/actors/<actorId> --body "$(cat sample_actor_ts/pricing.json)"`
prices one in a single call.

From then on every run of the Actor is a pay-per-event run: the SDKs read `pricingInfo` and
`chargedEventCounts` off the run object exactly as on the platform, and `Actor.charge()` (or
`apify actor charge`) posts to `POST /v2/actor-runs/<runId>/charge`. Do not set
`ACTOR_TEST_PAY_PER_EVENT` - the runtime already looks like the platform to the SDK, which refuses that
variable together with `APIFY_IS_AT_HOME`. The synthetic events work too: `apify-actor-start` is charged
at run start (once per GB of memory) and `apify-default-dataset-item` once per item pushed to the run's
default dataset, when the pricing defines them. The start pre-charge scales with the run's memory and
its count is written to the run log, so `-m 8192` charges eight start events, not one; a memory the
platform would refuse (anything but a power of two between 128 MB and 32 GB) is warned about in the log
and then used anyway. Tiered event prices resolve to the `BRONZE` (Starter) tier. The array is append-only, as on the platform: send the entries the Actor already has, unchanged,
plus at most one new one starting after all of them - so making the Actor free again means appending a
`{"pricingModel":"FREE"}` entry, not sending `[]`. Re-sending a file that was already applied is refused
for the same reason (`pricingInfos[0] differs ...`): the stored entries carry timestamps the file does
not, so append its entry to what `GET /v2/actors/<actorId>` returns rather than sending the file again.
The same form is on the Actor's console page.

Cap a run's spend like a user would: `apify api POST '/v2/actors/<actorId>/runs?maxTotalChargeUsd=0.5'`
(there is no `apify call` flag for it). When the charges reach the cap the run is aborted gracefully,
its status message and log say so, and `chargingStoppedAt` is set on the run. An SDK with budget left
for the next event stops charging by itself below the cap, so the abort only fires on a charge that
crosses it - the JavaScript SDK's deliberate one-event overshoot does, the Python SDK never does.

Read the outcome off the run object, `apify api GET actor-runs/<runId>`, or the run's console page:

- `chargedEventCounts` and `eventUsage` - what was charged and what it adds up to per event.
- `stats.computeUnits`, `usage`, `usageUsd` - the compute units (memory times run time) priced at the
  lowest paid tier ($0.20 per unit), plus the sampled CPU and memory figures.
- `usageTotalUsd` - compute units plus events. An estimate, never a bill: storage operations, data
  transfer and proxy are not metered. On the platform a user of a pay-per-event Actor pays only the
  events unless the pricing sets `isPPEPlatformUsagePaidByUser`.

## Run an Actor server (Actor Standby)

An Actor with Standby enabled is served over HTTP, as on the platform. `"usesStandbyMode": true` in
`.actor/actor.json` makes `apify push` enable it; `apify api GET v2/actors/<actorId>` then shows the
`actorStandby` settings and the Actor's `standbyUrl`:

```sh
apify push
# The standby URL, as on the platform (<username>--<actor-name>.apify.actor); open it in a browser too:
curl "http://<username>--<actor-name>.localhost:3333/some/path?token=<token>"
# The same Actor, for clients that do not resolve *.localhost (older curl, many Node/Python clients):
curl "http://localhost:3333/actor-runtime/standby/<username>--<actor-name>/some/path?token=<token>"
```

- The Actor's console page has the `*.localhost` standby URL with your token already in it (masked on screen), as a link
  to click and a Copy link button - the quickest way to try it in a browser.
- The first request starts a standby run (origin `STANDBY`, no timeout, the standby build and memory) and
  waits until its server answers on `ACTOR_STANDBY_PORT` (4321); later requests reuse it. More runs start
  once concurrent requests exceed `desiredRequestsPerActorRun` / `maxRequestsPerActorRun`.
- Everything after the standby URL - path, query, headers, body, websockets - reaches the Actor unchanged.
  The token (`?token=`, `Authorization: Bearer`) is required, and only the Actor's owner is served.
  The Actor owns `/` of the `*.localhost` URL, as on the platform, so an Actor's web UI with root-relative
  links (`fetch('/api/...')`) works; under the path form it would not. The Actor id can stand in for
  `<username>--<actor-name>` in every form.
- From another Actor's container use `http://apify-api:3333/actor-runtime/standby/<username>--<actor-name>`;
  the Actor object read from inside a container already carries that as its `standbyUrl`.
- A run idle for `idleTimeoutSecs` (300 by default) gets the `aborting` event, is stopped 15 s later and
  ends `SUCCEEDED`. Shorten it while developing:
  `apify api PUT v2/actors/<actorId> --body '{"actorStandby":{"idleTimeoutSecs":10}}'`.
- After `apify push` the next request is served by a run of the new build; older runs finish once idle. A
  dev-folder edit reaches only the next standby run - abort the current one (`apify runs abort <runId>`)
  to pick it up sooner.
- A request that cannot be served says why: `standby-not-enabled`, `standby-run-finished` (the run
  crashed before its server came up - read its log), `standby-run-not-ready` (nothing listened on the port
  within 180 s).
- `apify call` still starts an ordinary `API` run of the same Actor. `sample_actor_standby_ts` and
  `sample_actor_standby_py` are complete Actor servers (JSON, request body, Server-Sent Events, websocket,
  graceful shutdown) to start from; `sample_actor_standby_web` serves a web page and, in an ordinary run,
  calls a standby Actor from its container. Multi-tenant Standby and Standby for tasks are not emulated.

## Test how an Actor handles a platform migration

While a run is `RUNNING`:

```sh
apify api POST /actor-runtime/migrate/<runId>
```

The run gets the real migration experience: a `migrating` event, its container stopped a few seconds
later, then a fresh container for the same run - same run id, env vars and storages, in-memory state
gone. The Migrate button on the run's console page does the same.
`POST /v2/actor-runs/<runId>/reboot` is also implemented.

## When this runtime does not implement something

A call can fail because this runtime does not know the id, or does not implement the endpoint at
all. Such calls can be relayed to the real Apify platform instead of failing:

```sh
apify api POST /actor-runtime/api-fallback \
  --body '{"fallbackUnimplementedEnabled": true, "fallbackNotFoundEnabled": true}'
apify api GET /actor-runtime/api-fallback     # read the current state
```

Either field alone is accepted. Both default off and reset to off on every restart.

Named storages follow the same path: a `username~name` reference the runtime has no local storage for
is a not-found miss, so with `fallbackNotFoundEnabled` on, `apify api GET v2/datasets/apify~some-public-dataset/items`
reads that dataset from the real platform, and your own `~name` that exists only on the platform
resolves there too. A name that does exist locally is always served locally.

**This writes to a real Apify account.** Enabling either forwards the token the failing call carried
to the real platform, and every HTTP method is eligible - so a locally-missing `POST`/`PUT`/`DELETE`
becomes a real write. Only turn it on with a token whose account you are willing to change, and say
so before enabling it on someone's behalf. A relayed response carries `x-actor-runtime-fallback`
(which platform served it) and `x-actor-runtime-fallback-trigger` (which toggle let it through).

A `runs/last` call is never split between the two: an Actor that exists here is answered here, even when
a later step misses. Only a call naming an Actor this runtime does not know is relayed.

## Inspecting state directly

- `apify api ...` sends authenticated calls: `apify api GET v2/datasets`, `apify api GET v2/acts`.
  The `v2/` prefix and the leading slash are both optional.
- A named Actor, dataset, key-value store or request queue can stand in for its id as `~name` (your
  own), `username~name` or `userId~name`, like on the platform:
  `apify api GET v2/datasets/~my-results/items`. Names match case-insensitively. A bare name without
  `~` is an id, except for an Actor, where it is also tried as a name. Another user's resource is not
  found here - the runtime only ever shows your own.
- Or unauthenticated by URL: `http://localhost:3333/v2/datasets?token=TOKEN`.
- The `runs/last` shortcuts address an Actor's newest run without knowing its id:
  `apify api GET v2/actors/<actorId>/runs/last`, and the same under `/log`, `/dataset/items`,
  `/key-value-store/records/OUTPUT`, `/request-queue`, `/abort`. Add `?status=SUCCEEDED` to skip
  failed runs. `client.actor(id).lastRun()` in the SDKs uses these.
- The console at `http://localhost:3000` shows the same objects, plus the pricing and dev-folder forms,
  each run's usage and cost, the Migrate button, the browser view and an Actor's standby runs.
- The runtime's data directory holds every storage, build and run record on disk. Read it freely;
  write to it only through the API, never by editing the files.

## Reading the runtime's own output

In a build or run log, everything the runtime itself says - dev-folder notices, the debug attach
line, the browser-view URL, migration markers, a run that could not start - opens with a blue
`[actor-runtime]` prefix. The Actor's own output is passed through byte for byte.

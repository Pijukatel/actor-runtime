# actor-runtime

A minimal, self-contained "local Apify platform" in a single Docker image. Start
it with one `docker run`, point the stock `apify-cli` at it, and run the full
Actor dev loop offline: `apify push` -> build -> run -> inspect runs, builds and
the run's default storages (key-value store, dataset, request queue).

## Architecture

- **API server** (Node.js) - a subset of the public Apify API under `/v2`
  large enough that unmodified `apify-cli` works against it. See
  `requirements/api.md` for the endpoint list.
- **Storage** - crawlee v4's default file-system storage backend
  (`@crawlee/fs-storage`) rooted under `$DATA_DIR/storage/`, providing dataset
  and key-value store; the request-queue store is implemented by the runtime
  itself over the same on-disk layout (see `requirements/storage.md`).
  Metadata (users, Actors, versions, builds, runs, storages, access rights)
  lives in a single JSON file, `$DATA_DIR/meta.json` — no SQL engine, no
  migrations.
- **Actor driver** - builds Actor images with `docker build` and runs them as
  containers via the mounted host Docker socket, wiring in the run input and the
  run's default storages (Apify container conventions). Every Actor container
  gets a working `APIFY_API_BASE_URL` callback and a real (but never the
  bound-secret) `APIFY_TOKEN`, over a shared Docker network the runtime and
  every Actor container join, so containers can also reach each other by name.
- **Standby actors** - an Actor pushed with `usesStandbyMode: true` in
  `.actor/actor.json` is kept warm as a long-lived container instead of running
  once and exiting: its serialized object exposes a `standbyUrl`, and
  `{method} /v2/actor-standby/{actorId}/{path}` lazily starts it, waits for
  readiness, and reverse-proxies requests to it (idle-timeout torn down
  automatically). `standbyUrl` resolves only from **inside another Actor
  container** on the shared Docker network — a host-side caller (e.g. `curl`
  on your machine) must instead use
  `http://localhost:<published-api-port>/v2/actor-standby/{actorId}/...`. See
  `requirements/api.md`'s "Standby actors" section.
- **Console** - a tiny server-rendered SPA (no build tooling) to list Actors,
  builds and runs, trigger Build/Run, and browse a finished run's storages.
- **Multiple users via placeholder login.** The API token selects the acting user
  (no passwords, no real auth): users are auto-created on first use, everything is
  owned per-user, and one user cannot see another's Actors, builds, runs or
  storages. No token falls back to the default `local-user`. A storage's owner can
  optionally share an individual key-value store, dataset or request queue with
  another user at READ or WRITE level via the API. See `requirements/api.md`.
- **Optional upstream API fallback.** A single runtime-global toggle (the
  console header's "API fallback" switch, or `GET|PUT /v2/runtime-config`)
  makes any request that 404s locally on an Actor/run/build/storage id retry
  against the real `api.apify.com`, using the caller's own bound token, and
  relay a successful reply back verbatim. Off by default and resets to off on
  every restart; since it forwards the caller's real credential, turning it
  on can turn a locally-missing write into a live, billed change on that
  user's real Apify account. See `requirements/api.md`'s "Upstream fallback"
  section.

The API and the console are served on two ports; the container prints both URLs,
clearly labelled, on startup.

## Build and run the image

```bash
docker build -t actor-runtime .

# DATA must be an absolute host path. It is mounted at the SAME path inside the
# container so the runtime can bind-mount per-run storage into the sibling Actor
# containers it launches through the shared Docker socket.
DATA=$(mktemp -d)
docker run -d --name actor-runtime \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$DATA:$DATA" -e DATA_DIR="$DATA" -e HOST_DATA_DIR="$DATA" \
  -p 3333:3333 -p 3000:3000 \
  actor-runtime
```

On startup the container prints:

```
  API URL:     http://localhost:3333
  Console URL: http://localhost:3000
```

Data (Actors, versions, builds, runs and their storages) lives under `$DATA` and
persists across `docker stop` / `docker start`.

> Upgrade note: the metadata store is a plain JSON file (`$DATA_DIR/meta.json`),
> so there are no schema migrations — a field a new release adds simply
> defaults when absent from an existing file, and upgrading in place normally
> just works. Start from a fresh `DATA_DIR` only if a release's notes
> explicitly say so.

> Platform note: the host Docker-socket mount is validated on Linux. macOS and
> Windows are best-effort for this first draft (see `requirements/system.md`).

### Storage, volumes and non-root Actors

Each run gets its own directory under `$DATA/runs/<runId>/storage`, which the
runtime bind-mounts into the Actor container at `/apify_storage`. Two things make
this work, and neither needs any action from you:

- **Same-path volume + `HOST_DATA_DIR`.** `$DATA` is mounted at the *same* path
  inside the runtime container (`-v "$DATA:$DATA"`) and `HOST_DATA_DIR` tells the
  runtime that path on the host. The runtime launches Actor containers as
  *siblings* through the shared Docker socket, so their volume source must be a
  real host path - if `HOST_DATA_DIR` is wrong, the Actor's `/apify_storage` would
  mount from the wrong place.
- **Non-root Actors.** Official Apify Actor base images run as a non-root user
  (e.g. `uid 1000`), while the runtime itself runs as root. The runtime creates
  each run's storage directory world-writable so the Actor's user can write its
  key-value store, dataset and request queue; the runtime (root) then reads those
  results back to import them. You do **not** need to `chown`/`chmod` `$DATA` or
  run your Actor as root. (Earlier drafts created this directory root-owned `0755`,
  which caused a `PermissionError: [Errno 13] ... /apify_storage/...` on the
  Actor's first write - that is fixed.)

### Apify Proxy

An Actor can use real Apify Proxy from a local run. Export your proxy
password (Apify Console -> Proxy -> your password, distinct from your API
token) and pass it into the **runtime** container with `-e
APIFY_PROXY_PASSWORD`:

```bash
export APIFY_PROXY_PASSWORD=...   # from Apify Console -> Proxy
docker run -d --name actor-runtime \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$DATA:$DATA" -e DATA_DIR="$DATA" -e HOST_DATA_DIR="$DATA" \
  -e APIFY_PROXY_PASSWORD="$APIFY_PROXY_PASSWORD" \
  -p 3333:3333 -p 3000:3000 \
  actor-runtime
```

The password flows host -> runtime container -> every Actor container the
runtime launches: the runtime reads `APIFY_PROXY_PASSWORD` from its own
environment at startup (`loadSettings()`) and, whenever it is set,
`Service.buildEnvironment` adds the same variable/value to every Actor
container's environment (on-demand and standby runs alike). Inside the Actor,
the `apify` SDK's own configuration picks `APIFY_PROXY_PASSWORD` up
automatically, so `Actor.createProxyConfiguration(...)` builds a real
`proxy.apify.com:8000` connection with no other setup. If
`APIFY_PROXY_PASSWORD` is never set on the runtime container, no Actor
container ever gets the variable — there is no placeholder/fake value.

`sample_actor_crawler/` is a `CheerioCrawler`-based Actor that demonstrates
this end to end: its `proxyConfiguration` input (default `{"useApifyProxy":
true, "apifyProxyGroups": ["RESIDENTIAL"]}`) is passed straight to
`Actor.createProxyConfiguration(...)`, no fallback of any
kind. Two outcomes follow directly from the SDK's own behaviour, not from
anything this Actor codes around:

- An explicit `{"useApifyProxy": false}` (with no `proxyUrls`) is the *only*
  way to crawl direct with no proxy and no credentials — the SDK returns
  `undefined` and the crawler runs without a proxy.
- `useApifyProxy: true` — whether given explicitly, or via **omitting
  `proxyConfiguration` entirely**, which falls through to the SDK's own
  default `ProxyConfiguration` and behaves identically (omitting the field is
  *not* an alternate way to run without a proxy) — with
  `APIFY_PROXY_PASSWORD` missing or invalid causes the SDK's own live
  proxy-access check to fail the run. This needs real outbound network
  access to Apify's proxy infrastructure and a valid password for the
  requested proxy group(s) to succeed; failing without one is expected,
  documented behaviour, not a defect.

## Use it with apify-cli

```bash
npm install -g apify-cli
export APIFY_CLIENT_BASE_URL=http://localhost:3333   # redirect the CLI here
export APIFY_CONSOLE_URL=http://localhost:3000        # ...and its console links here too
apify login -t alice      # the token selects the acting user (see requirements/cli.md;
                          # push/call use the stored login, not the APIFY_TOKEN env var)

cd sample_actor           # or any Actor project
apify push --force        # creates the Actor + version and builds it
apify call -i '{"greeting":"hi"}'   # runs it and waits for completion
```

Then open the console URL, or fetch the run's storages over the API. See
`requirements/cli.md` for details.

All five `sample_actor*/` fixtures are real `apify` SDK Actors
(`Actor.main()`, `Actor.getInput()`/`setValue()`/`pushData()`/
`openRequestQueue()`), so their `.actor/Dockerfile` npm-installs the `apify`
SDK (version-pinned in each fixture's `package.json`) at image **build**
time -- `apify push`/`docker build` needs
normal internet egress for that step. At **run** time, the four original
fixtures only talk to this runtime and other local containers (e.g. the
caller fixture's container-to-container call to the standby Actor's own HTTP
endpoint), so those runs stay fully offline. `sample_actor_crawler/` is the
exception: it fetches its `startUrl` (and any same-domain links it
discovers) over real outbound internet, and via `proxy.apify.com` too when
`useApifyProxy: true` — see "Apify Proxy" above.

An Actor pushed and built before its `.actor/input_schema.json` existed keeps
showing the console's plain-JSON input editor until you push again — a plain
`apify push --force` picks up the new schema without needing a rebuild.

## Demo

`scripts/demo.sh` is a self-contained, commented walkthrough of the whole
loop including standby actors: it builds the image, starts the runtime,
points apify-cli at it, pushes the standby + caller sample Actors, runs the
caller (which discovers and calls the standby Actor container-to-container),
and prints the results read back over the API. Requires docker, apify-cli,
node and curl:

```bash
bash scripts/demo.sh
```

Pass `--remote` to run the same demo against the real Apify platform instead
(skips the image build/container steps; requires `apify login` beforehand):

```bash
bash scripts/demo.sh --remote
```

## Run the tests

The oracle installs the npm dependencies and `apify-cli`, builds the
image, and runs the unit/integration suite (vitest) plus the mandatory
end-to-end test (real `apify-cli` driving a real container). It exits
non-zero on any failure:

```bash
bash scripts/run-tests.sh
```

- Fast unit/integration tests (`tests/unit/`) need no Docker - they use an
  in-process app with a stub driver.
- The end-to-end test (`tests/e2e/`) requires the Docker daemon and `apify-cli`.

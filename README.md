# actor-runtime

A minimal, self-contained "local Apify platform" in a single Docker image. Start
it with one `docker run`, point the stock `apify-cli` at it, and run the full
Actor dev loop offline: `apify push` -> build -> run -> inspect runs, builds and
the run's default storages (key-value store, dataset, request queue).

## Architecture

- **API server** (FastAPI, Python) - a subset of the public Apify API under `/v2`
  large enough that unmodified `apify-cli` works against it. See
  `requirements/api.md` for the endpoint list.
- **Storage** - crawlee-python's SQL storage client on a single SQLite file,
  providing dataset, key-value store and request queue.
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

> Upgrade caveat: the runtime has no schema migrations (`create_all()` only
> creates missing tables, not new columns on existing ones). **Any release that
> adds columns to an existing table requires a fresh `DATA_DIR`** — new columns
> are never added to an existing database in place, only entirely new tables
> are. This has applied to every such release so far: the `username` columns
> added for per-user ownership, and this release's `users.container_token`,
> `actors.actor_standby` and `runs.is_standby` columns (added for standby-actor
> support).

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

## Use it with apify-cli

```bash
npm install -g apify-cli
export APIFY_CLIENT_BASE_URL=http://localhost:3333   # redirect the CLI here
apify login -t alice      # the token selects the acting user (see requirements/cli.md;
                          # push/call use the stored login, not the APIFY_TOKEN env var)

cd sample_actor           # or any Actor project
apify push --force        # creates the Actor + version and builds it
apify call -i '{"greeting":"hi"}'   # runs it and waits for completion
```

Then open the console URL, or fetch the run's storages over the API. See
`requirements/cli.md` for details.

An Actor pushed and built before its `.actor/input_schema.json` existed keeps
showing the console's plain-JSON input editor until you push again — a plain
`apify push --force` picks up the new schema without needing a rebuild.

## Proxies: Apify Proxy and your own servers

Actors use the platform's standard proxy input — the object the Console's
proxy editor (`"editor": "proxy"` in the input schema) produces:

```jsonc
{ "useApifyProxy": true, "apifyProxyGroups": ["RESIDENTIAL"], "apifyProxyCountry": "US" }
// or your own (generic) servers:
{ "useApifyProxy": false, "proxyUrls": ["http://user:pass@host:port"] }
```

The runtime mirrors the platform's side of the contract. Every Actor container
gets the platform's proxy connection env vars (`APIFY_PROXY_HOSTNAME`,
`APIFY_PROXY_PORT`, `APIFY_PROXY_STATUS_URL` — `proxy.apify.com` / `8000` /
`http://proxy.apify.com` unless you override them with env vars of the same
names on the runtime container). What the runtime cannot do is mint Apify
Proxy credentials: to use the **real Apify Proxy** locally, copy your own
proxy password from <https://console.apify.com/proxy> and add it to the
`docker run` command above:

```bash
  -e APIFY_PROXY_PASSWORD=<your-proxy-password> \
```

With that in place every Actor run gets `APIFY_PROXY_PASSWORD`, and
`{"useApifyProxy": true}` works exactly as on the platform — the SDK inside
the container builds `http://groups-...,country-...:<password>@proxy.apify.com:8000`
URLs and traffic really flows through Apify Proxy. Without it the variable is
absent (never empty), so such a run fails with the SDK's clear
missing-password error. Generic `proxyUrls` need nothing from the runtime at
all.

`sample_actor_proxy/` demonstrates both modes, resolving the proxy input the
same way the SDK's `Actor.create_proxy_configuration` does (see its module
docstring) while staying dependency-free:

```bash
cd sample_actor_proxy
apify push --force
# Real Apify Proxy (needs APIFY_PROXY_PASSWORD on the runtime container):
apify call -i '{"proxyConfiguration":{"useApifyProxy":true},"targetUrl":"https://api.apify.com/v2/browser-info"}'
# Your own proxy server:
apify call -i '{"proxyConfiguration":{"useApifyProxy":false,"proxyUrls":["http://user:pass@host:port"]},"targetUrl":"https://api.apify.com/v2/browser-info"}'
```

Its OUTPUT record shows the resolved proxy URLs (passwords always masked),
the Apify Proxy access-check result, and a preview of the page fetched
through the proxy — `browser-info` echoes the IP the request came from, so a
working proxy shows its IP instead of yours. Leave `targetUrl` empty to only
resolve and report the configuration without any network use.

## Demo

`scripts/demo.sh` is a self-contained, commented walkthrough of the whole
loop including standby actors: it builds the image, starts the runtime,
points apify-cli at it, pushes the standby + caller sample Actors, runs the
caller (which discovers and calls the standby Actor container-to-container),
and prints the results read back over the API. Requires docker, apify-cli,
python3 and curl:

```bash
bash scripts/demo.sh
```

## Run the tests

The oracle sets up the venv, installs dependencies and `apify-cli`, builds the
image, and runs the unit/integration suite plus the mandatory end-to-end test
(real `apify-cli` driving a real container). It exits non-zero on any failure:

```bash
bash scripts/run-tests.sh
```

- Fast unit/integration tests (`tests/unit/`) need no Docker - they use an
  in-process app with a stub driver.
- The end-to-end test (`tests/e2e/`) requires the Docker daemon and `apify-cli`.

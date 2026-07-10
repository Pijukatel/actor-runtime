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
  run's default storages (Apify container conventions).
- **Console** - a tiny server-rendered SPA (no build tooling) to list Actors,
  builds and runs, trigger Build/Run, and browse a finished run's storages.
- **Single implicit user**, no auth, no login.

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
  -p 8080:8080 -p 8081:8081 \
  actor-runtime
```

On startup the container prints:

```
  API URL:     http://localhost:8080
  Console URL: http://localhost:8081
```

Data (Actors, versions, builds, runs and their storages) lives under `$DATA` and
persists across `docker stop` / `docker start`.

> Platform note: the host Docker-socket mount is validated on Linux. macOS and
> Windows are best-effort for this first draft (see `requirements/system.md`).

## Use it with apify-cli

```bash
npm install -g apify-cli
export APIFY_CLIENT_BASE_URL=http://localhost:8080   # redirect the CLI here
export APIFY_TOKEN=local-runtime-dummy-token          # any non-empty value

cd sample_actor           # or any Actor project
apify push --force        # creates the Actor + version and builds it
apify call -i '{"greeting":"hi"}'   # runs it and waits for completion
```

Then open the console URL, or fetch the run's storages over the API. See
`requirements/cli.md` for details.

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

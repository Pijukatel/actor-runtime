# actor-runtime

A minimal, self-contained "local Apify platform" in a single Docker image. Start
it with one `docker run`, point the stock `apify-cli` at it, and run the full
Actor dev loop offline: `apify push` -> build -> run -> inspect runs, builds and
the run's default storages (key-value store, dataset, request queue).

See `requirements/*.md` for the full behavioural spec (`system.md`, `api.md`,
`storage.md`, `actor-driver.md`, `cli.md`, `console.md`, `test.md`).

## Quick start

```bash
docker compose up --build
# or: docker build -t actor-runtime . && docker run -p 3333:3333 -p 3000:3000 \
#       -v /var/run/docker.sock:/var/run/docker.sock -v actor-runtime-data:/data actor-runtime

export APIFY_CLIENT_BASE_URL=http://localhost:3333
export APIFY_CONSOLE_URL=http://localhost:3000
npm install -g apify-cli
apify login --token anything

cd sample_actor_ts
apify push
apify call --input '{"maxPages":3}'
```

## Development

```bash
npm install
npm run build     # tsc
npm test          # unit + integration (no Docker needed)
npm run test:e2e  # full CLI-driven dev loop against a built image (requires Docker)
npm run dev       # run the server directly against ./data with tsx
```

`npm run dev` sets `ACTOR_RUNTIME_DATA_DIR=./data` inline in the script (`DEFAULT_DATA_DIR` otherwise
falls back to the container path `/data` - see `src/config.ts`); this only works as written on a
POSIX shell (Linux/macOS). On Windows, set the env var separately before running `tsx src/index.ts`
(e.g. in PowerShell: `$env:ACTOR_RUNTIME_DATA_DIR="./data"; tsx src/index.ts`), or use a cross-platform
env-setter like `cross-env` if you add it as a dependency.

## Bumping the pinned Crawlee v4 version

`@crawlee/core` and `@crawlee/fs-storage` are pinned to the exact version the npm `v4` dist-tag
resolves to (both must move in lockstep - `@crawlee/fs-storage` pins its own native addon,
`@crawlee/fs-storage-native`). To bump:

```bash
npm view @crawlee/core dist-tags.v4
npm view @crawlee/fs-storage dist-tags.v4   # should match
# update both versions in package.json, then:
npm install
npm run build && npm test
```

## Apify Proxy

Set `APIFY_PROXY_PASSWORD` in the runtime container's own environment (see `docker-compose.yml`) to
have it forwarded, unscoped, into every Actor container's `APIFY_PROXY_PASSWORD`. Leave it unset and
the variable is simply absent from every Actor container - never a placeholder value.

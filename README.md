# actor-runtime

A minimal, self-contained "local Apify platform" in a single Docker image. Start
it with one `docker run`, point the stock `apify-cli` at it, and run the full
Actor dev loop: `apify push` -> build -> run -> inspect runs, builds and
the run's default storages (key-value store, dataset, request queue). The
runtime itself needs no outbound network access after the first build/push (see
`requirements/system.md`); the bundled sample Actors crawl the live web, so
running them does.

See `requirements/*.md` for the full behavioural spec (`system.md`, `api.md`,
`storage.md`, `actor-driver.md`, `cli.md`, `console.md`, `test.md`).

## Quick start

```bash
docker build -t actor-runtime .
docker run --rm -p 3333:3333 -p 3000:3000 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$(pwd)/data:/data" \
  actor-runtime
```

This mounts `./data` on the host as the runtime's `/data`, so every storage, build and run record
lands under `./data` for easy inspection.

```bash
export APIFY_CLIENT_BASE_URL=http://localhost:3333
export APIFY_CONSOLE_URL=http://localhost:3000
npm install -g apify-cli

cd sample_actor_ts
apify push
apify call --input '{"maxPages":3}'
```

This assumes you're already logged in (`apify login`, any stored token works - the runtime maps any
non-empty token to its single local user). If that token happens to be a real Apify account token and
the real platform is reachable, the runtime also adopts that account's real username/id/proxy password
the first time it sees the token; fully offline (or with any other non-empty token) it just keeps using
the single local user, with no error either way - see `requirements/cli.md`'s User bootstrap section.

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

Set `APIFY_PROXY_PASSWORD` in the runtime container's own environment (e.g. `docker run -e
APIFY_PROXY_PASSWORD=your-password ...`) to have it forwarded, unscoped, into every Actor container's
`APIFY_PROXY_PASSWORD`. Leave it unset and the variable is simply absent from every Actor container -
never a placeholder value.

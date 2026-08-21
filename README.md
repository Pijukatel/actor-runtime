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

## Rapid dev loop: bind-mounting your local source (no rebuild per edit)

After the one push+build above, register your Actor's local source folder so every future run picks up
local edits without a rebuild:

```bash
apify api POST /actor-runtime/dev-folder/<actorId> --body '"/abs/path/to/sample_actor_ts"'
```

`<actorId>` is the id `apify push --json` printed (`.actor.id`); the path must be absolute and must
already exist on the **host** - the runtime verifies this by actually trying to mount it, and rejects
the call with a clear error if the Actor has no build tagged `latest` yet (a stock `apify push` always
tags its build `latest`, so this is normally just "build at least once first") or the path can't be
confirmed.
The same thing is also a single-field form on the Actor's page in the console (`http://localhost:3000`).

From then on:

```bash
# edit src/main.ts, then:
pnpm run build       # recompile locally - tsc, no apify push
apify call --input '{"maxPages":3}'   # picks up the new dist/, no rebuild
```

Node doesn't hot-reload a running process, so a local recompile is picked up by the **next** run's
container start, not by any run already in progress. `node_modules` inside the container still comes
from the built image - an anonymous volume preserves it underneath the bind mount - so a new dependency
in `package.json` still needs a real `apify push`/build; only source edits skip it. Clear the
registration with an empty body (`--body '""'`) to go back to running purely from the built image. Full
mechanics: `requirements/actor-driver.md`'s "Bind mount volumes with Actor source code";
endpoint/console details: `requirements/api.md`'s `/actor-runtime/*` section and
`requirements/console.md`.

## Development

```bash
pnpm install
pnpm run build     # tsc
pnpm test          # unit + integration (no Docker needed)
pnpm run test:e2e  # full CLI-driven dev loop against a built image (requires Docker)
pnpm run dev       # run the server directly against ./data with tsx
```

`pnpm run dev` sets `ACTOR_RUNTIME_DATA_DIR=./data` inline in the script (`DEFAULT_DATA_DIR` otherwise
falls back to the container path `/data` - see `src/config.ts`); this only works as written on a
POSIX shell (Linux/macOS). On Windows, set the env var separately before running `tsx src/index.ts`
(e.g. in PowerShell: `$env:ACTOR_RUNTIME_DATA_DIR="./data"; tsx src/index.ts`), or use a cross-platform
env-setter like `cross-env` if you add it as a dependency.

### Package manager

Host-side installs (this repo and `sample_actor_ts`) use **pnpm**, never npm. The reason is
cross-OS lockfile correctness: npm's `package-lock.json` handling of platform-specific _optional_
dependencies is broken across operating systems - a lock generated on Linux pins Linux-only native
binaries (concretely: rollup, pulled in by vitest, optionally depends on
`@napi-rs/lzma-linux-x64-gnu`, a package with no darwin counterpart at all), and `npm ci`/
`npm install` from that lock then fails on macOS with `EBADPLATFORM`/missing-binary errors instead
of skipping the foreign-platform package. `pnpm-lock.yaml` records the full optional-dependency
matrix for every platform and picks the matching subset at install time, so one committed lockfile
works on Linux, macOS and Windows alike.

`package.json`'s `packageManager` field pins the pnpm version; `corepack enable` (Corepack ships
with Node) makes `pnpm` available at exactly that version, or install it any other way you prefer.
pnpm settings live in `pnpm-workspace.yaml` (one at the repo root, one in `sample_actor_ts` marking
the sample Actor as its own standalone root - see the comments in those files).

One place intentionally stays on npm: `sample_actor_ts/Dockerfile`. The Actor _image_ build always
runs on Linux inside Docker (so the macOS problem cannot reach it), and keeping it on the base
image's stock npm keeps the sample identical to a real user's npm-based Actor - which is exactly
what the runtime has to be able to build. The runtime's own `Dockerfile` installs with pnpm
(via the base image's Corepack), pinned by `packageManager` and `pnpm-lock.yaml`.

## Bumping the pinned Crawlee v4 version

`@crawlee/core` and `@crawlee/fs-storage` are pinned to the exact version the npm `v4` dist-tag
resolves to (both must move in lockstep - `@crawlee/fs-storage` pins its own native addon,
`@crawlee/fs-storage-native`). To bump:

```bash
pnpm view @crawlee/core dist-tags.v4
pnpm view @crawlee/fs-storage dist-tags.v4   # should match
# update both versions in package.json, then:
pnpm install
pnpm run build && pnpm test
```

## Apify Proxy

Set `APIFY_PROXY_PASSWORD` in the runtime container's own environment (e.g. `docker run -e
APIFY_PROXY_PASSWORD=your-password ...`) to have it forwarded, unscoped, into every Actor container's
`APIFY_PROXY_PASSWORD`. Leave it unset and the variable is simply absent from every Actor container -
never a placeholder value.

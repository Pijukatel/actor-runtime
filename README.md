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
npm run build        # recompile locally - tsc, no apify push
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

## Multi-actor demo: calling another Actor (and one that isn't here)

`sample_actor_multi` is a trivial caller. It calls two Actors in turn and pushes one dataset item per
call, so both outcomes are visible in `apify datasets info` and in the console:

1. `localActorId` (default `my-actor`, i.e. `sample_actor_ts`) - an Actor already pushed to this
   runtime, so the call is served locally.
2. `remoteActorId` (default `apify/hello-world`) - an Actor this runtime doesn't have. The call fails,
   the failure is recorded, and the run carries on rather than crashing.

```bash
cd sample_actor_ts && apify push        # the local callee
cd ../sample_actor_multi && apify push
apify call                              # first call succeeds, second one doesn't
```

The second call is the interesting one: switch the upstream API fallback on and the same unresolvable
Actor id is relayed to the real Apify platform instead of 404ing, so the call really runs there.

```bash
apify api POST /actor-runtime/api-fallback --body '{"fallbackNotFoundEnabled": true}'
apify call                              # now both calls succeed
```

Both Actor ids are inputs, so `apify call --input '{"remoteActorId": "your-username/your-actor"}'`
points the second call at whatever you have on the platform. Note what the toggle costs: it forwards
the token the failing call authenticated with to `upstreamBaseUrl`, and because the relayed request is
a `POST` it starts a real, billable run on that account. Both toggles are off on every start and reset
to off on restart - see `requirements/api.md`'s "Upstream fallback" section.

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

While bumping, check whether the `pnpm.overrides` pin on `@crawlee/fs-storage-native` in
`package.json` is still needed: it forces the first release with linux-arm64 bindings
(`0.1.5-beta.19`, API-identical to the `0.1.5-beta.18` that released `@crawlee/fs-storage`
versions still depend on). Once the bumped `@crawlee/fs-storage` depends on `>= 0.1.5-beta.19`
on its own, delete the override.

## Apify Proxy

Set `APIFY_PROXY_PASSWORD` in the runtime container's own environment (e.g. `docker run -e
APIFY_PROXY_PASSWORD=your-password ...`) to have it forwarded, unscoped, into every Actor container's
`APIFY_PROXY_PASSWORD`. Leave it unset and the variable is simply absent from every Actor container -
never a placeholder value.

# CLI

## Supported client

- The supported client for the Actor development loop is the **stock, unmodified
  [`apify-cli`](https://docs.apify.com/cli/docs)** from npm (`npm install -g apify-cli`,
  verified against v1.8.0). No forked or patched CLI is required or shipped.

## Pointing the CLI at the local runtime

- The CLI is redirected to the local runtime API through the environment variable
  **`APIFY_CLIENT_BASE_URL`**, set to the runtime's API URL (for example
  `http://localhost:3333`).
- The client issues requests against `<APIFY_CLIENT_BASE_URL>/...`.
- The CLI is redirected to the local runtime frontend through the environment variable
  **`APIFY_CONSOLE_URL`**, set to the runtime's API URL (for example
  `http://localhost:3000`).

## User bootstrap

- The single default user is created **by the runtime itself** at startup (see `storage.md`'s Users
  section) - the CLI never creates it.
- Users are expected to already be logged in (`apify login`, done once, outside the runtime's
  quickstart) before starting the dev loop against the runtime. Login itself simply authenticates the
  CLI against that already-existing user: any non-empty token is accepted, and `GET /v2/users/me`
  (which `apify login` and `apify info` both call) returns that user's `username`/`id`. There is no
  separate account or token to obtain - any stored token maps to the same single local user.
- **No magic login anywhere**: the runtime never fabricates or injects a token, and never writes to
  the CLI's own credential store. Any non-empty token still authenticates (above); on top of that, the
  runtime tries once, lazily, to find out whether the token is actually a _real_ Apify account token.
- **Real-console bootstrap**: on the first authenticated request seen for a given token, the runtime
  sends that same token to the real platform - `GET https://api.apify.com/v2/users/me` (base URL
  overridable via `APIFY_UPSTREAM_API_BASE_URL`, for tests/non-production platforms), with a short
  (~3s) timeout and no retries:
    - **Success** (a real token, real account reachable) - the runtime's single user record _adopts_
      that account's real `username`, `id`, and Apify Proxy password, and returns them from
      `GET /v2/users/me` /`GET /v2/users/:userId` from then on. The record's internal id (what every
      Actor/build/run/storage is actually owned by) never changes - only the DTO now prefers the real
      identity for display.
    - **Failure** (offline, non-200, timeout, or the token simply isn't a real one) - no error, no
      behavior change: the existing single local user (`username: "local-user"`) keeps being returned,
      exactly as before. One concise log line is printed (e.g. "could not resolve token against
      api.apify.com, using local identity").
    - The outcome (success or failure) is cached per token for the life of the process, so this happens
      once per token, not on every request; a negative outcome also stays cached (this is a dev tool - an
      offline runtime stays "local identity" for its whole run, it does not keep re-probing a dead
      upstream).
    - This check is lazy and per-token: it never runs at startup and never blocks the runtime from
      listening.
- **Proxy password precedence**: the same "adopted, real" proxy password (when known) is also what the
  runtime forwards as `APIFY_PROXY_PASSWORD` into every Actor run container (see `actor-driver.md`),
  with the runtime's own `APIFY_PROXY_PASSWORD` environment variable (explicit operator config) always
  taking precedence when set. Never a placeholder: with neither a runtime env var nor an adopted
  password, `/users/me`'s `proxy` field is omitted entirely and no `APIFY_PROXY_PASSWORD` is set on run
  containers.
- **Interplay with `apify-cli`'s own `auth.json` refresh**: `getLoggedClient()` (in the CLI itself)
  refreshes `~/.apify/auth.json`'s cached user metadata - including `proxy.password` - from whatever
  `GET /users/me` returns, on every authenticated command. With a real token and the real platform
  reachable, that cached metadata is the real account's own metadata either way, so nothing regresses.
  Fully offline (no route to `api.apify.com`), the runtime's local identity is what gets cached into
  `auth.json` until the next command that _does_ reach the real platform refreshes it back - the CLI's
  stored token itself is never touched or overwritten by any of this.

## Supported commands (POC)

- `apify push` - creates the Actor and Actor version from local source and triggers
  a build.
- `apify call` - starts a run against the built Actor, streams its log, waits for it
  to finish, and reports the run's default storages; `--json` prints the run's id
  and default storage ids as JSON on stdout (the human-readable progress log still
  streams to stderr). This is the documented way to drive both sample Actors with an input
  (`apify call --input '{"maxPages":3}'`).
- `apify info` - prints the currently authenticated account's username
- `apify runs ls` - lists an Actor's runs
- `apify datasets info <id>` - prints a dataset's metadata, including `itemCount`; used to inspect a
  run's default dataset after `apify call` finishes.
- `apify api` - sends API requests

## Out of scope

- `apify login` interactive flows and real credential management.

## Offline-capability note

- This note is scoped to the CLI's own interaction with the **runtime**
  (push/build/call/log-stream/storage-access) - not to what an Actor's own code does over the network
  once `apify call` starts it running.
- The very **first** `apify push` that creates a brand-new Actor is not offline-capable: stock
  `apify-cli` fetches the actor-templates manifest from the internet the first time it needs to create
  an Actor. Every push/call/log-stream/storage-access afterwards, and every build of an
  already-pulled base image, works with no outbound network access (see `system.md`'s offline-after-
  first-build note).
- The bundled sample Actors crawl the live web (`https://crawlee.dev/` by default), so an `apify call`
  that runs one of them needs outbound network access from the Actor container even though the
  CLI-to-runtime interaction itself does not (see `system.md`).
- A repeat `apify push` of an Actor whose local source is unmodified since its last successful build
  will fail with the stock CLI's "already on the platform and was modified there since modified
  locally" error and requires `--force` to proceed: the runtime bumps the Actor's `modifiedAt` when a
  build completes, so the server-side timestamp ends up newer than the local files' mtimes. This is
  expected CLI behavior, not a runtime defect.

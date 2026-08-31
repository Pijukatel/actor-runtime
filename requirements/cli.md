# CLI

## Supported client

- The supported client for the Actor development loop is the **stock, unmodified
  [`apify-cli`](https://docs.apify.com/cli/docs)** from npm (`npm install -g apify-cli`,
  verified against v1.8.0). No forked or patched CLI is required or shipped.

## Pointing the CLI at the local runtime

- The CLI is redirected to the local runtime API through the environment variable
  **`APIFY_CLIENT_BASE_URL`**, set to the runtime's API URL (for example
  `http://localhost:3333`).
- The CLI is redirected to the local runtime frontend through the environment variable
  **`APIFY_CONSOLE_URL`**, set to the runtime's console frontend URL (for example
  `http://localhost:3000`).

## User bootstrap

- The user is created by the runtime itself at the time of the first API request against the runtime
  with a previously unseen token.
- Users are expected to already be logged in (`apify login`, done once, outside the runtime's
  quickstart) before starting the dev loop against the runtime.
- The runtime never fabricates or injects a token, and never writes to the CLI's own credential store.
- On the first authenticated request seen for a given token, the runtime sends that same token to the
  real platform - `GET https://api.apify.com/v2/users/me` (base URL overridable via
  `APIFY_UPSTREAM_API_BASE_URL`, for tests/non-production platforms), with a short (~3s) timeout and
  no retries:
    - **Success** (a real token, real account reachable) - the runtime creates a user for this token
      with the real `username`, `id`, and Apify Proxy password, and returns them from
      `GET /v2/users/me` / `GET /v2/users/:userId` from then on when called with the corresponding
      token.
    - **Failure** (offline, non-200, timeout, or the token simply isn't a real one) - no error, no
      behavior change: the runtime creates a local user with name `local-user-{number}` and fabricated
      id `0000000000000000{number}` (where {number} is an increasing count of fabricated users). One
      concise log line is printed (e.g. "could not resolve token against api.apify.com, using local
      identity").
- Both real and fabricated users are persisted across runtime restarts: the same token resolves to
  the same user on every subsequent request.
- **Proxy password**: the adopted real proxy password (when known) is forwarded as
  `APIFY_PROXY_PASSWORD` into every Actor run container, with the runtime's own
  `APIFY_PROXY_PASSWORD` environment variable taking precedence when set (see `actor-driver.md`).
  With neither source, `/users/me`'s `proxy` field is omitted and no `APIFY_PROXY_PASSWORD` is set
  on run containers - never a placeholder.

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
  `apify-cli` fetches its actor-templates manifest from the internet. Every later
  push/call/log-stream/storage-access, and every build of an already-pulled base image, needs no
  outbound network access (see `system.md`'s offline-after-first-build note) - unless the opt-in
  upstream API fallback is enabled (`api.md`, "Upstream fallback"), in which case an eligible local
  miss makes one outbound request to the configured upstream instead of failing offline.
- The bundled sample Actors crawl the live web (`https://crawlee.dev/` by default), so an `apify call`
  that runs one of them needs outbound network access from the Actor container even though the
  CLI-to-runtime interaction itself does not (see `system.md`).
- A repeat `apify push` of an Actor whose local source is unmodified since its last successful build
  will fail with the stock CLI's "already on the platform and was modified there since modified
  locally" error and requires `--force` to proceed: the runtime bumps the Actor's `modifiedAt` when a
  build completes, so the server-side timestamp ends up newer than the local files' mtimes. This is
  expected CLI behavior, not a runtime defect.

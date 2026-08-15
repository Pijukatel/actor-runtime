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
  section) - the CLI never creates it. `apify login --token <anything>` simply authenticates the CLI
  against that already-existing user: any non-empty token is accepted, and `GET /v2/users/me` (which
  `apify login` and `apify info` both call) returns that user's `username`/`id`.

## Supported commands (POC)

- `apify login --token <anything>` - authenticates against the runtime's single default user (any
  non-empty token works; see "User bootstrap" above). Interactive login flows are out of scope.
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

## Out of scope

- `apify login` interactive flows and real credential management.

## Offline-capability note

- The very **first** `apify push` that creates a brand-new Actor is not offline-capable: stock
  `apify-cli` fetches the actor-templates manifest from the internet the first time it needs to create
  an Actor. Every push/call/log-stream/storage-access afterwards, and every build of an
  already-pulled base image, works with no outbound network access (see `system.md`'s offline-after-
  first-build note).
- A repeat `apify push` of an Actor whose local source is unmodified since its last successful build
  will fail with the stock CLI's "already on the platform and was modified there since modified
  locally" error and requires `--force` to proceed: the runtime bumps the Actor's `modifiedAt` when a
  build completes, so the server-side timestamp ends up newer than the local files' mtimes. This is
  expected CLI behavior, not a runtime defect.

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
- The system performs one time `apify info` call to extract currently logged user and save it as the default user.
  - username: ...
  - userId: ...

## Supported commands (POC)
- `apify push` - creates the Actor and Actor version from local source and triggers
  a build.
- `apify call` - starts a run against the built Actor, streams its log, waits for it
  to finish, and reports the run's default storages; `--json` prints the run's id
  and default storage ids as JSON on stdout (the human-readable progress log still
  streams to stderr).
- `apify info` - prints the currently authenticated account's username
- `apify runs` - lists an Actor's runs

## Out of scope
- `apify login` interactive flows and real credential management.

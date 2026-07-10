# CLI

## Supported client

- The supported client for the Actor development loop is the **stock, unmodified
  [`apify-cli`](https://docs.apify.com/cli/docs)** from npm (`npm install -g apify-cli`,
  verified against v1.7.0). No forked or patched CLI is required or shipped.

## Pointing the CLI at the local runtime

- The CLI is redirected at the local runtime through the environment variable
  **`APIFY_CLIENT_BASE_URL`**, set to the runtime's API URL (for example
  `http://localhost:8080`). This is the base URL that `apify-cli` passes to its
  underlying `apify-client`; `apify push` and `apify call` both honour it.
  (Confirmed by a spike: the other candidates `APIFY_API_BASE_URL` /
  `APIFY_CLIENT_API_URL` / `APIFY_API_PUBLIC_BASE_URL` are not the variable the
  push/call HTTP calls use.)
- The client issues requests against `<APIFY_CLIENT_BASE_URL>/v2/...`.

## Authentication / token bootstrap

- The runtime has no real authentication (single always-logged-in user). The CLI
  still requires a token to be present, so set **`APIFY_TOKEN`** to any non-empty
  dummy value (for example `local-runtime-dummy-token`). The runtime ignores the
  token value.
- No `apify login` step and no `~/.apify/auth.json` set-up are needed when
  `APIFY_TOKEN` and `APIFY_CLIENT_BASE_URL` are exported in the environment.

## Supported commands (first draft)

- `apify push` - creates the Actor and Actor version from local source and triggers
  a build. Source is uploaded inline as `sourceFiles` (no tarball for small Actors).
- `apify call` - starts a run against the built Actor, streams its log, waits for it
  to finish, and reports the run's default storages.

## Out of scope

- Modifying, forking or vendoring the CLI.
- `apify login` interactive flows and real credential management.

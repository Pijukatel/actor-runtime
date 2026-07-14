# CLI

## Supported client

- The supported client for the Actor development loop is the **stock, unmodified
  [`apify-cli`](https://docs.apify.com/cli/docs)** from npm (`npm install -g apify-cli`,
  verified against v1.7.0). No forked or patched CLI is required or shipped.

## Pointing the CLI at the local runtime

- The CLI is redirected at the local runtime through the environment variable
  **`APIFY_CLIENT_BASE_URL`**, set to the runtime's API URL (for example
  `http://localhost:3333`). This is the base URL that `apify-cli` passes to its
  underlying `apify-client`; `apify push` and `apify call` both honour it.
  (Confirmed by a spike: the other candidates `APIFY_API_BASE_URL` /
  `APIFY_CLIENT_API_URL` / `APIFY_API_PUBLIC_BASE_URL` are not the variable the
  push/call HTTP calls use.)
- The client issues requests against `<APIFY_CLIENT_BASE_URL>/v2/...`.

## Authentication / token bootstrap

- The runtime has **placeholder authentication with no passwords**: the value of
  **`APIFY_TOKEN`** selects the acting user. `apify-client` sends it as
  `Authorization: Bearer <token>`; the runtime sanitizes it into a username and
  auto-creates that user on first use. **Changing `APIFY_TOKEN` switches the user**
  you act as (matching how the real platform's CLI resolves the token to a user) —
  everything you push, build or run belongs to that user, and one user cannot see
  another user's Actors, builds, runs or storages.
- Set `APIFY_TOKEN` to any non-empty value; there is no signup, no password and no
  real verification (an unknown token just becomes a new user). If `APIFY_TOKEN` is
  absent, requests fall back to the default user `local-user`, so existing scripts
  keep working unchanged.
- No `apify login` step and no `~/.apify/auth.json` set-up are required when
  `APIFY_TOKEN` and `APIFY_CLIENT_BASE_URL` are exported in the environment; switching
  users is just a matter of exporting a different `APIFY_TOKEN`.

## Supported commands (first draft)

- `apify push` - creates the Actor and Actor version from local source and triggers
  a build. Source is uploaded inline as `sourceFiles` (no tarball for small Actors).
- `apify call` - starts a run against the built Actor, streams its log, waits for it
  to finish, and reports the run's default storages.

## Out of scope

- Modifying, forking or vendoring the CLI.
- `apify login` interactive flows and real credential management.

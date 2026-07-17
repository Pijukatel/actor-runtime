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

- The runtime has **placeholder authentication with no passwords**, and identity
  is **decoupled from the credential**: the value of **`APIFY_TOKEN`** is a private
  token that *selects* a user, but is never turned into a username. `apify-client`
  sends it as `Authorization: Bearer <token>`. **Changing `APIFY_TOKEN` switches
  the user** you act as (matching how the real platform's CLI resolves the token to
  a user) — everything you push, build or run belongs to that user, and one user
  cannot see another user's Actors, builds, runs or storages.
- How a token resolves:
  - **The first token ever presented** binds ("bootstraps") the default user
    `local-user` — it becomes that user's stored token, and you act as `local-user`.
  - **A token matching an existing user** acts as that user (users are created
    explicitly, e.g. via the console/API; a created user's token equals its name).
  - **An unknown token** (once the default user's credential is already claimed) is
    **rejected with `401 invalid-token`** — it is never auto-provisioned into a new
    user.
- If `APIFY_TOKEN` is **absent**, requests fall back to the default user
  `local-user` and are never rejected, so existing scripts keep working unchanged.
- No `apify login` step and no `~/.apify/auth.json` set-up are required when
  `APIFY_TOKEN` and `APIFY_CLIENT_BASE_URL` are exported in the environment; switching
  users is just a matter of exporting a different `APIFY_TOKEN`.
- **Caveat for previously logged-in CLIs:** a CLI that HAS run `apify login` may
  present its stored `auth.json` token instead of the exported `APIFY_TOKEN`
  (observed with v1.7.x). The flow still works — whatever token arrives first
  simply binds `local-user` — but scripts must not assume the bound credential
  equals their env value: read-backs should either reuse the same client or send
  **no token at all** (the never-rejected default-user fallback), as
  `scripts/demo.sh` does.

## Supported commands (first draft)

- `apify push` - creates the Actor and Actor version from local source and triggers
  a build. Source is uploaded in one of two shapes, chosen by total size: under the
  ~3 MB threshold it goes **inline** as `sourceFiles` (`sourceType=SOURCE_FILES`);
  at or above the threshold the CLI zips the source, uploads the zip to a key-value
  store record, and sets `sourceType=TARBALL` with a `tarballUrl` pointing at that
  record. The runtime builds whichever shape was pushed (see `api.md`).
- `apify call` - starts a run against the built Actor, streams its log, waits for it
  to finish, and reports the run's default storages.

## Out of scope

- Modifying, forking or vendoring the CLI.
- `apify login` interactive flows and real credential management.

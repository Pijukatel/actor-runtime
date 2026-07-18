# Mandatory end-to-end tests
## Actor full dev loop 
Test case must verify full Actor development flow:
 - Create Actor using [apify cli](https://docs.apify.com/cli/docs) and push it to the local actor runtime
 - Build the pushed Actor in local actor runtime
 - Run Actor in local actor runtime
 - Get results when Actor run finishes
 - Fetch all default storages of this Actor run:
   - key value store
   - dataset
   - request queue

## CLI redirect mechanism (confirmed)
The test points the stock `apify-cli` at the local runtime by exporting
`APIFY_CLIENT_BASE_URL=<runtime API URL>` together with an `APIFY_TOKEN` (see
`cli.md`). The token value selects the acting user; the e2e flow uses
`APIFY_TOKEN=local-user` so its hard-coded `local-user~<name>` ids resolve.
`apify push` performs both the push and the build; `apify call` starts and waits
for the run. No CLI patch is needed.

## On-demand Actor discovers and calls a standby Actor
Test case must verify the standby-actor flow end to end, using two fixture
Actors driven by the full Apify SDK `Actor` lifecycle
(`sample_actor_standby/`, `sample_actor_caller/`):
 - Push a standby-enabled Actor (`.actor/actor.json` with `usesStandbyMode: true`)
   and a plain on-demand Actor.
 - Before any request reaches it, the standby Actor has no running container.
 - Run the on-demand Actor with the standby Actor's id as input; from inside its
   own container it uses `APIFY_API_BASE_URL` + its own `APIFY_TOKEN` (no
   hardcoded URL/port) to look up the standby Actor and read its `standbyUrl`,
   then calls that URL container-to-container.
 - The on-demand run reaches `SUCCEEDED` and its output shows the standby
   Actor's real response including its `reply` field (proving the round trip);
   the caller also saves that response into its own default dataset, and the
   standby Actor saves one dataset record per call it served into its own
   run's dataset (both written through the runtime API). The standby Actor's
   run is warm and inspectable, then reaches a terminal state on its own after
   its (test-shortened) idle timeout, without any further request.
 - Runs in `tests/e2e/test_standby.py`, following the same Docker/`apify-cli`
   skip pattern as `tests/e2e/test_e2e.py`.

## Real apify SDK is_at_home + API round-trip
Test case must verify that the real `apify`/`apify-client` SDK -- pip-installed
at image build time, like every `sample_actor*` fixture -- running inside a
real Actor container reports `is_at_home` the way `Actor.is_at_home()` itself
computes it, calls back into the runtime's own API through
`Actor.new_client()` using its injected `APIFY_TOKEN`, and pushes its result
into its own default dataset through `Actor.push_data()` (not local disk):
pushed/run via `apify-cli` like the other e2e cases, then the run's dataset is
read back over the API to assert `is_at_home is True`, the resolved user
matches the run's owner, and the dataset id matches the run's real
`defaultDatasetId`. Runs in `tests/e2e/test_isathome.py`, following the same
Docker/`apify-cli` skip pattern as `tests/e2e/test_e2e.py`.

## Mandatory multi-user, isolation and storage-sharing tests
Automated coverage (runnable Docker-free via the in-process `wired` fixture, with
the acting user set per request through `Authorization: Bearer <token>`) MUST
exist for:
 - **Decoupled identity & credential** — a user is `{ username, token }`: the
   username is the public identity and the token is a private credential that only
   selects the acting user and is never derived into a username. Coverage MUST
   assert:
   - a token selects a user, and a user's username and token are independent (not
     required to be equal);
   - **no token** maps to the default `local-user` and is **never rejected** (at any
     point in the instance's lifecycle);
   - the **first token ever presented bootstraps** the default user (`local-user`)
     and later persists, while a no-token request still resolves to `local-user`;
   - an **unknown token** (once any token is claimed) is **rejected with `401
     invalid-token`** in the Apify envelope, with no user/Actor created as a side
     effect.
 - **User management** — creating a user by name yields `username == token == name`;
   a duplicate name is a `409` conflict; listing users returns every user with its
   token; the current-user endpoint returns the acting user's username and token.
 - **THE ANTI-LEAK GUARANTEE (mandatory, standing regression check)** — scoped to
   exactly the **first bound token**: the credential `apify-cli`'s first-ever
   request presents, bound to the default `local-user`, which may be a real
   externally-issued secret. Presenting an arbitrary secret-looking token as
   that first-ever token and pushing → building → running an Actor MUST leave
   the raw token substring (and any fragment of it) absent from **every**
   durable/user-visible surface: the Actor id, the serialized `userId`/`username`
   on the Actor, its build and its run, the Docker image tag, every run/Actor
   storage id, and **every env var of any run for any user — including
   `APIFY_TOKEN` itself**; each identity field MUST equal the (bootstrapped)
   default username. This guarantee is deliberately narrower than "no token-like
   value may ever appear in container env": every OTHER token the runtime hands
   out — every user's fabricated `container_token`, which is exactly what
   `APIFY_TOKEN` holds for every run (see "Environment-variable alignment"
   below) — is a runtime-generated credential, not the bound secret, and is
   safe (and required) to appear there. Coverage MUST also assert the positive
   half: `APIFY_TOKEN` is nonetheless a WORKING bearer credential for the run's
   owner (including for `local-user`'s own runs), so the guarantee's narrower
   scope is never mistaken for "`APIFY_TOKEN` doesn't work" or "no exception for
   `APIFY_TOKEN` is needed" — both halves are checked side by side in
   `tests/unit/test_multi_user.py::test_secret_token_never_leaks_into_ids_responses_or_env`.
 - **Per-user ownership** — Actors, Builds and Runs are owned by the acting user
   and serialized as such; two users may hold identically named Actors without
   collision.
 - **Strict isolation** — list endpoints return only the acting user's objects; a
   cross-user get/mutate by id (Actor, Build, Run) returns 404 `record-not-found`,
   indistinguishable from a missing id.
 - **Run-storage isolation** — a run's default key-value store, dataset and request
   queue are private to the run's owner; cross-user reads AND writes by id return
   404 `record-not-found` and have no effect.
 - **Storage sharing** — the owner can grant another user READ or WRITE on an
   individual storage, list current grantees, and revoke:
   - a READ grantee can read where they previously got 404; a WRITE grantee can
     read and write, and the owner sees the grantee's write;
   - a READ grantee attempting a write is refused with a **forbidden** response
     (403 `insufficient-permissions`), observably distinct from the 404
     `record-not-found` returned with no access at all;
   - management is **owner-only** — a non-owner or grantee cannot grant, list or
     revoke, and cannot escalate; sharing is per-storage (one grant exposes exactly
     one storage, not the run/build/Actor or the owner's other storages);
   - revoking returns the storage to 404 for that user, contents unchanged.

## Mandatory standby-actor tests (standing regression checks)

Automated coverage (Docker-free via the in-process `wired` / `wired_fast_standby`
fixtures, backed by `StubDriver`'s in-process fake standby target — see
`tests/unit/test_standby.py`) MUST exist for:
 - **Opt-in parsing** — `usesStandbyMode: true` in a pushed `.actor/actor.json`
   enables standby and a `standbyUrl` field appears on the serialized Actor; an
   Actor pushed without it has no `standbyUrl` (absent, not null); an explicit
   `actorStandby` field on the SAME create/update call takes precedence over
   `.actor/actor.json` (matching apify-core); a non-standby Actor's on-demand
   run behaves exactly as before (regression).
 - **Environment-variable alignment (every run, on-demand and standby)** —
   `APIFY_IS_AT_HOME=1`; `APIFY_API_BASE_URL` is a well-formed URL naming the
   runtime's own API host; `APIFY_TOKEN` is the run owner's `container_token` —
   a WORKING bearer credential for that owner (verified for at least two
   different users, showing it tracks the owner rather than being constant),
   and never equal to that owner's bound `token`; the default storage id env
   vars equal the run's real ids; both `APIFY_ACTOR_ID`/`ACTOR_ID` and
   `APIFY_ACTOR_RUN_ID`/`ACTOR_RUN_ID` are present and pairwise equal.
 - **Warm start, readiness, forwarding, authorization** — before any request,
   a standby Actor has no running container; the first request starts one,
   waiting for a 200 to the `x-apify-container-server-readiness-probe` header
   on `ACTOR_STANDBY_PORT` before forwarding; method, path, query string,
   headers and body reach the Actor unchanged, INCLUDING repeated header
   names surviving in either direction (e.g. multiple `Cookie` headers from
   the caller, multiple `Set-Cookie` headers from the Actor — never collapsed
   to only the last value); the response is genuinely **streamed** back to
   the caller, not buffered in full before the first byte (proven with a fake
   standby target that writes its body in several flushed chunks with a real
   delay between them and closes the connection instead of declaring
   `Content-Length`, driving the router function directly so the test can
   observe the timing of individual chunks — httpx's `ASGITransport` itself
   fully drains a `StreamingResponse` before returning anything, so it cannot
   be used to observe this); a second request while still warm reuses the
   same container (no second run, e.g. an in-memory counter on the fixture
   Actor increments); concurrent first callers for the same actor start
   exactly one container; a missing or unknown token is `401` and starts
   nothing; a cross-user request is `404` and starts nothing (same visibility
   rule as every other Actor endpoint); an unknown or non-standby actor id is
   `404`, never a silent on-demand run; a standby Actor that never becomes
   ready fails observably (`503`), never hangs; a `driver.start()`
   infrastructure failure (e.g. the shared Docker network unavailable) is a
   `500` naming the real cause, never the same `404` used for "no successful
   build" (the build is fine; only launching the container failed); an unset
   `memoryMbytes` in the Actor's standby config resolves to the SAME value
   (the 1024 MB default) in both the persisted `run.options.memoryMbytes` and
   the actual container's memory cap passed to the driver, never a divergence
   where the API reports a cap that isn't really enforced.
 - **Idle timeout and teardown** — after the actor's idle timeout (a
   `Settings`/env override lets tests use a near-instant value instead of the
   300s/5s-minimum production default) with no forwarded requests, the runtime
   stops and removes the container on its own — no further request required —
   and the run reaches a terminal status; a request after teardown re-triggers
   a fresh cold start (a new run), never a reuse of the dead container; a
   single forwarded request that is still actively being served — including a
   slow, multi-chunk streamed response — is NEVER torn down mid-flight no
   matter how long it runs past `idleTimeoutSecs`, since the idle clock only
   counts time with no in-flight request, not time since the request started;
   aborting a standby run out-of-band (`POST .../abort`) reaps its container,
   drops the manager's bookkeeping so the next request cold-starts, AND
   imports whatever the Actor had written to its default key-value
   store/dataset/request queue up to that point (exactly like an idle-timeout
   teardown does — an explicit abort must not discard a standby run's output),
   taking the same per-actor lock `ensure_standby_run()`/
   `reap_idle_standby_runs()` use so an abort can never race a concurrent cold
   start into two live containers for one actor; the reap pass and a
   concurrent request for the same actor serialize on that same per-actor
   lock, so a request arriving right at the idle boundary always resolves
   cleanly (a cold start or a warm reuse), never a broken/dropped request; a
   background reap pass that raises (a transient error) is logged and does NOT
   kill the watchdog loop — later passes still run and still reap idle
   standby runs; a standby run's container stdout/stderr is captured into
   `Run.log` at reap/teardown time (idle or explicit abort), since standby
   runs have no live log-streaming sink the way the blocking one-shot run path
   does.
 - **Opt-in persistence** — an explicit `actorStandby` override set via the API
   on one create/update call persists across a LATER call that carries only a
   `.actor/actor.json`-bearing push (no `actorStandby` field on that later
   call): the override is not silently reverted by re-inferring from
   `usesStandbyMode`, but a later call that itself carries an explicit
   `actorStandby` field still takes precedence (matching design decision 2
   exactly).
 - **Docker networking fallback** (driver-level, `DockerDriver` with a fake
   docker client, no daemon needed) — if the shared user-defined network
   cannot be created or found at boot, on-demand `run()` falls back to
   Docker's default bridge network (on-demand runs are unaffected by a standby
   networking failure) while the non-blocking `start()` used for standby runs
   raises a clear, actionable error instead of referencing a network that
   doesn't exist or silently degrading to an unreachable container.

## Mandatory Actor-source build tests (standing regression checks)

Automated, Docker-free coverage (via the in-process `wired` fixture, with the
StubDriver capturing the materialized build directory before cleanup) MUST exist
and keep passing for the runtime's two source-upload shapes and the no-stale-source
guarantee:
 - **Inline (`SOURCE_FILES`) build** — an inline push builds the exact pushed files
   (both TEXT and BASE64) at their given paths, reaching `SUCCEEDED`.
 - **Tarball (`TARBALL`) build** — a zip PUT to a key-value store record and
   referenced by a version's `tarballUrl` builds the **unzipped** contents of that
   zip (right files, right paths, right bytes), reaching `SUCCEEDED`. The build must
   read the record using the store id/key embedded in the pushed `tarballUrl`
   verbatim (not a reconstructed store name).
 - **No stale source across a shape switch** — re-pushing the same Actor/version in
   the other mode (inline→tarball and tarball→inline) builds only the newest push's
   source; the previous shape's files never survive, and the serialized version
   reflects only the pushed shape (the other shape's fields cleared) independent of
   whether a build was triggered.
 - **Zip traversal safety** — a tarball whose zip contains an absolute-path or
   `..`-escaping entry reaches terminal `FAILED` and writes nothing outside the
   build directory (mirroring the inline `sourceFiles[].name` traversal guard).
 - **Clean failure on missing/corrupt tarball** — a `TARBALL` version whose record
   is missing, or whose bytes are not a valid archive, reaches terminal `FAILED`
   with a clear log line and a set `finishedAt` (never stuck RUNNING, never a silent
   empty/partial `SUCCEEDED`).

## Mandatory console routing / IA tests (standing regression checks)

Automated, Docker-free coverage (via the in-process `wired` fixture and structural
scans of the served `index.html` / `app.js`) MUST exist and keep passing for the
console's URL-path-based navigation and restructured information architecture:
 - **History-API routing (no hash).** The served `app.js` drives its view from
   `location.pathname`, navigates via `history.pushState`, re-renders on a
   `popstate` listener, and exposes a `navigate` helper and the storage slug→kind
   map; it never uses hash-based routing (`location.hash`) nor full-page navigation
   (`location.href` / `window.open(`) for routing.
 - **Top-level nav is Actors / Storage / Users only.** The served `index.html`
   exposes exactly these three top-level entries (`tab-actors`, `tab-storage`,
   `tab-users`); Builds and Runs are **not** top-level (`tab-builds` / `tab-runs`
   are absent) — they are reached only from an actor's detail page. Actor rows,
   run/build/storage rows and sub-tabs all build real paths and navigate via
   `pushState`.
 - **Build detail keyed by build number.** The served `app.js` build-detail path
   uses a build's **number** (e.g. `0.0.1`) in the URL and resolves it to a build id
   client-side by fetching the actor's builds list and matching on `buildNumber`;
   coverage asserts (behaviourally) that for an actor with multiple builds a given
   number resolves to the record whose `buildNumber` equals it, and different numbers
   resolve to different build ids.
 - **Server serves the SPA shell for deep links / refresh.** `GET` of every SPA path
   (`/actors`, `/actors/{id}`, `/actors/{id}/runs/{runId}`,
   `/actors/{id}/builds/{buildNumber}`, `/storage/datasets`,
   `/storage/datasets/{id}`, `/users`, and a non-existent resource such as
   `/actors/no-such~actor`) returns HTTP 200 with the console's `index.html`
   (recognizably the shell, e.g. contains `id="detail"` and the `/console/app.js`
   script), while an unknown `/v2/...` path still returns a **404** in the Apify
   error envelope (never the shell), `/console/app.js` still returns the JS asset,
   and `/` still returns `index.html`. The catch-all uses an allowlist on the first
   path segment and must not shadow the API.
 - **Storage detail inspects contents.** The served `app.js` renders
   `/storage/{slug}/{resourceId}` by reusing the shared content renderer with a kind
   derived from the slug (via the slug→kind map), and storage rows link to that
   detail path; coverage asserts (behaviourally) that both a named and a run-derived
   storage are inspectable via the existing per-storage read endpoints, and that
   inspection stays scoped to the acting user (a cross-user read is 404).

## Mandatory console/API behaviour tests (standing regression checks)

Automated, Docker-free coverage (via the in-process `wired` / `wired_streaming`
fixtures) MUST exist and keep passing for the following behaviours:
 - **Token-free user listing with no bootstrap** — `GET /v2/users` returns `200`
   and a well-formed user list with **no** `Authorization` header, and has **no
   bootstrap side effect**: presenting a bearer token to it (unknown, stale or
   valid) neither resolves nor claims a user. Coverage MUST assert that after
   calling it token-less (and after calling it *with* an unknown token), a
   subsequent first-ever token presented to a real authenticated endpoint still
   bootstraps the default user (proving the list never claimed a token), while the
   authenticated endpoints (`/v2/users/me`, real work) still bootstrap exactly as
   before. A structural check on the served console JS MUST confirm the user-list
   fetches carry no bearer while other calls do.
 - **Live log streaming (stub-tested)** — a streaming-capable stub driver
   (delivering its log in several chunks over short delays through the driver's
   log-sink) MUST let tests assert that `GET /v2/logs/{jobId}/stream`: delivers more
   than one distinct chunk, in order, over the lifetime of one in-progress request
   (with the concatenation equal to the eventual full log); stops at the terminal
   transition with no missing/duplicated content; returns the complete stored log
   for an already-finished job (fallback); is `404` for an unknown/cross-user id;
   and works for both runs and builds. The one-shot `GET /v2/logs/{jobId}` MUST keep
   returning the full stored log for finished jobs. A structural check on the served
   console JS MUST confirm the Log view consumes the streaming endpoint. (The real
   docker-py live-streaming path is verified on a Docker-enabled host/CI, not in
   this environment — no daemon here; all streaming criteria are satisfiable purely
   via the stub driver.)
 - **Top-level storage list / create / delete with isolation** — coverage MUST
   assert: a user can create a standalone storage by name and see it in the
   per-type `/v2/users/me/{key-value-stores,datasets,request-queues}` listings,
   marked `named: true`; listings are strictly scoped to the acting user (another
   user's storages never appear); delete is owner-only and removes the listing
   entry, the underlying data (a subsequent read is `404`), and any access-rights
   grants that referenced it (no dangling grant survives); deleting another user's
   or an unknown id is `404` (no existence leak, no effect); and run-derived
   storages are **included** in the top-level listing (owner-scoped), marked
   `named: false`, still undeletable via this view (`400 invalid-request`), with
   the run's storage left intact. Coverage MUST also assert the serialized `name`
   is the **empty string** for a run-derived storage (not its id) while a named
   storage keeps its given name, and that the console renders the named/run-derived
   distinction as a **✅ / ❌** glyph gated on the same `named` flag as the delete
   affordance.

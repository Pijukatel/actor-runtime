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
 - **THE ANTI-LEAK GUARANTEE (mandatory, standing regression check)** — presenting
   an arbitrary secret-looking token as the first-ever token and pushing → building
   → running an Actor MUST leave the raw token substring (and any fragment of it)
   absent from **every** durable/user-visible surface: the Actor id, the serialized
   `userId`/`username` on the Actor, its build and its run, the Docker image tag,
   every run/Actor storage id, and the container environment dict (all keys and
   values); each identity field MUST equal the (bootstrapped) default username.
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

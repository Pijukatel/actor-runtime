# API specification

- The API is a subset of the public Apify OpenAPI specification from
  `https://docs.apify.com/api/openapi.json`.
- The tag **`Actor Runtime API`** (added in the *draft, unmerged* PR
  https://github.com/apify/apify-docs/pull/2521, pinned to commit
  `1c2d459f47edbc696b0a0adf95970ae1d24e15c4`) only covers the **in-run SDK
  callback surface**: start run, run status/control (`/v2/actor-runs/*`),
  key-value store records (`/v2/key-value-stores/*`) and dataset items
  (`/v2/datasets/*`). It defines only a *portion* of the API this system needs -
  it has **no Actor build/push endpoints and no request-queue endpoints**.
- Because the mandatory e2e flow (see `test.md`) requires pushing source, building,
  and fetching the request queue, the local API is a **superset** of that tag. In
  addition to the tag above it implements, from the same public Apify spec:
  - Actor / version / build management (needed for `apify push` + build):
    - `GET /v2/users/me`
    - `GET|POST /v2/acts` and `/v2/actors` (list / create Actor; both spellings)
    - `GET|PUT /v2/acts/{actorId}` (get / update Actor)
    - `GET /v2/acts/{actorId}/versions/{versionNumber}`,
      `POST /v2/acts/{actorId}/versions`,
      `PUT /v2/acts/{actorId}/versions/{versionNumber}` (upload source files)
    - `GET|POST /v2/acts/{actorId}/builds`, `GET /v2/actor-builds/{buildId}`
    - `GET /v2/logs/{buildId|runId}` (build / run log)
  - Runs: `POST /v2/acts/{actorId}/runs`, `GET /v2/acts/{actorId}/runs`,
    `GET /v2/actor-runs/{runId}`, `POST /v2/actor-runs/{runId}/abort`
  - Request queues: `GET /v2/request-queues/{queueId}`,
    `GET /v2/request-queues/{queueId}/requests`,
    `POST /v2/request-queues/{queueId}/requests`
- Only the endpoints exercised by the mandatory e2e flow are implemented in this
  first draft; full coverage of the `Actor Runtime API` tag is deferred.
- The API requires no authentication (single implicit user); any/no token is
  accepted.

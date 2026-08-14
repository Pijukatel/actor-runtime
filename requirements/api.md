# API specification
- The API is implementing subset of the OpenAPI specification `https://docs.apify.com/api/openapi.json`

# Public API
- It implements these API paths:
  - Actors
    - v2/actors
    - v2/actors/:actorId
    - v2/actors/:actorId/builds
    - v2/actors/:actorId/builds/default
    - v2/actors/:actorId/runs
    - v2/actors/:actorId/versions
    - v2/actors/:actorId/versions/:versionNumber
  - Builds
    - v2/actor-builds
    - v2/actor-builds/:buildId
    - v2/actor-builds/:buildId/abort
    - v2/actor-builds/:buildId/log
  - Runs 
    - v2/actor-runs
    - v2/actor-runs/:runId
    - v2/actor-runs/:runId/abort
    - v2/actor-runs/:runId/log
  - Datasets
    - v2/datasets
    - v2/datasets/:datasetId/items
    - v2/datasets/:datasetId/statistics
  - Key-value stores 
    - v2/key-value-stores
    - v2/key-value-stores/:storeId
    - v2/key-value-stores/:storeId/keys
    - v2/key-value-stores/:storeId/records
    - v2/key-value-stores/:storeId/records/:recordKey
  - Request queues
    - v2/request-queues
    - v2/request-queues/:queueId
    - v2/request-queues/:queueId/requests/batch
    - v2/request-queues/:queueId/requests
    - v2/request-queues/:queueId/head
    - v2/request-queues/:queueId/head/lock
    - v2/request-queues/:queueId/requests/unlock
  - Logs
    - v2/logs/:buildOrRunId
  - Default run storages
    - v2/actor-runs/:runId/dataset
    - v2/actor-runs/:runId/dataset/items
    - v2/actor-runs/:runId/dataset/statistics
    - v2/actor-runs/:runId/key-value-store
    - v2/actor-runs/:runId/key-value-store/keys
    - v2/actor-runs/:runId/key-value-store/records
    - v2/actor-runs/:runId/key-value-store/records/:recordKey
    - v2/actor-runs/:runId/request-queue
    - v2/actor-runs/:runId/request-queue/requests/batch
    - v2/actor-runs/:runId/request-queue/requests
    - v2/actor-runs/:runId/request-queue/head
    - v2/actor-runs/:runId/request-queue/head/lock
    - v2/actor-runs/:runId/request-queue/requests/unlock

- The implemented API paths implement all http methods mandated by the OpenAPI specification.
- All endpoints from the specification that do not have implementation must return response `501 Not Implemented`
- All endpoints not present in specification must return `404 Not Found`

# Private API
- Not implemented 

## Upstream fallback (opt-in, off by default, all HTTP methods)
- Not implemented 



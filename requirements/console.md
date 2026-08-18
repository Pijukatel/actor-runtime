# Frontend

- Console frontend is simple view-only page that allows to inspect each user object.
- Server-rendered HTML from the same process that serves the API, on its own fixed port (3000). No
  SPA, no bundler, no build step - plain Express routes returning HTML strings. It reads through the
  same service layer as the API handlers, so ownership filtering is shared rather than reimplemented.
- Frontend shows for each object the owner (`userId`).
- There are three types of objects: key-value store, dataset, request queue.
    - For each object type there must be exactly one widget for inspection.
    - The request-queue widget leads with the authoritative counts from `RequestQueue.getInfo()`
      (`totalRequestCount`/`handledRequestCount`/`pendingRequestCount`) plus a requests table; it is the
      same in-process, best-effort id index the API's `GET /requests` uses (never `GET /head`/`POST/head/lock`, which would mutate queue state - see
      `storage.md`'s "Known differences from the Apify platform" - it reflects only what this runtime
      process has seen, not necessarily the whole queue, and does not survive a restart).

- It contains list view and detail view for following objects:
    - Actors
    - Actor builds
    - Actor runs
    - Logs
    - User owned storages
        - key-value stores
        - datasets
        - request queues

- List view is a list of objects that can be clicked on to open detail view.
- Detail view of an object is showing only one object with all the available data
- Log views render ANSI colors from actor output as HTML, while the `/v2/logs/:id` API keeps serving logs raw (unconverted) for the CLI to render itself.
- The console accepts the real Apify Console's URL shapes (as printed by stock apify-cli, e.g. `/actors/:actorId/runs/:runId`, `/storage/datasets/:id`) via redirects to its own pages.

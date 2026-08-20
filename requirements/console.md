# Frontend

- Console frontend is a page that allows inspecting each user's objects across the whole runtime.
- Server-rendered HTML from the same process that serves the API, on its own fixed port (3000). No
  SPA, no bundler, no build step - plain Express routes returning HTML strings. It reads through the
  same service layer as the API handlers, so storage/build/run access logic is shared rather than
  reimplemented.
- Frontend shows for each object the owner (`userId`).
- The console has no login of its own, so with multiple users it lists and shows every user's objects
  rather than scoping to one - the API's own endpoints stay strictly scoped to the calling token's user
  (`storage.md`'s "Users" section).
- The console is unauthenticated. Every route is a read except the dev-folder form below and the
  Settings form below, which are the console's only two writes - it is no longer strictly view-only.
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
    - Settings (a single page, not a list/detail pair - see "Settings page" below)

- List view is a list of objects that can be clicked on to open detail view.
- Detail view of an object is showing only one object with all the available data
- A run's default storage ids (`defaultDatasetId`, `defaultKeyValueStoreId`, `defaultRequestQueueId`) are
  rendered as links to the corresponding storage detail views (in the run detail view and in the runs
  list's dataset column), not as plain text.
- Log views render ANSI colors from actor output as HTML, while the `/v2/logs/:id` API keeps serving logs raw (unconverted) for the CLI to render itself.
- The console accepts the real Apify Console's URL shapes (as printed by stock apify-cli, e.g. `/actors/:actorId/runs/:runId`, `/storage/datasets/:id`) via redirects to its own pages.

## Local dev-folder registration form (Actor detail view)

- The Actor detail view shows the Actor's registered local dev folder, or that none is registered - the
  same status the API endpoint reports (`api.md`). It never claims a mount "will apply": that depends on
  which build a given run resolves, which this Actor-level view has no way to know in advance.
- A single-field form exposes the same registration capability as the API endpoint, with no build-first
  precondition either: submitting it sets or clears the dev folder, funnelling into the same
  validate-and-persist path, so the two surfaces can never observe or produce different outcomes for the
  same input. Submitting an empty value clears the registration, matching the API; a whitespace-only
  value is rejected as a malformed path, also matching the API.
- A submission that fails validation redirects back to the same detail page with the classified error
  message shown inline, never swallowed by the redirect.

## Settings page

- The last entry in every page's header navigation is "Settings", linking to `/settings` - the one page
  for the upstream API fallback toggles (`api.md`'s "Upstream fallback" section). Every other page's
  header nav also shows both toggles' current state next to that link, in the form
  `Settings — fallback (unimplemented: on|off, not-found: on|off)`, so neither toggle can ever be on
  without being visible from anywhere in the console; the two states are shown independently, never
  collapsed into a single word (a mixed state - one on, one off - is visually distinct from both-on and
  both-off).
- `/settings` itself shows `fallbackUnimplementedEnabled`, `fallbackNotFoundEnabled`, and
  `upstreamBaseUrl` (the same values the API's toggle endpoint reports), plus a one-line warning that
  enabling either toggle forwards the caller's own Apify token to that URL.
- A single form on the page has two checkboxes, "Fall back for unimplemented endpoints" and "Fall back
  for not-found records", and one submit. Submitting it always sends both checkboxes' current state
  together - an unchecked box is read as `false`, not as "leave this toggle unchanged" - and redirects
  back to `/settings` showing the result. This differs from the API's own partial `POST` (`api.md`),
  which only touches the field(s) a caller's body actually names; both surfaces write through the same
  underlying toggle state, so a flip made on one is immediately visible on the other and via the API's
  own `GET`, with no restart needed either way.
- Since the console has no login of its own, anyone who can reach it can flip either toggle for every
  caller of the API - the same unauthenticated, cross-user model the rest of the console already has, not
  a new exposure specific to this page.

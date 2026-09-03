# Frontend

- Console frontend is a page that allows inspecting each user's objects across the whole runtime.
- Server-rendered HTML on its own fixed port (3000); the console reflects the same live state the API serves.
- Frontend shows for each object the owner (`userId`).
- The console has no login of its own, so with multiple users it lists and shows every user's objects
  rather than scoping to one - the API's own endpoints stay strictly scoped to the calling token's user
  (`storage.md`'s "Users" section).
- The console is unauthenticated. Every route is a read except the console's only three writes: the
  dev-folder form, the run detail view's Migrate button, and the Settings form (all below).
- All three of those writes reject a submission that identifies itself as cross-site (via the
  `Sec-Fetch-Site` header) with a plain `403`; a submission that does not is unaffected.
- There are three types of objects: key-value store, dataset, request queue.
    - For each object type there must be exactly one widget for inspection.
    - The request-queue widget leads with the authoritative counts
      (`totalRequestCount`/`handledRequestCount`/`pendingRequestCount`) plus a requests table showing the
      same best-effort listing as the API's `GET /requests` (see `storage.md`'s "Known differences from
      the Apify platform"): only requests this runtime process has seen, not necessarily the whole queue,
      and not surviving a restart. Viewing the widget never mutates queue state.

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
- The Actor builds list, the Actor runs list, and the combined Logs list all show the most recently
  started build or run first.
- Detail view of an object is showing only one object with all the available data
- A run's default storage ids (`defaultDatasetId`, `defaultKeyValueStoreId`, `defaultRequestQueueId`) are
  rendered as links to the corresponding storage detail views (in the run detail view and in the runs
  list's dataset column), not as plain text.
- Log views render ANSI colors from actor output as HTML, while the `/v2/logs/:id` API keeps serving logs raw (unconverted) for the CLI to render itself.
- The console accepts the real Apify Console's URL shapes (as printed by stock apify-cli, e.g. `/actors/:actorId/runs/:runId`, `/storage/datasets/:id`) via redirects to its own pages.

## Local dev-folder registration form (Actor detail view)

- The Actor detail view shows the Actor's registered local dev folder, or that none is registered - the
  same status the API endpoint reports (`api.md`). It never claims a mount "will apply" (that depends on
  which build a given run resolves - `actor-driver.md`).
- A single-field form sets or clears the dev folder with exactly the API endpoint's behavior (`api.md`),
  including no build-first precondition: an empty value clears the registration; a whitespace-only value
  is rejected as a malformed path. For any given input, the form and the API produce the same outcome.
- A submission that fails validation redirects back to the same detail page with the classified error
  message shown inline, never swallowed by the redirect.

## Migrate button (run detail view)

- The run detail view shows the run's `migrationCount` and `rebootCount`, and a "Migration" section:
  for a `RUNNING` run, a Migrate button that triggers the same emulated migration as
  `POST /actor-runtime/migrate/:runId` (`api.md`); for any other status, a note that only a `RUNNING`
  run can be migrated, with no button.
- Pressing the button returns to the same detail page while the migration proceeds in the background.
  A press that raced the run ending shows the reason inline, never swallowed by the redirect.
- Like the dev-folder form, the button writes cross-user - the console's usual unauthenticated model.

## Settings page

- Every page's header navigation includes a link to `/settings`, the one page for the upstream API
  fallback toggles (`api.md`'s "Upstream fallback" section); the link itself shows each toggle's current
  value.
- `/settings` shows `fallbackUnimplementedEnabled`, `fallbackNotFoundEnabled`, and `upstreamBaseUrl`
  (the same values the API's toggle endpoint reports), plus a warning that enabling either toggle
  forwards the caller's own Apify token to that URL.
- The Settings page lets a caller set both toggles at once. Unlike the API's partial `POST` (`api.md`),
  submitting the form always sets both toggles explicitly - leaving one unchecked sets it to `false`,
  never "leave this toggle unchanged". A change made through either surface is immediately visible on
  the other, and via the API's own `GET`, with no restart needed either way.
- The console has no login, so anyone who can reach it can flip either toggle for every caller of the
  API.

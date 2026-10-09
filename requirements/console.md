# Frontend

- Console frontend is a page that allows inspecting each user's objects across the whole runtime.
- Server-rendered HTML on its own port (`system.md`); the console reflects the same live state the API serves.
- Frontend shows human-readable names instead of ids where possible: the owner by username, an Actor as
  `username~actorname` linked to its detail view (builds, runs and logs show only that, no separate owner),
  and a run's build by its build number.
- The console has no login of its own, so with multiple users it lists and shows every user's objects
  rather than scoping to one - the API's own endpoints stay strictly scoped to the calling token's user
  (`storage.md`'s "Users" section).
- The console is unauthenticated. Every route is a read except the console's only six writes: the
  pricing form, the dev-folder form, the debug-mode form, the browser-view form, the run detail view's
  Migrate button, and the Settings form (all below).
- All six of those writes reject a submission that identifies itself as cross-site (via the
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
    - Actor tasks
    - Webhooks, with their dispatches
    - Schedules
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
- The run detail view lists all of the run's storages by type and alias in a second column beside the
  run's fields. Storage ids there and in the runs list's dataset column are
  links to the storage detail views.
- A run whose debug plan resolved (`actor-driver.md`'s "Debug mode" section) gets one extra row on its
  detail view: `debug` - `<language>, attach at 127.0.0.1:<port>`. Absent entirely for a non-debug run.
  This field is local-only and never appears in the emulated `/v2` run object (`api.md`).
- A run with browser view (`actor-driver.md`) gets one extra row on its detail view: `browser view` - a
  link to its viewer page (below). Absent for other runs; never in the emulated `/v2` run object.
- Every run's detail view shows its `containerUrl` (the run's live view) as a link.
- Tasks are read-only, changed through the API (`api.md`'s "Tasks"). A task's detail view shows its saved
  input and run options, its Standby URL and settings when its Actor's Standby is on, and its runs. The
  Actor detail view lists the Actor's tasks, and a task run's detail view links its task as
  `username~taskname`.
- Webhooks are read-only, changed through the API (`api.md`'s "Webhooks"). A webhook's detail view shows
  its settings, templates and dispatches; a dispatch's detail view shows every delivery attempt. The
  Actor and task detail views list their webhooks.
- Schedules are read-only, changed through the API (`api.md`'s "Schedules"). A schedule's detail view shows
  its settings, actions, the runs it started and its log; a scheduled run's detail view links its schedule
  as `username~schedulename`. The Actor and task detail views list the schedules that run them.
- Log views render ANSI colors from actor output as HTML, while the `/v2/logs/:id` API keeps serving logs raw (unconverted) for the CLI to render itself.
- The console accepts the real Apify Console's URL shapes (as printed by stock apify-cli, e.g. `/actors/:actorId/runs/:runId`, `/storage/datasets/:id`) via redirects to its own pages.

## Pricing form (Actor detail view)

- The Actor detail view shows the Actor's pay-per-event pricing (`actor-driver.md`) and a form that sets
  it, with exactly the API's behaviour and validation for any given input. A rejected submission redirects
  back to the same detail page with the message shown inline, leaving the stored pricing unchanged.

## Usage and cost (run detail view)

- The run detail view shows the run's usage estimate (`actor-driver.md`), its charged events and its
  maximum total charge; the runs list shows each run's total cost.

## Local dev-folder registration form (Actor detail view)

- The form's field shows the Actor's registered local dev folder, empty when none is registered - the
  same status the API endpoint reports (`api.md`). It never claims a mount "will apply" (that depends on
  which build a given run resolves - `actor-driver.md`).
- A single-field form sets or clears the dev folder with exactly the API endpoint's behavior (`api.md`),
  including no build-first precondition: an empty value clears the registration; a whitespace-only value
  is rejected as a malformed path. For any given input, the form and the API produce the same outcome.
- A submission that fails validation redirects back to the same detail page with the classified error
  message shown inline, never swallowed by the redirect.

## Saving options

- Debug-mode, browser-view and settings forms save on change, without a page reload.

## Debug-mode form (Actor detail view)

- The Actor detail view shows the Actor's debug-mode toggle status - `(debug mode is off)`, or the
  resolved `language`/`port` when on - the same status the API endpoint reports (`api.md`).
- A form on the same view has a select (`No`/`auto`/`node`/`python`) and a `port` input (blank means
  no override). `No` turns debug mode off; any other choice turns it on with that `language`.
- For any given input, the form and the API endpoint produce the same outcome.
- A submission that fails validation redirects back to the same detail page with the classified error
  message shown inline, never silently applied.

## Browser-view form (Actor detail view)

- The Actor detail view shows the browser-view toggle status and a select: `No`, `Passive` (view-only),
  or `Interactive`. For any input, the form and the API produce the same outcome.

## Browser view page (`/runs/:runId/browser`)

- Shows the run's live display, view-only or interactive per the run's toggle, and says which. It reconnects
  on its own while the run's browser is still starting.
- For a run that has ended, or never had browser view, the page says so instead.

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
- The same form also holds a "Use Apify Proxy" checkbox, `apifyProxyEnabled`, on by default and back on
  after every restart. Turned off, runs get an empty `APIFY_PROXY_PASSWORD` and `/users/me` omits `proxy`
  (`actor-driver.md`); like the fallback toggles, an unchecked box on submit turns it off.

## Actor Standby (Actor detail view)

- Shows the standby settings, live standby runs, and the standby URL with the owner's token, as a link and
  a copy button (the token masked on screen). Read-only. The run detail view shows each run's origin.

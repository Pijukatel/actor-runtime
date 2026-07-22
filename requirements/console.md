# Frontend
- Console frontend is simplified version of https://console.apify.com
- It allows to inspect actors
- It allows to build actors
- It allows to inspect actor builds
- It allows to run actors
- It allows to inspect actor runs
- It allows to inspect an actor run's default storages:
  - key-value store
  - dataset
  - request queue
- It supports multiple users with **decoupled identity and credential** (no
  password, no real credential check): a user's token is stored client-side and
  sent as `Authorization: Bearer` on every request. The header shows the acting
  user, and switching the active token switches the user.
- It has a dedicated **Users** section (its own top-level tab) for managing the
  decoupled model by hand:
  - shows the **current user**, highlighted;
  - **lists all users**, each with its token shown as **masked text that reveals
    on click**;
  - lets you **switch** the acting user by **clicking a username** (the console
    reads that user's token from the list and sets it as the active bearer —
    client-side, no server switch endpoint and no password prompt);
  - lets you **create a user from a name alone** (a single name input; the new
    user's token equals its name); a duplicate name shows the conflict.
- The header's **"Switch user"** control is a **dropdown populated only from
  existing users** (via `GET /v2/users`) — no free-text token entry; selecting a
  user sets that user's token as the active bearer, refetching the list so a
  just-created user is immediately selectable.
- **Optional real-API fallback, controlled by one global header toggle.** Every
  API resource the console fetches is requested **local-first**: the single
  `api()` helper always tries the local actor-runtime API, and only when that
  attempt fails (a network error or a non-2xx status, e.g. the runtime's 404 for
  a resource that exists only on the platform) is the **same path retried once
  against the real Apify API** (`https://api.apify.com`). The behavior is
  governed by an **"API fallback" button in the header, next to the "Switch
  user" dropdown** — the header is part of the SPA shell, so the toggle can be
  flipped from any view. The state is **global** (persisted in `localStorage`,
  shared by every view and surviving navigation and reloads), **OFF by
  default** (the console never contacts the real platform unless asked to; a
  blocked `localStorage` also reads as OFF), and shown as an explicit
  `API fallback: ON`/`OFF` label (with `aria-pressed`) so the current state is
  always visible. Scope and semantics:
  - **Reads only.** Only a resource *fetch* (`GET`) ever falls back; mutations
    (`POST`/`PUT`/`DELETE`) never do — a failed local write surfaces as a
    failure rather than silently becoming a write against the real platform.
  - **Same credential.** The fallback request carries the same
    `Authorization: Bearer` token as the local one (identity and credential are
    decoupled, so a user whose stored token is a real Apify token gets their
    real account's resources; any other token is simply rejected by the real
    API). A `skipAuth` call stays token-free on both attempts.
  - **Never less informative.** If the fallback request itself fails at the
    network level, the local outcome (response or error) is kept, so enabling
    the toggle can only add information, never replace a local error with a
    worse one.
  - **Logs too.** The log view's streaming fetch follows the same rule; since
    the `/v2/logs/{id}/stream` path is a local addition, its fallback fetches
    the same resource at the real API's one-shot `GET /v2/logs/{id}` path.
  - The toggle is wired like every other control (`addEventListener`, no inline
    handlers, `textContent` only).
- **Navigation is URL-path based (History API), mirroring the official console.**
  The view is driven by `location.pathname` (real paths, never a hash fragment), so
  every view is deep-linkable and refresh-safe and the path shape matches
  `console.apify.com` — swapping `localhost:{port}` for `console.apify.com` yields a
  structurally valid link to the same resource. Navigation is client-side via
  `history.pushState`, Back/Forward are handled by a `popstate` listener, and the
  console server serves the app shell (`index.html`) for SPA paths so a deep link or
  refresh renders the right view. The path map:
  - `/` normalizes to `/actors`.
  - `/actors` — the acting user's Actors.
  - `/actors/{actorId}` — actor detail (a tabbed page with **Input**, **Runs** and
    **Builds** sub-tabs; bare path defaults to **Input**, mirroring the official
    console's own default landing tab). `{actorId}` is our `username~name` id used
    verbatim (the `~` is URL-path-safe and is never treated as a separator).
  - `/actors/{actorId}/input` — the actor's Input tab (see below); also reached by
    the bare `/actors/{actorId}` path's default and is where **Start** now lives
    (there is no separate header "Run" button/prompt dialog any more).
  - `/actors/{actorId}/runs` and `/actors/{actorId}/runs/{runId}` — the actor's runs
    list and a specific run's detail.
  - `/actors/{actorId}/builds` and `/actors/{actorId}/builds/{buildNumber}` — the
    actor's builds list and a specific build's detail, keyed by build **number**
    (e.g. `0.0.1`), not the internal build id; the console resolves the number to a
    build id client-side (from the actor's builds list) before rendering its log.
  - `/storage/{slug}` and `/storage/{slug}/{resourceId}` — a per-type storage list
    and a storage's detail, with `{slug}` one of `key-value-stores`, `datasets`,
    `request-queues`.
  - `/users` — the Users section (a local-only concept, no official equivalent).
- The **top-level navigation is exactly three sections — Actors / Storage / Users**,
  each scoped to the acting user (backed by the `/v2/users/me/actors` and
  `/v2/users/me/key-value-stores|datasets|request-queues` endpoints, and each actor's
  own `/v2/acts/{id}/input-schema|runs|builds`). Input, Runs and Builds are **not**
  top-level; they are reached only from their actor's detail page. From a Run, its
  own default storages remain browsable as before. Because every view is backed by
  the ownership-scoped API, a user never sees another user's objects or storages.
- **The Input tab autoloads the actor's input schema and offers two synced editing
  modes**, mirroring the official console's own Actor "Input" tab. Opening it fetches
  `GET /v2/acts/{actorId}/input-schema` exactly once (not on every keystroke or
  Form/JSON switch) and renders a **Form** view — one widget per schema property, in
  declaration order and grouped under any `sectionCaption` headings, mapping `string`
  to a text/textarea/select (an `enum` always wins a select), `integer`/`number` to a
  number input, `boolean` to a checkbox, an `array` with a `stringList`-style editor
  to an add/remove row list, and everything else (`object`, any other array, an
  unrecognized editor) to a labeled JSON sub-field — alongside a **JSON** view (a
  plain textarea holding the equivalent JSON). Both open pre-populated per property
  from `prefill` else `default` else omitted entirely, so the two views agree from
  the start — with one necessary exception: a `boolean` property that is both
  **required** and has neither `prefill` nor `default` still shows an unchecked
  (`false`) checkbox the moment the Form renders, and that `false` is a real,
  submittable value from the outset, because a checkbox has no third "unset" state
  to represent "omitted" and a required field must resolve to something. An
  **optional** boolean in the same situation stays entirely absent from both views,
  exactly like every other property type, until a prefill/default/JSON edit gives it
  a value or the user actually toggles the checkbox. Switching modes re-derives one
  from the other: Form→JSON always
  succeeds; JSON→Form is blocked in place with an inline error (the typed JSON is
  left untouched) if the text doesn't parse as JSON at all, **or** if it parses to
  something other than a JSON object (e.g. an array, a string, a number, or
  `null`) — a schema-driven Form only ever has properties to populate from an
  object's keys. Clicking **Start** validates the active mode
  client-side — a missing required field or an unparseable individual value (e.g. a
  number field) in Form mode, invalid JSON in JSON mode — and blocks the
  `POST /v2/acts/{actorId}/runs` request with an inline error rather than sending it;
  the server itself stays exactly as permissive as before. An actor with no
  resolvable schema (none pushed, or a `TARBALL` version, whose manifest isn't
  inspectable before a build unpacks it) falls back to a plain JSON editor prefilled
  with `{}`, with no Form/JSON toggle at all.
- The **user list is fetched without a token.** The console attaches the acting
  user's bearer token to every request except the two public, read-only `GET
  /v2/users` calls (the "Switch user" dropdown and the Users tab table), which are
  sent with **no `Authorization` header** via a per-call opt-out in the single
  `api()` fetch helper. Consequently, loading the console, switching the Users tab,
  or the periodic user-list refresh can never claim/bootstrap a token as a side
  effect; only real, user-driven work (viewing "me", listing/pushing/building/
  running, storage work) presents the token.
- **Running jobs can be aborted from their detail page.** A run detail and a
  build detail each render an **Abort** button while (and only while) the job's
  status is `RUNNING`; it calls the corresponding abort endpoint
  (`POST /v2/actor-runs/{runId}/abort` / `POST /v2/actor-builds/{buildId}/abort`)
  and re-renders the page, so the badge flips to `ABORTED` in place.
- The **Log view streams live.** For a running build or run, the Log tab consumes
  the streaming log endpoint (`GET /v2/logs/{id}/stream`) by reading the response
  body incrementally and appending output into the log `<pre>` as it arrives, rather
  than a single fetch-and-render. Opening the Log tab for an already-finished job
  still shows the complete log immediately (the stream's finished-job fallback). Log
  text is added via text nodes only (never `innerHTML`), so log content can never be
  interpreted as markup.
- The **Storage section** shows one storage type at a time (at `/storage/{slug}`,
  with a per-type sub-nav between key-value stores, datasets and request queues) and
  lists **all** of the acting user's owned storages of that type — both the ones they
  created by name (**named**) and the ones created automatically by their Actor runs
  (**run-derived/unnamed**). Each row is marked with a **✅ (named) / ❌
  (run-derived)** glyph so it's clear which is which. A single checkbox above the
  list, **checked by default** (showing unnamed rows), lets you hide the run-derived
  rows on demand; toggling it only changes what's displayed, never what is fetched,
  created or deleted. Each type keeps its create-by-name form; a **delete control is
  offered only for named rows** — run-derived storages are managed with their run and
  are not deletable from this view, so no delete button is rendered for them (delete
  asks for confirmation first for named rows, since it permanently drops the
  underlying data). Run-derived storages serialize an **empty `name`** (they were
  never explicitly named), so their name cell renders blank.
- **Every storage is inspectable.** Clicking any storage row navigates to
  `/storage/{slug}/{resourceId}`, which shows that storage's actual contents
  (key-value store keys and record values, dataset items, or request-queue requests)
  with a link back to the list — for named **and** run-derived storages alike. This
  reuses the same content renderer as a run's default-storage sub-tabs. All controls
  reuse the DOM-safe builders (`mk`/`tableEl`/`api`) — no `innerHTML`, no inline
  handlers; navigation is wired with `addEventListener` + `history.pushState`.
- The **left column** shows the top-level category nav (Actors / Storage / Users)
  in its own bordered box, and directly below it, in a second, separate bordered
  box, the acting user's Actors list (so you can switch actors from any actor route).
  The detail panel to the right renders whichever view the URL addresses.

# Out of scope for now
- Real authentication / passwords (the token is a placeholder credential that
  selects a user; there is no real credential check).
- A share-management UI for storage access rights (sharing is API/CLI only this
  pass; grant/list/revoke are done against the API).
- It allows to get actors from store

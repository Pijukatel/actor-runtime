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
- It presents a dedicated top-level tab per user-owned object type — **Actors**,
  **Builds** and **Runs** — each scoped to the acting user (backed by the
  `/v2/users/me/actors|builds|runs` endpoints). From a Run, its own default
  storages remain browsable as before. Because every view is backed by the
  ownership-scoped API, a user never sees another user's objects or storages.

# Out of scope for now
- Real authentication / passwords (the token is a placeholder credential that
  selects a user; there is no real credential check).
- A share-management UI for storage access rights (sharing is API/CLI only this
  pass; grant/list/revoke are done against the API).
- It allows to get actors from store
- It allows to inspect named (non-default) storages - only a run's default
  storages are browsable in this first draft

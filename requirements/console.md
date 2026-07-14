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
- It supports multiple users through a **placeholder login**: the user enters the
  same token/name they use with the CLI (no password, no real credential check),
  stored client-side and sent as `Authorization: Bearer` on every request. The
  header shows the acting user, and switching the token switches the user.
- It presents a dedicated top-level tab per user-owned object type — **Actors**,
  **Builds** and **Runs** — each scoped to the acting user (backed by the
  `/v2/users/me/actors|builds|runs` endpoints). From a Run, its own default
  storages remain browsable as before. Because every view is backed by the
  ownership-scoped API, a user never sees another user's objects or storages.

# Out of scope for now
- Real authentication / passwords (login is a placeholder, token-as-identity).
- A share-management UI for storage access rights (sharing is API/CLI only this
  pass; grant/list/revoke are done against the API).
- It allows to get actors from store
- It allows to inspect named (non-default) storages - only a run's default
  storages are browsable in this first draft

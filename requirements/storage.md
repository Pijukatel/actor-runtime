# Storage backend
- The system uses SQLite as storage backend.
- The storage backend is using SQLite from `crawlee-python` https://github.com/apify/crawlee-python/tree/v1.8.1/src/crawlee/storage_clients/_sql
- The storage is persistent within the container.
- The crawlee-python SQL backend provides all three default storage types -
  dataset, key-value store **and request queue** - so no separate request-queue
  storage is needed. This is what lets the runtime satisfy `test.md`'s requirement
  to fetch the request queue, even though the `Actor Runtime API` tag referenced by
  `api.md` does not itself define request-queue endpoints (they are added by the
  local API; see `api.md`).
- Dataset `offset`/`limit` pagination is pushed all the way down to crawlee's own
  `DatasetClient.get_data(offset=, limit=)`, which already reports
  `total`/`count`/`offset` — the API layer (`api.md`'s "Pagination" section) just
  wires optional query params through to it. Key-value-store keys and
  request-queue requests have no equivalent offset/limit-aware read on their
  crawlee clients, so their optional slice is computed in Python over the
  already-fetched full list (acceptable for this project's dev-tool-sized
  storages; pushing it down into the crawlee facade is a documented follow-up,
  not a blocker).

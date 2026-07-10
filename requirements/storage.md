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

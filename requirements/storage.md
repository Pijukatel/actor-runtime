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
  wires optional query params through to it. Request-queue requests have no
  equivalent offset/limit-aware read on their crawlee client, so their optional
  `offset`/`limit` slice is computed in Python over the already-fetched full
  list (acceptable for this project's dev-tool-sized storages; pushing it down
  into the crawlee facade is a documented follow-up, not a blocker).
- Key-value-store keys are a partial exception: crawlee's SQL-backed KVS
  client's own `iterate_keys(exclusive_start_key=, limit=)` already filters
  `key > exclusive_start_key` in ascending key order and applies `limit` as a
  SQL `LIMIT` clause, so a request naming `exclusiveStartKey` and/or `limit`
  (the cursor-pagination path — see `api.md`'s "Pagination" section) is pushed
  straight through to that instead of being sliced from an already-fetched
  full list: `Storage.kv_keys_page()` requests `limit + 1` keys to detect
  truncation in one round trip, then drops the extra key from the returned
  page and reports the last KEPT key as `nextExclusiveStartKey`. The
  runtime's own `offset`-based console paging — which has no equivalent
  concept on the real API or on crawlee's KVS client — is untouched and still
  slices an already-fetched full list (`Storage.kv_keys()`) in Python, exactly
  like RQ requests above; the two mechanisms are independent query params on
  the same endpoint (a request naming both treats the cursor as authoritative
  and ignores `offset`).

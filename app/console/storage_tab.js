// Storage views: the per-type storage list (/storage/{slug}), a storage's
// detail content (key-value keys+records / dataset items / request-queue
// requests), paging, and the per-detail stats line.
//
// Split out of app.js so no single console script owns both the shell/
// routing/actors/users concerns and the entire storage-browsing feature.
// This is a third classic (non-module) script, sharing app.js's global scope
// exactly like input_tab.js already does: `mk`, `api`, `apiRaw`, `unwrap`,
// `navigate`, `tableEl`, `getToken` and `STORAGE_SLUG_TO_KIND` (all defined
// in app.js) are used here directly, and `loadStorages`/`showStorageDetail`/
// `showStore` below are what app.js's own router (`renderRoute`) and
// `openRun` call to render these views. index.html loads this file BEFORE
// app.js, for the same reason it already loads input_tab.js first: app.js's
// own top-level code (its router's initial render) can reach these functions
// the instant it runs.
//
// DOM safety: same convention as app.js's own header comment -- untrusted
// strings (storage ids/names, item/key/request contents) are never
// interpolated into inline event-handler attributes or innerHTML.

// The per-type storage sub-nav: URL slug -> display label. The list order is
// also the per-type sub-nav order. Only consumed here (`renderStorages`
// below), unlike `STORAGE_SLUG_TO_KIND` (app.js), which app.js's own router
// also needs.
const STORAGE_TYPES = [
  ["key-value-stores", "Key-value stores"],
  ["datasets", "Datasets"],
  ["request-queues", "Request queues"],
];

// Cache of the last-fetched items per storage type, keyed by slug, so toggling
// the show/hide-unnamed checkbox can re-render from already-fetched data instead
// of issuing a new fetch(). `currentStorageSlug` is the type the page is showing.
let showUnnamedStorages = true;
let storageItemsCache = {};
let currentStorageSlug = "key-value-stores";

// The storage list's paging cursor -- owned ENTIRELY by `loadStorages` below;
// no other function assigns it directly. Its own reset rule (see that
// function) resets to page 0 whenever the slug OR the acting user's token
// differs from the last load, so switching users needs no special-cased poke
// of this variable at all -- it falls out of the model for free. A caller
// that needs a guaranteed fresh first page for a reason the model can't
// detect on its own (a mutation: the list just changed under the SAME
// slug/user) asks for it explicitly via `loadStorages(slug, 0)`, exactly like
// the paging controls ask for any other explicit page.
let storageListOffset = 0;
let storageListToken = null;

// Every console fetch against a paginated listing surface (dataset items, KV
// keys, RQ requests, and this per-user storage list) always requests one
// explicit page of this size -- never a bare/unbounded request -- and pages
// with prev/next from the surface's reported total.
const STORAGE_PAGE_SIZE = 100;

function pagingLineEl(offset, count, total) {
  const from = count ? offset + 1 : 0;
  // Clamped to `total`, and pinned to `from` on an empty page, so a raced
  // page (`count` is 0 because `total` shrank between two page loads, e.g.
  // another session deleted items while this one sat on a later page) still
  // renders a sane "showing 0-0 of T" instead of a stale "showing 0-<old
  // offset> of T".
  const to = count ? Math.min(offset + count, total) : from;
  return mk("p", { class: "muted", text: `showing ${from}–${to} of ${total}` });
}

// Companion to `pagingLineEl` for a page-local FILTER (e.g. the storage
// list's "show unnamed" checkbox) that hides some of an already-fetched
// page's rows: `pagingLineEl`'s "showing N-M of T" wording claims the
// VISIBLE rows sit at positions N-M of the underlying result set, which is
// only true when nothing on the current page is hidden -- once a filter
// hides any rows, that position claim is simply wrong (the visible rows are
// a scattered subset of the page, not a contiguous N-M range of the total),
// even though the isolated COUNT half (how many rows are shown) stays
// accurate. This drops the range wording entirely in that case, reporting
// only counts that are genuinely true of what's rendered: how many of the
// current (unfiltered) page are visible, and the result set's grand total.
function filteredPagingLineEl(visibleCount, pageCount, total) {
  return mk("p", {
    class: "muted",
    text: `showing ${visibleCount} of ${pageCount} on this page · ${total} total`,
  });
}

// True when an already-`unwrap()`ed response is this app's error envelope
// (`{"error": {...}}`), e.g. the storage was deleted or access revoked between
// opening the detail view and this fetch -- a stale offset/limit re-fetch is a
// real, if rare, race, not a shape any paging line can be built from.
function isErrorEnvelope(resp) {
  return !!(resp && typeof resp === "object" && resp.error);
}

function errorLineEl(err) {
  const message = (err && err.message) || "Failed to load storage content.";
  return mk("p", { class: "muted", text: `Error: ${message}` });
}

function pagingControlsEl(offset, count, total, onPage) {
  const row = mk("div", { class: "row" });
  const prev = mk("button", {
    class: "secondary",
    text: "Prev",
    onClick: () => onPage(Math.max(0, offset - STORAGE_PAGE_SIZE)),
  });
  const next = mk("button", {
    class: "secondary",
    text: "Next",
    onClick: () => onPage(offset + STORAGE_PAGE_SIZE),
  });
  prev.disabled = offset <= 0;
  next.disabled = offset + count >= total;
  row.append(prev, next);
  return row;
}

// Identity/bookkeeping fields every storage's own GET-detail response
// carries that are never a "stat" to show in a detail view's stats line.
const STORAGE_META_KEYS = new Set([
  "id", "name", "userId", "createdAt", "modifiedAt", "accessedAt", "consoleUrl",
]);

// Every field a storage's own GET-detail response CURRENTLY returns with a
// non-empty value -- nothing invented, nothing non-empty omitted. Plain
// metadata and any object-valued field (no storage type's own GET-detail
// response currently returns a non-empty one -- a request queue's `stats`
// sub-object stays an empty stub, so it is hidden along with every other
// object-valued field) are excluded -- see requirements/console.md's "stats
// line" section. A counter-ish field that is absent/zero/blank for this
// instance is simply not shown, rather than hardcoding which fields exist per
// storage type -- but a boolean is a meaningful value either way (e.g. a
// request queue's `hadMultipleClients`), so `false` is shown just like `true`,
// never treated as "empty".
function statsLineEl(meta) {
  const parts = [];
  for (const [key, value] of Object.entries(meta || {})) {
    if (STORAGE_META_KEYS.has(key)) continue;
    if (value && typeof value === "object") continue;
    if (typeof value !== "boolean" && !value) continue;
    parts.push(`${key}: ${value}`);
  }
  // A brand-new/empty storage has every counter at 0 (suppressed above), so
  // there is nothing to show yet -- `null`, not an empty `<p>` element, so
  // the call site can skip rendering it entirely.
  return parts.length ? mk("p", { class: "muted", text: parts.join(" · ") }) : null;
}

async function loadStorages(slug, offset) {
  // The reset rule, owned entirely here: a fresh view -- a different slug,
  // OR the same slug under a DIFFERENT acting user (switchTo() changes the
  // token, never the slug) -- starts back at offset 0. Anything else (a
  // plain revisit of the same slug for the same user, e.g. navigating back
  // from a detail view, or an explicit offset from the paging controls)
  // keeps paging where it was. No other function needs to know this rule or
  // touch `storageListOffset` itself.
  const token = getToken();
  const sameContext = slug === currentStorageSlug && token === storageListToken;
  if (offset != null) {
    storageListOffset = offset;
  } else if (!sameContext) {
    storageListOffset = 0;
  }
  currentStorageSlug = slug || currentStorageSlug;
  storageListToken = token;
  const list = $("#actor-list");
  if (list) list.innerHTML = "";
  const resp = unwrap(
    await api(`/v2/users/me/${currentStorageSlug}?limit=${STORAGE_PAGE_SIZE}&offset=${storageListOffset}`),
  );
  if (isErrorEnvelope(resp)) {
    const detail = $("#detail");
    if (detail) {
      detail.innerHTML = "";
      detail.appendChild(errorLineEl(resp.error));
    }
    return;
  }
  storageItemsCache[currentStorageSlug] = { items: resp.items || [], total: resp.total || 0 };
  renderStorages();
}

function renderStorages() {
  const slug = currentStorageSlug;
  const detail = $("#detail");
  if (!detail) return;
  detail.innerHTML = "";

  // Per-type sub-nav: one deep-linkable path per storage type.
  const subnav = mk("div", { class: "tabs" });
  for (const [s, lbl] of STORAGE_TYPES) {
    subnav.appendChild(
      mk("span", { class: s === slug ? "active" : "", text: lbl, onClick: () => navigate(`/storage/${s}`) }),
    );
  }
  detail.appendChild(subnav);

  const label = (STORAGE_TYPES.find(([s]) => s === slug) || [slug, slug])[1];
  detail.appendChild(mk("h2", { text: label }));

  const form = mk("div", { class: "row" });
  const input = mk("input");
  input.placeholder = "New name";
  const createBtn = mk("button", { text: "Create", onClick: () => createStorage(slug, input.value) });
  form.append(input, createBtn);
  detail.appendChild(form);

  const toggleRow = mk("div", { class: "row" });
  const toggleLabel = document.createElement("label");
  toggleLabel.className = "muted";
  const toggle = document.createElement("input");
  toggle.type = "checkbox";
  toggle.id = "show-unnamed-storages";
  toggle.checked = showUnnamedStorages;
  toggle.addEventListener("change", () => {
    showUnnamedStorages = toggle.checked;
    renderStorages();
  });
  toggleLabel.appendChild(toggle);
  toggleLabel.appendChild(document.createTextNode(" Show run-derived (unnamed) storages"));
  toggleRow.appendChild(toggleLabel);
  detail.appendChild(toggleRow);

  const cache = storageItemsCache[slug] || { items: [], total: 0 };
  const items = cache.items;
  const visible = showUnnamedStorages ? items : items.filter((st) => st.named === true);
  // The wording switches on the checkbox state (`showUnnamedStorages`)
  // alone, not on whether this particular page happens to have any row
  // hidden -- see `filteredPagingLineEl`'s own comment above for why the
  // unchecked wording must drop the range claim regardless. Prev/Next below
  // stay keyed off the raw fetched page (`items.length`), never the
  // filtered subset.
  detail.appendChild(
    showUnnamedStorages
      ? pagingLineEl(storageListOffset, visible.length, cache.total)
      : filteredPagingLineEl(visible.length, items.length, cache.total),
  );
  const rows = visible.map((st) => {
    // ✅ for a named/standalone storage, ❌ for a run-derived one - the same
    // st.named flag that gates the delete affordance below.
    const marker = mk("td", { class: "muted", text: st.named ? "✅" : "❌" });
    const del = st.named
      ? mk("button", {
          class: "secondary",
          text: "Delete",
          onClick: () => deleteStorage(slug, st.id),
        })
      : mk("td", { class: "muted", text: "" });
    const idCell = mk("td", {
      class: "clickable",
      text: st.id,
      onClick: () => navigate(`/storage/${slug}/${st.id}`),
    });
    return [mk("td", { text: st.name }), idCell, marker, del];
  });
  detail.appendChild(tableEl(["Name", "Id", "Named", ""], rows));
  detail.appendChild(
    pagingControlsEl(storageListOffset, items.length, cache.total, (next) => loadStorages(slug, next)),
  );
}

async function createStorage(slug, name) {
  const trimmed = (name || "").trim();
  if (!trimmed) return;
  await api(`/v2/${slug}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: trimmed }),
  });
  // Explicit `0`, not a bare `loadStorages(slug)`: the list is ordered oldest
  // first, so a newly created item lands past the end of whatever page was
  // showing -- re-fetching the SAME stale offset can leave it permanently off
  // screen (a full last page never grows to reveal it, since offset doesn't
  // move). Resetting to the first page is simple, deterministic, and always
  // shows the freshest data immediately, with no empty-page case to handle.
  loadStorages(slug, 0);
}

async function deleteStorage(slug, id) {
  if (!confirm(`Delete storage "${id}"? This permanently removes its data and cannot be undone.`)) return;
  await api(`/v2/${slug}/${id}`, { method: "DELETE" });
  // Same reasoning as createStorage(): re-fetching the stale offset after
  // deleting the last item on a later page would land on an empty page
  // (`showing 0-0 of T`) until the user clicked Prev -- resetting to 0 avoids
  // that case entirely instead of computing a clamped "last non-empty page".
  loadStorages(slug, 0);
}

// Storage detail: inspect any storage's contents (keys+records / items /
// requests) at /storage/{slug}/{id}, reusing showStore via the slug→kind map.
async function showStorageDetail(slug, resourceId) {
  const kind = STORAGE_SLUG_TO_KIND[slug];
  const list = $("#actor-list");
  if (list) list.innerHTML = "";
  const detail = $("#detail");
  if (!detail) return;
  detail.innerHTML = "";

  const head = mk("div", { class: "row" });
  head.appendChild(mk("h2", { text: resourceId, style: { margin: "0" } }));
  detail.appendChild(head);
  const store = mk("div");
  store.id = "store";
  detail.append(
    store,
    mk("button", { class: "secondary", text: "Back", onClick: () => navigate(`/storage/${slug}`) }),
  );
  await showStore(null, kind, resourceId);
}

window.showStore = async function (tab, kind, id) {
  abortActiveLogStream();
  document.querySelectorAll(".tabs span").forEach((s) => s.classList.remove("active"));
  if (tab) tab.classList.add("active");
  // Fresh open always starts at the first page; a prev/next click re-renders
  // the SAME (kind, id) with a new offset by calling this directly (see
  // `onPage` below) without going through showStore() again.
  await renderStoreContent(kind, id, 0);
};

// Renders one storage's contents (plus, for kv/ds, its stats -- rq's stats
// need a separate metadata fetch, see its own branch below) into #store for
// the given (kind, id) at the given paging offset. Shared by showStore()
// (fresh open, offset 0) and the prev/next controls (same kind/id, new
// offset) -- always requesting an explicit limit=100&offset=N page, never a
// bare/unbounded request.
async function renderStoreContent(kind, id, offset) {
  const box = $("#store");
  if (!box) return;
  box.innerHTML = "";

  if (kind === "log") {
    const logPre = mk("pre");
    box.appendChild(logPre);
    await streamLogInto(id, logPre);
    return;
  }

  const onPage = (next) => renderStoreContent(kind, id, next);

  if (kind === "kv") {
    const keysResp = unwrap(
      await api(`/v2/key-value-stores/${id}/keys?limit=${STORAGE_PAGE_SIZE}&offset=${offset}`),
    );
    if (isErrorEnvelope(keysResp)) {
      box.appendChild(errorLineEl(keysResp.error));
      return;
    }
    const keys = keysResp.items || [];
    // `itemCount` is a KV store's only stats-line field, and this listing's
    // own `total` already reports it exactly -- no separate metadata fetch
    // (a full `kv_keys()` re-read server-side, paid again on every page
    // flip) is needed just to redundantly re-derive the same number. `total`
    // is always present here: the console always sends `limit`/`offset` (see
    // requirements/console.md's storage-paging section), so this never takes
    // the bare/unpaginated branch that would omit it.
    const total = keysResp.total;
    const stats = statsLineEl({ itemCount: total });
    if (stats) box.appendChild(stats);
    box.appendChild(pagingLineEl(offset, keys.length, total));
    const rows = [];
    for (const k of keys) {
      const rec = await api(`/v2/key-value-stores/${id}/records/${k.key}`);
      const pre = mk("pre", {
        text: typeof rec === "string" ? rec : JSON.stringify(rec, null, 2),
        style: { maxHeight: "120px" },
      });
      rows.push([mk("td", { text: k.key }), pre]);
    }
    box.appendChild(emptyOr(tableEl(["Key", "Value"], rows), keys.length));
    box.appendChild(pagingControlsEl(offset, keys.length, total, onPage));
  } else if (kind === "ds") {
    // Dataset items keep their bare-array body; the pagination info lives in
    // response headers (mirroring the real API's own convention), so this
    // reads the raw Response rather than going through api()/unwrap(). `ok`
    // is checked BEFORE parsing the body: a non-JSON error body (e.g. a
    // plain-text 500) would otherwise throw out of this fire-and-forget
    // render with no error line shown at all.
    const res = await apiRaw(`/v2/datasets/${id}/items?limit=${STORAGE_PAGE_SIZE}&offset=${offset}`);
    if (!res.ok) {
      let err = null;
      try {
        err = await res.json();
      } catch (e) {
        // Non-JSON error body -- fall through to errorLineEl's own generic
        // message below instead of throwing here.
      }
      box.appendChild(errorLineEl(err && err.error));
      return;
    }
    const items = await res.json();
    // `itemCount`/`cleanItemCount` are the same number for this runtime (no
    // separate "clean" count is tracked -- see app/routers/storages.py's
    // `get_dataset`), and this page's own `X-Apify-Pagination-Total` header
    // already reports it -- no separate metadata fetch (a full
    // `dataset_items()` re-read server-side, paid again on every page flip)
    // is needed just to redundantly re-derive the same number. The header is
    // always present here for the same reason `keysResp.total` always is
    // above: the console always sends `limit`/`offset`.
    const total = Number(res.headers.get("X-Apify-Pagination-Total"));
    const stats = statsLineEl({ itemCount: total, cleanItemCount: total });
    if (stats) box.appendChild(stats);
    box.appendChild(pagingLineEl(offset, items.length, total));
    box.appendChild(mk("pre", { text: JSON.stringify(items, null, 2) }));
    box.appendChild(pagingControlsEl(offset, items.length, total, onPage));
  } else if (kind === "rq") {
    // Unlike kv/ds above, a request queue's stats line needs fields
    // (`pendingRequestCount`/`handledRequestCount`/`hadMultipleClients`)
    // that the requests-listing page below does not carry, so this branch
    // alone still needs its own metadata fetch -- issued concurrently with
    // the listing fetch (`Promise.all`), since the two calls have no
    // dependency on each other, rather than serialized one after the other.
    const [meta, reqsResp] = await Promise.all([
      api(`/v2/request-queues/${id}`).then(unwrap),
      api(`/v2/request-queues/${id}/requests?limit=${STORAGE_PAGE_SIZE}&offset=${offset}`).then(unwrap),
    ]);
    if (isErrorEnvelope(meta)) {
      box.appendChild(errorLineEl(meta.error));
      return;
    }
    const stats = statsLineEl(meta);
    if (stats) box.appendChild(stats);
    if (isErrorEnvelope(reqsResp)) {
      box.appendChild(errorLineEl(reqsResp.error));
      return;
    }
    const reqs = reqsResp.items || [];
    box.appendChild(pagingLineEl(offset, reqs.length, reqsResp.total));
    const rows = reqs.map((q) => [
      mk("td", { text: q.url }),
      mk("td", { text: q.method }),
      mk("td", { text: String(Boolean(q.handledAt)) }),
    ]);
    box.appendChild(emptyOr(tableEl(["URL", "Method", "Handled"], rows), reqs.length));
    box.appendChild(pagingControlsEl(offset, reqs.length, reqsResp.total, onPage));
  }
}

// tableEl already renders a "none" row when empty; keep the previous "empty"
// wording for storage views by relabelling that row when there are zero rows.
function emptyOr(table, count) {
  if (!count) {
    const cell = table.querySelector("td.muted");
    if (cell) cell.textContent = "empty";
  }
  return table;
}

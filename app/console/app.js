// Minimal console. Calls the same-origin /v2 API. The acting user is selected by
// a plain-text token (no password, no real auth) stored client-side and sent as
// `Authorization: Bearer <token>` on EVERY request, exactly as apify-cli does.
//
// SECURITY: untrusted strings (Actor names/ids, storage contents) are NEVER
// interpolated into inline event-handler attributes or into innerHTML. A browser
// HTML-decodes an attribute value before compiling it as JavaScript, so
// HTML-escaping does NOT neutralise a JS-string breakout in an inline handler.
// Instead every interactive element is built with document.createElement, given
// its text via textContent, and wired with addEventListener over a closure that
// captures the value directly - the id stays a plain JS string that is never
// re-parsed as markup or code.
//
// ROUTING: the view is driven by location.pathname via the History API (real
// paths, not a hash), so every view is deep-linkable and refresh-safe and the
// path shape mirrors the official console (/actors, /actors/{id}/runs/{runId},
// /storage/{slug}/{id}, ...). navigate() pushes a real path and re-renders;
// popstate handles Back/Forward. The server serves index.html for these SPA
// paths (see app/routers/console.py) so a refresh/deep-link renders correctly.
const $ = (sel) => document.querySelector(sel);

const TOKEN_KEY = "actor-runtime-token";
const getToken = () => {
  try {
    return localStorage.getItem(TOKEN_KEY) || "";
  } catch (e) {
    return "";
  }
};
const setToken = (t) => {
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  } catch (e) {
    /* ignore */
  }
};

// Optional real-API fallback (the "API fallback" header toggle): when ON, a
// resource fetch (GET) that fails against the local runtime is retried once
// against the real Apify API. The flag lives in localStorage, so one header
// button controls it globally - every view, every navigation, and reloads all
// see the same state. It is OFF by default (and a blocked localStorage reads
// as OFF): the console never talks to the real platform unless asked to. The
// fallback request carries the same bearer credential as the local one -
// identity and credential are decoupled, so a user whose stored token is a
// real Apify token gets their real account's resources; any other token is
// simply rejected by the real API.
const REAL_API_BASE = "https://api.apify.com";
const FALLBACK_KEY = "actor-runtime-api-fallback";
const isApiFallbackEnabled = () => {
  try {
    return localStorage.getItem(FALLBACK_KEY) === "1";
  } catch (e) {
    return false;
  }
};
const setApiFallbackEnabled = (on) => {
  try {
    if (on) localStorage.setItem(FALLBACK_KEY, "1");
    else localStorage.removeItem(FALLBACK_KEY);
  } catch (e) {
    /* ignore */
  }
};

async function api(path, opts) {
  const options = Object.assign({}, opts);
  const headers = Object.assign({}, options.headers);
  const token = getToken();
  // Send the token as a bearer credential on every request so the runtime
  // resolves the acting user consistently across the whole console. `skipAuth`
  // opts a single call out of this (used for the public, side-effect-free user
  // list) so merely loading the console can never claim/bootstrap a token.
  if (token && !options.skipAuth) headers["Authorization"] = "Bearer " + token;
  options.headers = headers;
  const method = (options.method || "GET").toUpperCase();
  let res = null;
  let localError = null;
  try {
    res = await fetch(path, options);
  } catch (e) {
    localError = e;
  }
  // Local-first with optional real-API fallback: only a *fetch* of a resource
  // (GET) is ever retried, only while the header toggle is ON, and only after
  // the local attempt failed - a network error or a non-2xx status (e.g. the
  // runtime's 404 for a resource that exists only on the platform). Mutations
  // (POST/PUT/DELETE) never fall back: a failed local write must surface as a
  // failure, not silently become a write against the real platform. A failed
  // fallback keeps the local outcome, so turning the toggle ON can never make
  // an error less informative than it already was.
  if (isApiFallbackEnabled() && method === "GET" && (localError || !res.ok)) {
    try {
      res = await fetch(REAL_API_BASE + path, options);
      localError = null;
    } catch (e) {
      /* keep the local outcome */
    }
  }
  if (localError) throw localError;
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return res.json();
  return res.text();
}
const unwrap = (r) => (r && r.data !== undefined ? r.data : r);

// The one active log stream, if any. A running job's stream stays open
// indefinitely (a warm standby run's never ends at all), so an abandoned one
// must be aborted when the user moves elsewhere: it wastes a server poller
// and a browser connection, and an in-flight response to the same URL makes
// the browser queue the next request for that URL behind it — a reopened Log
// tab would otherwise hang empty forever.
let activeLogStream = null;

function abortActiveLogStream() {
  if (activeLogStream) {
    activeLogStream.abort();
    activeLogStream = null;
  }
}

// Consume the chunked text/plain log stream, appending output into `pre` as it
// arrives (live for a running job, the full stored log in one shot for a finished
// one). Text is added via text nodes only - never innerHTML - so log content can
// never be interpreted as markup.
async function streamLogInto(id, pre) {
  abortActiveLogStream();
  const ctrl = new AbortController();
  activeLogStream = ctrl;
  const token = getToken();
  const headers = {};
  if (token) headers["Authorization"] = "Bearer " + token;
  let res = null;
  try {
    res = await fetch(`/v2/logs/${id}/stream`, { headers, signal: ctrl.signal });
  } catch (e) {
    if (ctrl.signal.aborted) return;
  }
  // The same local-first / real-API-fallback rule as api(), for the one fetch
  // that bypasses it. The /stream suffix is a local addition, so the fallback
  // fetches the same resource (the job's log) at the real API's one-shot
  // /v2/logs/{id} path; the incremental reader below handles a one-shot body
  // fine (it just arrives in fewer chunks).
  if (isApiFallbackEnabled() && (!res || !res.ok)) {
    try {
      res = await fetch(`${REAL_API_BASE}/v2/logs/${id}`, { headers, signal: ctrl.signal });
    } catch (e) {
      if (ctrl.signal.aborted) return;
    }
  }
  if (!res) {
    pre.textContent = "(no log)";
    return;
  }
  let appended = false;
  try {
    if (res.body && res.body.getReader) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        if (text) {
          pre.appendChild(document.createTextNode(text));
          appended = true;
        }
      }
      const tail = decoder.decode();
      if (tail) {
        pre.appendChild(document.createTextNode(tail));
        appended = true;
      }
    } else {
      const text = await res.text();
      if (text) {
        pre.appendChild(document.createTextNode(text));
        appended = true;
      }
    }
  } catch (e) {
    // An aborted stream (tab switch / navigation) is expected; keep whatever
    // output already arrived.
    if (!ctrl.signal.aborted) throw e;
    return;
  }
  if (!appended) pre.textContent = "(no log)";
}

async function refreshUser() {
  const me = unwrap(await api("/v2/users/me"));
  const el = $("#current-user");
  if (el) el.textContent = (me && me.username) || "local-user";
}

// Switching users is client-side: pick an existing user's stored token and send
// it as the bearer on every subsequent request. A null token (the unclaimed
// default user) clears the stored token, i.e. acts token-less as local-user.
// Re-render whatever view the URL currently addresses (route-aware), so the
// switch takes effect in place rather than snapping back to a fixed view.
function switchTo(token) {
  setToken(token == null ? "" : token);
  refreshUser();
  refreshUserSelect();
  renderRoute();
}

// Populate the header's "Switch user" dropdown from the existing users only
// (never free text). Refetched each time so a just-created user is selectable.
async function refreshUserSelect() {
  const sel = $("#user-select");
  if (!sel) return;
  const users = (unwrap(await api("/v2/users", { skipAuth: true })).items) || [];
  const current = getToken();
  sel.innerHTML = "";
  const placeholder = mk("option", { text: "Switch user…" });
  placeholder.value = "";
  sel.appendChild(placeholder);
  for (const u of users) {
    const opt = mk("option", { text: u.username });
    opt.value = u.token == null ? "" : u.token;
    if (opt.value === current) opt.selected = true;
    sel.appendChild(opt);
  }
}

// Reflect the persisted fallback state on the header toggle: an explicit
// ON/OFF label (blue when ON, gray "secondary" when OFF) plus aria-pressed,
// so the global state is readable at a glance from any view.
function renderApiFallbackToggle() {
  const btn = $("#api-fallback-toggle");
  if (!btn) return;
  const on = isApiFallbackEnabled();
  btn.textContent = `API fallback: ${on ? "ON" : "OFF"}`;
  btn.classList.toggle("secondary", !on);
  btn.setAttribute("aria-pressed", on ? "true" : "false");
}

async function createUser(name) {
  const trimmed = (name || "").trim();
  const errEl = $("#user-create-error");
  if (errEl) errEl.textContent = "";
  if (!trimmed) return;
  const res = await api("/v2/users", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: trimmed }),
  });
  if (res && res.error) {
    if (errEl) errEl.textContent = res.error.message || "Could not create user.";
    return;
  }
  refreshUserSelect();
  loadUsers();
}

// Users view: current user highlighted, every user listed with a masked token
// that reveals on click, click-a-username to switch, and a create-by-name form.
async function loadUsers() {
  const detail = $("#detail");
  if (!detail) return;
  const list = $("#actor-list");
  if (list) list.innerHTML = "";
  const me = unwrap(await api("/v2/users/me"));
  const users = (unwrap(await api("/v2/users", { skipAuth: true })).items) || [];
  detail.innerHTML = "";

  const form = mk("div", { class: "row" });
  const input = mk("input");
  input.id = "new-user-name";
  input.placeholder = "New user name";
  const createBtn = mk("button", { text: "Create user", onClick: () => createUser(input.value) });
  const err = mk("span", { class: "muted" });
  err.id = "user-create-error";
  form.append(input, createBtn, err);

  const rows = users.map((u) => {
    const isCurrent = me && u.username === me.username;
    const nameCell = mk("td", {
      class: "clickable",
      text: u.username,
      onClick: () => switchTo(u.token),
      style: isCurrent ? { fontWeight: "700" } : {},
    });
    const tokenCell = mk("td", { class: "clickable", text: "••••••••" });
    tokenCell.addEventListener("click", () => {
      tokenCell.textContent = u.token == null ? "(unclaimed)" : u.token;
    });
    const marker = mk("td", { class: "muted", text: isCurrent ? "current" : "" });
    return [nameCell, tokenCell, marker];
  });

  detail.append(
    mk("h2", { text: "Users" }),
    form,
    tableEl(["User", "Token (click to reveal)", ""], rows),
  );
}

// Element builder: text is set via textContent (safe), click via addEventListener.
function mk(tag, opts = {}) {
  const e = document.createElement(tag);
  if (opts.class) e.className = opts.class;
  if (opts.text != null) e.textContent = String(opts.text);
  if (opts.onClick) e.addEventListener("click", opts.onClick);
  if (opts.style) Object.assign(e.style, opts.style);
  return e;
}

function badgeEl(status) {
  // status is a server-generated enum (RUNNING/SUCCEEDED/...). className is set
  // via a DOM property, so even an unexpected value can only add CSS classes,
  // never execute.
  return mk("span", { class: `badge ${status == null ? "" : status}`, text: status });
}

function tableEl(headers, rows) {
  const table = mk("table");
  const hdr = document.createElement("tr");
  for (const h of headers) hdr.appendChild(mk("th", { text: h }));
  table.appendChild(hdr);
  if (rows.length) {
    for (const cells of rows) table.appendChild(rowEl(cells));
  } else {
    const tr = document.createElement("tr");
    const td = mk("td", { class: "muted", text: "none" });
    td.colSpan = headers.length;
    tr.appendChild(td);
    table.appendChild(tr);
  }
  return table;
}

function rowEl(cells) {
  const tr = document.createElement("tr");
  for (const c of cells) tr.appendChild(c instanceof Node ? wrapTd(c) : mk("td", { text: c }));
  return tr;
}
function wrapTd(node) {
  if (node.tagName === "TD") return node;
  const td = document.createElement("td");
  td.appendChild(node);
  return td;
}

// ------------------------------------------------------------------ routing

// The storage URL slug (mirroring the official console) maps to the internal
// kind token used by showStore. The list order is also the per-type sub-nav order.
const STORAGE_SLUG_TO_KIND = {
  "key-value-stores": "kv",
  datasets: "ds",
  "request-queues": "rq",
};
const STORAGE_TYPES = [
  ["key-value-stores", "Key-value stores"],
  ["datasets", "Datasets"],
  ["request-queues", "Request queues"],
];

// Push a real path and render it. Every clickable element navigates through here
// (via the History API only, never a full-page load or a hash fragment), so
// navigation stays a single-page transition and the URL is a real, shareable path.
function navigate(path) {
  history.pushState({}, "", path);
  renderRoute();
}

// Highlight the top-level nav entry for the current section.
function highlightNav(section) {
  document.querySelectorAll("#top-tabs span").forEach((s) => s.classList.remove("active"));
  const map = { actors: "tab-actors", storage: "tab-storage", users: "tab-users" };
  const el = $(`#${map[section] || "tab-actors"}`);
  if (el) el.classList.add("active");
}

// Parse location.pathname and dispatch to the matching view. Segments are split
// only on "/"; the actor id (`username~name`) contains a literal "~", which is
// not a separator, so it survives whole.
function renderRoute() {
  abortActiveLogStream();
  const path = location.pathname;
  if (path === "/" || path === "") {
    history.replaceState({}, "", "/actors");
    return renderRoute();
  }
  const seg = path.split("/").filter(Boolean);
  highlightNav(seg[0]);

  if (seg[0] === "storage") {
    if (seg.length === 1 || !STORAGE_SLUG_TO_KIND[seg[1]]) {
      history.replaceState({}, "", "/storage/key-value-stores");
      return renderRoute();
    }
    if (seg.length === 2) return loadStorages(seg[1]);
    return showStorageDetail(seg[1], seg[2]);
  }

  if (seg[0] === "users") return loadUsers();

  // Default section is Actors (covers "/actors" and any unknown SPA path).
  renderActorListPanel();
  if (seg[0] !== "actors" || seg.length === 1) return showActorsPlaceholder();
  const actorId = seg[1];
  const subTab = seg[2];
  if (subTab === "builds") {
    if (seg.length === 3) return openActor(actorId, "builds");
    return openBuild(actorId, seg[3]);
  }
  if (subTab === "runs" && seg.length >= 4) return openRun(actorId, seg[3]);
  if (subTab === "runs") return openActor(actorId, "runs");
  // Input is the default sub-tab (mirrors the official console): a bare
  // "/actors/{id}", the explicit "/actors/{id}/input", and any unrecognized
  // sub-path all land here.
  return openActor(actorId, "input");
}

// The 4s auto-refresh applies only to the Actors list route (a plain, form-less
// left-panel list), exactly as the old periodic refresh did: it skipped detail
// views (so a live log stream is never restarted) AND the Storage/Users views
// (whose #detail create-by-name forms would be clobbered mid-edit by a re-render).
function shouldAutoRefresh() {
  const seg = location.pathname.split("/").filter(Boolean);
  if (seg.length === 0) return true; // "/" normalizes to the Actors list
  return seg[0] === "actors" && seg.length === 1;
}

function periodicRefresh() {
  if (shouldAutoRefresh()) renderRoute();
}

// The left panel always shows the acting user's Actors (scoped server-side), so
// you can switch actors from any actor route.
async function renderActorListPanel() {
  const list = $("#actor-list");
  if (!list) return;
  const items = (unwrap(await api("/v2/users/me/actors")).items) || [];
  list.innerHTML = "";
  if (!items.length) {
    list.appendChild(mk("li", { class: "muted", text: "No Actors yet. Push one with apify-cli." }));
    return;
  }
  for (const a of items) {
    list.appendChild(mk("li", { text: a.name, onClick: () => navigate(`/actors/${a.id}`) }));
  }
}

function showActorsPlaceholder() {
  const detail = $("#detail");
  if (!detail) return;
  detail.innerHTML = "";
  detail.appendChild(
    mk("p", { class: "muted", text: "Select an Actor to inspect its runs, builds and storages." }),
  );
}

// ------------------------------------------------------------------ storages

// Cache of the last-fetched items per storage type, keyed by slug, so toggling
// the show/hide-unnamed checkbox can re-render from already-fetched data instead
// of issuing a new fetch(). `currentStorageSlug` is the type the page is showing.
let showUnnamedStorages = true;
let storageItemsCache = {};
let currentStorageSlug = "key-value-stores";

async function loadStorages(slug) {
  currentStorageSlug = slug || currentStorageSlug;
  const list = $("#actor-list");
  if (list) list.innerHTML = "";
  storageItemsCache[currentStorageSlug] =
    (unwrap(await api(`/v2/users/me/${currentStorageSlug}`)).items) || [];
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

  const items = storageItemsCache[slug] || [];
  const visible = showUnnamedStorages ? items : items.filter((st) => st.named === true);
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
}

async function createStorage(slug, name) {
  const trimmed = (name || "").trim();
  if (!trimmed) return;
  await api(`/v2/${slug}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: trimmed }),
  });
  loadStorages(slug);
}

async function deleteStorage(slug, id) {
  if (!confirm(`Delete storage "${id}"? This permanently removes its data and cannot be undone.`)) return;
  await api(`/v2/${slug}/${id}`, { method: "DELETE" });
  loadStorages(slug);
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

// ------------------------------------------------------------------ actors

// Actor detail is a tabbed page (Input / Runs / Builds sub-tabs), mirroring
// the official console -- Input is the default landing tab (see
// `renderRoute`), exactly like the real console's own Actor page. Runs and
// Builds keep their previous content/behavior unchanged; Start now lives
// inside the Input tab (see `renderInputTab`) rather than behind a separate
// header "Run" button and browser-prompt dialog.
window.openActor = async function (actorId, subTab) {
  subTab = subTab === "builds" ? "builds" : subTab === "runs" ? "runs" : "input";
  const actor = unwrap(await api(`/v2/acts/${actorId}`));
  // Fetch per-tab what the tab actually renders -- Input needs neither list
  // (it only fetches its own schema, in `renderInputTab`), so the default
  // landing tab no longer pays for two unused requests on every visit.
  const builds = subTab === "builds" ? (unwrap(await api(`/v2/acts/${actorId}/builds`)).items) || [] : [];
  const runs = subTab === "runs" ? (unwrap(await api(`/v2/acts/${actorId}/runs`)).items) || [] : [];
  const detail = $("#detail");
  detail.innerHTML = "";

  const head = mk("div", { class: "row" });
  head.appendChild(mk("h2", { text: actor.name, style: { margin: "0" } }));
  head.appendChild(mk("span", { class: "muted", text: actor.id }));

  const actions = mk("div", { class: "row" });
  actions.appendChild(mk("button", { text: "Build", onClick: () => doBuild(actorId) }));
  actions.appendChild(
    mk("button", { class: "secondary", text: "Refresh", onClick: () => navigate(`/actors/${actorId}/${subTab}`) }),
  );

  const tabs = mk("div", { class: "tabs" });
  const inputTab = mk("span", {
    class: subTab === "input" ? "active" : "",
    text: "Input",
    onClick: () => navigate(`/actors/${actorId}/input`),
  });
  const runsTab = mk("span", {
    class: subTab === "runs" ? "active" : "",
    text: "Runs",
    onClick: () => navigate(`/actors/${actorId}/runs`),
  });
  const buildsTab = mk("span", {
    class: subTab === "builds" ? "active" : "",
    text: "Builds",
    onClick: () => navigate(`/actors/${actorId}/builds`),
  });
  tabs.append(inputTab, runsTab, buildsTab);

  detail.append(head, actions, tabs);

  if (subTab === "builds") {
    const buildsRows = builds.map((b) => [
      mk("td", {
        class: "clickable",
        text: b.buildNumber,
        onClick: () => navigate(`/actors/${actorId}/builds/${b.buildNumber}`),
      }),
      mk("td", { text: b.buildNumber }),
      badgeEl(b.status),
    ]);
    detail.append(mk("h2", { text: "Builds" }), tableEl(["Build", "Number", "Status"], buildsRows));
  } else if (subTab === "runs") {
    const runsRows = runs.map((r) => [
      mk("td", {
        class: "clickable",
        text: r.id,
        onClick: () => navigate(`/actors/${actorId}/runs/${r.id}`),
      }),
      mk("td", { text: r.buildNumber }),
      badgeEl(r.status),
    ]);
    detail.append(mk("h2", { text: "Runs" }), tableEl(["Run", "Build", "Status"], runsRows));
  } else {
    const inputBody = mk("div");
    inputBody.id = "input-tab";
    detail.appendChild(inputBody);
    await renderInputTab(actorId, inputBody);
  }
};

window.doBuild = async function (actorId) {
  await api(`/v2/acts/${actorId}/builds?version=0.0`, { method: "POST" });
  setTimeout(() => navigate(`/actors/${actorId}/builds`), 500);
};

// Build detail is addressed by buildNumber (e.g. 0.0.1), like the official
// console - not by internal build id. There is no by-number endpoint, so resolve
// it client-side: fetch the actor's builds list and match the buildNumber, then
// render that build's log. An unknown buildNumber renders "build not found"
// rather than silently showing an arbitrary build.
window.openBuild = async function (actorId, buildNumber) {
  const builds = (unwrap(await api(`/v2/acts/${actorId}/builds`)).items) || [];
  const match = builds.find((b) => b.buildNumber === buildNumber);
  const detail = $("#detail");
  detail.innerHTML = "";
  const back = mk("button", {
    class: "secondary",
    text: "Back",
    onClick: () => navigate(`/actors/${actorId}/builds`),
  });

  if (!match) {
    detail.append(
      mk("h2", { text: "Build not found" }),
      mk("p", { class: "muted", text: `No build ${buildNumber} for this Actor.` }),
      back,
    );
    return;
  }

  const b = unwrap(await api(`/v2/actor-builds/${match.id}`));
  const head = mk("div", { class: "row" });
  head.appendChild(mk("h2", { text: `Build ${b.buildNumber}`, style: { margin: "0" } }));
  head.appendChild(badgeEl(b.status));
  if (b.status === "RUNNING") {
    head.appendChild(
      mk("button", {
        class: "secondary",
        text: "Abort build",
        onClick: async () => {
          await api(`/v2/actor-builds/${match.id}/abort`, { method: "POST" });
          openBuild(actorId, buildNumber);
        },
      }),
    );
  }

  const logPre = mk("pre");
  detail.append(
    head,
    mk("p", { class: "muted", text: `Actor: ${b.actId} · number ${b.buildNumber}` }),
    mk("h2", { text: "Build log" }),
    logPre,
    back,
  );
  streamLogInto(match.id, logPre);
};

window.openRun = async function (actorId, runId) {
  const r = unwrap(await api(`/v2/actor-runs/${runId}`));
  const detail = $("#detail");
  detail.innerHTML = "";

  const head = mk("div", { class: "row" });
  head.appendChild(mk("h2", { text: `Run ${r.id}`, style: { margin: "0" } }));
  head.appendChild(badgeEl(r.status));
  if (r.status === "RUNNING") {
    head.appendChild(
      mk("button", {
        class: "secondary",
        text: "Abort run",
        onClick: async () => {
          await api(`/v2/actor-runs/${runId}/abort`, { method: "POST" });
          openRun(actorId, runId);
        },
      }),
    );
  }

  const tabs = mk("div", { class: "tabs" });
  const kvTab = mk("span", { class: "active", text: "Key-value store" });
  const dsTab = mk("span", { text: "Dataset" });
  const rqTab = mk("span", { text: "Request queue" });
  const logTab = mk("span", { text: "Log" });
  kvTab.addEventListener("click", () => showStore(kvTab, "kv", r.defaultKeyValueStoreId));
  dsTab.addEventListener("click", () => showStore(dsTab, "ds", r.defaultDatasetId));
  rqTab.addEventListener("click", () => showStore(rqTab, "rq", r.defaultRequestQueueId));
  logTab.addEventListener("click", () => showStore(logTab, "log", runId));
  tabs.append(kvTab, dsTab, rqTab, logTab);

  const store = mk("div");
  store.id = "store";

  detail.append(
    head,
    mk("p", { class: "muted", text: `Actor: ${r.actId} · exit code ${r.exitCode}` }),
    tabs,
    store,
    mk("button", {
      class: "secondary",
      text: "Back",
      onClick: () => navigate(`/actors/${actorId}/runs`),
    }),
  );
  showStore(kvTab, "kv", r.defaultKeyValueStoreId);
};

window.showStore = async function (tab, kind, id) {
  abortActiveLogStream();
  document.querySelectorAll(".tabs span").forEach((s) => s.classList.remove("active"));
  if (tab) tab.classList.add("active");
  const box = $("#store");
  box.innerHTML = "";

  if (kind === "kv") {
    const keys = (unwrap(await api(`/v2/key-value-stores/${id}/keys`)).items) || [];
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
  } else if (kind === "ds") {
    const items = await api(`/v2/datasets/${id}/items`);
    box.appendChild(mk("pre", { text: JSON.stringify(items, null, 2) }));
  } else if (kind === "rq") {
    const meta = unwrap(await api(`/v2/request-queues/${id}`));
    const reqs = (unwrap(await api(`/v2/request-queues/${id}/requests`)).items) || [];
    box.appendChild(
      mk("p", {
        class: "muted",
        text: `total ${meta.totalRequestCount} · pending ${meta.pendingRequestCount} · handled ${meta.handledRequestCount}`,
      }),
    );
    const rows = reqs.map((q) => [
      mk("td", { text: q.url }),
      mk("td", { text: q.method }),
      mk("td", { text: String(Boolean(q.handledAt)) }),
    ]);
    box.appendChild(emptyOr(tableEl(["URL", "Method", "Handled"], rows), reqs.length));
  } else {
    const logPre = mk("pre");
    box.appendChild(logPre);
    await streamLogInto(id, logPre);
  }
};

// tableEl already renders a "none" row when empty; keep the previous "empty"
// wording for storage views by relabelling that row when there are zero rows.
function emptyOr(table, count) {
  if (!count) {
    const cell = table.querySelector("td.muted");
    if (cell) cell.textContent = "empty";
  }
  return table;
}

// Wire the header controls and top-level nav with addEventListener (no inline
// handlers). The three top-level entries navigate to real paths; popstate
// re-renders on Back/Forward. Then render the initial route from the URL.
const _userSelect = $("#user-select");
if (_userSelect) _userSelect.addEventListener("change", () => switchTo(_userSelect.value));
const _fallbackToggle = $("#api-fallback-toggle");
if (_fallbackToggle) {
  _fallbackToggle.addEventListener("click", () => {
    setApiFallbackEnabled(!isApiFallbackEnabled());
    renderApiFallbackToggle();
  });
}
$("#tab-actors").addEventListener("click", () => navigate("/actors"));
$("#tab-storage").addEventListener("click", () => navigate("/storage/key-value-stores"));
$("#tab-users").addEventListener("click", () => navigate("/users"));
window.addEventListener("popstate", renderRoute);

refreshUser();
refreshUserSelect();
renderApiFallbackToggle();
renderRoute();
setInterval(periodicRefresh, 4000);

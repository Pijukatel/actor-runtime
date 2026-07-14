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
  const res = await fetch(path, options);
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return res.json();
  return res.text();
}
const unwrap = (r) => (r && r.data !== undefined ? r.data : r);

// Consume the chunked text/plain log stream, appending output into `pre` as it
// arrives (live for a running job, the full stored log in one shot for a finished
// one). Text is added via text nodes only - never innerHTML - so log content can
// never be interpreted as markup.
async function streamLogInto(id, pre) {
  const token = getToken();
  const headers = {};
  if (token) headers["Authorization"] = "Bearer " + token;
  let res;
  try {
    res = await fetch(`/v2/logs/${id}/stream`, { headers });
  } catch (e) {
    pre.textContent = "(no log)";
    return;
  }
  let appended = false;
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
  if (!appended) pre.textContent = "(no log)";
}

let activeTab = "actors";

async function refreshUser() {
  const me = unwrap(await api("/v2/users/me"));
  const el = $("#current-user");
  if (el) el.textContent = (me && me.username) || "local-user";
}

// Switching users is client-side: pick an existing user's stored token and send
// it as the bearer on every subsequent request. A null token (the unclaimed
// default user) clears the stored token, i.e. acts token-less as local-user.
function switchTo(token) {
  setToken(token == null ? "" : token);
  refreshUser();
  refreshUserSelect();
  if (activeTab === "users") loadUsers();
  else loadList();
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

// Top-level tabs are backed by the per-user aggregate endpoints, so each list is
// already scoped to the acting user server-side (no client-side filtering).
async function loadList() {
  const list = $("#actor-list");
  if (!list) return;
  // The Users and Storages views render into #detail, not the #actor-list panel;
  // skip them here so the periodic refresh never clobbers those views.
  if (activeTab === "users" || activeTab === "storages") return;
  if (activeTab === "actors") {
    const items = (unwrap(await api("/v2/users/me/actors")).items) || [];
    list.innerHTML = "";
    if (!items.length) {
      list.appendChild(mk("li", { class: "muted", text: "No Actors yet. Push one with apify-cli." }));
      return;
    }
    for (const a of items) {
      list.appendChild(mk("li", { text: a.name, onClick: () => openActor(a.id) }));
    }
  } else if (activeTab === "builds") {
    const items = (unwrap(await api("/v2/users/me/builds")).items) || [];
    list.innerHTML = "";
    if (!items.length) {
      list.appendChild(mk("li", { class: "muted", text: "No builds yet." }));
      return;
    }
    for (const b of items) {
      list.appendChild(mk("li", { text: `${b.buildNumber} (${b.status})`, onClick: () => openBuild(b.id) }));
    }
  } else {
    const items = (unwrap(await api("/v2/users/me/runs")).items) || [];
    list.innerHTML = "";
    if (!items.length) {
      list.appendChild(mk("li", { class: "muted", text: "No runs yet." }));
      return;
    }
    for (const r of items) {
      list.appendChild(mk("li", { text: `${r.id} (${r.status})`, onClick: () => openRun(r.id) }));
    }
  }
}

function selectTab(tab) {
  activeTab = tab;
  document.querySelectorAll("#top-tabs span").forEach((s) => s.classList.remove("active"));
  const el = $(`#tab-${tab}`);
  if (el) el.classList.add("active");
  if (tab === "users") loadUsers();
  else if (tab === "storages") loadStorages();
  else loadList();
}

// Top-level Storages view: the acting user's own standalone storages grouped by
// type, each with a create-by-name form and a per-row delete. All lists are
// server-scoped to the acting user, so no other user's storages are ever shown.
const STORAGE_TYPES = [
  ["key-value-stores", "Key-value stores"],
  ["datasets", "Datasets"],
  ["request-queues", "Request queues"],
];

let showUnnamedStorages = true;
// Cache of the last-fetched items per storage type, keyed by path, so toggling
// the show/hide-unnamed checkbox can re-render from already-fetched data
// instead of issuing a new fetch().
let storageItemsCache = {};

async function loadStorages() {
  const list = $("#actor-list");
  if (list) list.innerHTML = "";

  for (const [path] of STORAGE_TYPES) {
    storageItemsCache[path] = (unwrap(await api(`/v2/users/me/${path}`)).items) || [];
  }

  renderStorages();
}

function renderStorages() {
  const detail = $("#detail");
  if (!detail) return;
  detail.innerHTML = "";
  detail.appendChild(mk("h2", { text: "Storages" }));

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

  for (const [path, label] of STORAGE_TYPES) {
    detail.appendChild(storageSection(path, label));
  }
}

function storageSection(path, label) {
  const wrap = mk("div");
  wrap.appendChild(mk("h2", { text: label, style: { marginTop: "14px" } }));

  const form = mk("div", { class: "row" });
  const input = mk("input");
  input.placeholder = "New name";
  const createBtn = mk("button", { text: "Create", onClick: () => createStorage(path, input.value) });
  form.append(input, createBtn);
  wrap.appendChild(form);

  const items = storageItemsCache[path] || [];
  const visible = showUnnamedStorages ? items : items.filter((st) => st.named === true);
  const rows = visible.map((st) => {
    const marker = mk("td", { class: "muted", text: st.named ? "named" : "run-derived" });
    const del = st.named
      ? mk("button", {
          class: "secondary",
          text: "Delete",
          onClick: () => deleteStorage(path, st.id),
        })
      : mk("td", { class: "muted", text: "" });
    return [mk("td", { text: st.name }), mk("td", { text: st.id }), marker, del];
  });
  wrap.appendChild(tableEl(["Name", "Id", "Named", ""], rows));
  return wrap;
}

async function createStorage(path, name) {
  const trimmed = (name || "").trim();
  if (!trimmed) return;
  await api(`/v2/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: trimmed }),
  });
  loadStorages();
}

async function deleteStorage(path, id) {
  if (!confirm(`Delete storage "${id}"? This permanently removes its data and cannot be undone.`)) return;
  await api(`/v2/${path}/${id}`, { method: "DELETE" });
  loadStorages();
}

window.openActor = async function (actorId) {
  const actor = unwrap(await api(`/v2/acts/${actorId}`));
  const builds = (unwrap(await api(`/v2/acts/${actorId}/builds`)).items) || [];
  const runs = (unwrap(await api(`/v2/acts/${actorId}/runs`)).items) || [];
  const detail = $("#detail");
  detail.innerHTML = "";

  const head = mk("div", { class: "row" });
  head.appendChild(mk("h2", { text: actor.name, style: { margin: "0" } }));
  head.appendChild(mk("span", { class: "muted", text: actor.id }));

  const actions = mk("div", { class: "row" });
  actions.appendChild(mk("button", { text: "Build", onClick: () => doBuild(actorId) }));
  actions.appendChild(mk("button", { text: "Run", onClick: () => doRun(actorId) }));
  actions.appendChild(mk("button", { class: "secondary", text: "Refresh", onClick: () => openActor(actorId) }));

  const buildsRows = builds.map((b) => [
    mk("td", { class: "clickable", text: b.id, onClick: () => openBuild(b.id) }),
    mk("td", { text: b.buildNumber }),
    badgeEl(b.status),
  ]);
  const runsRows = runs.map((r) => [
    mk("td", { class: "clickable", text: r.id, onClick: () => openRun(r.id) }),
    mk("td", { text: r.buildNumber }),
    badgeEl(r.status),
  ]);

  detail.append(
    head,
    actions,
    mk("h2", { text: "Builds" }),
    tableEl(["Build", "Number", "Status"], buildsRows),
    mk("h2", { text: "Runs", style: { marginTop: "14px" } }),
    tableEl(["Run", "Build", "Status"], runsRows),
  );
};

window.doBuild = async function (actorId) {
  await api(`/v2/acts/${actorId}/builds?version=0.0`, { method: "POST" });
  setTimeout(() => openActor(actorId), 500);
};

window.doRun = async function (actorId) {
  const input = prompt("Run input (JSON):", '{"greeting":"hello from console"}') || "{}";
  await api(`/v2/acts/${actorId}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: input,
  });
  setTimeout(() => openActor(actorId), 500);
};

window.openBuild = async function (buildId) {
  const b = unwrap(await api(`/v2/actor-builds/${buildId}`));
  const detail = $("#detail");
  detail.innerHTML = "";

  const head = mk("div", { class: "row" });
  head.appendChild(mk("h2", { text: `Build ${b.id}`, style: { margin: "0" } }));
  head.appendChild(badgeEl(b.status));

  const logPre = mk("pre");
  detail.append(
    head,
    mk("p", { class: "muted", text: `Actor: ${b.actId} · number ${b.buildNumber}` }),
    mk("h2", { text: "Build log" }),
    logPre,
    mk("button", { class: "secondary", text: "Back", onClick: () => openActor(b.actId) }),
  );
  streamLogInto(buildId, logPre);
};

window.openRun = async function (runId) {
  const r = unwrap(await api(`/v2/actor-runs/${runId}`));
  const detail = $("#detail");
  detail.innerHTML = "";

  const head = mk("div", { class: "row" });
  head.appendChild(mk("h2", { text: `Run ${r.id}`, style: { margin: "0" } }));
  head.appendChild(badgeEl(r.status));

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
    mk("button", { class: "secondary", text: "Back", onClick: () => openActor(r.actId) }),
  );
  showStore(kvTab, "kv", r.defaultKeyValueStoreId);
};

window.showStore = async function (tab, kind, id) {
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
      mk("td", { text: String(q.handled) }),
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

// Wire the header controls and top-level tabs with addEventListener (no inline
// handlers), then start the per-user view.
const _userSelect = $("#user-select");
if (_userSelect) _userSelect.addEventListener("change", () => switchTo(_userSelect.value));
$("#tab-actors").addEventListener("click", () => selectTab("actors"));
$("#tab-builds").addEventListener("click", () => selectTab("builds"));
$("#tab-runs").addEventListener("click", () => selectTab("runs"));
$("#tab-storages").addEventListener("click", () => selectTab("storages"));
$("#tab-users").addEventListener("click", () => selectTab("users"));

refreshUser();
refreshUserSelect();
loadList();
setInterval(loadList, 4000);

// Minimal console. Calls the same-origin /v2 API (no auth, single user).
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

async function api(path, opts) {
  const res = await fetch(path, opts);
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return res.json();
  return res.text();
}
const unwrap = (r) => (r && r.data !== undefined ? r.data : r);

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

async function loadActors() {
  const data = unwrap(await api("/v2/acts"));
  const items = data.items || [];
  const list = $("#actor-list");
  list.innerHTML = "";
  if (!items.length) {
    list.appendChild(mk("li", { class: "muted", text: "No Actors yet. Push one with apify-cli." }));
    return;
  }
  for (const a of items) {
    // Closure captures a.id as a plain string - no interpolation into markup.
    list.appendChild(mk("li", { text: a.name, onClick: () => openActor(a.id) }));
  }
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
  const log = await api(`/v2/logs/${buildId}`);
  const detail = $("#detail");
  detail.innerHTML = "";

  const head = mk("div", { class: "row" });
  head.appendChild(mk("h2", { text: `Build ${b.id}`, style: { margin: "0" } }));
  head.appendChild(badgeEl(b.status));

  detail.append(
    head,
    mk("p", { class: "muted", text: `Actor: ${b.actId} · number ${b.buildNumber}` }),
    mk("h2", { text: "Build log" }),
    mk("pre", { text: log || "(no log)" }),
    mk("button", { class: "secondary", text: "Back", onClick: () => openActor(b.actId) }),
  );
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
    const log = await api(`/v2/logs/${id}`);
    box.appendChild(mk("pre", { text: log || "(no log)" }));
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

loadActors();
setInterval(loadActors, 4000);

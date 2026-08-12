"""Console-frontend structural checks for storage list/detail pagination, the
per-storage stats line, and the upstream-fallback toggle UI (mostly
app/console/storage_tab.js, plus app.js's header toggle and index.html) --
separately scannable from test_console_api_extensions.py's own topic
(token-free user listing, live log streaming, top-level standalone storage
management).

All Docker-free via the `wired` fixture. Every test here is a structural scan
of the served console assets: no JS runtime exists in this suite to execute
any of them directly. See requirements/console.md's storage-paging/stats-line
sections and requirements/api.md's "Upstream fallback" section.
"""
from __future__ import annotations

import re


async def test_console_storage_list_offset_reset_is_owned_by_load_storages(wired):
    """`loadStorages` (storage_tab.js) alone owns resetting `storageListOffset`
    to 0, keyed off BOTH the slug and the acting user's token changing.
    Regression this catches: the list is ordered oldest-first
    (`list_storages_for_user` orders by `created_at`), so re-fetching a stale
    offset after a create/delete (or after switching to a user with fewer
    items) can leave a just-created item permanently unseen or land on an
    empty page (Next disabled)."""
    client, _service = wired
    storage_js = (await client.get("/console/storage_tab.js")).text
    app_js = (await client.get("/console/app.js")).text

    # The model: `loadStorages` resets to page 0 whenever either the slug OR
    # the acting user's token differs from the last load -- not slug alone --
    # and is the only function that ever assigns `storageListOffset`.
    load_start = storage_js.index("async function loadStorages(slug, offset)")
    load_body = storage_js[load_start : storage_js.index("\n}\n", load_start)]
    assert "slug === currentStorageSlug && token === storageListToken" in load_body
    assert "storageListToken = token;" in load_body
    # Its own declaration aside, every assignment to `storageListOffset` in
    # the whole file lives inside `loadStorages` -- nothing else pokes it.
    assert storage_js.count("storageListOffset =") == 3  # `let ... = 0;` + the two assignments above
    assert load_body.count("storageListOffset =") == 2

    # `switchTo()` no longer hand-pokes the offset directly -- the model
    # above already resets it for a token change, so there is nothing left
    # to poke.
    switch_start = app_js.index("function switchTo(token)")
    switch_body = app_js[switch_start : app_js.index("\n}\n", switch_start)]
    assert "storageListOffset" not in switch_body
    assert "storageListOffset" not in app_js  # not even referenced elsewhere in app.js

    # `createStorage`/`deleteStorage` still force a guaranteed fresh first
    # page (the list itself just changed under the SAME slug/user, which no
    # identity check can detect on its own) via the same explicit-offset
    # argument the paging controls use -- never a bare `loadStorages(slug)`.
    for fn_sig in ("async function createStorage(slug, name)", "async function deleteStorage(slug, id)"):
        fn_start = storage_js.index(fn_sig)
        fn_body = storage_js[fn_start : storage_js.index("\n}\n", fn_start)]
        assert "loadStorages(slug, 0);" in fn_body
        assert "loadStorages(slug);" not in fn_body


async def test_console_stats_line_shows_boolean_false_fields(wired):
    """`statsLineEl`'s filter must treat a boolean specially -- `false` is a
    present value, not emptiness -- while zero/blank/absent counters are
    still suppressed (see requirements/console.md's stats-line section).
    Grounded in the actual data shape a request queue's own GET-detail
    response returns for `hadMultipleClients` (already pinned end to end in
    test_storage_metadata.py); this test's own subject is the JS filter, not
    the backend field."""
    client, _service = wired
    js = (await client.get("/console/storage_tab.js")).text
    stats_idx = js.index("function statsLineEl(meta)")
    body = js[stats_idx : js.index("\n}", stats_idx)]
    assert 'typeof value !== "boolean"' in body


async def test_console_stats_line_renders_nothing_for_a_brand_new_empty_storage(wired):
    """Regression: a brand-new storage has every counter at 0, so
    `statsLineEl` had nothing to show yet -- but used to unconditionally
    return a `<p>` element anyway, rendering as a bare empty line above the
    content. It must return `null` when there is nothing to show, and each of
    `renderStoreContent`'s three storage-type branches (kv/ds/rq) must guard
    its own append so an empty stats line is never inserted into the DOM."""
    client, _service = wired
    js = (await client.get("/console/storage_tab.js")).text
    stats_idx = js.index("function statsLineEl(meta)")
    body = js[stats_idx : js.index("\n}", stats_idx)]
    assert "parts.length ? mk(" in body and ": null;" in body

    render_start = js.index("async function renderStoreContent(kind, id, offset)")
    render_body = js[render_start : js.index("\n}\n", render_start)]
    assert render_body.count("const stats = statsLineEl(") == 3
    assert render_body.count("if (stats) box.appendChild(stats);") == 3


async def test_console_ds_kv_hand_coded_stats_fields_match_get_detail_response(wired):
    """The ds/kv arms of `renderStoreContent` build their stats-line input
    from HAND-ENCODED field lists (`statsLineEl({ itemCount: total })` for
    kv, `statsLineEl({ itemCount: total, cleanItemCount: total })` for ds)
    rather than from those storages' own `GET`-detail response -- unlike the
    rq arm, which passes a real `GET`-detail response through unchanged.
    This is a deliberate optimization (see storage_tab.js's own comments: a
    second, full-materialization metadata fetch would reintroduce the very
    unbounded read this pagination feature exists to remove), but it means
    nothing otherwise ties the hand-coded field NAMES to the actual non-meta
    fields `get_dataset`/`get_kvs` (app/routers/storages.py) return. If a
    future field (e.g. the design's own listed `storageBytes` follow-up) is
    added to either handler, the rq arm picks it up automatically (it
    forwards the real response) while ds/kv would silently keep omitting it
    from the stats line's own "nothing non-empty omitted" contract (see
    requirements/console.md's stats-line section), with no test failing.
    Pin today's exact non-meta field sets here so adding a field to
    either handler breaks THIS test as a loud reminder to update the
    hand-coded lists in storage_tab.js to match."""
    client, _service = wired
    js = (await client.get("/console/storage_tab.js")).text

    meta_keys_idx = js.index("const STORAGE_META_KEYS = new Set([")
    meta_keys_body = js[meta_keys_idx : js.index("]);", meta_keys_idx)]
    meta_keys = set(re.findall(r'"(\w+)"', meta_keys_body))

    kv = (await client.post("/v2/key-value-stores", json={"name": "statsfields"})).json()["data"]
    kv_detail = (await client.get(f"/v2/key-value-stores/{kv['id']}")).json()["data"]
    assert set(kv_detail) - meta_keys == {"itemCount"}
    assert "statsLineEl({ itemCount: total })" in js

    ds = (await client.post("/v2/datasets", json={"name": "statsfields"})).json()["data"]
    ds_detail = (await client.get(f"/v2/datasets/{ds['id']}")).json()["data"]
    assert set(ds_detail) - meta_keys == {"itemCount", "cleanItemCount"}
    assert "statsLineEl({ itemCount: total, cleanItemCount: total })" in js


async def test_console_storage_list_drops_position_wording_while_filtered(wired):
    """`renderStorages` switches to `filteredPagingLineEl` (see that
    function's own comment for why) based on the "show unnamed" checkbox's
    own state alone -- unchecked uses it, checked uses the normal
    `pagingLineEl` -- regardless of whether the current page actually has any
    row hidden."""
    client, _service = wired
    js = (await client.get("/console/storage_tab.js")).text

    filtered_idx = js.index("function filteredPagingLineEl(visibleCount, pageCount, total)")
    filtered_body = js[filtered_idx : js.index("\n}", filtered_idx)]
    assert "showing ${visibleCount} of ${pageCount} on this page" in filtered_body
    assert "${total} total" in filtered_body

    render_start = js.index("function renderStorages()")
    render_body = js[render_start : js.index("\n}\n", render_start)]
    assert re.search(
        r"showUnnamedStorages\s*\n\s*\? pagingLineEl\(storageListOffset, visible\.length, cache\.total\)\s*\n"
        r"\s*: filteredPagingLineEl\(visible\.length, items\.length, cache\.total\)",
        render_body,
    )


async def test_console_paging_controls_disable_boundary_pinned(wired):
    """Prev must disable exactly on the first page, Next exactly on the last
    (see requirements/console.md's paging section) -- structural, since no JS
    runtime exists in this suite to execute `pagingControlsEl` directly."""
    client, _service = wired
    js = (await client.get("/console/storage_tab.js")).text

    controls_idx = js.index("function pagingControlsEl(offset, count, total, onPage)")
    body = js[controls_idx : js.index("\n}", controls_idx)]

    # Prev disabled exactly on the first page -- not "< 0" (never true, since
    # offset never goes negative) and not "== 0" (would stay enabled after a
    # raced page that clamps offset back to 0 via Math.max(0, ...) below).
    assert "prev.disabled = offset <= 0;" in body
    # Next disabled exactly when the current slice reaches the total -- not
    # "> total" (an off-by-one leaving Next clickable one page past the end).
    assert "next.disabled = offset + count >= total;" in body

    # Both booleans are set on the actual buttons this function returns (not
    # dead/unused locals): `prev`/`next` are appended to the returned row.
    assert "row.append(prev, next);" in body


async def test_console_render_store_content_guards_against_error_envelopes(wired):
    """`renderStoreContent`'s kv/rq item fetches (and rq's own metadata fetch)
    must bail out on an error response (storage deleted / access revoked
    mid-view) before computing a paging line from a shape that was never a
    paginated payload -- no automated browser test exists for this repo's
    plain JS console, so this is a structural check that each guard is
    actually wired in, not just present somewhere in the function."""
    client, _service = wired
    js = (await client.get("/console/storage_tab.js")).text

    assert "function isErrorEnvelope(resp)" in js
    assert "function errorLineEl(err)" in js

    body_start = js.index("async function renderStoreContent(kind, id, offset)")
    body_end = js.index("\n// tableEl already renders", body_start)
    body = js[body_start:body_end]

    # Each `isErrorEnvelope` guard must be tied to an early `return` INSIDE
    # its own `if` block, not merely present somewhere in the function -- a
    # bare substring count on `isErrorEnvelope(...)` cannot catch a
    # regression that keeps the check but drops the `return;`, e.g.:
    #   if (isErrorEnvelope(meta)) { box.appendChild(errorLineEl(meta.error)); }
    # which falls through into `statsLineEl(meta)`/the paging fetch against an
    # `{error: ...}`-shaped object -- exactly the bug this test's docstring
    # says it exists to catch -- while a bare `isErrorEnvelope(...)` count
    # stays unchanged.
    guarded_return = re.compile(
        r"if \(isErrorEnvelope\((\w+)\)\) \{\s*"
        r"box\.appendChild\(errorLineEl\(\1\.error\)\);\s*"
        r"return;\s*\}"
    )
    matches = guarded_return.findall(body)
    assert matches.count("keysResp") == 1  # kv branch
    assert matches.count("meta") == 1  # rq branch's own metadata fetch
    assert matches.count("reqsResp") == 1  # rq branch's requests fetch

    # The ds branch's own items fetch is a bare array, not an envelope, so it
    # guards via `res.ok` instead of `isErrorEnvelope` -- and, unlike the
    # other branches, must check `ok` BEFORE parsing the body at all: a
    # non-JSON error body (e.g. a plain-text 500) would otherwise throw
    # trying to parse it as the success shape.
    assert re.search(
        r"if \(!res\.ok\) \{[\s\S]*?"
        r"box\.appendChild\(errorLineEl\(err && err\.error\)\);\s*"
        r"return;\s*\}",
        body,
    )
    assert body.index("if (!res.ok)") < body.index("const items = await res.json();")


async def test_console_kv_record_fetches_are_encoded_and_parallelized(wired):
    """Regression: the KV detail view's per-key record fetch must
    percent-encode the key (`encodeURIComponent`) before it reaches the URL --
    an unencoded key containing `/`, `#` or `?` would either address a
    different record (an extra path segment) or get mis-split by the
    browser's own URL parsing (`#` starts a fragment, `?` a query string) --
    and must issue all of a page's record fetches concurrently
    (`Promise.all`), not one key at a time, since `Promise.all` still
    resolves its results in the same order as the input array regardless of
    which individual fetch finishes first."""
    client, _service = wired
    js = (await client.get("/console/storage_tab.js")).text

    render_start = js.index("async function renderStoreContent(kind, id, offset)")
    render_body = js[render_start : js.index("\n}\n", render_start)]

    assert "records/${encodeURIComponent(k.key)}" in render_body
    assert re.search(r"await Promise\.all\(\s*keys\.map\(", render_body)


async def test_console_load_storages_guards_against_error_envelope(wired):
    """`loadStorages` fetches `/v2/users/me/{slug}` with the acting user's
    own (possibly stale/revoked) token, so it can fail just like any other
    per-storage fetch (e.g. a `401` error envelope) -- it must guard the same
    way `renderStoreContent` does (one idiom on both paths, not a guard on
    one and a silent `resp.items || []` degrade on the other)."""
    client, _service = wired
    js = (await client.get("/console/storage_tab.js")).text

    load_start = js.index("async function loadStorages(slug, offset)")
    body = js[load_start : js.index("\n}\n", load_start)]
    assert re.search(
        r"if \(isErrorEnvelope\(resp\)\) \{[\s\S]*?"
        r"detail\.appendChild\(errorLineEl\(resp\.error\)\);[\s\S]*?"
        r"return;\s*\}",
        body,
    )


async def test_console_four_listing_surfaces_always_send_limit_and_offset(wired):
    """Every console fetch against the four paginated listing surfaces
    (per-user storage lists, KV keys, dataset items, RQ requests) must carry
    an explicit `limit`/`offset` -- never a bare/unbounded request, or a
    local storage with more than one page silently reloads the old "fetch
    everything" behaviour in the browser (see requirements/console.md's
    storage-paging section).

    Structural, like this file's other storage_tab.js checks -- but instead of
    pinning one known-good call site by its exact interpolated variable
    name, this matches on each surface's static PATH SHAPE with any
    `${...}` interpolation in the id/slug position, so it fails equally on
    an existing call site losing its `limit`/`offset` AND on a brand-new
    call site added later for one of these paths (however it names its own
    id variable) that forgets them."""
    client, _service = wired
    js = (await client.get("/console/storage_tab.js")).text

    surfaces = {
        "per-user storage list": r"/v2/users/me/\$\{[^}]*\}",
        "kv keys": r"/v2/key-value-stores/\$\{[^}]*\}/keys",
        "dataset items": r"/v2/datasets/\$\{[^}]*\}/items",
        "rq requests": r"/v2/request-queues/\$\{[^}]*\}/requests",
    }
    for label, path_pattern in surfaces.items():
        call_sites = re.findall(rf"`{path_pattern}[^`]*`", js)
        assert call_sites, f"no fetch call site found for the {label} surface"
        for site in call_sites:
            assert "limit=" in site, f"{label} call site {site!r} is missing an explicit limit"
            assert "offset=" in site, f"{label} call site {site!r} is missing an explicit offset"


async def test_console_fallback_toggle_present_and_wired_to_runtime_config(wired):
    """The "API fallback" toggle must be present next to the existing "Switch
    user" control, read its state via a token-free GET on load, PUT its new
    state to the same endpoint on change, and reflect whatever the endpoint
    reports back onto the checkbox -- re-reading the server's actual
    resulting state after the PUT rather than assuming it succeeded, since a
    flip made from another tab/port (or a rejected PUT) must never leave this
    checkbox silently wrong (see requirements/console.md's "header's API
    fallback toggle" section). The backend half (GET/PUT /v2/runtime-config)
    already has thorough coverage in test_upstream_fallback.py; this covers
    the console-facing wiring's existence and shape, which had none."""
    client, _service = wired
    html = (await client.get("/")).text

    # The checkbox sits in the header, immediately after (i.e. "next to") the
    # existing "Switch user" <select> -- not just present somewhere on the page.
    header_start = html.index("<header")
    header_end = html.index("</header>")
    user_select_idx = html.index('id="user-select"')
    fallback_idx = html.index('id="fallback-toggle"')
    assert header_start < user_select_idx < fallback_idx < header_end
    assert fallback_idx - user_select_idx < 200
    assert 'type="checkbox"' in html[fallback_idx - 40 : fallback_idx + 40]

    js = (await client.get("/console/app.js")).text

    # Reads state on load via a token-free GET, reflecting the returned
    # boolean onto the checkbox -- not claiming/bootstrapping a token just to
    # load the console (like the public user list).
    refresh_start = js.index("async function refreshFallbackToggle()")
    refresh_body = js[refresh_start : js.index("\n}\n", refresh_start)]
    assert '$("#fallback-toggle")' in refresh_body
    assert 'api("/v2/runtime-config", { skipAuth: true })' in refresh_body
    assert "toggle.checked" in refresh_body and "upstreamFallbackEnabled" in refresh_body

    # PUTs the new state to the same endpoint on change -- WITHOUT skipAuth:
    # unlike GET, PUT requires a valid token (see requirements/api.md's
    # "Upstream fallback" section), so it sends the acting user's bearer
    # token like any other mutating request.
    set_start = js.index("async function setFallbackEnabled(enabled)")
    set_body = js[set_start : js.index("\n}\n", set_start)]
    assert 'method: "PUT"' in set_body
    assert '"/v2/runtime-config"' in set_body
    assert "upstreamFallbackEnabled: enabled" in set_body
    assert "skipAuth" not in set_body
    # Re-reads the server's actual resulting state after the PUT rather than
    # assuming it took effect as requested.
    assert "refreshFallbackToggle();" in set_body

    # Wired via addEventListener (no inline handler) to the checkbox's own
    # current .checked state, with a `.catch` guarding against a rejected PUT
    # (mirroring periodicRefresh's own guard on refreshFallbackToggle()) so a
    # runtime-unreachable flip never surfaces as an unhandled rejection.
    assert (
        'addEventListener("change", () => setFallbackEnabled(_fallbackToggle.checked).catch(() => {}))'
    ) in js
    # Read once on every initial page load -- the literal page-load init
    # sequence, not just ANY occurrence of `refreshFallbackToggle();`:
    # `periodicRefresh`/`setFallbackEnabled` also call it, so a bare
    # substring count would still pass even if the page-load call itself
    # were ever dropped.
    assert (
        "refreshUserSelect();\nrefreshFallbackToggle();\nrenderRoute();\n"
        "setInterval(periodicRefresh, 4000);"
    ) in js


async def test_console_fallback_toggle_guards_against_a_stale_periodic_repaint(wired):
    """A periodic 4s-tick GET issued before the user flips the toggle can
    resolve AFTER that flip's own PUT+re-GET (response ordering over the
    network is not guaranteed to match request issue order) and repaint the
    checkbox back to the pre-flip value -- the dangerous direction, since it
    shows OFF while the runtime is actually ON, no matter how far into the
    flip that earlier GET was still in flight. `setFallbackEnabled` must bump
    a monotonically-increasing generation counter exactly once, after its own
    PUT resolves and before its own trailing refresh, and
    `refreshFallbackToggle` must capture the counter BEFORE issuing its own
    GET and skip the repaint if the counter has since moved."""
    client, _service = wired
    js = (await client.get("/console/app.js")).text

    set_start = js.index("async function setFallbackEnabled(enabled)")
    set_body = js[set_start : js.index("\n}\n", set_start)]
    # Bumped exactly once, after the PUT resolves and before the trailing
    # refresh -- never before the PUT is issued.
    put_idx = set_body.index("await api(")
    increment_idx = set_body.index("fallbackToggleGeneration++;")
    refresh_idx = set_body.index("await refreshFallbackToggle();")
    assert put_idx < increment_idx < refresh_idx

    refresh_start = js.index("async function refreshFallbackToggle()")
    refresh_body = js[refresh_start : js.index("\n}\n", refresh_start)]
    # The snapshot must be taken BEFORE the GET and compared against the
    # live counter AFTER it, bailing out before any repaint if it moved.
    capture_idx = refresh_body.index("const generation = fallbackToggleGeneration;")
    fetch_idx = refresh_body.index("await api(")
    guard_idx = refresh_body.index("if (generation !== fallbackToggleGeneration) return;")
    assert capture_idx < fetch_idx < guard_idx < refresh_body.index("toggle.checked =")


async def test_console_fallback_toggle_ignores_a_failed_or_invalid_response(wired):
    """Regression: `api()` returns whatever a non-JSON response's body parses
    to (raw text) rather than throwing, and an error envelope's `unwrap()`
    passes through unchanged (only `.data` is stripped) -- so a transient
    500/plain-text/error `GET /v2/runtime-config` response used to leave
    `cfg.upstreamFallbackEnabled` `undefined`, which `!!(...)` turned into a
    false "fallback is OFF" repaint. This runs on every `periodicRefresh` tick
    (~4s), so a developer relying on an ON toggle could be shown OFF on a
    passing failure and issue a write believing it stays local-only.
    `toggle.checked` may only be assigned once the response is confirmed to
    actually carry a boolean `upstreamFallbackEnabled` -- anything else must
    leave the checkbox exactly as it was."""
    client, _service = wired
    js = (await client.get("/console/app.js")).text

    refresh_start = js.index("async function refreshFallbackToggle()")
    refresh_body = js[refresh_start : js.index("\n}\n", refresh_start)]
    assert re.search(
        r'if \(cfg && typeof cfg === "object" '
        r'&& typeof cfg\.upstreamFallbackEnabled === "boolean"\) \{\s*'
        r"toggle\.checked = cfg\.upstreamFallbackEnabled;\s*\}",
        refresh_body,
    )
    # The assignment must be gated by that check, not also happen unconditionally.
    assert refresh_body.count("toggle.checked =") == 1

"""Console-frontend structural checks for storage list/detail pagination, the
per-storage stats line, and the upstream-fallback toggle UI (app/console/
app.js and index.html) -- separately scannable from
test_console_api_extensions.py's own topic (token-free user listing, live log
streaming, top-level standalone storage management).

All Docker-free via the `wired` fixture. Every test here is a structural scan
of the served console assets: no JS runtime exists in this suite to execute
app.js directly. See requirements/console.md's storage-paging/stats-line
sections and requirements/api.md's "Upstream fallback" section.
"""
from __future__ import annotations

import re


async def test_console_create_and_delete_storage_reset_paging_offset(wired):
    """`createStorage`/`deleteStorage` must reset the paging offset when
    re-fetching the storage list, not silently re-fetch whatever offset was
    already showing: the list is ordered oldest-first
    (`list_storages_for_user` orders by `created_at`), so a create appended
    past the end of a full page can otherwise go permanently unseen (the
    fetch never moves past the stale offset to reveal it), and a delete of
    the last item on a later page can land on an empty page. Both must call
    `loadStorages(slug, 0)` explicitly -- a bare `loadStorages(slug)` leaves
    `storageListOffset` untouched (see `loadStorages`'s own reset logic:
    `offset != null` is false for an omitted argument), reproducing exactly
    this regression."""
    client, _service = wired
    js = (await client.get("/console/app.js")).text

    create_start = js.index("async function createStorage(slug, name)")
    create_body = js[create_start : js.index("\n}\n", create_start)]
    assert "loadStorages(slug, 0);" in create_body
    assert "loadStorages(slug);" not in create_body

    delete_start = js.index("async function deleteStorage(slug, id)")
    delete_body = js[delete_start : js.index("\n}\n", delete_start)]
    assert "loadStorages(slug, 0);" in delete_body
    assert "loadStorages(slug);" not in delete_body


async def test_console_switch_user_resets_storage_list_offset(wired):
    """Regression: `switchTo()` called `renderRoute()` without resetting
    `storageListOffset`, so switching the acting user while on
    `/storage/{slug}` reused the PREVIOUS user's paging offset -- landing on
    an empty page (Next disabled) for a user with fewer items than that
    offset, the same stale-offset hazard `createStorage`/`deleteStorage`
    (the test above) already reset for on mutation, just triggered by a user
    switch instead."""
    client, _service = wired
    js = (await client.get("/console/app.js")).text
    switch_start = js.index("function switchTo(token)")
    body = js[switch_start : js.index("\n}\n", switch_start)]
    assert "storageListOffset = 0;" in body


async def test_console_fallback_toggle_refreshed_periodically_and_after_put(wired):
    """Regression: the header's fallback checkbox used to be read once at
    page load and never again, and `setFallbackEnabled`'s PUT result was
    discarded outright -- so a flip made from another tab/port (or a
    rejected PUT) left this checkbox silently wrong. For THIS toggle that
    risks a developer believing local-only mode is active while writes are
    actually being relayed upstream. `periodicRefresh` must also refresh the
    toggle (not just conditionally re-render the route), and
    `setFallbackEnabled` must re-read the server's actual resulting state
    after its PUT rather than assume it succeeded."""
    client, _service = wired
    js = (await client.get("/console/app.js")).text

    periodic_start = js.index("function periodicRefresh()")
    periodic_body = js[periodic_start : js.index("\n}\n", periodic_start)]
    assert "refreshFallbackToggle()" in periodic_body
    # Guarded against, and tolerant of a failed fetch during, an in-flight
    # user-initiated flip (see the dedicated race test below) -- not a bare,
    # unconditional, uncaught call.
    assert "fallbackTogglePutInFlight" in periodic_body
    assert "refreshFallbackToggle().catch(" in periodic_body

    set_start = js.index("async function setFallbackEnabled(enabled)")
    set_body = js[set_start : js.index("\n}\n", set_start)]
    assert "refreshFallbackToggle();" in set_body


async def test_console_fallback_toggle_periodic_poll_guarded_against_in_flight_flip(wired):
    """Regression: `periodicRefresh`'s unconditional, uncaught
    `refreshFallbackToggle()` call could (a) land between the checkbox's own
    `change` event and its PUT's completion, re-reading the OLD server state
    and visually snapping the checkbox back an instant before
    `setFallbackEnabled`'s own re-read corrected it, and (b) throw an
    unhandled rejection every 4s with the API unreachable. `setFallbackEnabled`
    must set (and, in a `finally`, always clear) an in-flight flag around its
    PUT+re-read, and `periodicRefresh` must both skip its call while that flag
    is set and `.catch()` a failed one."""
    client, _service = wired
    js = (await client.get("/console/app.js")).text

    set_start = js.index("async function setFallbackEnabled(enabled)")
    set_body = js[set_start : js.index("\n}\n", set_start)]
    assert "fallbackTogglePutInFlight = true;" in set_body
    # Cleared unconditionally, even if the PUT itself throws -- a `finally`,
    # not a plain trailing assignment that a rejected `api()` call would skip.
    assert re.search(r"finally \{\s*fallbackTogglePutInFlight = false;\s*\}", set_body)

    periodic_start = js.index("function periodicRefresh()")
    periodic_body = js[periodic_start : js.index("\n}\n", periodic_start)]
    assert "if (!fallbackTogglePutInFlight) refreshFallbackToggle().catch(() => {});" in periodic_body


async def test_console_stats_line_shows_boolean_false_fields(wired):
    """`statsLineEl`'s filter must treat a boolean specially -- `false` is a
    present value, not emptiness -- while zero/blank/absent counters are
    still suppressed (see requirements/console.md's stats-line section).
    Grounded in the actual data shape a request queue's own GET-detail
    response returns for `hadMultipleClients` (already pinned end to end in
    test_storage_metadata.py); this test's own subject is the JS filter, not
    the backend field."""
    client, _service = wired
    js = (await client.get("/console/app.js")).text
    stats_idx = js.index("function statsLineEl(meta)")
    body = js[stats_idx : js.index("\n}", stats_idx)]
    assert 'typeof value !== "boolean"' in body
    assert "value === false" not in body


async def test_console_stats_line_only_excludes_empty_objects(wired):
    """`statsLineEl`'s object-valued filter must key off emptiness, not a
    blanket `typeof value === "object"` check -- the latter would silently
    drop any non-empty object-valued stat field ever added later, at odds
    with requirements/console.md's "nothing non-empty omitted" stats-line
    contract. Today only a request queue's permanently-empty `stats`
    sub-object hits this filter, so the gap is latent, not a present bug --
    this pins the fix in place. Structural, like the sibling boolean-false
    check above: no JS runtime exists in this suite to execute `statsLineEl`
    directly."""
    client, _service = wired
    js = (await client.get("/console/app.js")).text
    stats_idx = js.index("function statsLineEl(meta)")
    body = js[stats_idx : js.index("\n}", stats_idx)]
    assert "Object.keys(value).length === 0" in body


async def test_console_stats_line_renders_nothing_for_a_brand_new_empty_storage(wired):
    """Regression: a brand-new storage has every counter at 0, so
    `statsLineEl` had nothing to show yet -- but used to unconditionally
    return a `<p>` element anyway, rendering as a bare empty line above the
    content. It must return `null` when there is nothing to show, and each of
    `renderStoreContent`'s three storage-type branches (kv/ds/rq) must guard
    its own append so an empty stats line is never inserted into the DOM."""
    client, _service = wired
    js = (await client.get("/console/app.js")).text
    stats_idx = js.index("function statsLineEl(meta)")
    body = js[stats_idx : js.index("\n}", stats_idx)]
    assert "parts.length ? mk(" in body and ": null;" in body

    render_start = js.index("async function renderStoreContent(kind, id, offset)")
    render_body = js[render_start : js.index("\n}\n", render_start)]
    assert render_body.count("const stats = statsLineEl(") == 3
    assert render_body.count("if (stats) box.appendChild(stats);") == 3


async def test_console_paging_line_clamps_upper_bound_to_total(wired):
    """`pagingLineEl`'s upper bound (`to`) must be guarded the same way its
    lower bound (`from`) already is. `from` was already `count ? offset + 1 :
    0` -- correct on an empty page -- but `to` used to be a bare
    `offset + count`, which renders something like "showing 0-100 of 90" for
    a raced empty page (`count` 0, `offset` > 0, because `total` shrank
    between two page loads -- e.g. another session deleted items while this
    one sat on a later page). `to` must both (a) fall back to `from` on an
    empty page, so the line reads "showing 0-0 of T", and (b) never exceed
    `total` even on a non-empty page, so the line always correctly describes
    the current slice's position (see requirements/console.md's paging
    section). Structural, like this file's other app.js checks: no JS
    runtime exists in this suite to execute `pagingLineEl` directly."""
    client, _service = wired
    js = (await client.get("/console/app.js")).text
    paging_idx = js.index("function pagingLineEl(offset, count, total)")
    body = js[paging_idx : js.index("\n}", paging_idx)]
    assert "const from = count ? offset + 1 : 0;" in body
    assert re.search(r"const to = count \? Math\.min\(offset \+ count, total\) : from;", body)


async def test_console_storage_list_drops_position_wording_while_filtered(wired):
    """`renderStorages`'s "showing N-M of T" line is only accurate when every
    fetched row is visible: with the "show unnamed" checkbox hiding some
    rows, the visible rows are a scattered subset of the page, not a
    contiguous N-M slice of the total, so that range claim would be false.
    `renderStorages` must switch to `filteredPagingLineEl` (which drops the
    position claim, keeping only counts that stay true either way) exactly
    when the filter is hiding rows, and back to the normal `pagingLineEl`
    when it isn't."""
    client, _service = wired
    js = (await client.get("/console/app.js")).text

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
    js = (await client.get("/console/app.js")).text

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
    js = (await client.get("/console/app.js")).text

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


async def test_console_load_storages_guards_against_error_envelope(wired):
    """`loadStorages` fetches `/v2/users/me/{slug}` with the acting user's
    own (possibly stale/revoked) token, so it can fail just like any other
    per-storage fetch (e.g. a `401` error envelope) -- it must guard the same
    way `renderStoreContent` does (one idiom on both paths, not a guard on
    one and a silent `resp.items || []` degrade on the other)."""
    client, _service = wired
    js = (await client.get("/console/app.js")).text

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

    Structural, like this file's other app.js checks -- but instead of
    pinning one known-good call site by its exact interpolated variable
    name, this matches on each surface's static PATH SHAPE with any
    `${...}` interpolation in the id/slug position, so it fails equally on
    an existing call site losing its `limit`/`offset` AND on a brand-new
    call site added later for one of these paths (however it names its own
    id variable) that forgets them."""
    client, _service = wired
    js = (await client.get("/console/app.js")).text

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
    reports back onto the checkbox (see requirements/console.md's "header's
    API fallback toggle" section). The backend half (GET/PUT
    /v2/runtime-config) already has thorough coverage in
    test_upstream_fallback.py; this covers the console-facing wiring's
    existence and shape, which had none."""
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

    # Wired via addEventListener (no inline handler) to the checkbox's own
    # current .checked state.
    assert 'addEventListener("change", () => setFallbackEnabled(_fallbackToggle.checked))' in js
    # Read once on every initial page load -- the literal page-load init
    # sequence, not just ANY occurrence of `refreshFallbackToggle();`:
    # `periodicRefresh`/`setFallbackEnabled` also call it, so a bare
    # substring count would still pass even if the page-load call itself
    # were ever dropped.
    assert (
        "refreshUserSelect();\nrefreshFallbackToggle();\nrenderRoute();\n"
        "setInterval(periodicRefresh, 4000);"
    ) in js

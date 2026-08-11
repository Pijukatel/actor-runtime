"""Console-frontend structural checks for storage list/detail pagination, the
per-storage stats line, and the upstream-fallback toggle UI (app/console/
app.js and index.html).

Split out of test_console_api_extensions.py (scoped to token-free user
listing, live log streaming, and top-level standalone storage management) so
that module's stated scope stays accurate and this one's own topic --
console-side paging/stats/toggle rendering -- is separately scannable.

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


async def test_console_paging_controls_disable_boundary_pinned(wired):
    """`pagingControlsEl` implements the Prev/Next paging controls that must
    step through the full result set and disable at either end -- Prev
    disabled on the first page, Next disabled on the last (see
    requirements/console.md's paging section). Every sibling paging/stats
    function has a dedicated structural pin -- `pagingLineEl`'s clamping (the
    test above), `statsLineEl`'s boolean/empty-object filters (the two tests
    above that) -- so this pins the two boundary expressions for
    `pagingControlsEl` verbatim too. Structural, like those: no JS runtime
    exists in this suite to execute `pagingControlsEl` directly. It fails
    equally if a future edit drops either `disabled` assignment outright or
    inverts its comparison -- e.g. `offset < 0` instead of `offset <= 0`
    (Prev would stay enabled with nothing before it), or
    `offset + count > total` instead of `>= total` (Next would stay
    clickable one page past the end, requesting an empty slice beyond the
    total) -- exactly the off-by-one class that would silently mis-page a
    large storage."""
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
    """`renderStoreContent`'s shared meta fetch and its kv/rq item fetches
    must bail out on an error response (storage deleted / access revoked
    mid-view) before computing a paging line from a shape that was never a
    paginated payload -- no automated browser test exists for this repo's
    plain JS console, so this is a structural check that each guard is
    actually wired in, not just present somewhere in the function."""
    client, _service = wired
    js = (await client.get("/console/app.js")).text

    assert "function isErrorEnvelope(resp)" in js
    assert "function errorLineEl(err)" in js

    body_start = js.index("async function renderStoreContent()")
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
    # The meta fetch/guard is shared by all three branches (kv/ds/rq) --
    # written, and therefore matched, exactly once, not copy-pasted per
    # branch.
    assert matches.count("meta") == 1
    assert matches.count("keysResp") == 1  # kv branch
    assert matches.count("reqsResp") == 1  # rq branch

    # The ds branch's own items fetch is a bare array, not an envelope, so it
    # guards via `res.ok` instead of `isErrorEnvelope` -- same tied-to-`return`
    # contract applies there too.
    assert re.search(
        r"if \(!res\.ok\) \{\s*"
        r"box\.appendChild\(errorLineEl\(items && items\.error\)\);\s*"
        r"return;\s*\}",
        body,
    )


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

    # PUTs the new state to the same endpoint on change.
    set_start = js.index("async function setFallbackEnabled(enabled)")
    set_body = js[set_start : js.index("\n}\n", set_start)]
    assert 'method: "PUT"' in set_body
    assert '"/v2/runtime-config"' in set_body
    assert "upstreamFallbackEnabled: enabled" in set_body

    # Wired via addEventListener (no inline handler) to the checkbox's own
    # current .checked state, and read once on every initial page load.
    assert 'addEventListener("change", () => setFallbackEnabled(_fallbackToggle.checked))' in js
    assert "refreshFallbackToggle();" in js

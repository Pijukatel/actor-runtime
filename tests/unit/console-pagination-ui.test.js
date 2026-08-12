/**
 * Console-frontend structural checks for storage list/detail pagination, the
 * per-storage stats line, and the upstream-fallback toggle UI (mostly
 * src/console/storage_tab.js, plus app.js's header toggle and index.html) --
 * separately scannable from console-api-extensions.test.js's own topic
 * (token-free user listing, live log streaming, top-level standalone storage
 * management).
 *
 * All Docker-free via `wire()`. Every test here is a structural scan of the
 * served console assets: no JS runtime exists in this suite to execute any of
 * them directly. See requirements/console.md's storage-paging/stats-line
 * sections and requirements/api.md's "Upstream fallback" section.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { wire } from '../helpers.js';

let ctx;

beforeEach(async () => {
    ctx = await wire();
});

afterEach(async () => {
    await ctx.close();
});

/** Like `String.prototype.indexOf`, but fails the test when absent (Python's `str.index`). */
function indexOfOrFail(haystack, needle, from = 0) {
    const i = haystack.indexOf(needle, from);
    expect(i, `expected to find ${JSON.stringify(needle)}`).toBeGreaterThanOrEqual(0);
    return i;
}

function count(haystack, needle) {
    return haystack.split(needle).length - 1;
}

/** Slice out the text from `start` marker up to the next `end` marker. */
function sliceBetween(text, startMarker, endMarker) {
    const start = indexOfOrFail(text, startMarker);
    return text.slice(start, indexOfOrFail(text, endMarker, start));
}

describe('console pagination and fallback-toggle UI', () => {
    it('storage list offset reset is owned by loadStorages', async () => {
        // `loadStorages` (storage_tab.js) alone owns resetting
        // `storageListOffset` to 0, keyed off BOTH the slug and the acting
        // user's token changing. Regression this catches: the list is ordered
        // oldest-first (`listStoragesForUser` orders by `createdAt`), so
        // re-fetching a stale offset after a create/delete (or after switching
        // to a user with fewer items) can leave a just-created item
        // permanently unseen or land on an empty page (Next disabled).
        const storageJs = (await ctx.client.get('/console/storage_tab.js')).text();
        const appJs = (await ctx.client.get('/console/app.js')).text();

        // The model: `loadStorages` resets to page 0 whenever either the slug
        // OR the acting user's token differs from the last load -- not slug
        // alone -- and is the only function that ever assigns
        // `storageListOffset`.
        const loadBody = sliceBetween(storageJs, 'async function loadStorages(slug, offset)', '\n}\n');
        expect(loadBody).toContain('slug === currentStorageSlug && token === storageListToken');
        expect(loadBody).toContain('storageListToken = token;');
        // Its own declaration aside, every assignment to `storageListOffset`
        // in the whole file lives inside `loadStorages` -- nothing else pokes it.
        expect(count(storageJs, 'storageListOffset =')).toBe(3); // `let ... = 0;` + the two assignments above
        expect(count(loadBody, 'storageListOffset =')).toBe(2);

        // `switchTo()` no longer hand-pokes the offset directly -- the model
        // above already resets it for a token change, so there is nothing left
        // to poke.
        const switchBody = sliceBetween(appJs, 'function switchTo(token)', '\n}\n');
        expect(switchBody).not.toContain('storageListOffset');
        expect(appJs).not.toContain('storageListOffset'); // not even referenced elsewhere in app.js

        // `createStorage`/`deleteStorage` still force a guaranteed fresh first
        // page (the list itself just changed under the SAME slug/user, which
        // no identity check can detect on its own) via the same
        // explicit-offset argument the paging controls use -- never a bare
        // `loadStorages(slug)`.
        for (const fnSig of ['async function createStorage(slug, name)', 'async function deleteStorage(slug, id)']) {
            const fnBody = sliceBetween(storageJs, fnSig, '\n}\n');
            expect(fnBody).toContain('loadStorages(slug, 0);');
            expect(fnBody).not.toContain('loadStorages(slug);');
        }
    });

    it('stats line shows boolean false fields', async () => {
        // `statsLineEl`'s filter must treat a boolean specially -- `false` is
        // a present value, not emptiness -- while zero/blank/absent counters
        // are still suppressed (see requirements/console.md's stats-line
        // section). Grounded in the actual data shape a request queue's own
        // GET-detail response returns for `hadMultipleClients` (already pinned
        // end to end in the storage-metadata suite); this test's own subject
        // is the JS filter, not the backend field.
        const js = (await ctx.client.get('/console/storage_tab.js')).text();
        const body = sliceBetween(js, 'function statsLineEl(meta)', '\n}');
        expect(body).toContain('typeof value !== "boolean"');
    });

    it('stats line renders nothing for a brand-new empty storage', async () => {
        // Regression: a brand-new storage has every counter at 0, so
        // `statsLineEl` had nothing to show yet -- but used to unconditionally
        // return a `<p>` element anyway, rendering as a bare empty line above
        // the content. It must return `null` when there is nothing to show,
        // and each of `renderStoreContent`'s three storage-type branches
        // (kv/ds/rq) must guard its own append so an empty stats line is never
        // inserted into the DOM.
        const js = (await ctx.client.get('/console/storage_tab.js')).text();
        const body = sliceBetween(js, 'function statsLineEl(meta)', '\n}');
        expect(body).toContain('parts.length ? mk(');
        expect(body).toContain(': null;');

        const renderBody = sliceBetween(js, 'async function renderStoreContent(kind, id, offset)', '\n}\n');
        expect(count(renderBody, 'const stats = statsLineEl(')).toBe(3);
        expect(count(renderBody, 'if (stats) box.appendChild(stats);')).toBe(3);
    });

    it('ds/kv hand-coded stats fields match the GET-detail response', async () => {
        // The ds/kv arms of `renderStoreContent` build their stats-line input
        // from HAND-ENCODED field lists (`statsLineEl({ itemCount: total })`
        // for kv, `statsLineEl({ itemCount: total, cleanItemCount: total })`
        // for ds) rather than from those storages' own `GET`-detail response
        // -- unlike the rq arm, which passes a real `GET`-detail response
        // through unchanged. This is a deliberate optimization (see
        // storage_tab.js's own comments: a second, full-materialization
        // metadata fetch would reintroduce the very unbounded read this
        // pagination feature exists to remove), but it means nothing otherwise
        // ties the hand-coded field NAMES to the actual non-meta fields the
        // dataset/kv-store GET handlers (src/routes/storages.js) return. If a
        // future field (e.g. the design's own listed `storageBytes` follow-up)
        // is added to either handler, the rq arm picks it up automatically (it
        // forwards the real response) while ds/kv would silently keep omitting
        // it from the stats line's own "nothing non-empty omitted" contract
        // (see requirements/console.md's stats-line section), with no test
        // failing. Pin today's exact non-meta field sets here so adding a
        // field to either handler breaks THIS test as a loud reminder to
        // update the hand-coded lists in storage_tab.js to match.
        const { client } = ctx;
        const js = (await client.get('/console/storage_tab.js')).text();

        const metaKeysBody = sliceBetween(js, 'const STORAGE_META_KEYS = new Set([', ']);');
        const metaKeys = new Set([...metaKeysBody.matchAll(/"(\w+)"/g)].map((m) => m[1]));

        const kv = (await client.post('/v2/key-value-stores', { json: { name: 'statsfields' } })).json().data;
        const kvDetail = (await client.get(`/v2/key-value-stores/${kv.id}`)).json().data;
        expect(Object.keys(kvDetail).filter((k) => !metaKeys.has(k)).sort()).toEqual(['itemCount']);
        expect(js).toContain('statsLineEl({ itemCount: total })');

        const ds = (await client.post('/v2/datasets', { json: { name: 'statsfields' } })).json().data;
        const dsDetail = (await client.get(`/v2/datasets/${ds.id}`)).json().data;
        expect(Object.keys(dsDetail).filter((k) => !metaKeys.has(k)).sort()).toEqual(['cleanItemCount', 'itemCount']);
        expect(js).toContain('statsLineEl({ itemCount: total, cleanItemCount: total })');
    });

    it('storage list drops position wording while filtered', async () => {
        // `renderStorages` switches to `filteredPagingLineEl` (see that
        // function's own comment for why) based on the "show unnamed"
        // checkbox's own state alone -- unchecked uses it, checked uses the
        // normal `pagingLineEl` -- regardless of whether the current page
        // actually has any row hidden.
        const js = (await ctx.client.get('/console/storage_tab.js')).text();

        const filteredBody = sliceBetween(js, 'function filteredPagingLineEl(visibleCount, pageCount, total)', '\n}');
        expect(filteredBody).toContain('showing ${visibleCount} of ${pageCount} on this page');
        expect(filteredBody).toContain('${total} total');

        const renderBody = sliceBetween(js, 'function renderStorages()', '\n}\n');
        expect(renderBody).toMatch(
            /showUnnamedStorages\s*\n\s*\? pagingLineEl\(storageListOffset, visible\.length, cache\.total\)\s*\n\s*: filteredPagingLineEl\(visible\.length, items\.length, cache\.total\)/,
        );
    });

    it('paging controls pin the disable boundaries', async () => {
        // Prev must disable exactly on the first page, Next exactly on the
        // last (see requirements/console.md's paging section) -- structural,
        // since no JS runtime exists in this suite to execute
        // `pagingControlsEl` directly.
        const js = (await ctx.client.get('/console/storage_tab.js')).text();

        const body = sliceBetween(js, 'function pagingControlsEl(offset, count, total, onPage)', '\n}');

        // Prev disabled exactly on the first page -- not "< 0" (never true,
        // since offset never goes negative) and not "== 0" (would stay enabled
        // after a raced page that clamps offset back to 0 via Math.max(0, ...)
        // below).
        expect(body).toContain('prev.disabled = offset <= 0;');
        // Next disabled exactly when the current slice reaches the total --
        // not "> total" (an off-by-one leaving Next clickable one page past
        // the end).
        expect(body).toContain('next.disabled = offset + count >= total;');

        // Both booleans are set on the actual buttons this function returns
        // (not dead/unused locals): `prev`/`next` are appended to the returned
        // row.
        expect(body).toContain('row.append(prev, next);');
    });

    it('renderStoreContent guards against error envelopes', async () => {
        // `renderStoreContent`'s kv/rq item fetches (and rq's own metadata
        // fetch) must bail out on an error response (storage deleted / access
        // revoked mid-view) before computing a paging line from a shape that
        // was never a paginated payload -- no automated browser test exists
        // for this repo's plain JS console, so this is a structural check that
        // each guard is actually wired in, not just present somewhere in the
        // function.
        const js = (await ctx.client.get('/console/storage_tab.js')).text();

        expect(js).toContain('function isErrorEnvelope(resp)');
        expect(js).toContain('function errorLineEl(err)');

        const body = sliceBetween(js, 'async function renderStoreContent(kind, id, offset)', '\n// tableEl already renders');

        // Each `isErrorEnvelope` guard must be tied to an early `return`
        // INSIDE its own `if` block, not merely present somewhere in the
        // function -- a bare substring count on `isErrorEnvelope(...)` cannot
        // catch a regression that keeps the check but drops the `return;`,
        // e.g.:
        //   if (isErrorEnvelope(meta)) { box.appendChild(errorLineEl(meta.error)); }
        // which falls through into `statsLineEl(meta)`/the paging fetch
        // against an `{error: ...}`-shaped object -- exactly the bug this
        // test's docstring says it exists to catch -- while a bare
        // `isErrorEnvelope(...)` count stays unchanged.
        const guardedReturn = /if \(isErrorEnvelope\((\w+)\)\) \{\s*box\.appendChild\(errorLineEl\(\1\.error\)\);\s*return;\s*\}/g;
        const matches = [...body.matchAll(guardedReturn)].map((m) => m[1]);
        expect(matches.filter((name) => name === 'keysResp').length).toBe(1); // kv branch
        expect(matches.filter((name) => name === 'meta').length).toBe(1); // rq branch's own metadata fetch
        expect(matches.filter((name) => name === 'reqsResp').length).toBe(1); // rq branch's requests fetch

        // The ds branch's own items fetch is a bare array, not an envelope, so
        // it guards via `res.ok` instead of `isErrorEnvelope` -- and, unlike
        // the other branches, must check `ok` BEFORE parsing the body at all:
        // a non-JSON error body (e.g. a plain-text 500) would otherwise throw
        // trying to parse it as the success shape.
        expect(body).toMatch(/if \(!res\.ok\) \{[\s\S]*?box\.appendChild\(errorLineEl\(err && err\.error\)\);\s*return;\s*\}/);
        expect(indexOfOrFail(body, 'if (!res.ok)')).toBeLessThan(indexOfOrFail(body, 'const items = await res.json();'));
    });

    it('kv record fetches are encoded and parallelized', async () => {
        // Regression: the KV detail view's per-key record fetch must
        // percent-encode the key (`encodeURIComponent`) before it reaches the
        // URL -- an unencoded key containing `/`, `#` or `?` would either
        // address a different record (an extra path segment) or get mis-split
        // by the browser's own URL parsing (`#` starts a fragment, `?` a query
        // string) -- and must issue all of a page's record fetches
        // concurrently (`Promise.all`), not one key at a time, since
        // `Promise.all` still resolves its results in the same order as the
        // input array regardless of which individual fetch finishes first.
        const js = (await ctx.client.get('/console/storage_tab.js')).text();

        const renderBody = sliceBetween(js, 'async function renderStoreContent(kind, id, offset)', '\n}\n');

        expect(renderBody).toContain('records/${encodeURIComponent(k.key)}');
        expect(renderBody).toMatch(/await Promise\.all\(\s*keys\.map\(/);
    });

    it('loadStorages guards against an error envelope', async () => {
        // `loadStorages` fetches `/v2/users/me/{slug}` with the acting user's
        // own (possibly stale/revoked) token, so it can fail just like any
        // other per-storage fetch (e.g. a `401` error envelope) -- it must
        // guard the same way `renderStoreContent` does (one idiom on both
        // paths, not a guard on one and a silent `resp.items || []` degrade on
        // the other).
        const js = (await ctx.client.get('/console/storage_tab.js')).text();

        const body = sliceBetween(js, 'async function loadStorages(slug, offset)', '\n}\n');
        expect(body).toMatch(
            /if \(isErrorEnvelope\(resp\)\) \{[\s\S]*?detail\.appendChild\(errorLineEl\(resp\.error\)\);[\s\S]*?return;\s*\}/,
        );
    });

    it('the four listing surfaces always send limit and offset', async () => {
        // Every console fetch against the four paginated listing surfaces
        // (per-user storage lists, KV keys, dataset items, RQ requests) must
        // carry an explicit `limit`/`offset` -- never a bare/unbounded
        // request, or a local storage with more than one page silently reloads
        // the old "fetch everything" behaviour in the browser (see
        // requirements/console.md's storage-paging section).
        //
        // Structural, like this file's other storage_tab.js checks -- but
        // instead of pinning one known-good call site by its exact
        // interpolated variable name, this matches on each surface's static
        // PATH SHAPE with any `${...}` interpolation in the id/slug position,
        // so it fails equally on an existing call site losing its
        // `limit`/`offset` AND on a brand-new call site added later for one of
        // these paths (however it names its own id variable) that forgets
        // them.
        const js = (await ctx.client.get('/console/storage_tab.js')).text();

        const surfaces = {
            'per-user storage list': String.raw`/v2/users/me/\$\{[^}]*\}`,
            'kv keys': String.raw`/v2/key-value-stores/\$\{[^}]*\}/keys`,
            'dataset items': String.raw`/v2/datasets/\$\{[^}]*\}/items`,
            'rq requests': String.raw`/v2/request-queues/\$\{[^}]*\}/requests`,
        };
        for (const [label, pathPattern] of Object.entries(surfaces)) {
            const callSites = [...js.matchAll(new RegExp('`' + pathPattern + '[^`]*`', 'g'))].map((m) => m[0]);
            expect(callSites.length, `no fetch call site found for the ${label} surface`).toBeGreaterThan(0);
            for (const site of callSites) {
                expect(site, `${label} call site ${JSON.stringify(site)} is missing an explicit limit`).toContain('limit=');
                expect(site, `${label} call site ${JSON.stringify(site)} is missing an explicit offset`).toContain('offset=');
            }
        }
    });

    it('fallback toggle is present and wired to runtime-config', async () => {
        // The "API fallback" toggle must be present next to the existing
        // "Switch user" control, read its state via a token-free GET on load,
        // PUT its new state to the same endpoint on change, and reflect
        // whatever the endpoint reports back onto the checkbox -- re-reading
        // the server's actual resulting state after the PUT rather than
        // assuming it succeeded, since a flip made from another tab/port (or a
        // rejected PUT) must never leave this checkbox silently wrong (see
        // requirements/console.md's "header's API fallback toggle" section).
        // The backend half (GET/PUT /v2/runtime-config) already has thorough
        // coverage in the upstream-fallback suite; this covers the
        // console-facing wiring's existence and shape, which had none.
        const html = (await ctx.client.get('/')).text();

        // The checkbox sits in the header, immediately after (i.e. "next to")
        // the existing "Switch user" <select> -- not just present somewhere on
        // the page.
        const headerStart = indexOfOrFail(html, '<header');
        const headerEnd = indexOfOrFail(html, '</header>');
        const userSelectIdx = indexOfOrFail(html, 'id="user-select"');
        const fallbackIdx = indexOfOrFail(html, 'id="fallback-toggle"');
        expect(headerStart).toBeLessThan(userSelectIdx);
        expect(userSelectIdx).toBeLessThan(fallbackIdx);
        expect(fallbackIdx).toBeLessThan(headerEnd);
        expect(fallbackIdx - userSelectIdx).toBeLessThan(200);
        expect(html.slice(fallbackIdx - 40, fallbackIdx + 40)).toContain('type="checkbox"');

        const js = (await ctx.client.get('/console/app.js')).text();

        // Reads state on load via a token-free GET, reflecting the returned
        // boolean onto the checkbox -- not claiming/bootstrapping a token just
        // to load the console (like the public user list).
        const refreshBody = sliceBetween(js, 'async function refreshFallbackToggle()', '\n}\n');
        expect(refreshBody).toContain('$("#fallback-toggle")');
        expect(refreshBody).toContain('api("/v2/runtime-config", { skipAuth: true })');
        expect(refreshBody).toContain('toggle.checked');
        expect(refreshBody).toContain('upstreamFallbackEnabled');

        // PUTs the new state to the same endpoint on change -- WITHOUT
        // skipAuth: unlike GET, PUT requires a valid token (see
        // requirements/api.md's "Upstream fallback" section), so it sends the
        // acting user's bearer token like any other mutating request.
        const setBody = sliceBetween(js, 'async function setFallbackEnabled(enabled)', '\n}\n');
        expect(setBody).toContain('method: "PUT"');
        expect(setBody).toContain('"/v2/runtime-config"');
        expect(setBody).toContain('upstreamFallbackEnabled: enabled');
        expect(setBody).not.toContain('skipAuth');
        // Re-reads the server's actual resulting state after the PUT rather
        // than assuming it took effect as requested.
        expect(setBody).toContain('refreshFallbackToggle();');

        // Wired via addEventListener (no inline handler) to the checkbox's own
        // current .checked state, with a `.catch` guarding against a rejected
        // PUT (mirroring periodicRefresh's own guard on
        // refreshFallbackToggle()) so a runtime-unreachable flip never
        // surfaces as an unhandled rejection.
        expect(js).toContain(
            'addEventListener("change", () => setFallbackEnabled(_fallbackToggle.checked).catch(() => {}))',
        );
        // Read once on every initial page load -- the literal page-load init
        // sequence, not just ANY occurrence of `refreshFallbackToggle();`:
        // `periodicRefresh`/`setFallbackEnabled` also call it, so a bare
        // substring count would still pass even if the page-load call itself
        // were ever dropped.
        expect(js).toContain(
            'refreshUserSelect();\nrefreshFallbackToggle();\nrenderRoute();\nsetInterval(periodicRefresh, 4000);',
        );
    });

    it('fallback toggle guards against a stale periodic repaint', async () => {
        // A periodic 4s-tick GET issued before the user flips the toggle can
        // resolve AFTER that flip's own PUT+re-GET (response ordering over the
        // network is not guaranteed to match request issue order) and repaint
        // the checkbox back to the pre-flip value -- the dangerous direction,
        // since it shows OFF while the runtime is actually ON, no matter how
        // far into the flip that earlier GET was still in flight.
        // `setFallbackEnabled` must bump a monotonically-increasing generation
        // counter exactly once, after its own PUT resolves and before its own
        // trailing refresh, and `refreshFallbackToggle` must capture the
        // counter BEFORE issuing its own GET and skip the repaint if the
        // counter has since moved.
        const js = (await ctx.client.get('/console/app.js')).text();

        const setBody = sliceBetween(js, 'async function setFallbackEnabled(enabled)', '\n}\n');
        // Bumped exactly once, after the PUT resolves and before the trailing
        // refresh -- never before the PUT is issued.
        const putIdx = indexOfOrFail(setBody, 'await api(');
        const incrementIdx = indexOfOrFail(setBody, 'fallbackToggleGeneration++;');
        const refreshIdx = indexOfOrFail(setBody, 'await refreshFallbackToggle();');
        expect(putIdx).toBeLessThan(incrementIdx);
        expect(incrementIdx).toBeLessThan(refreshIdx);

        const refreshBody = sliceBetween(js, 'async function refreshFallbackToggle()', '\n}\n');
        // The snapshot must be taken BEFORE the GET and compared against the
        // live counter AFTER it, bailing out before any repaint if it moved.
        const captureIdx = indexOfOrFail(refreshBody, 'const generation = fallbackToggleGeneration;');
        const fetchIdx = indexOfOrFail(refreshBody, 'await api(');
        const guardIdx = indexOfOrFail(refreshBody, 'if (generation !== fallbackToggleGeneration) return;');
        expect(captureIdx).toBeLessThan(fetchIdx);
        expect(fetchIdx).toBeLessThan(guardIdx);
        expect(guardIdx).toBeLessThan(indexOfOrFail(refreshBody, 'toggle.checked ='));
    });

    it('fallback toggle ignores a failed or invalid response', async () => {
        // Regression: `api()` returns whatever a non-JSON response's body
        // parses to (raw text) rather than throwing, and an error envelope's
        // `unwrap()` passes through unchanged (only `.data` is stripped) -- so
        // a transient 500/plain-text/error `GET /v2/runtime-config` response
        // used to leave `cfg.upstreamFallbackEnabled` `undefined`, which
        // `!!(...)` turned into a false "fallback is OFF" repaint. This runs
        // on every `periodicRefresh` tick (~4s), so a developer relying on an
        // ON toggle could be shown OFF on a passing failure and issue a write
        // believing it stays local-only. `toggle.checked` may only be assigned
        // once the response is confirmed to actually carry a boolean
        // `upstreamFallbackEnabled` -- anything else must leave the checkbox
        // exactly as it was.
        const js = (await ctx.client.get('/console/app.js')).text();

        const refreshBody = sliceBetween(js, 'async function refreshFallbackToggle()', '\n}\n');
        expect(refreshBody).toMatch(
            /if \(cfg && typeof cfg === "object" && typeof cfg\.upstreamFallbackEnabled === "boolean"\) \{\s*toggle\.checked = cfg\.upstreamFallbackEnabled;\s*\}/,
        );
        // The assignment must be gated by that check, not also happen
        // unconditionally.
        expect(count(refreshBody, 'toggle.checked =')).toBe(1);
    });
});

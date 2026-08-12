/**
 * Offline coverage for `sample_actor_crawler/main.js`'s proxy-configuration
 * branching. These tests pin the SDK's actual omitted-`proxyConfiguration`
 * semantics -- omitted is equivalent to an explicit `useApifyProxy: true`,
 * and never falls back to a direct (proxy-less) crawl -- so the sample's
 * docs and code cannot silently drift from real `apify` SDK behaviour.
 *
 * Running `main.js` as a subprocess the way `tests/unit/sample-actor.test.js`
 * runs `sample_actor/main.js` would start a real `CheerioCrawler` crawl
 * against the internet, so these tests call the real `apify` SDK's
 * `Actor.createProxyConfiguration` directly instead, avoiding both the
 * subprocess and any network traffic entirely.
 *
 * `main.js`'s proxy handling is a single, uncustomized passthrough (see
 * the "still passes proxyConfiguration straight through" test below, which
 * pins this claim against the file's actual source):
 *
 *     const proxyConfiguration = await Actor.createProxyConfiguration(
 *         actorInput.proxyConfiguration,
 *     );
 *
 * -- no fallback, no try/catch (a deliberate design decision, not an
 * oversight). So calling the real `apify` SDK's
 * `Actor.createProxyConfiguration` with exactly the values
 * `actorInput.proxyConfiguration` would produce for each input shape tests
 * the sample's real, documented behaviour fully offline, without a crawl:
 *
 * - an explicit `{"useApifyProxy": false}` (no `proxyUrls`) returns
 *   `undefined` immediately -- no `ProxyConfiguration` is even constructed,
 *   so this is trivially offline.
 * - `undefined` (an *omitted* `proxyConfiguration`) falls through to the
 *   SDK's own default `ProxyConfiguration`, whose `initialize()` requires
 *   an Apify Proxy password.
 *
 * Adaptation from the Python original: the Python SDK raises `ValueError`
 * on a missing proxy password unconditionally, so the original asserted
 * that error with local (not-at-home) configuration. The JS SDK throws the
 * equivalent error ("Apify Proxy password must be provided ...") only when
 * `Actor.isAtHome()` is true -- run locally without a password it merely
 * logs a warning and performs a **live** proxy access check against
 * proxy.apify.com (verified by reading
 * `node_modules/apify/dist/proxy_configuration.js` directly). To keep these
 * tests fully offline while still proving "omitted assumes Apify Proxy, not
 * a direct crawl", the omitted/schema-default tests set `APIFY_IS_AT_HOME=1`
 * (simulating the deployed container, which is where the sample actually
 * runs): the missing-password error is thrown synchronously *before* the
 * access check, so no network call is attempted. The `useApifyProxy: false`
 * short-circuit happens before any of that, so that test needs no such
 * simulation. Every test strips ambient `APIFY_`/`CRAWLEE_` env vars first
 * (mirroring `sample-actor.test.js`'s `run` helper) so no stray
 * `APIFY_TOKEN`/`APIFY_PROXY_PASSWORD` from the environment this test
 * itself runs in leaks into the call.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Actor } from 'apify';
import { afterEach, beforeEach, expect, it } from 'vitest';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CRAWLER_DIR = path.join(REPO, 'sample_actor_crawler');
const MAIN_JS = path.join(CRAWLER_DIR, 'main.js');

const NO_PASSWORD_ERROR = /Apify Proxy password must be provided/;

let savedEnv;

beforeEach(() => {
    // Strip every ambient APIFY_/CRAWLEE_ env var (see module docstring).
    // The JS SDK's Configuration reads process.env live at get() time, so
    // mutating process.env here is enough -- no Actor re-init needed.
    savedEnv = {};
    for (const key of Object.keys(process.env)) {
        if (key.startsWith('APIFY_') || key.startsWith('CRAWLEE_')) {
            savedEnv[key] = process.env[key];
            delete process.env[key];
        }
    }
});

afterEach(() => {
    delete process.env.APIFY_IS_AT_HOME;
    Object.assign(process.env, savedEnv);
});

/**
 * Call the real `apify` SDK's `Actor.createProxyConfiguration` the exact way
 * `sample_actor_crawler/main.js` does. `atHome` simulates the deployed
 * container so a missing password throws offline instead of triggering the
 * SDK's local warn-and-live-check path (see module docstring).
 */
async function createProxyConfiguration(actorProxyInput, { atHome = false } = {}) {
    if (atHome) process.env.APIFY_IS_AT_HOME = '1';
    return Actor.createProxyConfiguration(actorProxyInput);
}

it('explicit useApifyProxy false returns undefined and crawls direct', async () => {
    // The sole documented way to run without credentials (see README.md's
    // "Apify Proxy" section and `input_schema.json`'s `proxyConfiguration`
    // description): an explicit `{"useApifyProxy": false}` (with no
    // `proxyUrls`) makes the SDK return `undefined`, so `CheerioCrawler`
    // gets no proxy and crawls direct.
    const result = await createProxyConfiguration({ useApifyProxy: false });
    expect(result).toBeUndefined();
});

it('omitted proxyConfiguration is not a direct crawl', async () => {
    // Regression guard against the false belief that an omitted
    // `proxyConfiguration` crawls direct: omitting it entirely
    // (`actorInput.proxyConfiguration` evaluates to `undefined`) does NOT
    // behave like `useApifyProxy: false` -- it falls through to the SDK's
    // own default `ProxyConfiguration`, which assumes Apify Proxy, exactly
    // like an explicit `useApifyProxy: true`. With no `APIFY_PROXY_PASSWORD`
    // and no `APIFY_TOKEN` (so the SDK cannot fetch one either), that
    // default configuration's `initialize()` throws -- fully offline; no
    // network call is attempted (the throw happens before the SDK's proxy
    // access check).
    await expect(createProxyConfiguration(undefined, { atHome: true })).rejects.toThrow(NO_PASSWORD_ERROR);
});

it('schema default proxyConfiguration behaves like omitted', async () => {
    // The schema's own default (read from the real, on-disk
    // `input_schema.json`: `useApifyProxy: true`,
    // `apifyProxyGroups: ["RESIDENTIAL"]`) is an *explicit*
    // `useApifyProxy: true`, not an omission -- it must fail the exact same
    // way as the omitted case above when no password is available, directly
    // proving the documented "omitted behaves like an explicit
    // useApifyProxy: true" claim rather than merely asserting it in prose.
    const inputSchema = JSON.parse(
        await readFile(path.join(CRAWLER_DIR, '.actor', 'input_schema.json'), 'utf8'),
    );
    const schemaDefaultProxyConfiguration = inputSchema.properties.proxyConfiguration.default;
    expect(schemaDefaultProxyConfiguration).toEqual({
        useApifyProxy: true,
        apifyProxyGroups: ['RESIDENTIAL'],
    });
    await expect(
        createProxyConfiguration(schemaDefaultProxyConfiguration, { atHome: true }),
    ).rejects.toThrow(NO_PASSWORD_ERROR);
});

/**
 * Strip comments from JS source without touching string/template literals
 * (so e.g. a `'https://...'` URL never loses its `//...` tail). A tiny
 * single-pass scanner is enough for `main.js`'s plain module code; the
 * Python original used `ast.parse` for the same job, but this repo ships no
 * JS parser dependency, so comment-stripped source checks are the
 * adaptation (still resilient to comment edits, though unlike the AST
 * version a formatter reflow of the call itself is handled only via the
 * whitespace-tolerant matching below).
 */
function stripComments(source) {
    let out = '';
    let i = 0;
    let quote = null; // ', ", or ` when inside a string/template literal
    while (i < source.length) {
        const ch = source[i];
        const next = source[i + 1];
        if (quote) {
            out += ch;
            if (ch === '\\') {
                out += next ?? '';
                i += 2;
                continue;
            }
            if (ch === quote) quote = null;
            i += 1;
            continue;
        }
        if (ch === "'" || ch === '"' || ch === '`') {
            quote = ch;
            out += ch;
            i += 1;
            continue;
        }
        if (ch === '/' && next === '/') {
            while (i < source.length && source[i] !== '\n') i += 1;
            continue;
        }
        if (ch === '/' && next === '*') {
            i += 2;
            while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
            i += 2;
            continue;
        }
        out += ch;
        i += 1;
    }
    return out;
}

it('main.js still passes proxyConfiguration straight through', async () => {
    // Pins the three tests above to `main.js`'s actual source. If this call
    // site ever grows a fallback -- e.g.
    // `actorInput.proxyConfiguration ?? { useApifyProxy: false }` -- or gets
    // wrapped in a `try`/`catch`, this test fails, flagging that the offline
    // tests above no longer represent `main.js`'s real, no-fallback
    // behaviour. (The Python original walked `main.py`'s AST; see
    // `stripComments` above for why this port checks comment-stripped
    // source text instead.)
    const source = stripComments(await readFile(MAIN_JS, 'utf8'));

    expect(source, 'createProxyConfiguration must not be wrapped in a try/catch (no-fallback design decision)')
        .not.toMatch(/\btry\b/);

    const calls = [...source.matchAll(/\bcreateProxyConfiguration\s*\(([^)]*)\)/g)];
    expect(calls, 'expected exactly one call to Actor.createProxyConfiguration in main.js').toHaveLength(1);

    // Whole-call shape: a straight `Actor.createProxyConfiguration(...)`
    // (the Python test's "attribute call" check).
    expect(source).toMatch(/\bActor\.createProxyConfiguration\s*\(/);

    // The single argument must be a plain `actorInput.proxyConfiguration`
    // passthrough -- no fallback default (`??`/`||`), no extra options like
    // `checkAccess`. Whitespace-normalized so a formatter reflow of the call
    // across lines cannot break the check.
    const argument = calls[0][1].replace(/\s+/g, '').replace(/,$/, '');
    expect(
        argument,
        'expected a straight actorInput.proxyConfiguration passthrough with no fallback default',
    ).toBe('actorInput.proxyConfiguration');
});

/**
 * Ports are hardcoded: `loadSettings()` always resolves 3333/3000, ignoring
 * `PORT_API`/`PORT_CONSOLE` in the environment (the override mechanism is
 * removed, not just re-defaulted).
 */
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadSettings } from '../../src/config.js';

// Every env var loadSettings() reads (plus the two removed port overrides).
// Each test starts from a clean slate -- the pytest original's
// monkeypatch.delenv/setenv, adapted to saving and restoring process.env.
const ENV_KEYS = [
    'PORT_API',
    'PORT_CONSOLE',
    'APIFY_PROXY_PASSWORD',
    'APIFY_UPSTREAM_BASE_URL',
    'DATA_DIR',
    'HOST_DATA_DIR',
    'STANDBY_IDLE_OVERRIDE_SECS',
];

let savedEnv;

beforeEach(() => {
    savedEnv = {};
    for (const key of ENV_KEYS) {
        savedEnv[key] = process.env[key];
        delete process.env[key];
    }
});

afterEach(() => {
    for (const key of ENV_KEYS) {
        if (savedEnv[key] === undefined) delete process.env[key];
        else process.env[key] = savedEnv[key];
    }
});

describe('loadSettings', () => {
    it('defaults to fixed ports', () => {
        const settings = loadSettings();
        expect(settings.portApi).toBe(3333);
        expect(settings.portConsole).toBe(3000);
    });

    it('ignores PORT_API/PORT_CONSOLE env overrides', () => {
        process.env.PORT_API = '9999';
        process.env.PORT_CONSOLE = '9998';
        const settings = loadSettings();
        expect(settings.portApi).toBe(3333);
        expect(settings.portConsole).toBe(3000);
    });

    it('defaults apifyProxyPassword to empty', () => {
        const settings = loadSettings();
        expect(settings.apifyProxyPassword).toBe('');
    });

    it('reads APIFY_PROXY_PASSWORD from the environment', () => {
        process.env.APIFY_PROXY_PASSWORD = 'dummy-proxy-password';
        const settings = loadSettings();
        expect(settings.apifyProxyPassword).toBe('dummy-proxy-password');
    });

    it('defaults the upstream base URL to the real platform', () => {
        const settings = loadSettings();
        expect(settings.apifyUpstreamBaseUrl).toBe('https://api.apify.com');
    });

    it('upstream base URL is overridable', () => {
        // Purely so tests (unit and any future e2e) can point the
        // upstream-fallback layer at a local stub instead of the real
        // platform.
        process.env.APIFY_UPSTREAM_BASE_URL = 'http://127.0.0.1:9';
        const settings = loadSettings();
        expect(settings.apifyUpstreamBaseUrl).toBe('http://127.0.0.1:9');
    });

    it('strips a trailing slash from the upstream base URL', () => {
        // Regression: an operator-supplied `APIFY_UPSTREAM_BASE_URL` ending
        // in `/` (e.g. `https://api.apify.com/`) produces a double slash once
        // `fetchUpstreamFallback` (src/upstream.js) concatenates it with
        // `rawTarget(ctx)` (see requirements/api.md's Upstream fallback
        // section). Normalized away in the `Settings` constructor -- the
        // boundary every construction path goes through -- so `loadSettings`,
        // the env-var path, never carries a trailing slash through.
        process.env.APIFY_UPSTREAM_BASE_URL = 'https://api.apify.com/';
        const settings = loadSettings();
        expect(settings.apifyUpstreamBaseUrl).toBe('https://api.apify.com');
    });

    // ------------------------------------------------------------------
    // JS-port additions beyond test_config.py: pin the remaining
    // Settings-derived values loadSettings() resolves (data-dir paths,
    // containerApiBaseUrl, standby-override parsing), which had no dedicated
    // Python unit test.

    it('resolves DATA_DIR and derives every data-dir path from it', () => {
        process.env.DATA_DIR = '/some/data';
        const settings = loadSettings();
        expect(settings.dataDir).toBe(path.resolve('/some/data'));
        // hostDataDir defaults to dataDir when HOST_DATA_DIR is unset (the
        // "runtime runs directly on the host" case).
        expect(settings.hostDataDir).toBe(settings.dataDir);
        expect(settings.storageDir).toBe(path.join(settings.dataDir, 'storage'));
        expect(settings.metaPath).toBe(path.join(settings.dataDir, 'meta.json'));
        expect(settings.runsDir).toBe(path.join(settings.dataDir, 'runs'));
        expect(settings.buildsDir).toBe(path.join(settings.dataDir, 'builds'));
        expect(settings.hostRunsDir).toBe(path.join(settings.dataDir, 'runs'));
    });

    it('HOST_DATA_DIR redirects only the host-side paths', () => {
        process.env.DATA_DIR = '/some/data';
        process.env.HOST_DATA_DIR = '/host/side/data';
        const settings = loadSettings();
        expect(settings.runsDir).toBe(path.join(path.resolve('/some/data'), 'runs'));
        expect(settings.hostRunsDir).toBe(path.join('/host/side/data', 'runs'));
    });

    it('containerApiBaseUrl addresses the runtime by network alias and API port', () => {
        const settings = loadSettings();
        expect(settings.containerApiBaseUrl).toBe('http://actor-runtime:3333');
    });

    it('standby idle override defaults to null and parses as a number when set', () => {
        expect(loadSettings().standbyIdleOverrideSecs).toBeNull();
        process.env.STANDBY_IDLE_OVERRIDE_SECS = '0.2';
        expect(loadSettings().standbyIdleOverrideSecs).toBe(0.2);
    });
});

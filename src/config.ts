/** Fixed, non-configurable ports (`system.md`): identical on every start, no env var overrides them. */
export const API_PORT = 3333;
export const CONSOLE_PORT = 3000;

/** The DNS alias every Actor container resolves the runtime's own API by, on the `apify-local` network. */
export const CONTAINER_API_ALIAS = 'apify-api';
export const CONTAINER_API_BASE_URL = `http://${CONTAINER_API_ALIAS}:${API_PORT}`;

/** Base for the events-websocket URL every Actor container is given (`ACTOR_EVENTS_WEBSOCKET_URL` /
 * `APIFY_ACTOR_EVENTS_WS_URL`, `services/runs.ts: buildEnv`) - the same host:port as
 * `CONTAINER_API_BASE_URL`, just `ws://` instead of `http://`: the events endpoint upgrades on the
 * existing API server (`api/events-ws.ts`), not a second port (`system.md`'s fixed-ports contract). */
export const CONTAINER_EVENTS_WS_BASE_URL = `ws://${CONTAINER_API_ALIAS}:${API_PORT}`;

/** Host-facing base URL for the local console UI (fixed port, `system.md`) - used only to build the
 * `consoleUrl` field storage DTOs return (the real platform's equivalent points at
 * `console.apify.com`; this points at the one console this runtime actually serves). The path appended
 * after this base uses the real platform's URL shape (e.g. `/storage/datasets/:id`), which the console
 * server redirects to its own page - see `console.md`. */
export const CONSOLE_BASE_URL = `http://localhost:${CONSOLE_PORT}`;

export const DEFAULT_DATA_DIR = process.env.ACTOR_RUNTIME_DATA_DIR ?? '/data';

/**
 * Where the Python debug-mode payload (`Dockerfile`'s `debugpy-payload` build stage: a pinned, pure-
 * Python debugpy wheel plus the generated `sitecustomize.py`, pre-built into a tar - `actor-driver.md`'s
 * "Debug mode" section) lives inside the runtime's own image. Read fresh on every call, not cached into
 * a top-level constant, so a unit test can point `ACTOR_RUNTIME_DEBUGPY_PAYLOAD_DIR` at a fixture
 * directory (or a nonexistent one, to exercise the "payload missing" failure path) without needing to
 * re-import this module. Outside the built image (`pnpm dev`, unit tests, an uncustomized env) this
 * directory simply does not exist - `docker-driver.ts` treats that as "cannot start a Python debug run",
 * never a silent non-debug start.
 */
function debugpyPayloadDir(): string {
	return process.env.ACTOR_RUNTIME_DEBUGPY_PAYLOAD_DIR ?? '/opt/apify-debug-payload';
}

/** The prebuilt tar `docker-driver.ts` streams into a Python debug run's container via
 * `container.putArchive(tar, { path: '/' })`, between `createContainer` and `start()`. */
export function debugpyPayloadTarPath(): string {
	return `${debugpyPayloadDir()}/debugpy-payload.tar`;
}

/** The exact debugpy version baked into the payload above, written at image-build time by reading it
 * back off the extracted wheel itself (`Dockerfile`) - so the version named in a debug run's attach log
 * line (`actor-driver.md`) is never a second, independently-hardcoded copy of the same number. */
export function debugpyVersionFilePath(): string {
	return `${debugpyPayloadDir()}/debugpy-version.txt`;
}

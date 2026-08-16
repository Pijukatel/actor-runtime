/** Fixed, non-configurable ports (`system.md`): identical on every start, no env var overrides them. */
export const API_PORT = 3333;
export const CONSOLE_PORT = 3000;

/** The DNS alias every Actor container resolves the runtime's own API by, on the `apify-local` network. */
export const CONTAINER_API_ALIAS = 'apify-api';
export const CONTAINER_API_BASE_URL = `http://${CONTAINER_API_ALIAS}:${API_PORT}`;

/** Host-facing base URL for the local console UI (fixed port, `system.md`) - used only to build the
 * `consoleUrl` field storage DTOs return (the real platform's equivalent points at
 * `console.apify.com`; this points at the one console this runtime actually serves). */
export const CONSOLE_BASE_URL = `http://localhost:${CONSOLE_PORT}`;

export const DEFAULT_DATA_DIR = process.env.ACTOR_RUNTIME_DATA_DIR ?? '/data';

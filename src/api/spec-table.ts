/**
 * A vendored, committed snapshot of the paths/methods this runtime knows about from
 * `https://docs.apify.com/api/openapi.json`, so 501-vs-404 decisions never depend on a network
 * fetch at runtime (the live spec is not fetched at implementation time or at runtime/build time -
 * this table's "not implemented" section is a best-effort snapshot of the well-documented, stable
 * Apify v2 API surface, not a byte-for-byte copy of the live spec; it is deliberately wide enough to
 * exercise the 501/404 split required by `api.md` and success criterion 9).
 *
 * `implemented: true` entries all have a real Express route registered for them (including the small
 * number that are *wired but intentionally answer 501* - request deletion - which is a documented,
 * deliberate simplification rather than "missing route"). `implemented: false` entries are real,
 * well-known Apify API paths this runtime does not serve; hitting them falls through every real
 * route and lands on the catch-all, which looks them up here and answers `501`. Anything that
 * matches no entry at all - right down to typos and made-up paths - is off-spec and answers `404`.
 */

export interface SpecTableEntry {
	method: string;
	/** Path segments relative to the server root, e.g. `v2/actors/:actorId/builds/default`. */
	path: string;
	implemented: boolean;
}

function segmentsOf(path: string): string[] {
	return path.split('/').filter(Boolean);
}

function pathTemplate(method: string, path: string, implemented: boolean): SpecTableEntry {
	return { method: method.toUpperCase(), path, implemented };
}

/** Every user-storage default-run-storage alias family shares the same request-queue/dataset/kv shape. */
function runStorageAliasEntries(prefix: string): SpecTableEntry[] {
	return [
		pathTemplate('GET', `${prefix}/dataset`, true),
		pathTemplate('GET', `${prefix}/dataset/items`, true),
		pathTemplate('POST', `${prefix}/dataset/items`, true),
		pathTemplate('GET', `${prefix}/dataset/statistics`, true),
		pathTemplate('GET', `${prefix}/key-value-store`, true),
		pathTemplate('GET', `${prefix}/key-value-store/keys`, true),
		// Real platform path (forwarded through `ACTOR_RUNS.KEY_VALUE_STORE`'s wildcard route to the same
		// zip-download-all-records handler as `v2/key-value-stores/:storeId/records`), not implemented.
		pathTemplate('GET', `${prefix}/key-value-store/records`, false),
		pathTemplate('GET', `${prefix}/key-value-store/records/:recordKey`, true),
		pathTemplate('HEAD', `${prefix}/key-value-store/records/:recordKey`, true),
		pathTemplate('PUT', `${prefix}/key-value-store/records/:recordKey`, true),
		pathTemplate('DELETE', `${prefix}/key-value-store/records/:recordKey`, true),
		pathTemplate('GET', `${prefix}/request-queue`, true),
		pathTemplate('POST', `${prefix}/request-queue/requests/batch`, true),
		pathTemplate('DELETE', `${prefix}/request-queue/requests/batch`, true),
		pathTemplate('POST', `${prefix}/request-queue/requests`, true),
		pathTemplate('GET', `${prefix}/request-queue/requests`, true),
		pathTemplate('GET', `${prefix}/request-queue/requests/:requestId`, true),
		pathTemplate('PUT', `${prefix}/request-queue/requests/:requestId`, true),
		pathTemplate('DELETE', `${prefix}/request-queue/requests/:requestId`, true),
		pathTemplate('PUT', `${prefix}/request-queue/requests/:requestId/lock`, true),
		pathTemplate('DELETE', `${prefix}/request-queue/requests/:requestId/lock`, true),
		pathTemplate('GET', `${prefix}/request-queue/head`, true),
		pathTemplate('POST', `${prefix}/request-queue/head/lock`, true),
		pathTemplate('POST', `${prefix}/request-queue/requests/unlock`, true),
	];
}

export const SPEC_TABLE: SpecTableEntry[] = [
	// --- Actors ---
	pathTemplate('GET', 'v2/actors', true),
	pathTemplate('POST', 'v2/actors', true),
	pathTemplate('GET', 'v2/actors/:actorId', true),
	pathTemplate('PUT', 'v2/actors/:actorId', true),
	pathTemplate('DELETE', 'v2/actors/:actorId', true),
	pathTemplate('GET', 'v2/actors/:actorId/builds', true),
	pathTemplate('POST', 'v2/actors/:actorId/builds', true),
	pathTemplate('GET', 'v2/actors/:actorId/builds/default', true),
	pathTemplate('GET', 'v2/actors/:actorId/runs', true),
	pathTemplate('POST', 'v2/actors/:actorId/runs', true),
	pathTemplate('GET', 'v2/actors/:actorId/versions', true),
	pathTemplate('POST', 'v2/actors/:actorId/versions', true),
	pathTemplate('GET', 'v2/actors/:actorId/versions/:versionNumber', true),
	pathTemplate('PUT', 'v2/actors/:actorId/versions/:versionNumber', true),
	pathTemplate('DELETE', 'v2/actors/:actorId/versions/:versionNumber', true),

	// --- Builds ---
	pathTemplate('GET', 'v2/actor-builds', true),
	pathTemplate('GET', 'v2/actor-builds/:buildId', true),
	pathTemplate('DELETE', 'v2/actor-builds/:buildId', true),
	pathTemplate('POST', 'v2/actor-builds/:buildId/abort', true),
	pathTemplate('GET', 'v2/actor-builds/:buildId/log', true),

	// --- Runs ---
	pathTemplate('GET', 'v2/actor-runs', true),
	pathTemplate('GET', 'v2/actor-runs/:runId', true),
	pathTemplate('DELETE', 'v2/actor-runs/:runId', true),
	pathTemplate('POST', 'v2/actor-runs/:runId/abort', true),
	pathTemplate('GET', 'v2/actor-runs/:runId/log', true),

	// --- Datasets ---
	pathTemplate('GET', 'v2/datasets', true),
	pathTemplate('POST', 'v2/datasets', true),
	pathTemplate('GET', 'v2/datasets/:datasetId', true),
	pathTemplate('PUT', 'v2/datasets/:datasetId', true),
	pathTemplate('DELETE', 'v2/datasets/:datasetId', true),
	pathTemplate('GET', 'v2/datasets/:datasetId/items', true),
	pathTemplate('POST', 'v2/datasets/:datasetId/items', true),
	pathTemplate('GET', 'v2/datasets/:datasetId/statistics', true),

	// --- Key-value stores ---
	pathTemplate('GET', 'v2/key-value-stores', true),
	pathTemplate('POST', 'v2/key-value-stores', true),
	pathTemplate('GET', 'v2/key-value-stores/:storeId', true),
	pathTemplate('PUT', 'v2/key-value-stores/:storeId', true),
	pathTemplate('DELETE', 'v2/key-value-stores/:storeId', true),
	pathTemplate('GET', 'v2/key-value-stores/:storeId/keys', true),
	// Real platform path, not implemented here: `GET .../records` (no `:recordKey`) downloads every
	// record as a zip archive (apify-core's `records.ts` GET handler, mounted at
	// `API_V2_SERVER_ROUTES.KEY_VALUE_STORES.RECORDS`) - unrelated to `GET .../records/:recordKey`
	// (single-record read) just below, which this runtime does implement.
	pathTemplate('GET', 'v2/key-value-stores/:storeId/records', false),
	pathTemplate('GET', 'v2/key-value-stores/:storeId/records/:recordKey', true),
	pathTemplate('HEAD', 'v2/key-value-stores/:storeId/records/:recordKey', true),
	pathTemplate('PUT', 'v2/key-value-stores/:storeId/records/:recordKey', true),
	pathTemplate('DELETE', 'v2/key-value-stores/:storeId/records/:recordKey', true),

	// --- Request queues ---
	pathTemplate('GET', 'v2/request-queues', true),
	pathTemplate('POST', 'v2/request-queues', true),
	pathTemplate('GET', 'v2/request-queues/:queueId', true),
	pathTemplate('PUT', 'v2/request-queues/:queueId', true),
	pathTemplate('DELETE', 'v2/request-queues/:queueId', true),
	pathTemplate('POST', 'v2/request-queues/:queueId/requests/batch', true),
	pathTemplate('DELETE', 'v2/request-queues/:queueId/requests/batch', true),
	pathTemplate('POST', 'v2/request-queues/:queueId/requests', true),
	pathTemplate('GET', 'v2/request-queues/:queueId/requests', true),
	pathTemplate('GET', 'v2/request-queues/:queueId/requests/:requestId', true),
	pathTemplate('PUT', 'v2/request-queues/:queueId/requests/:requestId', true),
	pathTemplate('DELETE', 'v2/request-queues/:queueId/requests/:requestId', true),
	pathTemplate('PUT', 'v2/request-queues/:queueId/requests/:requestId/lock', true),
	pathTemplate('DELETE', 'v2/request-queues/:queueId/requests/:requestId/lock', true),
	pathTemplate('GET', 'v2/request-queues/:queueId/head', true),
	pathTemplate('POST', 'v2/request-queues/:queueId/head/lock', true),
	pathTemplate('POST', 'v2/request-queues/:queueId/requests/unlock', true),

	// --- Logs ---
	pathTemplate('GET', 'v2/logs/:buildOrRunId', true),

	// --- Users (requirements amendment) ---
	pathTemplate('GET', 'v2/users/me', true),
	pathTemplate('GET', 'v2/users/:userId', true),

	// --- Default run storages (requirements amendment for the request sub-resources) ---
	...runStorageAliasEntries('v2/actor-runs/:runId'),

	// --- Known, real Apify API v2 paths this runtime does not implement (-> 501) ---
	pathTemplate('GET', 'v2/actor-tasks', false),
	pathTemplate('POST', 'v2/actor-tasks', false),
	pathTemplate('GET', 'v2/actor-tasks/:taskId', false),
	pathTemplate('PUT', 'v2/actor-tasks/:taskId', false),
	pathTemplate('DELETE', 'v2/actor-tasks/:taskId', false),
	pathTemplate('GET', 'v2/actor-tasks/:taskId/runs', false),
	pathTemplate('POST', 'v2/actor-tasks/:taskId/runs', false),
	pathTemplate('GET', 'v2/schedules', false),
	pathTemplate('POST', 'v2/schedules', false),
	pathTemplate('GET', 'v2/schedules/:scheduleId', false),
	pathTemplate('PUT', 'v2/schedules/:scheduleId', false),
	pathTemplate('DELETE', 'v2/schedules/:scheduleId', false),
	pathTemplate('GET', 'v2/webhooks', false),
	pathTemplate('POST', 'v2/webhooks', false),
	pathTemplate('GET', 'v2/webhooks/:webhookId', false),
	pathTemplate('PUT', 'v2/webhooks/:webhookId', false),
	pathTemplate('DELETE', 'v2/webhooks/:webhookId', false),
	pathTemplate('GET', 'v2/webhooks/:webhookId/dispatches', false),
	pathTemplate('GET', 'v2/webhook-dispatches', false),
	pathTemplate('GET', 'v2/webhook-dispatches/:dispatchId', false),
	pathTemplate('GET', 'v2/store', false),
	pathTemplate('GET', 'v2/store/:storeId', false),
	pathTemplate('GET', 'v2/users/:userId/limits', false),
	pathTemplate('GET', 'v2/users/:userId/usage/monthly', false),
	pathTemplate('POST', 'v2/actor-runs/:runId/resurrect', false),
	pathTemplate('POST', 'v2/actor-runs/:runId/metamorph', false),
	pathTemplate('POST', 'v2/actor-tasks/:taskId/webhooks', false),
];

/** Structural match: same segment count, every literal segment equal, `:param` segments wildcard. */
export function matchSpecPath(method: string, requestPath: string): SpecTableEntry | undefined {
	const upperMethod = method.toUpperCase();
	const requestSegments = segmentsOf(requestPath);
	return SPEC_TABLE.find((entry) => {
		if (entry.method !== upperMethod) return false;
		const entrySegments = segmentsOf(entry.path);
		if (entrySegments.length !== requestSegments.length) return false;
		return entrySegments.every((segment, i) => segment.startsWith(':') || segment === requestSegments[i]);
	});
}

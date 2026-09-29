/**
 * The `/actor-runtime/*` namespace's own OpenAPI document (`openapi/actor-runtime.json`) and the
 * lookups the server drives from it.
 *
 * The document - not this module, and not `requirements/api.md` - is the single source of truth for
 * which runtime-specific endpoints exist: `routes/actor-runtime-spec.ts` serves it verbatim so a client
 * can enumerate the namespace, and the namespace's terminal handler decides `404` vs `405` vs `426`
 * from these lookups. Adding an endpoint therefore means adding it to the document; a test
 * (`test/integration/actor-runtime-spec.test.ts`) fails if a documented HTTP operation has no route
 * behind it, so the two cannot drift apart silently.
 *
 * This is the namespace-local counterpart of `spec-table.ts`, which does the same 501-vs-404 job for
 * the emulated Apify `/v2` surface from a vendored snapshot of the platform's own spec.
 */
import rawDocument from './openapi/actor-runtime.json' with { type: 'json' };

/** Only the parts of OpenAPI this runtime actually reads - not a general-purpose OpenAPI model. */
interface OperationObject {
	operationId?: string;
	summary?: string;
	/** `"websocket"` marks an operation served by the HTTP upgrade handler rather than an Express route. */
	'x-actor-runtime-transport'?: string;
}

interface OpenApiDocument {
	openapi: string;
	info: { title: string; version: string; description?: string };
	paths: Record<string, Record<string, unknown>>;
}

/** Lower-case, as OpenAPI spells them; anything else under a path item (`parameters`, `summary`, ...)
 * is not an operation. */
const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;

export const ACTOR_RUNTIME_OPENAPI = rawDocument as unknown as OpenApiDocument;

export interface ActorRuntimeOperation {
	/** Upper-case, matching `req.method`. */
	method: string;
	/** The OpenAPI path template, e.g. `/actor-runtime/debug/{actorId}`. */
	path: string;
	operationId: string;
	summary: string;
	/** `websocket` operations are upgraded by `events-ws.ts`, so no Express route ever matches them. */
	transport: 'http' | 'websocket';
}

function readOperations(document: OpenApiDocument): ActorRuntimeOperation[] {
	const operations: ActorRuntimeOperation[] = [];
	for (const [path, pathItem] of Object.entries(document.paths)) {
		for (const method of HTTP_METHODS) {
			const operation = pathItem[method] as OperationObject | undefined;
			if (!operation) continue;
			operations.push({
				method: method.toUpperCase(),
				path,
				operationId: operation.operationId ?? `${method}${path}`,
				summary: operation.summary ?? '',
				transport: operation['x-actor-runtime-transport'] === 'websocket' ? 'websocket' : 'http',
			});
		}
	}
	return operations;
}

export const ACTOR_RUNTIME_OPERATIONS: readonly ActorRuntimeOperation[] = readOperations(ACTOR_RUNTIME_OPENAPI);

/** `/actor-runtime/events/` and `/actor-runtime/events` are the same path here; the empty trailing
 * segment is not a segment. A bare `/actor-runtime` normalizes to no segments beyond the namespace. */
function segmentsOf(path: string): string[] {
	return path.split('/').filter(Boolean);
}

/** Structural match, same rule as `spec-table.ts`: equal segment count, literal segments equal,
 * `{param}` segments wildcard. */
function pathMatches(template: string, requestPath: string): boolean {
	const templateSegments = segmentsOf(template);
	const requestSegments = segmentsOf(requestPath);
	if (templateSegments.length !== requestSegments.length) return false;
	return templateSegments.every(
		(segment, i) => (segment.startsWith('{') && segment.endsWith('}')) || segment === requestSegments[i],
	);
}

/**
 * Every operation the document describes on the path template `requestPath` matches - empty when the
 * document describes no such path at all. The namespace's terminal handler branches on this: empty is
 * a `404` (off-spec path), non-empty with no matching method is a `405` (the `Allow` header is built
 * from exactly these).
 *
 * `requestPath` is the full namespace path (`/actor-runtime/...`), with or without a trailing slash,
 * and without a query string.
 */
export function actorRuntimeOperationsAtPath(requestPath: string): ActorRuntimeOperation[] {
	return ACTOR_RUNTIME_OPERATIONS.filter((operation) => pathMatches(operation.path, requestPath));
}

/**
 * The router-relative Express path for a documented operation - `/actor-runtime/events/{runId}` ->
 * `/events/:runId` - so a route can be registered from the document instead of from a second,
 * hand-maintained copy of the same path.
 */
export function routerPathOf(operation: ActorRuntimeOperation): string {
	const relative = segmentsOf(operation.path)
		.slice(1)
		.map((segment) => (segment.startsWith('{') && segment.endsWith('}') ? `:${segment.slice(1, -1)}` : segment))
		.join('/');
	return `/${relative}`;
}

/** The one operation the document describes for this method and path, if any. */
export function matchActorRuntimeOperation(method: string, requestPath: string): ActorRuntimeOperation | undefined {
	const upperMethod = method.toUpperCase();
	return actorRuntimeOperationsAtPath(requestPath).find((operation) => operation.method === upperMethod);
}

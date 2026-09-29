/**
 * The `/actor-runtime/*` namespace's OpenAPI document is the source of truth for what the namespace
 * contains (`src/api/actor-runtime-spec.ts`), so these guard the document itself and the lookups the
 * server drives from it. That the documented operations are actually *served* is asserted against a
 * running server in `test/integration/actor-runtime-spec.test.ts`.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
	ACTOR_RUNTIME_OPENAPI,
	ACTOR_RUNTIME_OPERATIONS,
	actorRuntimeOperationsAtPath,
	matchActorRuntimeOperation,
	routerPathOf,
} from '../../src/api/actor-runtime-spec.js';

describe('the Actor runtime OpenAPI document', () => {
	it('is an OpenAPI 3.1 document describing only the /actor-runtime namespace', () => {
		expect(ACTOR_RUNTIME_OPENAPI.openapi).toMatch(/^3\.1\./);
		expect(Object.keys(ACTOR_RUNTIME_OPENAPI.paths).length).toBeGreaterThan(0);
		for (const path of Object.keys(ACTOR_RUNTIME_OPENAPI.paths)) {
			expect(path === '/actor-runtime' || path.startsWith('/actor-runtime/')).toBe(true);
		}
	});

	it("carries the runtime's own version, so a client can tell two runtimes apart", () => {
		const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
			version: string;
		};
		expect(ACTOR_RUNTIME_OPENAPI.info.version).toBe(version);
	});

	it('gives every operation a unique operationId and a summary', () => {
		const operationIds = ACTOR_RUNTIME_OPERATIONS.map((operation) => operation.operationId);
		expect(new Set(operationIds).size).toBe(operationIds.length);
		for (const operation of ACTOR_RUNTIME_OPERATIONS) {
			expect(operation.operationId).not.toBe('');
			expect(operation.summary).not.toBe('');
		}
	});

	it('describes every endpoint the namespace has', () => {
		const described = ACTOR_RUNTIME_OPERATIONS.map((operation) => `${operation.method} ${operation.path}`).sort();
		expect(described).toEqual(
			[
				'GET /actor-runtime',
				'GET /actor-runtime/openapi.json',
				'GET /actor-runtime/skill',
				'GET /actor-runtime/api-fallback',
				'POST /actor-runtime/api-fallback',
				'POST /actor-runtime/browser-view/{actorId}',
				'POST /actor-runtime/debug/{actorId}',
				'POST /actor-runtime/dev-folder/{actorId}',
				'POST /actor-runtime/migrate/{runId}',
				'GET /actor-runtime/events/{runId}',
				'GET /actor-runtime/standby/{standbyLabel}',
			].sort(),
		);
	});

	it('declares at least one response per operation, and resolves every $ref it uses', () => {
		const document = ACTOR_RUNTIME_OPENAPI as unknown as Record<string, unknown>;

		for (const [path, pathItem] of Object.entries(ACTOR_RUNTIME_OPENAPI.paths)) {
			for (const [method, operation] of Object.entries(pathItem)) {
				const responses = (operation as { responses?: Record<string, unknown> }).responses ?? {};
				expect(Object.keys(responses).length, `${method} ${path} declares no response`).toBeGreaterThan(0);
			}
		}

		// A typo'd `$ref` is the one way this document can be structurally broken while still parsing as
		// JSON, and nothing else in the suite would notice.
		const refsIn = (value: unknown): string[] => {
			if (Array.isArray(value)) return value.flatMap(refsIn);
			if (typeof value !== 'object' || value === null) return [];
			return Object.entries(value).flatMap(([key, child]) =>
				key === '$ref' && typeof child === 'string' ? [child] : refsIn(child),
			);
		};
		const resolve = (ref: string): unknown =>
			ref
				.replace(/^#\//, '')
				.split('/')
				.reduce<unknown>((node, segment) => (node as Record<string, unknown> | undefined)?.[segment], document);

		const refs = refsIn(document);
		expect(refs.length).toBeGreaterThan(0);
		for (const ref of refs) {
			expect(ref.startsWith('#/'), `${ref} is not a local reference`).toBe(true);
			expect(resolve(ref), `${ref} does not resolve`).toBeDefined();
		}
	});

	it('lists the platform endpoints this runtime extends, so nothing local is left undescribed', () => {
		const notes = (ACTOR_RUNTIME_OPENAPI as unknown as Record<string, unknown>)[
			'x-actor-runtime-platform-notes'
		] as Array<Record<string, string>>;

		expect(notes.map((note) => `${note.method} ${note.path}`)).toEqual([
			'POST /v2/actors/{actorId}/runs',
			'POST /v2/actor-runs/{runId}/abort',
			'POST /v2/actor-runs/{runId}/reboot',
			'GET /v2/actors/{actorId}',
		]);
		for (const note of notes) {
			expect(note.summary).toBeTruthy();
			expect(note.description).toBeTruthy();
		}
	});

	it('marks the events endpoint as the one websocket transport', () => {
		const websocketPaths = ACTOR_RUNTIME_OPERATIONS.filter((operation) => operation.transport === 'websocket').map(
			(operation) => operation.path,
		);
		expect(websocketPaths).toEqual(['/actor-runtime/events/{runId}']);
	});
});

describe('matchActorRuntimeOperation', () => {
	it('matches a documented operation through its {param} segments', () => {
		expect(matchActorRuntimeOperation('POST', '/actor-runtime/debug/abc123')?.operationId).toBe(
			'setActorDebugMode',
		);
		expect(matchActorRuntimeOperation('post', '/actor-runtime/debug/abc123')?.operationId).toBe(
			'setActorDebugMode',
		);
	});

	it('matches the namespace root with or without a trailing slash', () => {
		expect(matchActorRuntimeOperation('GET', '/actor-runtime')?.operationId).toBe('getActorRuntimeSpecification');
		expect(matchActorRuntimeOperation('GET', '/actor-runtime/')?.operationId).toBe('getActorRuntimeSpecification');
	});

	it('is sensitive to the method', () => {
		expect(matchActorRuntimeOperation('GET', '/actor-runtime/debug/abc123')).toBeUndefined();
	});

	it('is sensitive to the segment count, so no path is matched by a prefix of it', () => {
		expect(matchActorRuntimeOperation('POST', '/actor-runtime/debug')).toBeUndefined();
		expect(matchActorRuntimeOperation('POST', '/actor-runtime/debug/abc123/extra')).toBeUndefined();
	});

	it('does not match an undocumented path at all', () => {
		expect(matchActorRuntimeOperation('GET', '/actor-runtime/does-not-exist')).toBeUndefined();
		expect(actorRuntimeOperationsAtPath('/actor-runtime/does-not-exist')).toEqual([]);
	});

	it('reports every method documented on a path, which is what the Allow header is built from', () => {
		expect(
			actorRuntimeOperationsAtPath('/actor-runtime/api-fallback')
				.map((entry) => entry.method)
				.sort(),
		).toEqual(['GET', 'POST']);
	});
});

describe('routerPathOf', () => {
	it('turns a documented path template into the Express path the router registers', () => {
		const events = matchActorRuntimeOperation('GET', '/actor-runtime/events/some-run')!;
		expect(routerPathOf(events)).toBe('/events/:runId');

		const root = matchActorRuntimeOperation('GET', '/actor-runtime')!;
		expect(routerPathOf(root)).toBe('/');
	});
});

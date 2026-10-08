import { describe, expect, it } from 'vitest';
import { matchSpecPath } from '../../src/api/spec-table.js';

describe('matchSpecPath', () => {
	it('matches an implemented path with param segments', () => {
		const entry = matchSpecPath('GET', 'v2/actors/abc123/builds');
		expect(entry?.implemented).toBe(true);
	});

	it('matches a real-but-unimplemented spec path as not implemented', () => {
		const entry = matchSpecPath('GET', 'v2/schedules');
		expect(entry).toBeDefined();
		expect(entry?.implemented).toBe(false);
	});

	it('does not match a completely off-spec path', () => {
		expect(matchSpecPath('GET', 'v2/totally-made-up-endpoint')).toBeUndefined();
		expect(matchSpecPath('GET', 'not-even-v2/actors')).toBeUndefined();
	});

	it('is sensitive to segment count (no accidental prefix matches)', () => {
		expect(matchSpecPath('GET', 'v2/actors/abc/builds/extra/segment')).toBeUndefined();
	});

	it('is sensitive to method', () => {
		expect(matchSpecPath('PATCH', 'v2/actors')).toBeUndefined();
	});

	it("knows the last-run shortcut family, mirroring each target path's own implemented flag", () => {
		expect(matchSpecPath('GET', 'v2/actors/abc/runs/last')?.implemented).toBe(true);
		expect(matchSpecPath('GET', 'v2/actors/abc/runs/last/log')?.implemented).toBe(true);
		expect(matchSpecPath('POST', 'v2/actors/abc/runs/last/abort')?.implemented).toBe(true);
		expect(matchSpecPath('GET', 'v2/actors/abc/runs/last/dataset/items')?.implemented).toBe(true);
		expect(matchSpecPath('PUT', 'v2/actors/abc/runs/last/key-value-store/records/OUTPUT')?.implemented).toBe(true);
		// Same 501s as their own targets.
		expect(matchSpecPath('GET', 'v2/actors/abc/runs/last/key-value-store/records')?.implemented).toBe(false);
		expect(matchSpecPath('POST', 'v2/actors/abc/runs/last/metamorph')?.implemented).toBe(false);
	});

	it('serves the Actor run-sync endpoints but not their task variants', () => {
		for (const method of ['GET', 'POST']) {
			expect(matchSpecPath(method, 'v2/actors/abc/run-sync')?.implemented).toBe(true);
			expect(matchSpecPath(method, 'v2/actors/abc/run-sync-get-dataset-items')?.implemented).toBe(true);
			expect(matchSpecPath(method, 'v2/actor-tasks/abc/run-sync')?.implemented).toBe(false);
			expect(matchSpecPath(method, 'v2/actor-tasks/abc/run-sync-get-dataset-items')?.implemented).toBe(false);
		}
	});
});

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
});

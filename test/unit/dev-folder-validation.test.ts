/**
 * Pure-function coverage for `validateDevFolderPathShape` (`design.md`: "A cheap shape pre-filter still
 * runs first" - absolute POSIX path, no newline/NUL, length cap, `~` never expanded). This is the only
 * layer of validation exercisable with no registries/driver at all; `setDevFolder`'s build-first and
 * host-side-probe layers are covered by `test/integration/dev-folder.test.ts`.
 */
import { describe, expect, it } from 'vitest';

import { validateDevFolderPathShape } from '../../src/services/actors.js';

describe('validateDevFolderPathShape', () => {
	it('accepts a plain absolute POSIX path', () => {
		expect(validateDevFolderPathShape('/home/dev/my-actor')).toBeNull();
	});

	it('accepts a root-level absolute path', () => {
		expect(validateDevFolderPathShape('/src')).toBeNull();
	});

	it('rejects a relative path', () => {
		expect(validateDevFolderPathShape('relative/path')).toMatch(/absolute/i);
	});

	it('does not expand a leading "~" - rejected as non-absolute, not resolved to some assumed home directory', () => {
		expect(validateDevFolderPathShape('~/my-actor')).toMatch(/absolute/i);
	});

	it('rejects a path containing a newline', () => {
		expect(validateDevFolderPathShape('/home/dev/my\nactor')).toMatch(/newline|NUL/i);
	});

	it('rejects a path containing a carriage return', () => {
		expect(validateDevFolderPathShape('/home/dev/my\ractor')).toMatch(/newline|NUL/i);
	});

	it('rejects a path containing a NUL byte', () => {
		expect(validateDevFolderPathShape('/home/dev/my\0actor')).toMatch(/newline|NUL/i);
	});

	it('rejects an unreasonably long path', () => {
		const long = '/' + 'a'.repeat(5000);
		expect(validateDevFolderPathShape(long)).toMatch(/too long/i);
	});

	it('accepts a path right at the length cap boundary', () => {
		const atCap = '/' + 'a'.repeat(4095);
		expect(atCap.length).toBe(4096);
		expect(validateDevFolderPathShape(atCap)).toBeNull();
	});
});

import { describe, expect, it } from 'vitest';

import { normalizeEntryName } from '../../src/driver/tar-entry-name.js';

describe('normalizeEntryName', () => {
	it('strips a leading "./"', () => {
		expect(normalizeEntryName('./Dockerfile')).toBe('Dockerfile');
	});

	it('converts backslashes to POSIX separators', () => {
		expect(normalizeEntryName('.actor\\Dockerfile')).toBe('.actor/Dockerfile');
	});

	it('collapses "a/./b" and "a/b/../c" via path.posix.normalize', () => {
		expect(normalizeEntryName('.actor/./Dockerfile')).toBe('.actor/Dockerfile');
		expect(normalizeEntryName('.actor/sub/../Dockerfile')).toBe('.actor/Dockerfile');
	});

	it('leaves an escaping "../" prefix alone (the escape check depends on this)', () => {
		expect(normalizeEntryName('../evil/Dockerfile')).toBe('../evil/Dockerfile');
	});
});

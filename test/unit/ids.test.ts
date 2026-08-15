import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { getRequestId } from '@crawlee/core';

import { generateId } from '../../src/storage/ids.js';

describe('generateId', () => {
	it('generates 17-character alphanumeric ids', () => {
		const id = generateId();
		expect(id).toHaveLength(17);
		expect(id).toMatch(/^[A-Za-z0-9]{17}$/);
	});

	it('generates unique ids', () => {
		const ids = new Set(Array.from({ length: 1000 }, () => generateId()));
		expect(ids.size).toBe(1000);
	});
});

describe('getRequestId parity with Crawlee', () => {
	function referenceImplementation(uniqueKey: string): string {
		return createHash('sha256').update(uniqueKey).digest('base64').replace(/[+/=]/g, '').slice(0, 15);
	}

	it('matches the documented sha256(uniqueKey).base64, strip [+/=], slice(0,15) algorithm', () => {
		const samples = ['http://example.com', 'http://example.com/foo?bar=baz', 'a', '', 'unicode-éè'];
		for (const uniqueKey of samples) {
			expect(getRequestId(uniqueKey)).toBe(referenceImplementation(uniqueKey));
		}
	});

	it('is deterministic', () => {
		expect(getRequestId('http://example.com')).toBe(getRequestId('http://example.com'));
	});

	it('produces 15-character ids without +, / or =', () => {
		const id = getRequestId('http://example.com/some/path?with=query&params=1');
		expect(id).toHaveLength(15);
		expect(id).not.toMatch(/[+/=]/);
	});
});

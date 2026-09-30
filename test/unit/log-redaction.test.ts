import { describe, expect, it } from 'vitest';

import { createLogRedactor, REDACTION_MASK } from '../../src/services/log-redaction.js';

function redactAll(secrets: string[], chunks: string[]): string {
	const redactor = createLogRedactor(secrets);
	return chunks.map((chunk) => redactor.redact(chunk)).join('') + redactor.flush();
}

describe('createLogRedactor', () => {
	it('masks every exact occurrence with the fixed mask, whatever the length', () => {
		expect(redactAll(['my-secret-key'], ['key=my-secret-key and again my-secret-key\n'])).toBe(
			`key=${REDACTION_MASK} and again ${REDACTION_MASK}\n`,
		);
		expect(REDACTION_MASK).toBe('*********');
	});

	it('masks a secret split across chunks', () => {
		expect(redactAll(['my-secret-key'], ['API_KEY my-se', 'cret-', 'key\n'])).toBe(`API_KEY ${REDACTION_MASK}\n`);
	});

	it('holds back only what could still become a secret', () => {
		const redactor = createLogRedactor(['my-secret-key']);
		expect(redactor.redact('line one\nAPI_KEY my-')).toBe('line one\nAPI_KEY ');
		expect(redactor.redact('value\n')).toBe('my-value\n');
		expect(redactor.flush()).toBe('');
	});

	it('releases a held-back tail on flush when the stream ends mid-prefix', () => {
		expect(redactAll(['my-secret-key'], ['ends with my-sec'])).toBe('ends with my-sec');
	});

	it('does not catch a secret printed in another form, as on the platform', () => {
		expect(redactAll(['my-secret-key'], ['reversed: yek-terces-ym\n'])).toBe('reversed: yek-terces-ym\n');
	});

	it('masks a secret containing a shorter one whole, and ignores empty values', () => {
		expect(redactAll(['abc', 'abcdef', ''], ['x abcdef y abc z\n'])).toBe(
			`x ${REDACTION_MASK} y ${REDACTION_MASK} z\n`,
		);
	});

	it('passes everything through untouched with no secrets', () => {
		expect(redactAll([], ['a', 'b\n'])).toBe('ab\n');
	});
});

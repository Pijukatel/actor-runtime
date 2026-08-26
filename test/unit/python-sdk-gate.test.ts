/**
 * Pure-function coverage for `decidePythonSdkGate`/`isCi`
 * (`test/integration/helpers/python-sdk-gate.ts`) - the CI-vs-local decision that gates
 * `test/integration/python-sdk-charging.test.ts`, so a missing Python `apify` package fails the CI job
 * instead of silently skipping the test that would have caught a regression. The "fails, rather than
 * skips, in CI" arm below is the one this file exists to pin down: an unavailable SDK must produce
 * `'skip'` outside CI but `'fail'` inside it, never `'skip'` unconditionally.
 */
import { describe, expect, it } from 'vitest';

import { decidePythonSdkGate, isCi } from '../integration/helpers/python-sdk-gate.js';

describe('decidePythonSdkGate', () => {
	it('runs when the SDK is available, regardless of CI', () => {
		expect(decidePythonSdkGate({ available: true, ci: false })).toBe('run');
		expect(decidePythonSdkGate({ available: true, ci: true })).toBe('run');
	});

	it('skips cleanly when the SDK is unavailable outside CI - the reasonable local case', () => {
		expect(decidePythonSdkGate({ available: false, ci: false })).toBe('skip');
	});

	it('fails, rather than skips, when the SDK is unavailable in CI - the provisioning step regressed', () => {
		expect(decidePythonSdkGate({ available: false, ci: true })).toBe('fail');
	});
});

describe('isCi', () => {
	it('is false when CI is unset', () => {
		expect(isCi({})).toBe(false);
	});

	it('is false when CI is explicitly empty', () => {
		expect(isCi({ CI: '' })).toBe(false);
	});

	it('is true when CI is set, matching GitHub Actions setting CI=true on every run', () => {
		expect(isCi({ CI: 'true' })).toBe(true);
	});
});

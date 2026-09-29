import { describe, expect, it } from 'vitest';

import { portFromEnv } from '../../src/config.js';

describe('portFromEnv', () => {
	it('falls back to the default when the variable is unset or blank', () => {
		expect(portFromEnv('ACTOR_RUNTIME_API_PORT', 3333, {})).toBe(3333);
		expect(portFromEnv('ACTOR_RUNTIME_API_PORT', 3333, { ACTOR_RUNTIME_API_PORT: '  ' })).toBe(3333);
	});

	it('reads a valid port', () => {
		expect(portFromEnv('ACTOR_RUNTIME_API_PORT', 3333, { ACTOR_RUNTIME_API_PORT: ' 4333 ' })).toBe(4333);
	});

	it.each(['0', '65536', 'abc', '80.5', '-1', '3e3'])('rejects %s', (value) => {
		expect(() => portFromEnv('ACTOR_RUNTIME_API_PORT', 3333, { ACTOR_RUNTIME_API_PORT: value })).toThrow(
			/ACTOR_RUNTIME_API_PORT must be a TCP port/,
		);
	});
});

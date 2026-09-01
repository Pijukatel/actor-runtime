/**
 * Pure-function coverage for `services/debug-mode.ts`'s body validation and run-start language
 * resolution (`actor-driver.md`'s "Debug mode" section) - mirrors `dev-folder-validation.test.ts`'s own
 * split: everything here needs no registry, no Docker, and no driver stub at all.
 * `setDebugMode`/`debugStatus` (the registry-touching half) are covered by
 * `test/integration/debug-mode.test.ts`.
 */
import { describe, expect, it } from 'vitest';

import {
	DEFAULT_PORT_BY_LANGUAGE,
	DEBUGPY_PORT_ENV_VAR,
	PYTHON_DEBUG_PAYLOAD_DIR,
	describeDebugRefusal,
	resolveDebugPlan,
	validateDebugModeBody,
} from '../../src/services/debug-mode.js';
import type { InspectedDebugTarget } from '../../src/driver/types.js';

function target(overrides: Partial<InspectedDebugTarget> = {}): InspectedDebugTarget {
	return { env: {}, ...overrides };
}

describe('validateDebugModeBody', () => {
	it('accepts {"enabled": true} and defaults language to "auto" with no port override', () => {
		const result = validateDebugModeBody({ enabled: true });
		expect(result).toEqual({ kind: 'ok', enabled: true, language: 'auto', port: undefined });
	});

	it('accepts a full body overriding both language and port', () => {
		const result = validateDebugModeBody({ enabled: true, language: 'node', port: 9229 });
		expect(result).toEqual({ kind: 'ok', enabled: true, language: 'node', port: 9229 });
	});

	it('accepts {"enabled": false}', () => {
		const result = validateDebugModeBody({ enabled: false });
		expect(result).toEqual({ kind: 'ok', enabled: false, language: 'auto', port: undefined });
	});

	it('rejects a non-object body (array)', () => {
		expect(validateDebugModeBody([])).toMatchObject({ kind: 'invalid' });
	});

	it('rejects a non-object body (null)', () => {
		expect(validateDebugModeBody(null)).toMatchObject({ kind: 'invalid' });
	});

	it('rejects a non-object body (a bare string)', () => {
		expect(validateDebugModeBody('true')).toMatchObject({ kind: 'invalid' });
	});

	it('rejects an unknown field, naming it and the allowed fields verbatim', () => {
		const result = validateDebugModeBody({ enabled: true, prot: 9229 });
		expect(result).toEqual({
			kind: 'invalid',
			message: 'Unknown field "prot" - allowed fields are "enabled", "language", "port".',
		});
	});

	it('rejects a missing "enabled" field', () => {
		expect(validateDebugModeBody({ language: 'node' })).toMatchObject({ kind: 'invalid' });
	});

	it('rejects a non-boolean "enabled"', () => {
		expect(validateDebugModeBody({ enabled: 'true' })).toMatchObject({ kind: 'invalid' });
	});

	it('rejects an invalid "language" value', () => {
		expect(validateDebugModeBody({ enabled: true, language: 'ruby' })).toMatchObject({ kind: 'invalid' });
	});

	it('rejects a non-integer "port"', () => {
		expect(validateDebugModeBody({ enabled: true, port: 1024.5 })).toMatchObject({ kind: 'invalid' });
	});

	it('rejects a "port" below 1024', () => {
		expect(validateDebugModeBody({ enabled: true, port: 80 })).toMatchObject({ kind: 'invalid' });
	});

	it('rejects a "port" above 65535', () => {
		expect(validateDebugModeBody({ enabled: true, port: 70000 })).toMatchObject({ kind: 'invalid' });
	});

	it('accepts port at the exact boundaries (1024 and 65535)', () => {
		expect(validateDebugModeBody({ enabled: true, port: 1024 }).kind).toBe('ok');
		expect(validateDebugModeBody({ enabled: true, port: 65535 }).kind).toBe('ok');
	});
});

describe('resolveDebugPlan - language detection order', () => {
	it('an exec-form python3 command resolves to python with the default port', () => {
		const result = resolveDebugPlan({ language: 'auto' }, target({ cmd: ['python3', '-m', 'src'] }));
		expect(result).toEqual({
			kind: 'plan',
			plan: {
				language: 'python',
				port: DEFAULT_PORT_BY_LANGUAGE.python,
				env: {
					PYTHONPATH: PYTHON_DEBUG_PAYLOAD_DIR,
					[DEBUGPY_PORT_ENV_VAR]: String(DEFAULT_PORT_BY_LANGUAGE.python),
				},
			},
		});
	});

	it('a shell-form command (daemon-stored as /bin/sh -c "...") still finds the python3 token inside the joined string', () => {
		const result = resolveDebugPlan({ language: 'auto' }, target({ cmd: ['/bin/sh', '-c', 'python3 -m src'] }));
		expect(result).toMatchObject({ kind: 'plan', plan: { language: 'python' } });
	});

	it('a plain "node dist/main.js" command resolves to node with the default port', () => {
		const result = resolveDebugPlan({ language: 'auto' }, target({ cmd: ['node', 'dist/main.js'] }));
		expect(result).toEqual({
			kind: 'plan',
			plan: {
				language: 'node',
				port: DEFAULT_PORT_BY_LANGUAGE.node,
				env: { NODE_OPTIONS: `--inspect-brk=0.0.0.0:${DEFAULT_PORT_BY_LANGUAGE.node}` },
			},
		});
	});

	it('"tsx" and "ts-node" are also recognized as node-family launchers', () => {
		expect(resolveDebugPlan({ language: 'auto' }, target({ cmd: ['tsx', 'src/main.ts'] }))).toMatchObject({
			kind: 'plan',
			plan: { language: 'node' },
		});
		expect(resolveDebugPlan({ language: 'auto' }, target({ cmd: ['ts-node', 'src/main.ts'] }))).toMatchObject({
			kind: 'plan',
			plan: { language: 'node' },
		});
	});

	it('an "npm start" command is refused as package-manager, even though the base image env fingerprint would otherwise say "node"', () => {
		const result = resolveDebugPlan(
			{ language: 'auto' },
			target({ cmd: ['npm', 'start'], env: { NODE_VERSION: '24.1.0' } }),
		);
		expect(result).toEqual({ kind: 'refused', reason: 'package-manager', command: 'npm start' });
	});

	it('"yarn start" and "pnpm start" are refused the same way', () => {
		expect(resolveDebugPlan({ language: 'auto' }, target({ cmd: ['yarn', 'start'] }))).toEqual({
			kind: 'refused',
			reason: 'package-manager',
			command: 'yarn start',
		});
		expect(resolveDebugPlan({ language: 'auto' }, target({ cmd: ['pnpm', 'start'] }))).toEqual({
			kind: 'refused',
			reason: 'package-manager',
			command: 'pnpm start',
		});
	});

	it('an empty command (no Cmd, no Entrypoint, no env fingerprint) is refused as unclassifiable', () => {
		const result = resolveDebugPlan({ language: 'auto' }, target());
		expect(result).toEqual({ kind: 'refused', reason: 'unclassifiable' });
	});

	it('falls back to the PYTHON_VERSION base-image env fingerprint when the argv gives no signal at all', () => {
		const result = resolveDebugPlan(
			{ language: 'auto' },
			target({ cmd: ['./run.sh'], env: { PYTHON_VERSION: '3.13.1' } }),
		);
		expect(result).toMatchObject({ kind: 'plan', plan: { language: 'python' } });
	});

	it('falls back to the NODE_VERSION base-image env fingerprint when the argv gives no signal at all', () => {
		const result = resolveDebugPlan(
			{ language: 'auto' },
			target({ cmd: ['./run.sh'], env: { NODE_VERSION: '24.1.0' } }),
		);
		expect(result).toMatchObject({ kind: 'plan', plan: { language: 'node' } });
	});

	it('an explicit language override wins over a wrong heuristic - even an npm-start-shaped command', () => {
		const result = resolveDebugPlan({ language: 'node' }, target({ cmd: ['npm', 'start'] }));
		expect(result).toMatchObject({ kind: 'plan', plan: { language: 'node', port: DEFAULT_PORT_BY_LANGUAGE.node } });
	});

	it('an explicit "python" override wins even against a node-shaped command', () => {
		const result = resolveDebugPlan({ language: 'python' }, target({ cmd: ['node', 'dist/main.js'] }));
		expect(result).toMatchObject({ kind: 'plan', plan: { language: 'python' } });
	});

	it('entrypoint + cmd are both scanned, entrypoint first', () => {
		const result = resolveDebugPlan({ language: 'auto' }, target({ entrypoint: ['python3'], cmd: ['-m', 'src'] }));
		expect(result).toMatchObject({ kind: 'plan', plan: { language: 'python' } });
	});
});

describe('resolveDebugPlan - port resolution', () => {
	it("an explicit port override wins over the resolved language's own default, for a Node Actor", () => {
		const result = resolveDebugPlan({ language: 'auto', port: 9230 }, target({ cmd: ['node', 'dist/main.js'] }));
		expect(result).toMatchObject({ kind: 'plan', plan: { language: 'node', port: 9230 } });
	});

	it('an explicit port override wins for a Python Actor too', () => {
		const result = resolveDebugPlan({ language: 'python', port: 5679 }, target());
		expect(result).toMatchObject({ kind: 'plan', plan: { language: 'python', port: 5679 } });
	});
});

describe("resolveDebugPlan - env prepending (never replacing the image's own value)", () => {
	it('prepends the payload dir onto an existing PYTHONPATH rather than replacing it', () => {
		const result = resolveDebugPlan({ language: 'python' }, target({ env: { PYTHONPATH: '/usr/src/app' } }));
		expect(result).toMatchObject({
			kind: 'plan',
			plan: { env: { PYTHONPATH: `${PYTHON_DEBUG_PAYLOAD_DIR}:/usr/src/app` } },
		});
	});

	it('prepends --inspect-brk onto an existing NODE_OPTIONS rather than replacing it', () => {
		const result = resolveDebugPlan(
			{ language: 'node' },
			target({ env: { NODE_OPTIONS: '--max-old-space-size=4096' } }),
		);
		expect(result).toMatchObject({
			kind: 'plan',
			plan: { env: { NODE_OPTIONS: '--inspect-brk=0.0.0.0:9229 --max-old-space-size=4096' } },
		});
	});
});

describe('describeDebugRefusal', () => {
	it('names the exact offending command and the clear-debug-mode command for a package-manager refusal', () => {
		const message = describeDebugRefusal('actor-123', {
			kind: 'refused',
			reason: 'package-manager',
			command: 'npm start',
		});
		expect(message).toContain('npm start');
		expect(message).toContain('Cannot start run:');
		expect(message).toContain('/actor-runtime/debug/actor-123');
		expect(message).toContain('"enabled": false');
	});

	it('names the language override as the fix for an unclassifiable refusal', () => {
		const message = describeDebugRefusal('actor-123', { kind: 'refused', reason: 'unclassifiable' });
		expect(message).toContain('language');
		expect(message).toContain('/actor-runtime/debug/actor-123');
		expect(message).toContain('Cannot start run:');
	});
});

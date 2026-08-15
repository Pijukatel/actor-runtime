import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { load } from 'js-yaml';

/** Repo root is two levels up from `test/unit/`. */
const composePath = fileURLToPath(new URL('../../docker-compose.yml', import.meta.url));

interface ComposeFile {
	services: {
		'actor-runtime': {
			environment: Record<string, string>;
		};
	};
}

/**
 * Uncomments exactly the line the file's own "Uncomment to ..." instruction points at, the same way a
 * user following that instruction verbatim would - regardless of whether that line happens to be
 * mapping-style (`# KEY: value`) or sequence-style (`# - KEY=value`), so this generically exercises
 * whatever the current example looks like rather than hard-coding one shape.
 */
function uncommentDocumentedExample(raw: string): string {
	const lines = raw.split('\n');
	const instructionIndex = lines.findIndex((line) => /Uncomment to/i.test(line));
	if (instructionIndex === -1)
		throw new Error('Expected an "Uncomment to ..." instruction comment in docker-compose.yml');
	const exampleIndex = instructionIndex + 1;
	lines[exampleIndex] = lines[exampleIndex]!.replace(/^(\s*)#\s?/, '$1');
	return lines.join('\n');
}

describe('docker-compose.yml', () => {
	it('parses as valid YAML as shipped', () => {
		const raw = readFileSync(composePath, 'utf8');
		const parsed = load(raw) as ComposeFile;
		expect(parsed.services['actor-runtime'].environment.ACTOR_RUNTIME_DATA_DIR).toBe('/data');
	});

	/**
	 * Regression: the `environment:` block is mapping-style (`KEY: value`), so its commented example
	 * must also be mapping-style - a sequence-style example (`# - KEY=value`) mixes a block sequence
	 * into a block mapping once uncommented, which is not valid YAML at all. Follows the file's own
	 * instruction literally, exactly as a reader would, rather than asserting against one hard-coded
	 * fixed string.
	 */
	it('still parses as valid YAML once the documented example is uncommented', () => {
		const raw = readFileSync(composePath, 'utf8');
		const uncommented = uncommentDocumentedExample(raw);
		expect(uncommented).not.toBe(raw); // sanity: the instruction's line was actually found and changed

		const parsed = load(uncommented) as ComposeFile;
		const { environment } = parsed.services['actor-runtime'];
		expect(environment.APIFY_PROXY_PASSWORD).toBe('your-password');
		expect(environment.ACTOR_RUNTIME_DATA_DIR).toBe('/data');
	});
});

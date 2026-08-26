import { describe, expect, it } from 'vitest';

import { resolveDockerfileLocation } from '../../src/services/dockerfile-location.js';
import { DEFAULT_DOCKERFILE_CONTENT, DEFAULT_DOCKERFILE_NAME } from '../../src/services/default-dockerfile.js';
import type { SourceFile } from '../../src/storage/entities.js';

/** A `TEXT`-format `SourceFile`, the common case in every table row below. */
function text(name: string, content: string): SourceFile {
	return { name, format: 'TEXT', content };
}

/** `.actor/actor.json` as a `SourceFile`, given the object to serialize (or a raw string, for the
 * JSON5-tolerance and unparseable-content cases below). */
function actorJson(spec: Record<string, unknown> | string): SourceFile {
	return text('.actor/actor.json', typeof spec === 'string' ? spec : JSON.stringify(spec));
}

describe('resolveDockerfileLocation', () => {
	it('A: resolves the "dockerfile" field to .actor/Dockerfile (sample_actor_crawler layout)', () => {
		const result = resolveDockerfileLocation([
			actorJson({ dockerfile: './Dockerfile' }),
			text('.actor/Dockerfile', 'FROM python:3.11-slim\n'),
			text('.actor/input_schema.json', '{}'),
			text('main.py', 'print(1)\n'),
		]);

		expect(result.outcome).toBe('resolved');
		if (result.outcome !== 'resolved') return;
		expect(result.dockerfilePath).toBe('.actor/Dockerfile');
		expect(result.logLines).toEqual([
			'Using Dockerfile ".actor/Dockerfile" (from the "dockerfile" field in .actor/actor.json).\n',
		]);
	});

	it('B: resolves "../Dockerfile" to the root Dockerfile (sample_actor_ts/py layout) - byte-identical to today\'s implicit default', () => {
		const result = resolveDockerfileLocation([
			actorJson({ dockerfile: '../Dockerfile' }),
			text('Dockerfile', 'FROM node:20\n'),
			text('main.ts', 'console.log(1);\n'),
		]);

		expect(result.outcome).toBe('resolved');
		if (result.outcome !== 'resolved') return;
		expect(result.dockerfilePath).toBe('Dockerfile');
	});

	it('C: warns and falls through to .actor/Dockerfile when the "dockerfile" field names no file', () => {
		const result = resolveDockerfileLocation([
			actorJson({ dockerfile: './Custom.Dockerfile' }),
			text('.actor/Dockerfile', 'FROM node:20\n'),
		]);

		expect(result.outcome).toBe('resolved');
		if (result.outcome !== 'resolved') return;
		expect(result.dockerfilePath).toBe('.actor/Dockerfile');
		expect(result.logLines).toEqual([
			'Warning: ".actor/Custom.Dockerfile" (from the "dockerfile" field in .actor/actor.json) is not in the pushed source; falling back to the default locations.\n',
			'Using Dockerfile ".actor/Dockerfile" (found at .actor/Dockerfile).\n',
		]);
	});

	describe('D: an escaping "dockerfile" field fails the build before any daemon call', () => {
		it('a relative path with enough ".." segments to escape .actor/', () => {
			const result = resolveDockerfileLocation([actorJson({ dockerfile: '../../evil/Dockerfile' })]);

			expect(result).toEqual({
				outcome: 'failure',
				reason: 'escapes-actor-root',
				message:
					'Dockerfile path "../../evil/Dockerfile" in .actor/actor.json points outside the Actor root directory.',
			});
		});

		it('an absolute path (leading "/")', () => {
			const result = resolveDockerfileLocation([actorJson({ dockerfile: '/etc/passwd' })]);

			expect(result).toEqual({
				outcome: 'failure',
				reason: 'escapes-actor-root',
				message: 'Dockerfile path "/etc/passwd" in .actor/actor.json points outside the Actor root directory.',
			});
		});

		it('a path that normalizes to exactly ".." (the joined === ".." disjunct, not just startsWith("../"))', () => {
			const result = resolveDockerfileLocation([actorJson({ dockerfile: '../..' })]);

			expect(result).toEqual({
				outcome: 'failure',
				reason: 'escapes-actor-root',
				message: 'Dockerfile path "../.." in .actor/actor.json points outside the Actor root directory.',
			});
		});

		it('a path that stays inside .actor/ (one level of ".." exactly cancels the join) is not treated as escaping', () => {
			const result = resolveDockerfileLocation([
				actorJson({ dockerfile: '../Dockerfile' }),
				text('Dockerfile', 'FROM node:20\n'),
			]);

			expect(result.outcome).toBe('resolved');
		});
	});

	describe('E: case-insensitive matching', () => {
		it('matches .actor/Dockerfile against a lowercase .actor/dockerfile source file, returning ITS OWN spelling', () => {
			const result = resolveDockerfileLocation([text('.actor/dockerfile', 'FROM node:20\n')]);

			expect(result.outcome).toBe('resolved');
			if (result.outcome !== 'resolved') return;
			expect(result.dockerfilePath).toBe('.actor/dockerfile');
		});

		it('an exact-case match wins even when a case-differing match appears earlier in sourceFiles order', () => {
			const result = resolveDockerfileLocation([
				text('dockerfile', 'wrong case, listed first'),
				text('Dockerfile', 'exact case, listed second - must still win'),
			]);
			expect(result.outcome).toBe('resolved');
			if (result.outcome !== 'resolved') return;
			expect(result.dockerfilePath).toBe('Dockerfile');
		});

		it('with no exact-case match, the first case-differing match in sourceFiles order wins', () => {
			const result = resolveDockerfileLocation([
				text('DOCKERFILE', 'all caps, listed first'),
				text('dockerfile', 'all lowercase, listed second'),
			]);
			expect(result.outcome).toBe('resolved');
			if (result.outcome !== 'resolved') return;
			expect(result.dockerfilePath).toBe('DOCKERFILE');
		});
	});

	describe('F: nothing resolves - the bundled default is injected', () => {
		it('injects the bundled default Dockerfile, verbatim, as an extra Dockerfile-named SourceFile', () => {
			const result = resolveDockerfileLocation([
				actorJson({ name: 'no-dockerfile-actor' }),
				text('main.py', 'print(1)\n'),
			]);

			expect(result.outcome).toBe('default');
			if (result.outcome !== 'default') return;
			expect(result.dockerfilePath).toBe(DEFAULT_DOCKERFILE_NAME);
			expect(result.extraSourceFile).toEqual({
				name: 'Dockerfile',
				format: 'TEXT',
				content: DEFAULT_DOCKERFILE_CONTENT,
			});
			expect(result.logLines).toEqual(['Dockerfile not found, using the default one.\n']);
		});

		it('also injects the default when there is no .actor/actor.json at all', () => {
			const result = resolveDockerfileLocation([text('main.py', 'print(1)\n')]);

			expect(result.outcome).toBe('default');
		});

		it('is reached only after both .actor/Dockerfile and a root Dockerfile have failed to match, in any case', () => {
			const result = resolveDockerfileLocation([
				text('main.py', 'print(1)\n'),
				text('README.md', '# not a Dockerfile\n'),
			]);

			expect(result.outcome).toBe('default');
		});
	});

	describe('G: malformed "dockerfile" field', () => {
		it('a non-string value (e.g. true) fails the build immediately, before any candidate is tried', () => {
			const result = resolveDockerfileLocation([
				actorJson({ dockerfile: true }),
				text('Dockerfile', 'FROM node:20\n'),
			]);

			expect(result).toEqual({
				outcome: 'failure',
				reason: 'invalid-dockerfile-field',
				message: '.actor/actor.json has invalid format: "dockerfile" must be a string.',
			});
		});

		it('a number value fails the same way as a boolean', () => {
			const result = resolveDockerfileLocation([actorJson({ dockerfile: 42 })]);

			expect(result.outcome).toBe('failure');
			if (result.outcome !== 'failure') return;
			expect(result.reason).toBe('invalid-dockerfile-field');
		});

		it('an empty string is treated as "names nothing" - warn and fall through, never the invalid-format failure', () => {
			const result = resolveDockerfileLocation([
				actorJson({ dockerfile: '' }),
				text('.actor/Dockerfile', 'FROM node:20\n'),
			]);

			expect(result.outcome).toBe('resolved');
			if (result.outcome !== 'resolved') return;
			expect(result.dockerfilePath).toBe('.actor/Dockerfile');
			expect(result.logLines[0]).toBe(
				'Warning: "" (from the "dockerfile" field in .actor/actor.json) is not in the pushed source; falling back to the default locations.\n',
			);
		});

		it('an empty string falls all the way through to the bundled default when no other candidate exists either', () => {
			const result = resolveDockerfileLocation([actorJson({ dockerfile: '' }), text('main.py', 'print(1)\n')]);

			expect(result.outcome).toBe('default');
		});
	});

	describe('JSON5 tolerance', () => {
		it('parses a trailing comma and a comment in .actor/actor.json', () => {
			const result = resolveDockerfileLocation([
				actorJson('{\n  // a comment JSON.parse would reject\n  "dockerfile": "./Dockerfile",\n}\n'),
				text('.actor/Dockerfile', 'FROM node:20\n'),
			]);

			expect(result.outcome).toBe('resolved');
			if (result.outcome !== 'resolved') return;
			expect(result.dockerfilePath).toBe('.actor/Dockerfile');
		});

		it('parses unquoted keys and single-quoted strings', () => {
			const result = resolveDockerfileLocation([
				actorJson("{ dockerfile: '../Dockerfile' }"),
				text('Dockerfile', 'FROM node:20\n'),
			]);

			expect(result.outcome).toBe('resolved');
			if (result.outcome !== 'resolved') return;
			expect(result.dockerfilePath).toBe('Dockerfile');
		});

		it('a genuinely unparseable .actor/actor.json fails the build with a clear message', () => {
			const result = resolveDockerfileLocation([actorJson('{ this is not json at all')]);

			expect(result.outcome).toBe('failure');
			if (result.outcome !== 'failure') return;
			expect(result.reason).toBe('unparseable-actor-json');
			expect(result.message).toContain('.actor/actor.json');
		});

		it('tolerates .actor/actor.json delivered as a BASE64-encoded SourceFile', () => {
			const spec = JSON.stringify({ dockerfile: './Dockerfile' });
			const result = resolveDockerfileLocation([
				{ name: '.actor/actor.json', format: 'BASE64', content: Buffer.from(spec, 'utf8').toString('base64') },
				text('.actor/Dockerfile', 'FROM node:20\n'),
			]);

			expect(result.outcome).toBe('resolved');
			if (result.outcome !== 'resolved') return;
			expect(result.dockerfilePath).toBe('.actor/Dockerfile');
		});
	});

	describe('no-actor.json fallbacks', () => {
		it('resolves .actor/Dockerfile with no actor.json present at all', () => {
			const result = resolveDockerfileLocation([
				text('.actor/Dockerfile', 'FROM node:20\n'),
				text('main.py', ''),
			]);

			expect(result.outcome).toBe('resolved');
			if (result.outcome !== 'resolved') return;
			expect(result.dockerfilePath).toBe('.actor/Dockerfile');
		});

		it('resolves the root Dockerfile with no actor.json and no .actor/Dockerfile present', () => {
			const result = resolveDockerfileLocation([text('Dockerfile', 'FROM node:20\n'), text('main.py', '')]);

			expect(result.outcome).toBe('resolved');
			if (result.outcome !== 'resolved') return;
			expect(result.dockerfilePath).toBe('Dockerfile');
		});

		it('.actor/Dockerfile is preferred over a root Dockerfile when both exist and actor.json names neither', () => {
			const result = resolveDockerfileLocation([
				text('.actor/Dockerfile', 'FROM node:20 # actor-dir\n'),
				text('Dockerfile', 'FROM node:20 # root\n'),
			]);

			expect(result.outcome).toBe('resolved');
			if (result.outcome !== 'resolved') return;
			expect(result.dockerfilePath).toBe('.actor/Dockerfile');
		});
	});

	describe('.actor/actor.json parses to a non-object value', () => {
		it('content is exactly "null" (JSON5-parseable, non-object) - falls through to candidate 2, no crash', () => {
			const result = resolveDockerfileLocation([actorJson('null'), text('.actor/Dockerfile', 'FROM node:20\n')]);

			expect(result.outcome).toBe('resolved');
			if (result.outcome !== 'resolved') return;
			expect(result.dockerfilePath).toBe('.actor/Dockerfile');
		});
	});
});

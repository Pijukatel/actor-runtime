import { describe, expect, it } from 'vitest';

import { dockerContextFiles, resolveDockerContext } from '../../src/services/docker-context.js';
import type { SourceFile } from '../../src/storage/entities.js';

function text(name: string, content = ''): SourceFile {
	return { name, format: 'TEXT', content };
}

function actorJson(actorPath: string, spec: Record<string, unknown>): SourceFile {
	return text(`${actorPath ? `${actorPath}/` : ''}.actor/actor.json`, JSON.stringify(spec));
}

/** The platform builder's rules (apify-worker `act2_build_job.ts`), which apply to every source type. */
describe('resolveDockerContext', () => {
	it("is the Actor's folder when dockerContextDir is not set", () => {
		expect(resolveDockerContext([actorJson('', {})])).toEqual({
			outcome: 'resolved',
			contextPath: '',
			actorPathInContext: '',
		});
		expect(resolveDockerContext([actorJson('actors/a', {}), text('shared/x')], 'actors/a')).toEqual({
			outcome: 'resolved',
			contextPath: 'actors/a',
			actorPathInContext: '',
		});
	});

	it('resolves dockerContextDir relative to .actor/, and names the Actor relative to the context', () => {
		const files = [actorJson('actors/a', { dockerContextDir: '../..' }), text('packages/p/index.js')];
		expect(resolveDockerContext(files, 'actors/a')).toEqual({
			outcome: 'resolved',
			contextPath: 'actors',
			actorPathInContext: 'a',
		});
		expect(resolveDockerContext([actorJson('actors/a', { dockerContextDir: '../../..' })], 'actors/a')).toEqual({
			outcome: 'resolved',
			contextPath: '',
			actorPathInContext: 'actors/a',
		});
	});

	it('fails for a context outside the pushed files or one that does not exist, with the platform messages', () => {
		expect(resolveDockerContext([actorJson('a', { dockerContextDir: '../../..' })], 'a')).toEqual({
			outcome: 'failure',
			message: 'Actor context path "../../.." is outside of Actor root directory!',
		});
		expect(resolveDockerContext([actorJson('a', { dockerContextDir: '../../missing' })], 'a')).toEqual({
			outcome: 'failure',
			message: 'Actor context path "../../missing" does not exist!',
		});
	});

	it('keeps only the context in the build, named relative to it', () => {
		const files = [text('actors/a/main.js'), text('packages/p/index.js'), text('README.md')];
		expect(dockerContextFiles(files, 'actors').map((file) => file.name)).toEqual(['a/main.js']);
		expect(dockerContextFiles(files, '').map((file) => file.name)).toEqual([
			'actors/a/main.js',
			'packages/p/index.js',
			'README.md',
		]);
	});
});

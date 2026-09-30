import { describe, expect, it } from 'vitest';

import { describeActorJsonDefect } from '../../src/services/actor-json-validation.js';
import type { SourceFile } from '../../src/storage/entities.js';

function actorJson(content: unknown, actorPath = ''): SourceFile[] {
	return [
		{
			name: `${actorPath ? `${actorPath}/` : ''}.actor/actor.json`,
			format: 'TEXT',
			content: typeof content === 'string' ? content : JSON.stringify(content),
		},
	];
}

/** The same `@apify/json_schemas` check the platform's builder runs on every build. */
describe('describeActorJsonDefect', () => {
	it('accepts a valid file, JSON5 included, and a missing one', () => {
		expect(describeActorJsonDefect(actorJson({ actorSpecification: 1, name: 'a', version: '0.1' }))).toBeNull();
		expect(describeActorJsonDefect(actorJson("{ actorSpecification: 1, name: 'a', version: '0.1', }"))).toBeNull();
		expect(describeActorJsonDefect([])).toBeNull();
	});

	it('rejects what the platform rejects, with its message', () => {
		const cases: Array<[unknown, string]> = [
			[{ actorSpecification: 1, name: 'a' }, "must have required property 'version'"],
			[{ name: 'a', version: '0.0' }, "must have required property 'actorSpecification'"],
			[{ actorSpecification: 2, name: 'a', version: '0.0' }, 'must be <= 1'],
			[{ actorSpecification: 1, name: 'a', version: '1' }, 'must match pattern'],
			[{ actorSpecification: 1, name: 'a', version: '0.0', usesStandbyMode: 'yes' }, 'must be boolean'],
			[{ actorSpecification: 1, name: 'a', version: '0.0', dockerContextDir: 5 }, 'must be string'],
		];
		for (const [content, reason] of cases) {
			const defect = describeActorJsonDefect(actorJson(content));
			expect(defect, reason).toMatch(/^\.actor\/actor\.json has invalid format /);
			expect(defect).toContain(reason);
		}
	});

	it("checks the Actor's own .actor/actor.json in a monorepo push", () => {
		expect(describeActorJsonDefect(actorJson({ name: 'a' }, 'actors/a'), 'actors/a')).toContain(
			'actorSpecification',
		);
	});
});

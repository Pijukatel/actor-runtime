/**
 * `.actor/actor.json`'s memory fields, from a real build over pushed source to the run it starts
 * (`actor-driver.md`'s "Run memory"). The driver is stubbed at `docker build`; nothing here needs Docker.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { fixedBuildOutcomeDriver, startTestServer, type TestServerHandle } from './helpers/test-server.js';
import { getRegistries } from '../../src/storage/registries.js';
import { runBuildInBackground } from '../../src/services/builds.js';
import type { SourceFile } from '../../src/storage/entities.js';

describe('run memory from .actor/actor.json (via real apify-client)', () => {
	let server: TestServerHandle;

	beforeEach(async () => {
		server = await startTestServer();
	});

	afterEach(async () => {
		await server.close();
	});

	async function build(actorId: string, userId: string, buildId: string, actorJson: unknown): Promise<void> {
		const { actors, builds } = getRegistries();
		const sourceFiles: SourceFile[] = [
			{ name: 'main.js', format: 'TEXT', content: 'console.log(1)' },
			{
				name: '.actor/actor.json',
				format: 'TEXT',
				content: JSON.stringify({
					actorSpecification: 1,
					name: 'memory-actor',
					version: '0.0',
					...(actorJson as object),
				}),
			},
		];
		await builds.set(buildId, {
			id: buildId,
			userId,
			actorId,
			versionNumber: '0.0',
			buildNumber: '0.0.1',
			tag: 'latest',
			status: 'READY',
			startedAt: new Date().toISOString(),
		});
		await runBuildInBackground(
			fixedBuildOutcomeDriver({ imageId: 'built-image:latest' }),
			(await actors.get(actorId))!,
			{ versionNumber: '0.0', buildTag: 'latest', sourceType: 'SOURCE_FILES', sourceFiles },
			(await builds.get(buildId))!,
			{ tag: 'latest', useCache: true },
		);
	}

	it('sizes runs by defaultMemoryMbytes and the min/max bounds, and fails a build that declares them wrong', async () => {
		const actor = await server.client.actors().create({ name: 'memory-actor' });
		const { builds } = getRegistries();

		await build(actor.id, actor.userId, 'badMemoryBuild123', { minMemoryMbytes: 'lots' });
		expect((await builds.get('badMemoryBuild123'))?.status).toBe('FAILED');

		await build(actor.id, actor.userId, 'goodMemoryBuild12', {
			defaultMemoryMbytes: "get(input, 'pages', 1) * 1024",
			minMemoryMbytes: 2048,
			maxMemoryMbytes: 8192,
		});
		expect((await builds.get('goodMemoryBuild12'))?.status).toBe('SUCCEEDED');

		const fromExpression = await server.client.actor(actor.id).start({ pages: 4 });
		expect(fromExpression.options.memoryMbytes).toBe(4096);
		expect(fromExpression.options.diskMbytes).toBe(8192);

		const raisedToMin = await server.client.actor(actor.id).start({});
		expect(raisedToMin.options.memoryMbytes).toBe(2048);

		const cappedAtMax = await server.client.actor(actor.id).start({}, { memory: 32768 });
		expect(cappedAtMax.options.memoryMbytes).toBe(8192);

		// The stub driver cannot run anything; let each run fail before the server goes away.
		for (const run of [fromExpression, raisedToMin, cappedAtMax]) {
			await server.client.run(run.id).waitForFinish({ waitSecs: 10 });
		}
	});
});

/**
 * Actor-level `defaultRunOptions` (`requirements/api.md`): stored on create and update, and applied to a
 * run for every option its caller leaves out. The driver finishes every run at once; nothing needs Docker.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import axios from 'axios';

import { fixedRunOutcomeDriver, startTestServer, type TestServerHandle } from './helpers/test-server.js';
import { getRegistries } from '../../src/storage/registries.js';
import { generateId } from '../../src/storage/ids.js';
import { recordTaggedBuild, updateActor } from '../../src/services/actors.js';

describe('Actor-level default run options (via real apify-client)', () => {
	let server: TestServerHandle;

	beforeEach(async () => {
		server = await startTestServer(fixedRunOutcomeDriver({ exitCode: 0, timedOut: false }));
	});

	afterEach(async () => {
		await server.close();
	});

	async function seedTaggedBuild(actorId: string, userId: string, tag: string, buildNumber: string) {
		const id = generateId();
		await getRegistries().builds.set(id, {
			id,
			userId,
			actorId,
			versionNumber: '0.0',
			buildNumber,
			tag,
			status: 'SUCCEEDED',
			startedAt: new Date().toISOString(),
			finishedAt: new Date().toISOString(),
			imageId: `fake-image:${tag}`,
		});
		await updateActor(actorId, (current) => recordTaggedBuild(current, tag, id, buildNumber));
	}

	function putActor(actorId: string, body: unknown) {
		return axios.put(`${server.baseUrl}/v2/actors/${actorId}`, body, {
			headers: { Authorization: `Bearer ${server.token}` },
			validateStatus: () => true,
		});
	}

	it('reads as the platform defaults until set, and merges a partial update', async () => {
		const actor = await server.client.actors().create({ name: 'defaults-actor' });
		expect(actor.defaultRunOptions).toEqual({ build: 'latest', timeoutSecs: 300, memoryMbytes: 1024 });

		await server.client.actor(actor.id).update({ defaultRunOptions: { memoryMbytes: 4096 } } as never);
		const updated = await server.client.actor(actor.id).get();
		expect(updated?.defaultRunOptions).toEqual({ build: 'latest', timeoutSecs: 300, memoryMbytes: 4096 });

		const created = await server.client
			.actors()
			.create({ name: 'created-with-defaults', defaultRunOptions: { timeoutSecs: 0, maxItems: 10 } } as never);
		expect(created.defaultRunOptions).toEqual({
			build: 'latest',
			timeoutSecs: 0,
			memoryMbytes: 1024,
			maxItems: 10,
		});
	});

	it('rejects invalid options with schema-validation and leaves the Actor unchanged', async () => {
		const actor = await server.client.actors().create({ name: 'invalid-defaults' });
		for (const defaultRunOptions of [
			{ memoryMbytes: 1000 },
			{ memoryMbytes: 65536 },
			{ timeoutSecs: -1 },
			{ build: 'not a tag' },
			{ unknownOption: 1 },
		]) {
			const response = await putActor(actor.id, { defaultRunOptions });
			expect(response.status, JSON.stringify(defaultRunOptions)).toBe(400);
			expect(response.data.error.type).toBe('schema-validation');
		}
		const unchanged = await server.client.actor(actor.id).get();
		expect(unchanged?.defaultRunOptions).toEqual({ build: 'latest', timeoutSecs: 300, memoryMbytes: 1024 });
	});

	it('applies each default the caller leaves out, and lets an explicit option win', async () => {
		const actor = await server.client.actors().create({ name: 'applied-defaults' });
		await seedTaggedBuild(actor.id, actor.userId, 'latest', '0.0.1');
		await seedTaggedBuild(actor.id, actor.userId, 'beta', '0.0.2');
		await server.client.actor(actor.id).update({
			defaultRunOptions: { build: 'beta', timeoutSecs: 0, memoryMbytes: 2048, maxTotalChargeUsd: 5 },
		} as never);

		const fromDefaults = await server.client.actor(actor.id).start({});
		expect(fromDefaults.buildNumber).toBe('0.0.2');
		expect(fromDefaults.options).toMatchObject({
			build: 'beta',
			timeoutSecs: 0,
			memoryMbytes: 2048,
			diskMbytes: 4096,
			maxTotalChargeUsd: 5,
		});

		const explicit = await server.client
			.actor(actor.id)
			.start({}, { build: 'latest', timeout: 60, memory: 512, maxTotalChargeUsd: 1 });
		expect(explicit.buildNumber).toBe('0.0.1');
		expect(explicit.options).toMatchObject({
			build: 'latest',
			timeoutSecs: 60,
			memoryMbytes: 512,
			maxTotalChargeUsd: 1,
		});

		for (const run of [fromDefaults, explicit]) {
			await server.client.run(run.id).waitForFinish({ waitSecs: 10 });
		}
	});
});

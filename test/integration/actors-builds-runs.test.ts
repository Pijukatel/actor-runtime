import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { startTestServer, type TestServerHandle } from './helpers/test-server.js';
import { getRegistries } from '../../src/storage/registries.js';
import { recordTaggedBuild, updateActor } from '../../src/services/actors.js';
import type { Driver } from '../../src/driver/types.js';

/** An available driver whose `startRun` is never expected to be reached in the tests that use it - every
 * build seeded against it has no `imageId`, so `runInBackground` fails the run before calling any driver
 * method at all. */
function availableDriverWithNoImage(): Driver {
	return {
		available: true,
		async init() {},
		async startBuild() {
			throw new Error('not used by this stub');
		},
		async abortBuild() {},
		async startRun() {
			throw new Error('not used by this stub - the seeded build has no imageId');
		},
		async abortRun() {},
		async reconcileOrphans() {},
		async probeDevFolder() {
			throw new Error('not used by this stub');
		},
		async ensureProbeImage() {
			throw new Error('not used by this stub');
		},
		async inspectDebugTarget() {
			throw new Error('not used by this stub');
		},
	};
}

describe('actors / versions / builds / runs (via real apify-client)', () => {
	let server: TestServerHandle;

	beforeEach(async () => {
		server = await startTestServer();
	});

	afterEach(async () => {
		await server.close();
	});

	it('creates an Actor, then finds it again by username~name (apify push probe)', async () => {
		const actor = await server.client.actors().create({
			name: 'my-actor',
			versions: [
				{ versionNumber: '0.0', buildTag: 'latest', sourceType: 'SOURCE_FILES' as never, sourceFiles: [] },
			],
		});
		expect(actor.id).toHaveLength(17);

		const user = await server.client.user('me').get();
		const byName = await server.client.actor(`${user.username}/my-actor`).get();
		expect(byName?.id).toBe(actor.id);

		const missing = await server.client.actor('someone/does-not-exist').get();
		expect(missing).toBeUndefined();
	});

	it('creates and updates an Actor version', async () => {
		const actor = await server.client.actors().create({ name: 'versioned-actor' });
		const actorClient = server.client.actor(actor.id);

		await actorClient.versions().create({
			versionNumber: '0.1',
			buildTag: 'latest',
			sourceType: 'SOURCE_FILES' as never,
			sourceFiles: [{ name: 'main.js', format: 'TEXT', content: 'console.log(1)' }],
		} as never);

		const version = await actorClient.version('0.1').get();
		expect(version?.sourceFiles).toHaveLength(1);

		await actorClient.version('0.1').update({ buildTag: 'beta' } as never);
		const updated = await actorClient.version('0.1').get();
		expect(updated?.buildTag).toBe('beta');
	});

	it('lists an Actor versions via the real apify-client, and gets a single version by number (field-shape drift is the risk `sendPaginated` here guards against)', async () => {
		const actor = await server.client.actors().create({ name: 'listed-versions-actor' });
		const actorClient = server.client.actor(actor.id);

		await actorClient.versions().create({
			versionNumber: '0.0',
			buildTag: 'latest',
			sourceType: 'SOURCE_FILES' as never,
			sourceFiles: [{ name: 'main.js', format: 'TEXT', content: 'console.log(0)' }],
		} as never);
		await actorClient.versions().create({
			versionNumber: '0.1',
			buildTag: 'beta',
			sourceType: 'SOURCE_FILES' as never,
			sourceFiles: [{ name: 'main.js', format: 'TEXT', content: 'console.log(1)' }],
		} as never);

		// `ActorVersionCollectionClient.list()` (apify-client-js) requires the full
		// `{ total, offset, count, limit, desc, items }` pagination envelope, not a bare array - this is
		// exactly the contract `sendPaginated` (as opposed to `sendData`) exists to satisfy.
		const page = await actorClient.versions().list();
		expect(page.items.map((v) => v.versionNumber)).toEqual(['0.0', '0.1']);
		expect(page.total).toBe(2);
		expect(page.count).toBe(2);
		expect(page.offset).toBe(0);
		expect(page.desc).toBe(false);

		const single = await actorClient.version('0.1').get();
		expect(single?.versionNumber).toBe('0.1');
		expect(single?.buildTag).toBe('beta');
	});

	it('triggers a build; without Docker in this sandbox it fails fast with a clear status message', async () => {
		const actor = await server.client.actors().create({ name: 'build-actor' });
		const actorClient = server.client.actor(actor.id);
		await actorClient.versions().create({
			versionNumber: '0.0',
			buildTag: 'latest',
			sourceType: 'SOURCE_FILES' as never,
			sourceFiles: [{ name: 'main.js', format: 'TEXT', content: '// noop' }],
		} as never);

		const build = await actorClient.build('0.0', { useCache: true, waitForFinish: 5 });
		expect(build.buildNumber).toBeTruthy();
		expect(['FAILED', 'RUNNING', 'READY']).toContain(build.status);

		const refreshed = await server.client.build(build.id).get();
		expect(refreshed?.status).toBe('FAILED');
		expect(refreshed?.statusMessage).toMatch(/Docker/i);

		const log = await server.client.log(build.id).get();
		expect(log).toMatch(/Docker is not available/);

		const list = await server.client.builds().list();
		expect(list.items.some((b) => b.id === build.id)).toBe(true);
	});

	it('build numbers start at .1, never .0 (regression: apify-client Python model rejects a trailing .0 build number)', async () => {
		const actor = await server.client.actors().create({ name: 'build-numbering-actor' });
		const actorClient = server.client.actor(actor.id);
		await actorClient.versions().create({
			versionNumber: '0.0',
			buildTag: 'latest',
			sourceType: 'SOURCE_FILES' as never,
			sourceFiles: [],
		} as never);

		const first = await actorClient.build('0.0', { waitForFinish: 5 });
		expect(first.buildNumber).toBe('0.0.1');

		const second = await actorClient.build('0.0', { waitForFinish: 5 });
		expect(second.buildNumber).toBe('0.0.2');
	});

	it("a started run's options include the resolved build tag and diskMbytes, and a default generalAccess (regression: apify-client Python `Run`/`RunOptions` models require all three)", async () => {
		const actor = await server.client.actors().create({ name: 'run-options-actor' });
		const { builds } = getRegistries();
		const fakeBuildId = 'fakeBuildId12345o';
		await builds.set(fakeBuildId, {
			id: fakeBuildId,
			userId: actor.userId,
			actorId: actor.id,
			versionNumber: '0.0',
			buildNumber: '0.0.1',
			tag: 'latest',
			status: 'SUCCEEDED',
			startedAt: new Date().toISOString(),
			finishedAt: new Date().toISOString(),
			imageId: 'fake-image:latest',
		});
		await updateActor(actor.id, (current) => recordTaggedBuild(current, 'latest', fakeBuildId, '0.0.1'));

		const run = await server.client.actor(actor.id).start({}, { waitForFinish: 5 });
		expect(run.options).toEqual({
			build: 'latest',
			memoryMbytes: 1024,
			timeoutSecs: 300,
			diskMbytes: 2048,
		});
		expect(run.generalAccess).toBe('FOLLOW_USER_SETTING');
	});

	it('starting a run against an Actor with no tagged build 404s, naming the tag that has no build', async () => {
		const actor = await server.client.actors().create({ name: 'no-build-actor' });
		await expect(server.client.actor(actor.id).start({})).rejects.toMatchObject({
			statusCode: 404,
			type: 'record-not-found',
			message: 'Actor has no build tagged "latest"',
		});
	});

	it('starting a run against a tag whose BuildRecord was since deleted 404s the same bare way base did (not the "no build tagged" message, since the tag genuinely still exists)', async () => {
		const actor = await server.client.actors().create({ name: 'deleted-tagged-build-actor' });

		// Seed a tagged, successful build directly, then delete the underlying BuildRecord without
		// clearing the tag - the exact state `deleteBuild` (`services/builds.ts`) leaves behind, since it
		// only removes the build itself and never touches `actor.taggedBuilds`.
		const { builds } = getRegistries();
		const fakeBuildId = 'fakeBuildId12345d';
		await builds.set(fakeBuildId, {
			id: fakeBuildId,
			userId: actor.userId,
			actorId: actor.id,
			versionNumber: '0.0',
			buildNumber: '0.0.1',
			tag: 'latest',
			status: 'SUCCEEDED',
			startedAt: new Date().toISOString(),
			finishedAt: new Date().toISOString(),
			imageId: 'fake-image:latest',
		});
		await updateActor(actor.id, (current) => recordTaggedBuild(current, 'latest', fakeBuildId, '0.0.1'));
		await builds.delete(fakeBuildId);

		// At base (`9cb32f0:src/api/routes/actors.ts`), a tag whose BuildRecord had been deleted fell
		// through to a bare `recordNotFound()` - the default "Record was not found" message, distinct from
		// the "Actor has no build tagged" message the no-such-tag case above gets. This locks in that this
		// input class stays byte-for-byte base-identical: `resolveTaggedBuild` exists only so this route can
		// tell the two failure reasons apart internally, not to change what either one reports.
		await expect(server.client.actor(actor.id).start({})).rejects.toMatchObject({
			statusCode: 404,
			type: 'record-not-found',
			message: 'Record was not found',
		});
	});

	it('a run against a (test-seeded) successful build wires storages/env, then fails fast without Docker', async () => {
		const actor = await server.client.actors().create({ name: 'run-actor' });

		// Seed a "successful" build directly, bypassing the driver, to exercise run start/env-building
		// without requiring a real Docker build in this sandbox.
		const { builds } = getRegistries();
		const fakeBuildId = 'fakeBuildId12345a';
		await builds.set(fakeBuildId, {
			id: fakeBuildId,
			userId: actor.userId,
			actorId: actor.id,
			versionNumber: '0.0',
			buildNumber: '0.0.1',
			tag: 'latest',
			status: 'SUCCEEDED',
			startedAt: new Date().toISOString(),
			finishedAt: new Date().toISOString(),
			imageId: 'fake-image:latest',
		});
		await updateActor(actor.id, (current) => recordTaggedBuild(current, 'latest', fakeBuildId, '0.0.1'));

		const run = await server.client.actor(actor.id).start({ maxPages: 3 });
		expect(run.defaultDatasetId).toHaveLength(17);
		expect(run.defaultKeyValueStoreId).toHaveLength(17);
		expect(run.defaultRequestQueueId).toHaveLength(17);

		// The INPUT record should already be written before the run "starts".
		const inputRecord = await server.client.keyValueStore(run.defaultKeyValueStoreId).getRecord('INPUT');
		expect(inputRecord?.value).toEqual({ maxPages: 3 });

		// Poll for the terminal state - fails fast because there is no Docker socket here.
		let final = run;
		for (let i = 0; i < 20 && !['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT'].includes(final.status); i++) {
			await new Promise((resolve) => setTimeout(resolve, 100));
			final = (await server.client.run(run.id).get())!;
		}
		expect(final.status).toBe('FAILED');
		// The bare driver-unavailable reason, no "Cannot start run: " prefix and no literal "undefined" -
		// the caller composes that prefix only for the log line it passes to `failBeforeContainer`, which
		// itself prefixes nothing and stores `statusMessage` verbatim, matching `services/builds.ts`'s own
		// driver-unavailable path, which stores `driver.unavailableReason` as-is.
		expect(final.statusMessage).toBe('Docker is not available in the test environment');

		const list = await server.client.runs().list();
		expect(list.items.some((r) => r.id === run.id)).toBe(true);
	});

	it('a run against a build with no imageId fails fast with the bare "Build has no image to run" statusMessage (no prefix)', async () => {
		// `bootstrapStorage` is a process-wide singleton (`storage/bootstrap.ts`) - the outer `beforeEach`'s
		// default (`unavailableDriver`) server must be fully closed before a second one can be started
		// against a different driver; `server` is reassigned so the outer `afterEach`'s own `close()` still
		// tears down whichever server this test ends up with.
		await server.close();
		server = await startTestServer(availableDriverWithNoImage());

		const actor = await server.client.actors().create({ name: 'run-no-image-actor' });
		const { builds } = getRegistries();
		const fakeBuildId = 'fakeBuildIdNoImage1';
		await builds.set(fakeBuildId, {
			id: fakeBuildId,
			userId: actor.userId,
			actorId: actor.id,
			versionNumber: '0.0',
			buildNumber: '0.0.1',
			tag: 'latest',
			status: 'SUCCEEDED',
			startedAt: new Date().toISOString(),
			finishedAt: new Date().toISOString(),
		});
		await updateActor(actor.id, (current) => recordTaggedBuild(current, 'latest', fakeBuildId, '0.0.1'));

		const run = await server.client.actor(actor.id).start({}, { waitForFinish: 5 });
		expect(run.status).toBe('FAILED');
		expect(run.statusMessage).toBe('Build has no image to run');
	});

	it('deletes a build for real: gone from get and list; unknown id 404s (record-not-found)', async () => {
		const actor = await server.client.actors().create({ name: 'delete-build-actor' });
		await server.client
			.actor(actor.id)
			.versions()
			.create({
				versionNumber: '0.0',
				buildTag: 'latest',
				sourceType: 'SOURCE_FILES' as never,
				sourceFiles: [],
			} as never);
		const build = await server.client.actor(actor.id).build('0.0', { waitForFinish: 5 });

		// Before the fix this DELETE was a bare 204 no-op: the build survived both `get()` and `list()`.
		await server.client.build(build.id).delete();
		expect(await server.client.build(build.id).get()).toBeUndefined();

		const list = await server.client.builds().list();
		expect(list.items.some((b) => b.id === build.id)).toBe(false);

		// apify-client-js's own `.delete()` swallows a `record-not-found` 404 to stay idempotent from the
		// caller's perspective, so hit the HTTP endpoint directly to observe the real status/envelope.
		const res = await fetch(`${server.baseUrl}/v2/actor-builds/nonexistent12345a`, {
			method: 'DELETE',
			headers: { Authorization: `Bearer ${server.token}` },
		});
		expect(res.status).toBe(404);
		const body = (await res.json()) as { error: { type: string } };
		expect(body.error.type).toBe('record-not-found');
	});

	it('deletes a run for real: gone from get and list; unknown id 404s (record-not-found)', async () => {
		const actor = await server.client.actors().create({ name: 'delete-run-actor' });
		const { builds } = getRegistries();
		const fakeBuildId = 'fakeBuildId12345d';
		await builds.set(fakeBuildId, {
			id: fakeBuildId,
			userId: actor.userId,
			actorId: actor.id,
			versionNumber: '0.0',
			buildNumber: '0.0.1',
			tag: 'latest',
			status: 'SUCCEEDED',
			startedAt: new Date().toISOString(),
			finishedAt: new Date().toISOString(),
			imageId: 'fake-image:latest',
		});
		await updateActor(actor.id, (current) => recordTaggedBuild(current, 'latest', fakeBuildId, '0.0.1'));
		// waitForFinish: deleting a *terminal* run is exactly what this test exercises; without Docker
		// the run fails fast, but the fix now rejects a DELETE while the run is still non-terminal (see
		// the dedicated "DELETE rejects a non-terminal run" test below), so this setup must wait for the
		// terminal status the same way the sibling build-delete test above already does.
		const run = await server.client.actor(actor.id).start({}, { waitForFinish: 5 });
		expect(run.status).toBe('FAILED');

		// Before the fix this DELETE was a bare 204 no-op: the run survived both `get()` and `list()`.
		await server.client.run(run.id).delete();
		expect(await server.client.run(run.id).get()).toBeUndefined();

		const list = await server.client.runs().list();
		expect(list.items.some((r) => r.id === run.id)).toBe(false);

		const res = await fetch(`${server.baseUrl}/v2/actor-runs/nonexistent123456`, {
			method: 'DELETE',
			headers: { Authorization: `Bearer ${server.token}` },
		});
		expect(res.status).toBe(404);
		const body = (await res.json()) as { error: { type: string } };
		expect(body.error.type).toBe('record-not-found');
	});

	it('deletes an Actor for real, and a missing Actor 404s on DELETE the same as on GET (record-not-found)', async () => {
		const actor = await server.client.actors().create({ name: 'delete-actor' });
		const user = await server.client.user('me').get();

		await server.client.actor(actor.id).delete();
		expect(await server.client.actor(actor.id).get()).toBeUndefined();

		const list = await server.client.actors().list();
		expect(list.items.some((a) => a.id === actor.id)).toBe(false);

		// apify-client-js's own `.delete()` swallows a `record-not-found` 404 to stay idempotent from the
		// caller's perspective, so hit the HTTP endpoint directly to observe the real status/envelope.
		for (const missingRef of ['nonexistent12345b', `${user.username}~does-not-exist`]) {
			const res = await fetch(`${server.baseUrl}/v2/actors/${missingRef}`, {
				method: 'DELETE',
				headers: { Authorization: `Bearer ${server.token}` },
			});
			expect(res.status).toBe(404);
			const body = (await res.json()) as { error: { type: string } };
			expect(body.error.type).toBe('record-not-found');
		}
	});

	it('deletes an Actor version for real, and a missing version or Actor 404s on DELETE (record-not-found)', async () => {
		const actor = await server.client.actors().create({ name: 'delete-version-actor' });
		await server.client
			.actor(actor.id)
			.versions()
			.create({
				versionNumber: '0.0',
				buildTag: 'latest',
				sourceType: 'SOURCE_FILES' as never,
				sourceFiles: [],
			} as never);

		await server.client.actor(actor.id).version('0.0').delete();
		expect(await server.client.actor(actor.id).version('0.0').get()).toBeUndefined();

		const missingVersion = await fetch(`${server.baseUrl}/v2/actors/${actor.id}/versions/9.9`, {
			method: 'DELETE',
			headers: { Authorization: `Bearer ${server.token}` },
		});
		expect(missingVersion.status).toBe(404);
		expect(((await missingVersion.json()) as { error: { type: string } }).error.type).toBe('record-not-found');

		const missingActor = await fetch(`${server.baseUrl}/v2/actors/nonexistent12345c/versions/0.0`, {
			method: 'DELETE',
			headers: { Authorization: `Bearer ${server.token}` },
		});
		expect(missingActor.status).toBe(404);
		expect(((await missingActor.json()) as { error: { type: string } }).error.type).toBe('record-not-found');
	});

	it('DELETE rejects a non-terminal build instead of deleting it (matches the real platform: reject, not abort-then-delete)', async () => {
		const actor = await server.client.actors().create({ name: 'delete-running-build-actor' });
		const { builds } = getRegistries();
		const runningBuildId = 'runningBuildId12345';
		await builds.set(runningBuildId, {
			id: runningBuildId,
			userId: actor.userId,
			actorId: actor.id,
			versionNumber: '0.0',
			buildNumber: '0.0.1',
			tag: 'latest',
			status: 'RUNNING',
			startedAt: new Date().toISOString(),
		});

		// Before the fix this DELETE unconditionally removed the record, with no remaining path to stop
		// the in-flight `docker build` (its only cancellation route, `POST .../abort`, needs the record
		// to still resolve). apify-core rejects the same request with 400/`deleting-unfinished-build`
		// (`src/packages/errors/src/errors/api.ts:217-218`) rather than deleting-then-orphaning.
		await expect(server.client.build(runningBuildId).delete()).rejects.toMatchObject({
			statusCode: 400,
			type: 'deleting-unfinished-build',
		});

		// The record must still be there afterwards - the delete was rejected, not silently ignored.
		const stillThere = await server.client.build(runningBuildId).get();
		expect(stillThere?.status).toBe('RUNNING');
	});

	it('DELETE rejects a non-terminal run instead of deleting it (matches the real platform: reject, not abort-then-delete)', async () => {
		const actor = await server.client.actors().create({ name: 'delete-running-run-actor' });
		const { runs } = getRegistries();
		const runningRunId = 'runningRunId123456';
		await runs.set(runningRunId, {
			id: runningRunId,
			userId: actor.userId,
			actorId: actor.id,
			buildId: 'fakeBuildIdxxxxxxx',
			buildNumber: '0.0.1',
			status: 'RUNNING',
			startedAt: new Date().toISOString(),
			defaultDatasetId: 'd',
			defaultKeyValueStoreId: 'k',
			defaultRequestQueueId: 'r',
			options: { memoryMbytes: 1024, timeoutSecs: 300 },
			meta: { origin: 'API' },
		});

		// Before the fix this DELETE unconditionally removed the record, permanently leaking the run's
		// Docker container (its only stop path, `POST .../abort`, needs the record to still resolve, and
		// startup reconciliation only ever looks at *existing* run records). apify-core rejects the same
		// request with 400/`cannot-remove-running-run` (`src/packages/errors/src/errors/runs.ts:10-15`)
		// rather than deleting-then-orphaning.
		await expect(server.client.run(runningRunId).delete()).rejects.toMatchObject({
			statusCode: 400,
			type: 'cannot-remove-running-run',
		});

		const stillThere = await server.client.run(runningRunId).get();
		expect(stillThere?.status).toBe('RUNNING');
	});

	it('abort is a no-op on an already-terminal build/run', async () => {
		const actor = await server.client.actors().create({ name: 'abort-actor' });
		await server.client
			.actor(actor.id)
			.versions()
			.create({
				versionNumber: '0.0',
				buildTag: 'latest',
				sourceType: 'SOURCE_FILES' as never,
				sourceFiles: [],
			} as never);
		const build = await server.client.actor(actor.id).build('0.0', { waitForFinish: 5 });
		const aborted = await server.client.build(build.id).abort();
		expect(aborted.status).toBe('FAILED');
	});

	it('two concurrent updates to the same Actor record both survive (no lost update)', async () => {
		const actor = await server.client.actors().create({ name: 'concurrent-actor', title: 'original title' });
		const actorClient = server.client.actor(actor.id);

		// Each request only sets one field, leaving the other to be carried over from `current` inside
		// the read-modify-write. Without `KeyedMutex` serialising the whole get->merge->set, one of the
		// two concurrent updates could read a stale `current` (from before the other's write landed) and
		// clobber it on write - a classic lost update.
		await Promise.all([actorClient.update({ name: 'renamed-actor' }), actorClient.update({ title: 'new title' })]);

		const updated = await actorClient.get();
		expect(updated?.name).toBe('renamed-actor');
		expect(updated?.title).toBe('new title');
	});

	it('interleaved concurrent updates to one record preserve every writer, none lost', async () => {
		// A stronger version of the above: five concurrent updates, each appending to a running counter
		// field rather than overwriting a fixed value, so a lost update would show up as a wrong count
		// rather than being masked by two updates coincidentally agreeing on the final value.
		const actor = await server.client.actors().create({ name: 'counter-actor' });
		const { getRegistries } = await import('../../src/storage/registries.js');
		const { updateActor } = await import('../../src/services/actors.js');

		const writers = Array.from({ length: 5 }, (_, i) =>
			updateActor(actor.id, (current) => ({
				...current,
				title: `${current.title ?? ''}${i}`,
			})),
		);
		await Promise.all(writers);

		const final = await getRegistries().actors.get(actor.id);
		expect(final?.title).toHaveLength(5);
		expect(new Set(final?.title?.split(''))).toEqual(new Set(['0', '1', '2', '3', '4']));
	});

	it('actor-scoped GET .../builds is filtered by userId, not just actorId (regression: a foreign-user build with the same actorId must not leak)', async () => {
		const actor = await server.client.actors().create({ name: 'ownership-builds-actor' });
		const { builds } = getRegistries();

		const ownBuildId = 'ownedBuildId1234a';
		await builds.set(ownBuildId, {
			id: ownBuildId,
			userId: actor.userId,
			actorId: actor.id,
			versionNumber: '0.0',
			buildNumber: '0.0.1',
			tag: 'latest',
			status: 'SUCCEEDED',
			startedAt: new Date().toISOString(),
			finishedAt: new Date().toISOString(),
		});

		// Seeded directly via the registry (bypassing the API, which could never produce this), the same
		// way `services/builds.ts`'s own `actorId` is set - a record for the SAME `actorId` but a
		// DIFFERENT `userId`. `routes/actors.ts` used to filter builds by `actorId` alone (reaching past
		// the ownership-filtered service straight into the registry), which would leak this record.
		const foreignBuildId = 'foreignBuildId1234';
		await builds.set(foreignBuildId, {
			id: foreignBuildId,
			userId: 'someone-elses-user-id',
			actorId: actor.id,
			versionNumber: '0.0',
			buildNumber: '0.0.2',
			tag: 'latest',
			status: 'SUCCEEDED',
			startedAt: new Date().toISOString(),
			finishedAt: new Date().toISOString(),
		});

		const list = await server.client.actor(actor.id).builds().list();
		const ids = list.items.map((b) => b.id);
		expect(ids).toContain(ownBuildId);
		expect(ids).not.toContain(foreignBuildId);
	});

	it('actor-scoped GET .../runs is filtered by userId, not just actorId (regression: a foreign-user run with the same actorId must not leak)', async () => {
		const actor = await server.client.actors().create({ name: 'ownership-runs-actor' });
		const { runs } = getRegistries();

		const bareRun = (id: string, userId: string) => ({
			id,
			userId,
			actorId: actor.id,
			buildId: 'fakeBuildIdxxxxxxx',
			buildNumber: '0.0.1',
			status: 'SUCCEEDED' as const,
			startedAt: new Date().toISOString(),
			finishedAt: new Date().toISOString(),
			defaultDatasetId: 'd',
			defaultKeyValueStoreId: 'k',
			defaultRequestQueueId: 'r',
			options: { memoryMbytes: 1024, timeoutSecs: 300 },
			meta: { origin: 'API' },
		});

		const ownRunId = 'ownedRunId12345678';
		const foreignRunId = 'foreignRunId123456';
		await runs.set(ownRunId, bareRun(ownRunId, actor.userId));
		await runs.set(foreignRunId, bareRun(foreignRunId, 'someone-elses-user-id'));

		const list = await server.client.actor(actor.id).runs().list();
		const ids = list.items.map((r) => r.id);
		expect(ids).toContain(ownRunId);
		expect(ids).not.toContain(foreignRunId);
	});

	it('GET /actor-builds honours limit + offset + desc together, end to end via apify-client (regression: these were previously ignored)', async () => {
		const actor = await server.client.actors().create({ name: 'pagination-builds-actor' });
		const { builds } = getRegistries();

		const seeded = [0, 1, 2, 3, 4].map((i) => ({
			id: `paginationBuild0${i}1234`,
			userId: actor.userId,
			actorId: actor.id,
			versionNumber: '0.0',
			buildNumber: `0.0.${i + 1}`,
			tag: 'latest',
			status: 'SUCCEEDED' as const,
			startedAt: new Date(2024, 0, i + 1).toISOString(),
			finishedAt: new Date(2024, 0, i + 1).toISOString(),
		}));
		for (const build of seeded) await builds.set(build.id, build);

		const page = await server.client.builds().list({ limit: 2, offset: 1, desc: true });

		// Natural (ascending startedAt) order is build 0..4; `desc` reverses it to 4..0; `offset: 1,
		// limit: 2` then slices to builds 3 and 2, in that order.
		expect(page.items.map((b) => b.id)).toEqual([seeded[3]!.id, seeded[2]!.id]);
		expect(page.count).toBe(2);
		expect(page.offset).toBe(1);
		expect(page.limit).toBe(2);
		expect(page.desc).toBe(true);
		expect(page.total).toBeGreaterThanOrEqual(seeded.length);
	});
});

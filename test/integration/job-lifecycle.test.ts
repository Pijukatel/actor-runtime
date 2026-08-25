/**
 * Regression tests for the build/run job-lifecycle state machine (`services/job-status.ts`,
 * `services/builds.ts`, `services/runs.ts`), covering:
 *  1. `TIMED-OUT` is produced (not `FAILED`) when the driver itself stopped a build/run for exceeding
 *     its timeout, distinct from a normal non-zero exit or build failure.
 *  2. Aborting a build genuinely interrupts it (the driver is asked to cancel, not just flagged), and an
 *     eventual completion write that races in after the abort can never overwrite the terminal `ABORTED`
 *     status - whichever write reaches the record first, the other is refused.
 *  3. Aborting a run is race-proof against the run's own completion handler the same way, including the
 *     pre-start ("abort during READY", before any container/build is ever created) window, and
 *     terminal-status immutability more generally (an already-terminal record refuses every further
 *     transition).
 *
 * All three are exercised with stub drivers (`test-server.ts`'s `fixed*`/`deferred*` factories), never
 * against a real Docker daemon (there is none in this sandbox - see `docker-driver.ts`'s doc comment).
 * `runInBackground`/`runBuildInBackground` are called directly (they are exported from their service
 * modules for exactly this purpose) so each scenario is driven deterministically via explicit awaits on
 * controllable promises, instead of racing real timers/timeouts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
	deferredBuildDriver,
	deferredRunDriver,
	fixedBuildOutcomeDriver,
	fixedRunOutcomeDriver,
	startTestServer,
	type TestServerHandle,
} from './helpers/test-server.js';
import { getRegistries } from '../../src/storage/registries.js';
import { generateId } from '../../src/storage/ids.js';
import { recordTaggedBuild, updateActor } from '../../src/services/actors.js';
import { abortBuild, runBuildInBackground, startBuild } from '../../src/services/builds.js';
import {
	abortRun,
	reconcileOrphanedJobs,
	runInBackground,
	startRun,
	waitForRunFinish,
} from '../../src/services/runs.js';
import { DriverTimedOutError, type Driver } from '../../src/driver/types.js';
import type {
	ActorRecord,
	ActorVersionRecord,
	BuildRecord,
	RunRecord,
	SourceFile,
} from '../../src/storage/entities.js';
import { DEFAULT_DOCKERFILE_CONTENT, DEFAULT_DOCKERFILE_NAME } from '../../src/services/default-dockerfile.js';

/** Creates an Actor via the real client (so it has a genuine owner) and returns the underlying
 * `ActorRecord` for direct service-layer calls. */
async function seedActor(server: TestServerHandle, name: string): Promise<ActorRecord> {
	const created = await server.client.actors().create({ name });
	return (await getRegistries().actors.get(created.id))!;
}

/** A SUCCEEDED build with a fake image, seeded directly (bypassing the driver) - mirrors the pattern
 * already used by `actors-builds-runs.test.ts`. */
async function seedSucceededBuild(actor: ActorRecord): Promise<BuildRecord> {
	const build: BuildRecord = {
		id: generateId(),
		userId: actor.userId,
		actorId: actor.id,
		versionNumber: '0.0',
		buildNumber: '0.0.1',
		tag: 'latest',
		status: 'SUCCEEDED',
		startedAt: new Date().toISOString(),
		finishedAt: new Date().toISOString(),
		imageId: 'fake-image:latest',
	};
	await getRegistries().builds.set(build.id, build);
	return build;
}

function bareRunRecord(actor: ActorRecord, build: BuildRecord): RunRecord {
	return {
		id: generateId(),
		userId: actor.userId,
		actorId: actor.id,
		buildId: build.id,
		buildNumber: build.buildNumber,
		status: 'READY',
		startedAt: new Date().toISOString(),
		defaultDatasetId: 'd',
		defaultKeyValueStoreId: 'k',
		defaultRequestQueueId: 'r',
		options: { memoryMbytes: 1024, timeoutSecs: 300 },
		meta: { origin: 'API' },
	};
}

const VERSION: ActorVersionRecord = {
	versionNumber: '0.0',
	buildTag: 'latest',
	sourceType: 'SOURCE_FILES',
	sourceFiles: [],
};

/** Fails the test immediately (rather than hanging) if the driver is ever asked to start a run/build -
 * used to assert the pre-start abort window really does prevent a container/build from ever starting. */
function neverStartDriver(): Driver & { abortRunCalls: string[]; abortBuildCalls: string[] } {
	const abortRunCalls: string[] = [];
	const abortBuildCalls: string[] = [];
	return {
		available: true,
		abortRunCalls,
		abortBuildCalls,
		async init() {},
		async startBuild() {
			throw new Error('startBuild must never be called once the record is already ABORTING');
		},
		async abortBuild(buildId) {
			abortBuildCalls.push(buildId);
		},
		async startRun() {
			throw new Error('startRun must never be called once the record is already ABORTING');
		},
		async abortRun(runId) {
			abortRunCalls.push(runId);
		},
		async reconcileOrphans() {},
		async probeDevFolder() {
			throw new Error('not used by this stub');
		},
		async ensureProbeImage() {
			throw new Error('not used by this stub');
		},
	};
}

describe('job lifecycle: TIMED-OUT mapping and abort/completion race guards', () => {
	let server: TestServerHandle;

	afterEach(async () => {
		await server.close();
	});

	describe('finding 1: TIMED-OUT is produced instead of FAILED', () => {
		it('a run the driver stopped for exceeding timeoutSecs ends TIMED-OUT, not FAILED', async () => {
			server = await startTestServer(fixedRunOutcomeDriver({ exitCode: 137, timedOut: true }));
			const actor = await seedActor(server, 'timeout-run-actor');
			const build = await seedSucceededBuild(actor);
			await updateActor(actor.id, (current) => recordTaggedBuild(current, 'latest', build.id, build.buildNumber));

			const run = await server.client.actor(actor.id).start({}, { waitForFinish: 5 });
			expect(run.status).toBe('TIMED-OUT');
		});

		it('a normal non-zero exit (not driver-timed-out) still ends FAILED', async () => {
			server = await startTestServer(fixedRunOutcomeDriver({ exitCode: 1, timedOut: false }));
			const actor = await seedActor(server, 'fail-run-actor');
			const build = await seedSucceededBuild(actor);
			await updateActor(actor.id, (current) => recordTaggedBuild(current, 'latest', build.id, build.buildNumber));

			const run = await server.client.actor(actor.id).start({}, { waitForFinish: 5 });
			expect(run.status).toBe('FAILED');
		});

		it('a zero exit still ends SUCCEEDED', async () => {
			server = await startTestServer(fixedRunOutcomeDriver({ exitCode: 0, timedOut: false }));
			const actor = await seedActor(server, 'succeed-run-actor');
			const build = await seedSucceededBuild(actor);
			await updateActor(actor.id, (current) => recordTaggedBuild(current, 'latest', build.id, build.buildNumber));

			const run = await server.client.actor(actor.id).start({}, { waitForFinish: 5 });
			expect(run.status).toBe('SUCCEEDED');
		});

		it('a build the driver stopped for exceeding its timeout ends TIMED-OUT, not FAILED', async () => {
			server = await startTestServer(
				fixedBuildOutcomeDriver({ imageId: 'x' }, new DriverTimedOutError('Build exceeded its 1800s timeout')),
			);
			const actor = await seedActor(server, 'timeout-build-actor');
			await server.client
				.actor(actor.id)
				.versions()
				.create({ ...VERSION } as never);

			const build = await server.client.actor(actor.id).build('0.0', { waitForFinish: 5 });
			expect(build.status).toBe('TIMED-OUT');
			expect(build.statusMessage).toMatch(/timeout/i);
		});
	});

	describe('finding 2: build abort is genuine and terminal-respecting', () => {
		it('abort mid-build: ABORTED sticks even after the (uncancelled) build later "succeeds" - the late write is a no-op, and taggedBuilds is not clobbered', async () => {
			const driver = deferredBuildDriver();
			server = await startTestServer(driver);
			const actor = await seedActor(server, 'abort-build-actor');

			// Seed a previously-good tagged build so we can assert it survives the aborted build's late
			// "success" untouched - this is the exact clobbering scenario the tag-recording guard fixes.
			await updateActor(actor.id, (current) =>
				recordTaggedBuild(current, 'latest', 'previous-build-id', '0.0.1'),
			);

			const record: BuildRecord = {
				id: generateId(),
				userId: actor.userId,
				actorId: actor.id,
				versionNumber: '0.0',
				buildNumber: '0.0.1',
				tag: 'latest',
				status: 'READY',
				startedAt: new Date().toISOString(),
			};
			await getRegistries().builds.set(record.id, record);

			const bg = runBuildInBackground(driver, actor, VERSION, record, { tag: 'latest', useCache: true });
			await driver.started;
			expect(driver.startBuildCalls).toEqual([record.id]);

			const aborted = await abortBuild(driver, record);
			expect(aborted?.status).toBe('ABORTED');
			// Finding 2a: the driver was genuinely asked to interrupt the build (not a no-op flag).
			expect(driver.abortBuildCalls).toEqual([record.id]);

			// The stub can't actually cut the HTTP request to a real daemon, so simulate the worst case:
			// the (in reality now-aborted) build "finishes" successfully anyway.
			driver.resolveBuild({ imageId: 'late-image:latest' });
			await bg; // let the background handler's now-guarded completion write run to completion

			const final = await getRegistries().builds.get(record.id);
			expect(final?.status).toBe('ABORTED');
			expect(final?.imageId).toBeUndefined();

			// The aborted build's late "success" must not overwrite the actor's taggedBuilds entry - only
			// a write that actually landed as SUCCEEDED is allowed to record itself against the tag.
			const finalActor = await getRegistries().actors.get(actor.id);
			expect(finalActor?.taggedBuilds.latest).toEqual({ buildId: 'previous-build-id', buildNumber: '0.0.1' });
		});

		it('a normal (non-aborted) successful build does record itself against the tag', async () => {
			const driver = deferredBuildDriver();
			server = await startTestServer(driver);
			const actor = await seedActor(server, 'succeed-build-tag-actor');

			const record: BuildRecord = {
				id: generateId(),
				userId: actor.userId,
				actorId: actor.id,
				versionNumber: '0.0',
				buildNumber: '0.0.1',
				tag: 'latest',
				status: 'READY',
				startedAt: new Date().toISOString(),
			};
			await getRegistries().builds.set(record.id, record);

			const bg = runBuildInBackground(driver, actor, VERSION, record, { tag: 'latest', useCache: true });
			await driver.started;
			driver.resolveBuild({ imageId: 'good-image:latest' });
			await bg;

			const final = await getRegistries().builds.get(record.id);
			expect(final?.status).toBe('SUCCEEDED');

			const finalActor = await getRegistries().actors.get(actor.id);
			expect(finalActor?.taggedBuilds.latest).toEqual({ buildId: record.id, buildNumber: record.buildNumber });
		});

		it('abort during READY (before the build is ever started): startBuild is never called, final status ABORTED', async () => {
			const driver = neverStartDriver();
			server = await startTestServer(driver);
			const actor = await seedActor(server, 'preflight-abort-build-actor');

			const record: BuildRecord = {
				id: generateId(),
				userId: actor.userId,
				actorId: actor.id,
				versionNumber: '0.0',
				buildNumber: '0.0.1',
				tag: 'latest',
				status: 'ABORTING', // simulates abortRun() having already landed during the READY window
				startedAt: new Date().toISOString(),
			};
			await getRegistries().builds.set(record.id, record);

			await runBuildInBackground(driver, actor, VERSION, record, { tag: 'latest', useCache: true });

			const final = await getRegistries().builds.get(record.id);
			expect(final?.status).toBe('ABORTED');
			expect(driver.abortBuildCalls).toEqual([record.id]);
		});

		it('record already ABORTED (not just ABORTING) before runBuildInBackground even starts: bare-return, no driver call, no further write', async () => {
			// Reachable because abortBuild's two-write ABORTING -> ABORTED sequence can complete before
			// this function's own RUNNING transition attempt ever runs - there is no ordering guarantee
			// between the two (see the comment on the guard this exercises, `builds.ts`'s first `if` in
			// `runBuildInBackground`).
			const driver = neverStartDriver();
			server = await startTestServer(driver);
			const actor = await seedActor(server, 'already-aborted-build-actor');

			const record: BuildRecord = {
				id: generateId(),
				userId: actor.userId,
				actorId: actor.id,
				versionNumber: '0.0',
				buildNumber: '0.0.1',
				tag: 'latest',
				status: 'ABORTED',
				startedAt: new Date().toISOString(),
				finishedAt: new Date().toISOString(),
			};
			await getRegistries().builds.set(record.id, record);

			await runBuildInBackground(driver, actor, VERSION, record, { tag: 'latest', useCache: true });

			const final = await getRegistries().builds.get(record.id);
			expect(final?.status).toBe('ABORTED');
			// The bare-return arm: since the record is already ABORTED (not ABORTING), there is nothing
			// left to finalise - no defensive driver.abortBuild call, no further status write. (`startBuild`
			// is never called either - if it were, `neverStartDriver` would have thrown and failed the test.)
			expect(driver.abortBuildCalls).toEqual([]);
		});

		it('abort is a no-op on an already-terminal build (regression: still true after the rewrite)', async () => {
			server = await startTestServer(fixedBuildOutcomeDriver({ imageId: 'x' }));
			const actor = await seedActor(server, 'terminal-abort-build-actor');
			const build = await seedSucceededBuild(actor);

			const aborted = await abortBuild(server.driver, build);
			expect(aborted?.status).toBe('SUCCEEDED');
		});
	});

	describe("Dockerfile resolution wiring: runBuildInBackground acts on resolveDockerfileLocation's outcome", () => {
		it('a "failure" outcome marks the build FAILED with the resolver\'s message as statusMessage, and never calls driver.startBuild', async () => {
			const driver = neverStartDriver();
			server = await startTestServer(driver);
			const actor = await seedActor(server, 'dockerfile-failure-actor');

			// A "dockerfile" field that escapes the Actor root - resolveDockerfileLocation returns a
			// `failure` outcome before any candidate is even looked up in sourceFiles.
			const escapingSourceFiles: SourceFile[] = [
				{
					name: '.actor/actor.json',
					format: 'TEXT',
					content: JSON.stringify({ dockerfile: '../../evil/Dockerfile' }),
				},
			];
			const version: ActorVersionRecord = { ...VERSION, sourceFiles: escapingSourceFiles };

			const record: BuildRecord = {
				id: generateId(),
				userId: actor.userId,
				actorId: actor.id,
				versionNumber: '0.0',
				buildNumber: '0.0.1',
				tag: 'latest',
				status: 'READY',
				startedAt: new Date().toISOString(),
			};
			await getRegistries().builds.set(record.id, record);

			await runBuildInBackground(driver, actor, version, record, { tag: 'latest', useCache: true });

			const final = await getRegistries().builds.get(record.id);
			expect(final?.status).toBe('FAILED');
			expect(final?.statusMessage).toBe(
				'Dockerfile path "../../evil/Dockerfile" in .actor/actor.json points outside the Actor root directory.',
			);
			// `startBuild` is never called either - if it were, `neverStartDriver` would have thrown and
			// failed the test.
		});

		it('a "default" outcome appends the bundled default Dockerfile to the driver\'s ctx.sourceFiles and sets ctx.dockerfilePath to "Dockerfile"', async () => {
			const driver = fixedBuildOutcomeDriver({ imageId: 'x' });
			server = await startTestServer(driver);
			const actor = await seedActor(server, 'dockerfile-default-actor');

			// No actor.json, and no Dockerfile anywhere in sourceFiles - resolveDockerfileLocation falls
			// all the way through to the bundled default.
			const noDockerfileSourceFiles: SourceFile[] = [
				{ name: 'main.js', format: 'TEXT', content: 'console.log(1);\n' },
			];
			const version: ActorVersionRecord = { ...VERSION, sourceFiles: noDockerfileSourceFiles };

			const record: BuildRecord = {
				id: generateId(),
				userId: actor.userId,
				actorId: actor.id,
				versionNumber: '0.0',
				buildNumber: '0.0.1',
				tag: 'latest',
				status: 'READY',
				startedAt: new Date().toISOString(),
			};
			await getRegistries().builds.set(record.id, record);

			await runBuildInBackground(driver, actor, version, record, { tag: 'latest', useCache: true });

			expect(driver.startBuildContexts).toHaveLength(1);
			const ctx = driver.startBuildContexts[0]!;
			expect(ctx.dockerfilePath).toBe('Dockerfile');
			expect(ctx.dockerfilePath).toBe(DEFAULT_DOCKERFILE_NAME);
			// The extra, injected Dockerfile SourceFile actually reaches the driver's ctx, alongside the
			// original sourceFiles - never in place of them.
			expect(ctx.sourceFiles).toEqual([
				...noDockerfileSourceFiles,
				{ name: 'Dockerfile', format: 'TEXT', content: DEFAULT_DOCKERFILE_CONTENT },
			]);
			// Never written back to the version's own persisted sourceFiles - only this one build's ctx
			// gets the extra entry.
			expect(version.sourceFiles).toEqual(noDockerfileSourceFiles);

			const final = await getRegistries().builds.get(record.id);
			expect(final?.status).toBe('SUCCEEDED');
		});

		it('a "resolved" outcome passes the resolved path through to ctx.dockerfilePath, with sourceFiles unchanged', async () => {
			const driver = fixedBuildOutcomeDriver({ imageId: 'x' });
			server = await startTestServer(driver);
			const actor = await seedActor(server, 'dockerfile-resolved-actor');

			// No actor.json "dockerfile" field, but a .actor/Dockerfile exists - candidate 2 resolves.
			const resolvedSourceFiles: SourceFile[] = [
				{ name: '.actor/Dockerfile', format: 'TEXT', content: 'FROM node:20\n' },
				{ name: 'main.js', format: 'TEXT', content: 'console.log(1);\n' },
			];
			const version: ActorVersionRecord = { ...VERSION, sourceFiles: resolvedSourceFiles };

			const record: BuildRecord = {
				id: generateId(),
				userId: actor.userId,
				actorId: actor.id,
				versionNumber: '0.0',
				buildNumber: '0.0.1',
				tag: 'latest',
				status: 'READY',
				startedAt: new Date().toISOString(),
			};
			await getRegistries().builds.set(record.id, record);

			await runBuildInBackground(driver, actor, version, record, { tag: 'latest', useCache: true });

			expect(driver.startBuildContexts).toHaveLength(1);
			const ctx = driver.startBuildContexts[0]!;
			expect(ctx.dockerfilePath).toBe('.actor/Dockerfile');
			expect(ctx.sourceFiles).toEqual(resolvedSourceFiles);

			const final = await getRegistries().builds.get(record.id);
			expect(final?.status).toBe('SUCCEEDED');
		});
	});

	describe('imageWorkingDirectory is build-specific, not Actor-specific (human directive: "the workdir should be build specific, not actor specific")', () => {
		it('a successful build outcome carrying imageWorkingDirectory lands it on that BUILD record, and the Actor record has no such field at all', async () => {
			const driver = fixedBuildOutcomeDriver({ imageId: 'x', imageWorkingDirectory: '/usr/src/app' });
			server = await startTestServer(driver);
			const actor = await seedActor(server, 'dev-folder-capture-actor');

			const record: BuildRecord = {
				id: generateId(),
				userId: actor.userId,
				actorId: actor.id,
				versionNumber: '0.0',
				buildNumber: '0.0.1',
				tag: 'latest',
				status: 'READY',
				startedAt: new Date().toISOString(),
			};
			await getRegistries().builds.set(record.id, record);

			await runBuildInBackground(driver, actor, VERSION, record, { tag: 'latest', useCache: true });

			// The working directory lands on the build record itself...
			const final = await getRegistries().builds.get(record.id);
			expect(final?.status).toBe('SUCCEEDED');
			expect(final?.imageWorkingDirectory).toBe('/usr/src/app');

			// ...the tag still moves in the same background handler...
			const finalActor = await getRegistries().actors.get(actor.id);
			expect(finalActor?.taggedBuilds.latest).toEqual({ buildId: record.id, buildNumber: record.buildNumber });
			// ...but the Actor record itself never carries this field - there is exactly one source of
			// truth, on the build, not two that could disagree.
			expect(finalActor).not.toHaveProperty('imageWorkingDirectory');
		});

		it("a successful build outcome with no imageWorkingDirectory leaves that field absent on this build, and never touches any other build's value", async () => {
			const driver = fixedBuildOutcomeDriver({ imageId: 'y' });
			server = await startTestServer(driver);
			const actor = await seedActor(server, 'dev-folder-preserve-actor');

			// An earlier, already-`SUCCEEDED` build with its own known-good working directory - this new
			// build's outcome (no `imageWorkingDirectory` at all - e.g. its inspect failed or came up
			// empty/`/`) must not touch that earlier build's own record.
			const earlierBuild: BuildRecord = {
				id: generateId(),
				userId: actor.userId,
				actorId: actor.id,
				versionNumber: '0.0',
				buildNumber: '0.0.1',
				tag: 'latest',
				status: 'SUCCEEDED',
				startedAt: new Date().toISOString(),
				finishedAt: new Date().toISOString(),
				imageId: 'earlier-image',
				imageWorkingDirectory: '/usr/src/app',
			};
			await getRegistries().builds.set(earlierBuild.id, earlierBuild);
			await updateActor(actor.id, (current) =>
				recordTaggedBuild(current, 'latest', earlierBuild.id, earlierBuild.buildNumber),
			);

			const record: BuildRecord = {
				id: generateId(),
				userId: actor.userId,
				actorId: actor.id,
				versionNumber: '0.0',
				buildNumber: '0.0.2',
				tag: 'latest',
				status: 'READY',
				startedAt: new Date().toISOString(),
			};
			await getRegistries().builds.set(record.id, record);

			await runBuildInBackground(driver, actor, VERSION, record, { tag: 'latest', useCache: true });

			// The tag now points at the new build...
			const final = await getRegistries().builds.get(record.id);
			expect(final?.status).toBe('SUCCEEDED');
			expect(final).not.toHaveProperty('imageWorkingDirectory');
			const finalActor = await getRegistries().actors.get(actor.id);
			expect(finalActor?.taggedBuilds.latest).toEqual({ buildId: record.id, buildNumber: record.buildNumber });
			// ...but the earlier build's own record is untouched - build-specific storage means one
			// build's missing value can never be confused with, or clobber, another build's known value.
			const earlierAfter = await getRegistries().builds.get(earlierBuild.id);
			expect(earlierAfter?.imageWorkingDirectory).toBe('/usr/src/app');
		});

		it("a differently-tagged build's more recently captured working directory never affects the latest-tagged build's own value (the cross-tag staleness this fix closes)", async () => {
			const driver = fixedBuildOutcomeDriver({ imageId: 'staging-image', imageWorkingDirectory: '/app' });
			server = await startTestServer(driver);
			const actor = await seedActor(server, 'cross-tag-staleness-actor');

			// `latest` was built first, with its own working directory.
			const latestBuild: BuildRecord = {
				id: generateId(),
				userId: actor.userId,
				actorId: actor.id,
				versionNumber: '0.0',
				buildNumber: '0.0.1',
				tag: 'latest',
				status: 'SUCCEEDED',
				startedAt: new Date().toISOString(),
				finishedAt: new Date().toISOString(),
				imageId: 'latest-image',
				imageWorkingDirectory: '/usr/src/app',
			};
			await getRegistries().builds.set(latestBuild.id, latestBuild);
			await updateActor(actor.id, (current) =>
				recordTaggedBuild(current, 'latest', latestBuild.id, latestBuild.buildNumber),
			);

			// A `staging` build runs afterward, with a different working directory.
			const stagingRecord: BuildRecord = {
				id: generateId(),
				userId: actor.userId,
				actorId: actor.id,
				versionNumber: '0.0',
				buildNumber: '0.0.2',
				tag: 'staging',
				status: 'READY',
				startedAt: new Date().toISOString(),
			};
			await getRegistries().builds.set(stagingRecord.id, stagingRecord);
			await runBuildInBackground(driver, actor, VERSION, stagingRecord, { tag: 'staging', useCache: true });

			// `staging`'s own build record got its own working directory...
			const stagingFinal = await getRegistries().builds.get(stagingRecord.id);
			expect(stagingFinal?.imageWorkingDirectory).toBe('/app');
			// ...but `latest`'s own build record - the one a tag-less run would actually resolve and mount
			// against - is completely unaffected, exactly as if the `staging` build had never happened.
			const latestAfter = await getRegistries().builds.get(latestBuild.id);
			expect(latestAfter?.imageWorkingDirectory).toBe('/usr/src/app');
		});
	});

	describe('finding 3: run abort is race-proof end to end', () => {
		it('abort while running: ABORTED sticks despite the completion write racing in after', async () => {
			const driver = deferredRunDriver();
			server = await startTestServer(driver);
			const actor = await seedActor(server, 'abort-run-actor');
			const build = await seedSucceededBuild(actor);
			const record = bareRunRecord(actor, build);
			await getRegistries().runs.set(record.id, record);

			const bg = runInBackground(driver, actor, record, { apiBaseUrl: server.baseUrl, token: server.token });
			await driver.started;
			expect(driver.startRunCalls).toEqual([record.id]);

			const aborted = await abortRun(driver, record);
			expect(aborted?.status).toBe('ABORTED');
			expect(driver.abortRunCalls).toEqual([record.id]);

			// container.wait() resolving after container.stop() - the exact race from the review's finding 3.
			driver.resolveRun({ exitCode: 137, timedOut: false });
			await bg;

			const final = await getRegistries().runs.get(record.id);
			expect(final?.status).toBe('ABORTED');
			expect(final?.exitCode).toBeUndefined();
		});

		it('abort while running with a would-be-successful exit still stays ABORTED, not SUCCEEDED', async () => {
			const driver = deferredRunDriver();
			server = await startTestServer(driver);
			const actor = await seedActor(server, 'abort-run-success-race-actor');
			const build = await seedSucceededBuild(actor);
			const record = bareRunRecord(actor, build);
			await getRegistries().runs.set(record.id, record);

			const bg = runInBackground(driver, actor, record, { apiBaseUrl: server.baseUrl, token: server.token });
			await driver.started;

			const aborted = await abortRun(driver, record);
			expect(aborted?.status).toBe('ABORTED');

			driver.resolveRun({ exitCode: 0, timedOut: false });
			await bg;

			const final = await getRegistries().runs.get(record.id);
			expect(final?.status).toBe('ABORTED');
		});

		it('abort during READY (before the container is ever created): startRun is never called, final status ABORTED', async () => {
			const driver = neverStartDriver();
			server = await startTestServer(driver);
			const actor = await seedActor(server, 'preflight-abort-run-actor');
			const build = await seedSucceededBuild(actor);
			const record: RunRecord = { ...bareRunRecord(actor, build), status: 'ABORTING' };
			await getRegistries().runs.set(record.id, record);

			await runInBackground(driver, actor, record, { apiBaseUrl: server.baseUrl, token: server.token });

			const final = await getRegistries().runs.get(record.id);
			expect(final?.status).toBe('ABORTED');
			expect(driver.abortRunCalls).toEqual([record.id]);
		});

		it('record already ABORTED (not just ABORTING) before runInBackground even starts: bare-return, no driver call, no further write', async () => {
			// Reachable because abortRun's two-write ABORTING -> ABORTED sequence can complete before this
			// function's own RUNNING transition attempt ever runs - there is no ordering guarantee between
			// the two (see the comment on the guard this exercises, `runs.ts`'s first `if` in
			// `runInBackground`).
			const driver = neverStartDriver();
			server = await startTestServer(driver);
			const actor = await seedActor(server, 'already-aborted-run-actor');
			const build = await seedSucceededBuild(actor);
			const record: RunRecord = {
				...bareRunRecord(actor, build),
				status: 'ABORTED',
				finishedAt: new Date().toISOString(),
			};
			await getRegistries().runs.set(record.id, record);

			await runInBackground(driver, actor, record, { apiBaseUrl: server.baseUrl, token: server.token });

			const final = await getRegistries().runs.get(record.id);
			expect(final?.status).toBe('ABORTED');
			// The bare-return arm: since the record is already ABORTED (not ABORTING), there is nothing
			// left to finalise - no defensive driver.abortRun call, no further status write. (`startRun` is
			// never called either - if it were, `neverStartDriver` would have thrown and failed the test.)
			expect(driver.abortRunCalls).toEqual([]);
		});

		it('a normal completion (no abort involved) is unaffected by the guard', async () => {
			const driver = fixedRunOutcomeDriver({ exitCode: 0, timedOut: false });
			server = await startTestServer(driver);
			const actor = await seedActor(server, 'plain-run-actor');
			const build = await seedSucceededBuild(actor);
			const record = bareRunRecord(actor, build);
			await getRegistries().runs.set(record.id, record);

			await runInBackground(driver, actor, record, { apiBaseUrl: server.baseUrl, token: server.token });

			const final = await getRegistries().runs.get(record.id);
			expect(final?.status).toBe('SUCCEEDED');
			expect(final?.exitCode).toBe(0);
		});
	});
});

describe('reconcileOrphanedJobs (startup reconciliation)', () => {
	let server: TestServerHandle;

	afterEach(async () => {
		await server.close();
	});

	/** A driver whose `reconcileOrphans` records every call (the run ids it was given, and a snapshot of
	 * the given records' current statuses read at call time) without doing anything else - lets a test
	 * assert both "called with exactly these ids" and "called before the records were finalised". */
	function recordingReconcileDriver(): Driver & {
		reconcileOrphansCalls: string[][];
		statusesAtCallTime: Array<Record<string, string | undefined>>;
	} {
		const reconcileOrphansCalls: string[][] = [];
		const statusesAtCallTime: Array<Record<string, string | undefined>> = [];
		return {
			available: true,
			reconcileOrphansCalls,
			statusesAtCallTime,
			async init() {},
			async startBuild() {
				throw new Error('not used by this stub');
			},
			async abortBuild() {},
			async startRun() {
				throw new Error('not used by this stub');
			},
			async abortRun() {},
			async reconcileOrphans(runIds) {
				reconcileOrphansCalls.push(runIds);
				const snapshot: Record<string, string | undefined> = {};
				for (const id of runIds) {
					snapshot[id] = (await getRegistries().runs.get(id))?.status;
				}
				statusesAtCallTime.push(snapshot);
			},
			async probeDevFolder() {
				throw new Error('not used by this stub');
			},
			async ensureProbeImage() {
				throw new Error('not used by this stub');
			},
		};
	}

	it('finalizes non-terminal runs and builds as ABORTED with a statusMessage, calls driver.reconcileOrphans with exactly the orphaned run ids before finalizing, and leaves terminal jobs untouched', async () => {
		const driver = recordingReconcileDriver();
		server = await startTestServer(driver);
		const actor = await seedActor(server, 'reconcile-actor');

		const nonTerminalRun: RunRecord = {
			...bareRunRecord(actor, await seedSucceededBuild(actor)),
			status: 'RUNNING',
		};
		const terminalRun: RunRecord = {
			...bareRunRecord(actor, await seedSucceededBuild(actor)),
			status: 'SUCCEEDED',
			finishedAt: new Date().toISOString(),
			exitCode: 0,
		};
		await getRegistries().runs.set(nonTerminalRun.id, nonTerminalRun);
		await getRegistries().runs.set(terminalRun.id, terminalRun);

		const nonTerminalBuild: BuildRecord = {
			id: generateId(),
			userId: actor.userId,
			actorId: actor.id,
			versionNumber: '0.0',
			buildNumber: '0.0.1',
			tag: 'latest',
			status: 'READY',
			startedAt: new Date().toISOString(),
		};
		const terminalBuild: BuildRecord = {
			id: generateId(),
			userId: actor.userId,
			actorId: actor.id,
			versionNumber: '0.0',
			buildNumber: '0.0.2',
			tag: 'latest',
			status: 'SUCCEEDED',
			startedAt: new Date().toISOString(),
			finishedAt: new Date().toISOString(),
			imageId: 'already-built:latest',
		};
		await getRegistries().builds.set(nonTerminalBuild.id, nonTerminalBuild);
		await getRegistries().builds.set(terminalBuild.id, terminalBuild);

		await reconcileOrphanedJobs(driver);

		// The driver was told about exactly the orphaned run - not the terminal one, and not any build id
		// (builds have no container of their own to reconcile - see `Driver.reconcileOrphans`'s doc
		// comment).
		expect(driver.reconcileOrphansCalls).toEqual([[nonTerminalRun.id]]);
		// And it was called BEFORE the finalization writes below landed - proven by reading the record's
		// status from inside the stub itself, at call time.
		expect(driver.statusesAtCallTime).toEqual([{ [nonTerminalRun.id]: 'RUNNING' }]);

		const finalNonTerminalRun = await getRegistries().runs.get(nonTerminalRun.id);
		expect(finalNonTerminalRun?.status).toBe('ABORTED');
		expect(finalNonTerminalRun?.statusMessage).toBeTruthy();
		expect(finalNonTerminalRun?.finishedAt).toBeTruthy();

		const finalNonTerminalBuild = await getRegistries().builds.get(nonTerminalBuild.id);
		expect(finalNonTerminalBuild?.status).toBe('ABORTED');
		expect(finalNonTerminalBuild?.statusMessage).toBeTruthy();
		expect(finalNonTerminalBuild?.finishedAt).toBeTruthy();

		// Terminal jobs are left completely untouched - proves the filter is `!isTerminal`, not inverted.
		const finalTerminalRun = await getRegistries().runs.get(terminalRun.id);
		expect(finalTerminalRun).toEqual(terminalRun);
		const finalTerminalBuild = await getRegistries().builds.get(terminalBuild.id);
		expect(finalTerminalBuild).toEqual(terminalBuild);
	});

	it('does nothing and does not throw when there are zero orphans', async () => {
		const driver = recordingReconcileDriver();
		server = await startTestServer(driver);
		const actor = await seedActor(server, 'no-orphans-actor');

		const terminalRun: RunRecord = {
			...bareRunRecord(actor, await seedSucceededBuild(actor)),
			status: 'SUCCEEDED',
			finishedAt: new Date().toISOString(),
			exitCode: 0,
		};
		await getRegistries().runs.set(terminalRun.id, terminalRun);

		await expect(reconcileOrphanedJobs(driver)).resolves.toBeUndefined();

		expect(driver.reconcileOrphansCalls).toEqual([[]]);
		const finalTerminalRun = await getRegistries().runs.get(terminalRun.id);
		expect(finalTerminalRun).toEqual(terminalRun);
	});
});

describe('fire-and-forget background handlers: unexpected exceptions are logged and best-effort finalized', () => {
	let server: TestServerHandle;

	afterEach(async () => {
		await server.close();
	});

	/** Polls via `.list()`, not `.get()`, so it never risks consuming a one-shot `.get()` spy meant for
	 * the production code path under test. */
	async function pollUntilNonPending<T extends { id: string; status: string }>(
		list: () => Promise<T[]>,
		id: string,
		seconds: number,
	): Promise<T | undefined> {
		const deadline = Date.now() + seconds * 1000;
		for (;;) {
			const found = (await list()).find((record) => record.id === id);
			if (found && found.status !== 'READY' && found.status !== 'RUNNING') return found;
			if (Date.now() >= deadline) return found;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
	}

	it('startBuild: a registry failure at the pre-start re-check (outside the internal try/catch) still logs and finalizes the build FAILED instead of hanging non-terminal forever', async () => {
		// `fixedBuildOutcomeDriver` would succeed if ever reached - it must not be, since the injected
		// throw happens before `driver.startBuild` is ever called.
		const driver = fixedBuildOutcomeDriver({ imageId: 'should-not-be-reached' });
		server = await startTestServer(driver);
		const actor = await seedActor(server, 'unexpected-build-error-actor');

		const { builds } = getRegistries();
		const boom = new Error('simulated registry failure at the pre-start re-check');
		const getSpy = vi.spyOn(builds, 'get').mockImplementationOnce(async () => {
			throw boom;
		});
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

		const record = await startBuild(driver, actor, VERSION, { tag: 'latest', useCache: true });
		expect(record.status).toBe('READY');

		const final = await pollUntilNonPending(() => builds.list(), record.id, 5);
		expect(final?.status).toBe('FAILED');
		expect(final?.statusMessage).toContain('simulated registry failure at the pre-start re-check');
		expect(errorSpy).toHaveBeenCalled();

		getSpy.mockRestore();
		errorSpy.mockRestore();
	});

	it('startRun: a registry failure at the pre-start re-check (outside the internal try/catch) still logs and finalizes the run FAILED instead of hanging non-terminal forever', async () => {
		const driver = fixedRunOutcomeDriver({ exitCode: 0, timedOut: false });
		server = await startTestServer(driver);
		const actor = await seedActor(server, 'unexpected-run-error-actor');
		const build = await seedSucceededBuild(actor);

		const { runs } = getRegistries();
		const boom = new Error('simulated registry failure at the pre-start re-check');
		const getSpy = vi.spyOn(runs, 'get').mockImplementationOnce(async () => {
			throw boom;
		});
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

		const record = await startRun(driver, actor, build, { apiBaseUrl: server.baseUrl, token: server.token });
		expect(record.status).toBe('READY');

		const final = await pollUntilNonPending(() => runs.list(), record.id, 5);
		expect(final?.status).toBe('FAILED');
		expect(final?.statusMessage).toContain('simulated registry failure at the pre-start re-check');
		expect(errorSpy).toHaveBeenCalled();

		getSpy.mockRestore();
		errorSpy.mockRestore();
	});
});

// `startRun` (the public, HTTP-facing entry point) is exercised too, so the guard is proven not just at
// the `runInBackground` unit level but through the same code path `POST /actors/:id/runs` actually uses.
describe('startRun (public entry point) still creates a normal READY record the guard then governs', () => {
	let server: TestServerHandle;
	let driver: ReturnType<typeof deferredRunDriver>;

	beforeEach(async () => {
		driver = deferredRunDriver();
		server = await startTestServer(driver);
	});

	afterEach(async () => {
		// Let the fire-and-forgotten background run settle before the temp data dir is torn down -
		// otherwise its still-in-flight registry write can race `close()`'s `rm(dataDir, ...)`.
		driver.resolveRun({ exitCode: 0, timedOut: false });
		await server.close();
	});

	it('creates the record with status READY before any driver call happens', async () => {
		const created = await server.client.actors().create({ name: 'ready-actor' });
		const actor = (await getRegistries().actors.get(created.id))!;
		const build = await seedSucceededBuild(actor);
		const record = await startRun(server.driver, actor, build, { apiBaseUrl: server.baseUrl, token: server.token });
		expect(record.status).toBe('READY');

		driver.resolveRun({ exitCode: 0, timedOut: false });
		await waitForRunFinish(record.id, 5);
	});
});

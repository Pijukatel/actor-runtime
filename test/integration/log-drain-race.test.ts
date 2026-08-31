/**
 * End-to-end regression test for the finding: a run's persisted log could read incomplete the instant
 * an HTTP client observed its status turn terminal, because `container.wait()` (the signal
 * `runInBackground` used to decide the run is done) and `container.logs({follow:true})` (the source of
 * every `onLog`/`appendLog` call) are two independent Docker API connections with no ordering guarantee
 * between them - the container process can exit before its trailing stdout/stderr bytes have actually
 * arrived over the logs connection.
 *
 * This drives the real `DockerDriver` (not a hand-rolled `Driver` stub) through the full HTTP stack
 * (`apify-client` -> `POST .../runs` -> `runInBackground` -> `DockerDriver.startRun`) against a stubbed
 * `dockerode`, so the fix under test is `docker-driver.ts`'s own `startRun` - the one place the real race
 * lives (see its doc comment). The stub gives independent, deterministic control over "the container
 * process exited" (`triggerContainerExit`) versus "the logs connection delivered its trailing chunk and
 * closed" (`pushFinalLogChunk` / `endLogStream`), mirroring the two genuinely separate Docker connections.
 */
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';
import type Docker from 'dockerode';

import { startTestServer, type TestServerHandle } from './helpers/test-server.js';
import { getRegistries } from '../../src/storage/registries.js';
import { generateId } from '../../src/storage/ids.js';
import { recordTaggedBuild, updateActor } from '../../src/services/actors.js';
import { DockerDriver } from '../../src/driver/docker-driver.js';
import type { ActorRecord, BuildRecord } from '../../src/storage/entities.js';

async function seedActor(server: TestServerHandle, name: string): Promise<ActorRecord> {
	const created = await server.client.actors().create({ name });
	return (await getRegistries().actors.get(created.id))!;
}

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

/** Same shape as `test/unit/docker-driver.test.ts`'s `stubDockerForRun` - `container.wait()` and the
 * `container.logs()` stream are each controlled independently, exactly like the real daemon's two
 * separate Docker API connections. */
function stubDockerForRun() {
	let resolveWait!: (result: { StatusCode: number }) => void;
	const waitPromise = new Promise<{ StatusCode: number }>((resolve) => {
		resolveWait = resolve;
	});
	const rawLogStream = new PassThrough();

	const container = {
		start: vi.fn(async () => undefined),
		logs: vi.fn(async () => rawLogStream),
		wait: vi.fn(async () => waitPromise),
		remove: vi.fn(async () => undefined),
		stop: vi.fn(async () => undefined),
	};

	// Faithful to the real `docker-modem` `Modem.prototype.demuxStream`
	// (`node_modules/docker-modem/lib/modem.js`): it forwards data frames only and never ends `stdout`/
	// `stderr` itself (only `streama.on('data', processData)` is registered on the source). Ending them is
	// `DockerDriver.startRun`'s own responsibility, derived from the SOURCE stream's `'end'` - see
	// `test/unit/docker-driver.test.ts`'s matching stub doc comment for the regression this guards against.
	const demuxStream = vi.fn((stream: NodeJS.ReadableStream, stdout: PassThrough) => {
		stream.on('data', (chunk: Buffer) => stdout.write(chunk));
	});

	const docker = {
		createContainer: vi.fn(async () => container),
		modem: { demuxStream },
	} as unknown as Docker;

	return {
		docker,
		triggerContainerExit(statusCode = 0): void {
			resolveWait({ StatusCode: statusCode });
		},
		pushFinalLogChunk(chunk: string): void {
			rawLogStream.write(chunk);
		},
		endLogStream(): void {
			rawLogStream.end();
		},
	};
}

describe('end-to-end: a run never reads terminal via HTTP before its log has fully drained (regression)', () => {
	let server: TestServerHandle;

	afterEach(async () => {
		await server.close();
	});

	it('the instant a non-stream GET of run status is terminal, GET /v2/logs/:id already contains the full output, even though the container process "exited" earlier', async () => {
		const stub = stubDockerForRun();
		const driver = new DockerDriver(stub.docker);
		driver.available = true;
		server = await startTestServer(driver);

		const actor = await seedActor(server, 'log-drain-race-actor');
		const build = await seedSucceededBuild(actor);
		await updateActor(actor.id, (current) => recordTaggedBuild(current, 'latest', build.id, build.buildNumber));

		const run = await server.client.actor(actor.id).start({});

		// The run is created as READY and only turns RUNNING once the background `runInBackground` handler
		// (fired off asynchronously by the route, not awaited by `start()`) actually gets to its RUNNING
		// transition - on a loaded/shared CI runner that can take longer than the gap between `start()`
		// returning and the very first status check below. Asserting RUNNING at that single point in time
		// (instead of polling for it first) is what produced the CI failure this fixes: `expected 'READY' to
		// be 'RUNNING'`. This poll is not the regression under test - it just waits out that unrelated
		// startup lag before the real assertion (the "stays RUNNING" window right below) begins.
		await expect
			.poll(async () => (await server.client.run(run.id).get())?.status, { timeout: 5000, interval: 20 })
			.toBe('RUNNING');

		// The container process exits - but its trailing log output has not arrived over the (separate)
		// logs connection yet.
		stub.triggerContainerExit(0);

		// Poll for a real, generous window: without the fix, `container.wait()` resolving is all it takes
		// for `startRun` (and therefore the run's terminal status write) to complete, so the run would
		// already read terminal somewhere in here, well before the trailing chunk below is ever sent.
		const deadline = Date.now() + 300;
		while (Date.now() < deadline) {
			const current = await server.client.run(run.id).get();
			expect(current?.status).toBe('RUNNING');
			await new Promise((resolve) => setTimeout(resolve, 20));
		}

		// Only now does the trailing chunk arrive, and the logs connection close.
		stub.pushFinalLogChunk('final line\n');
		stub.endLogStream();

		const finished = await server.client.run(run.id).waitForFinish({ waitSecs: 5 });
		expect(finished.status).toBe('SUCCEEDED');

		// A fresh, non-stream log read the instant status is observed terminal must contain the full
		// output - not just what had arrived before the container "exited".
		const log = await server.client.log(run.id).get();
		// Strip the per-line timestamp - this test is about the drain race, not the log format.
		expect(log?.replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /, '')).toBe('final line\n');
	});
});

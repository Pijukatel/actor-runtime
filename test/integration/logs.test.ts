import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { startTestServer, type TestServerHandle } from './helpers/test-server.js';
import {
	appendLog,
	flushAllLogs,
	flushLog,
	getFullLog,
	getSubscriberCount,
	markLogTerminal,
} from '../../src/services/logs.js';
import { getRegistries } from '../../src/storage/registries.js';
import { getOrCreateUserForToken } from '../../src/services/users.js';

/** The per-line timestamp prefix from the platform log format (api.md). */
const LINE_STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /;

function stripStamps(log: string): string {
	return log
		.split('\n')
		.map((line) => line.replace(LINE_STAMP, ''))
		.join('\n');
}

/** Polls `check()` until it returns true or `timeoutMs` elapses, rather than a fixed sleep - keeps the
 * disconnect test fast on the happy path and still deterministic if cleanup is ever slow. */
async function waitUntil(check: () => boolean, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() >= deadline) throw new Error('waitUntil: condition never became true');
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

describe('log streaming', () => {
	let server: TestServerHandle;

	beforeEach(async () => {
		server = await startTestServer();
	});

	afterEach(async () => {
		await server.close();
	});

	it('GET /v2/logs/:id returns plain text, not {data}-wrapped', async () => {
		const actor = await server.client.actors().create({ name: 'log-actor' });
		await server.client
			.actor(actor.id)
			.versions()
			.create({
				versionNumber: '0.0',
				buildTag: 'latest',
				sourceType: 'SOURCE_FILES' as never,
				sourceFiles: [],
			} as never);

		const triggeredBuild = await server.client.actor(actor.id).build('0.0', { waitForFinish: 5 });
		const log = await server.client.log(triggeredBuild.id).get();
		expect(typeof log).toBe('string');
		expect(log).toMatch(/Docker/);
	});

	it('?stream=true holds the response open until the job is marked terminal, then closes', async () => {
		const jobId = 'streamingJobId12345';
		appendLog(jobId, 'line 1\n');

		// Seed ownership so the log endpoint's ownership check passes.
		const user = await getOrCreateUserForToken(server.token);
		await getRegistries().runs.set(jobId, {
			id: jobId,
			userId: user.id,
			actorId: 'x',
			buildId: 'y',
			buildNumber: '0.0.1',
			status: 'RUNNING',
			startedAt: new Date().toISOString(),
			defaultDatasetId: 'd',
			defaultKeyValueStoreId: 'k',
			defaultRequestQueueId: 'r',
			options: { memoryMbytes: 1024, timeoutSecs: 300 },
			meta: { origin: 'API' },
		});

		const stream = await server.client.log(jobId).stream();
		expect(stream).toBeDefined();

		const chunks: string[] = [];
		const done = new Promise<void>((resolve) => {
			stream!.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));
			stream!.on('end', () => resolve());
		});

		setTimeout(() => {
			appendLog(jobId, 'line 2\n');
			markLogTerminal(jobId);
		}, 100);

		await done;
		expect(chunks.join('')).toContain('line 1');
		expect(chunks.join('')).toContain('line 2');
	});

	it('client disconnect mid-stream cleans up the subscriber (and its poll interval) instead of leaking', async () => {
		const jobId = 'disconnectingJobId1';
		appendLog(jobId, 'line 1\n');

		const user = await getOrCreateUserForToken(server.token);
		await getRegistries().runs.set(jobId, {
			id: jobId,
			userId: user.id,
			actorId: 'x',
			buildId: 'y',
			buildNumber: '0.0.1',
			status: 'RUNNING', // deliberately non-terminal: the job never finishes in this test, so the
			// only thing that can end the stream/subscription is the client disconnect itself.
			startedAt: new Date().toISOString(),
			defaultDatasetId: 'd',
			defaultKeyValueStoreId: 'k',
			defaultRequestQueueId: 'r',
			options: { memoryMbytes: 1024, timeoutSecs: 300 },
			meta: { origin: 'API' },
		});

		const controller = new AbortController();
		const res = await fetch(`${server.baseUrl}/v2/logs/${jobId}?stream=true`, {
			headers: { Authorization: `Bearer ${server.token}` },
			signal: controller.signal,
		});
		expect(res.status).toBe(200);

		const reader = res.body!.getReader();
		const { value } = await reader.read();
		expect(Buffer.from(value!).toString()).toContain('line 1');

		// The subscriber is registered as soon as the response is written to; confirm that before
		// tearing the connection down, so the later "dropped to 0" assertion is meaningful rather than
		// vacuously true (e.g. because the subscription never registered in the first place).
		expect(getSubscriberCount(jobId)).toBe(1);

		controller.abort();
		await reader.cancel().catch(() => undefined);

		// The server's `req.on('close', ...)` handler runs asynchronously relative to the client-side
		// abort, so poll rather than asserting immediately.
		await waitUntil(() => getSubscriberCount(jobId) === 0);
		expect(getSubscriberCount(jobId)).toBe(0);

		// The job is still non-terminal and was never closed from the server's side - if the poll
		// interval that watches for terminal status had not been cleared on disconnect, it would keep
		// firing forever, which vitest's open-handle detection would catch at suite teardown.
		markLogTerminal(jobId);
	});

	it('two overlapping flushLog calls for the same id do not drop content (regression for the read-modify-write race)', async () => {
		const jobId = 'flushRaceJobId1234';
		appendLog(jobId, 'line1\n');

		const store = getRegistries().logs;
		const originalGetValue = store.getValue.bind(store);

		// Deterministically reproduce the finding's exact interleaving, rather than relying on
		// wall-clock timing: each `getValue` call does its *real* read immediately (so both calls
		// genuinely observe the same stale "nothing persisted yet" state, exactly like two overlapping
		// flushes racing on a live store), then blocks on a gate we control explicitly, so we decide
		// which flush resumes-and-writes first.
		let releaseFirst!: () => void;
		const firstGate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		let releaseSecond!: () => void;
		const secondGate = new Promise<void>((resolve) => {
			releaseSecond = resolve;
		});
		let callCount = 0;
		const spy = vi
			.spyOn(store, 'getValue')
			.mockImplementation(async (...args: Parameters<typeof originalGetValue>) => {
				// Snapshot this call's own ordinal *before* the `await` below - `callCount` is a shared
				// closure variable, and by the time this call's `await originalGetValue` resolves, the
				// other overlapping call may already have bumped it, so re-reading the shared variable
				// here would make both calls wait on the same gate.
				const myCall = (callCount += 1);
				const result = await originalGetValue(...args);
				await (myCall === 1 ? firstGate : secondGate);
				return result;
			});

		const first = flushLog(jobId);
		await new Promise((resolve) => setImmediate(resolve)); // let the first flush reach its getValue call

		// Append more content, then fire a second overlapping flush, while the first flush's read is
		// still gated open - mirrors the periodic flusher's tick landing while a job's own
		// end-of-run/build flush for the same id is still in flight.
		appendLog(jobId, 'line2\n');
		const second = flushLog(jobId);
		await new Promise((resolve) => setImmediate(resolve)); // let the mutex hand off / second reach its own gate

		// Let the first flush resume and fully complete (buffer swap + persisted write) before the
		// second is allowed to resume - the exact ordering the finding reproduced as total data loss
		// under the old, unserialised algorithm.
		releaseFirst();
		await first;
		releaseSecond();
		await second;
		spy.mockRestore();

		expect(stripStamps(await getFullLog(jobId))).toBe('line1\nline2\n');
	});

	it('getFullLog never returns a torn read while a flush for the same id is in flight (regression for the reader-vs-writer race)', async () => {
		const jobId = 'readerWriterRaceJob1';
		appendLog(jobId, 'first chunk\n');

		const store = getRegistries().logs;
		const originalSetValue = store.setValue.bind(store);

		// Gate the flush's `setValue`, so a concurrent `getFullLog` call is deterministically forced into
		// the exact window the finding reproduced: the flush has already snapshot-and-cleared its buffer
		// (so the old implementation's in-memory fallback reads back empty) but has not yet persisted the
		// chunk (so the old implementation's `logs.getValue` read also misses it) - the old code returned
		// an empty string here instead of the content that a settled flush would produce.
		let releaseSetValue!: () => void;
		const gate = new Promise<void>((resolve) => {
			releaseSetValue = resolve;
		});
		const spy = vi
			.spyOn(store, 'setValue')
			.mockImplementation(async (...args: Parameters<typeof originalSetValue>) => {
				await gate;
				return originalSetValue(...args);
			});

		const flush = flushLog(jobId);
		await new Promise((resolve) => setImmediate(resolve)); // let the flush snapshot-and-clear its buffer and reach the gated setValue

		const read = getFullLog(jobId);
		await new Promise((resolve) => setImmediate(resolve)); // let getFullLog's own flushLog call queue behind the in-flight flush

		releaseSetValue();
		await flush;
		const result = await read;
		spy.mockRestore();

		expect(stripStamps(result)).toBe('first chunk\n');
	});

	it("flushAllLogs persists every live log's buffered content (regression for a lost trailing chunk on graceful shutdown)", async () => {
		const jobId1 = 'shutdownFlushJobA12';
		const jobId2 = 'shutdownFlushJobB34';
		appendLog(jobId1, 'alpha\n');
		appendLog(jobId2, 'beta\n');

		// Before flushAllLogs runs, nothing is persisted yet - only the in-memory buffer holds the
		// content, which is exactly what a `SIGTERM` without this fix would lose.
		expect(await getRegistries().logs.getValue(jobId1)).toBeNull();
		expect(await getRegistries().logs.getValue(jobId2)).toBeNull();

		await flushAllLogs();

		expect(stripStamps((await getRegistries().logs.getValue(jobId1)) ?? '')).toBe('alpha\n');
		expect(stripStamps((await getRegistries().logs.getValue(jobId2)) ?? '')).toBe('beta\n');
	});

	it('a stream closes when the persisted record turns terminal even if markLogTerminal is never called (regression: aborted in the READY window)', async () => {
		const jobId = 'readyWindowAbortJob1';
		appendLog(jobId, 'line 1\n');

		const user = await getOrCreateUserForToken(server.token);
		await getRegistries().runs.set(jobId, {
			id: jobId,
			userId: user.id,
			actorId: 'x',
			buildId: 'y',
			buildNumber: '0.0.1',
			status: 'READY',
			startedAt: new Date().toISOString(),
			defaultDatasetId: 'd',
			defaultKeyValueStoreId: 'k',
			defaultRequestQueueId: 'r',
			options: { memoryMbytes: 1024, timeoutSecs: 300 },
			meta: { origin: 'API' },
		});

		const stream = await server.client.log(jobId).stream();
		expect(stream).toBeDefined();

		const chunks: string[] = [];
		const done = new Promise<void>((resolve) => {
			stream!.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));
			stream!.on('end', () => resolve());
		});

		// Simulate the exact finding: the record is finalised directly (as `abortBuild`/`reconcileOrphanedJobs`
		// would on this path) WITHOUT ever calling `markLogTerminal` - the in-memory `isLogTerminal` flag for
		// this job never becomes true. Only the persisted-record safety net can close this stream.
		setTimeout(() => {
			void getRegistries().runs.update(jobId, (current) => (current ? { ...current, status: 'ABORTED' } : null));
		}, 100);

		await done;
		expect(chunks.join('')).toContain('line 1');
	});

	it('a stream closes when the persisted record turns terminal with no live in-memory log state at all (regression: reconciled-after-restart shape)', async () => {
		const jobId = 'reconciledAfterRestart1';
		// Deliberately no `appendLog` call at all - mirrors a job reconciled after a process restart,
		// where `live` (services/logs.ts) starts out completely empty for this id.

		const user = await getOrCreateUserForToken(server.token);
		await getRegistries().runs.set(jobId, {
			id: jobId,
			userId: user.id,
			actorId: 'x',
			buildId: 'y',
			buildNumber: '0.0.1',
			status: 'RUNNING',
			startedAt: new Date().toISOString(),
			defaultDatasetId: 'd',
			defaultKeyValueStoreId: 'k',
			defaultRequestQueueId: 'r',
			options: { memoryMbytes: 1024, timeoutSecs: 300 },
			meta: { origin: 'API' },
		});

		const stream = await server.client.log(jobId).stream();
		expect(stream).toBeDefined();
		const done = new Promise<void>((resolve) => {
			// A readable stream in Node stays paused (never emits 'end') until something puts it into
			// flowing mode - attach a no-op 'data' listener so this test can observe 'end' at all.
			stream!.on('data', () => undefined);
			stream!.on('end', () => resolve());
		});

		setTimeout(() => {
			void getRegistries().runs.update(jobId, (current) => (current ? { ...current, status: 'ABORTED' } : null));
		}, 100);

		await done;
	});

	it('the happy path (markLogTerminal called normally) is unaffected by the persisted-record safety net', async () => {
		const jobId = 'happyPathMarkTerminal1';
		appendLog(jobId, 'line 1\n');

		const user = await getOrCreateUserForToken(server.token);
		await getRegistries().runs.set(jobId, {
			id: jobId,
			userId: user.id,
			actorId: 'x',
			buildId: 'y',
			buildNumber: '0.0.1',
			status: 'RUNNING',
			startedAt: new Date().toISOString(),
			defaultDatasetId: 'd',
			defaultKeyValueStoreId: 'k',
			defaultRequestQueueId: 'r',
			options: { memoryMbytes: 1024, timeoutSecs: 300 },
			meta: { origin: 'API' },
		});

		const stream = await server.client.log(jobId).stream();
		const chunks: string[] = [];
		const done = new Promise<void>((resolve) => {
			stream!.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));
			stream!.on('end', () => resolve());
		});

		// Note: the run record stays RUNNING here - only `markLogTerminal` ends this stream, proving the
		// persisted-record check is a supplementary safety net, not a replacement for the prompt path.
		setTimeout(() => {
			appendLog(jobId, 'line 2\n');
			markLogTerminal(jobId);
		}, 100);

		await done;
		expect(chunks.join('')).toContain('line 1');
		expect(chunks.join('')).toContain('line 2');
	});

	it('?stream=true against a job whose persisted record is already terminal at request time closes the initial response immediately, without ever opening a stream (regression: untested initial-response persisted-record arm)', async () => {
		const jobId = 'alreadyTerminalRecord1';
		appendLog(jobId, 'line 1\n');

		const user = await getOrCreateUserForToken(server.token);
		await getRegistries().runs.set(jobId, {
			id: jobId,
			userId: user.id,
			actorId: 'x',
			buildId: 'y',
			buildNumber: '0.0.1',
			status: 'SUCCEEDED', // already terminal when the request arrives
			startedAt: new Date().toISOString(),
			finishedAt: new Date().toISOString(),
			defaultDatasetId: 'd',
			defaultKeyValueStoreId: 'k',
			defaultRequestQueueId: 'r',
			options: { memoryMbytes: 1024, timeoutSecs: 300 },
			meta: { origin: 'API' },
		});

		// `markLogTerminal` is deliberately never called - `isLogTerminal(jobId)` stays false, so the
		// only thing that can produce the immediate-close response is `serveLog`'s
		// `isTerminalJobStatus(job.status)` check on the very first evaluation of the line-44 condition
		// (the initial response), not the `setInterval` poll loop, which never gets the chance to run
		// before the assertion below.
		const res = await fetch(`${server.baseUrl}/v2/logs/${jobId}?stream=true`, {
			headers: { Authorization: `Bearer ${server.token}` },
		});
		expect(res.status).toBe(200);

		const reader = res.body!.getReader();
		const { value } = await reader.read();
		expect(stripStamps(Buffer.from(value!).toString())).toBe('line 1\n');

		// The initial response is a single `res.status(200).send(soFar)`, never `res.write` + a
		// held-open connection, so `subscribeLog` is never called - checked immediately after the first
		// (and only) chunk, before the 250ms poll interval could possibly have fired, so a stream that
		// was genuinely left open (the bug this guards against: falling through to the streaming branch
		// because this initial check was skipped) would still show a registered subscriber here.
		expect(getSubscriberCount(jobId)).toBe(0);

		const { done } = await reader.read();
		expect(done).toBe(true);
	});

	it('?stream=true against a job already markLogTerminal-ed before the request closes the initial response immediately, without ever opening a stream (regression: untested initial-response in-memory-flag arm)', async () => {
		const jobId = 'alreadyMarkedTerminal1';
		appendLog(jobId, 'line 1\n');
		markLogTerminal(jobId);

		const user = await getOrCreateUserForToken(server.token);
		await getRegistries().runs.set(jobId, {
			id: jobId,
			userId: user.id,
			actorId: 'x',
			buildId: 'y',
			buildNumber: '0.0.1',
			status: 'RUNNING', // the persisted record itself is NOT terminal - isolates this arm from the
			// previous test's `isTerminalJobStatus` arm, so only `isLogTerminal(id)` can explain the
			// immediate close here.
			startedAt: new Date().toISOString(),
			defaultDatasetId: 'd',
			defaultKeyValueStoreId: 'k',
			defaultRequestQueueId: 'r',
			options: { memoryMbytes: 1024, timeoutSecs: 300 },
			meta: { origin: 'API' },
		});

		const res = await fetch(`${server.baseUrl}/v2/logs/${jobId}?stream=true`, {
			headers: { Authorization: `Bearer ${server.token}` },
		});
		expect(res.status).toBe(200);

		const reader = res.body!.getReader();
		const { value } = await reader.read();
		expect(stripStamps(Buffer.from(value!).toString())).toBe('line 1\n');
		expect(getSubscriberCount(jobId)).toBe(0);

		const { done } = await reader.read();
		expect(done).toBe(true);
	});

	it('stamps every log line with a platform-style ISO timestamp, exactly once per line even when chunk boundaries fall mid-line', async () => {
		const jobId = 'stampedLinesJobId12';
		// Docker output is not line-aligned: one line arrives split over two appends, and one append
		// carries two lines. Both must come out with exactly one stamp per *line*.
		appendLog(jobId, '[apify] INFO first line\n[apify] WARN second li');
		appendLog(jobId, 'ne, same stamp\n');
		appendLog(jobId, '[apify] INFO third line\n');

		const log = await getFullLog(jobId);
		const lines = log.split('\n').filter((line) => line.length > 0);
		expect(lines).toHaveLength(3);
		for (const line of lines) expect(line).toMatch(LINE_STAMP);
		// The continuation of the split line must NOT have been stamped mid-line.
		expect(lines[1]).toMatch(/second line, same stamp$/);
		expect(stripStamps(log)).toBe(
			'[apify] INFO first line\n[apify] WARN second line, same stamp\n[apify] INFO third line\n',
		);
	});

	it('apify-client log redirection recovers every message from ?stream=true&raw=true (regression: Actor.call redirected nothing)', async () => {
		const jobId = 'redirectedLogJobId1';
		appendLog(jobId, '[apify] INFO Initializing Actor...\n');

		const user = await getOrCreateUserForToken(server.token);
		await getRegistries().runs.set(jobId, {
			id: jobId,
			userId: user.id,
			actorId: 'x',
			buildId: 'y',
			buildNumber: '0.0.1',
			status: 'RUNNING',
			startedAt: new Date().toISOString(),
			defaultDatasetId: 'd',
			defaultKeyValueStoreId: 'k',
			defaultRequestQueueId: 'r',
			options: { memoryMbytes: 1024, timeoutSecs: 300 },
			meta: { origin: 'API' },
		});

		// The exact request apify-client's log redirection makes.
		const res = await fetch(`${server.baseUrl}/v2/actor-runs/${jobId}/log?stream=true&raw=true`, {
			headers: { Authorization: `Bearer ${server.token}` },
		});
		expect(res.status).toBe(200);

		setTimeout(() => appendLog(jobId, '[apify] INFO doing work\n[apify] WARN partial li'), 50);
		setTimeout(() => appendLog(jobId, 'ne finished\n'), 100);
		setTimeout(() => markLogTerminal(jobId), 150);

		// Replicates the client's redirect parsing: buffer chunks, split on the timestamp marker, emit
		// only marker-delimited messages (a possibly incomplete trailing part waits in the buffer until
		// the final flush). Without the per-line timestamps this recovers zero messages.
		const splitMarker = /(?:\n|^)(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)/;
		let streamBuffer = '';
		const messages: string[] = [];
		const flushBuffer = (includeLastPart: boolean) => {
			const allParts = streamBuffer.split(splitMarker).slice(1);
			const complete = includeLastPart ? allParts : allParts.slice(0, -2);
			streamBuffer = includeLastPart ? '' : allParts.slice(-2).join('');
			for (let i = 0; i + 1 < complete.length; i += 2) {
				messages.push(`${complete[i]}${complete[i + 1]}`.trim());
			}
		};

		const reader = res.body!.getReader();
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			streamBuffer += Buffer.from(value!).toString();
			if (splitMarker.test(streamBuffer)) flushBuffer(false);
		}
		flushBuffer(true);

		const contentsOnly = messages.map((message) => message.replace(LINE_STAMP, ''));
		expect(contentsOnly).toEqual([
			'[apify] INFO Initializing Actor...',
			'[apify] INFO doing work',
			'[apify] WARN partial line finished',
		]);
	});
});

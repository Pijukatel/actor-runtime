/**
 * Build/run log buffering, periodic flush into `__LOGS__`, and live fan-out to `?stream=true`
 * responses. The log endpoint itself is plain text, never `{data}`-wrapped (see `api/routes/logs.ts`).
 */
import { getRegistries } from '../storage/registries.js';
import { KeyedMutex } from '../storage/mutex.js';

interface LiveLog {
	buffer: string[];
	subscribers: Set<(chunk: string) => void>;
	terminal: boolean;
	/** Whether the next appended character starts a new log line - lets `appendLog` stamp exactly one
	 * timestamp per line even when chunk boundaries fall mid-line. */
	atLineStart: boolean;
}

const live = new Map<string, LiveLog>();
const FLUSH_INTERVAL_MS = 500;
let flushTimer: NodeJS.Timeout | undefined;

/**
 * `flushLog` is a read-modify-write against the raw `__LOGS__` `KeyValueStore` (not a `Registry`, so it
 * gets none of `Registry`'s built-in serialisation). It is called from two independent places for the
 * same id - the periodic flusher below and the explicit end-of-run/build flush in `runs.ts`/`builds.ts`
 * - so overlapping calls for one id are serialised per id here, mirroring `Registry`'s `KeyedMutex`.
 */
const flushMutex = new KeyedMutex();

function getOrCreate(id: string): LiveLog {
	let state = live.get(id);
	if (!state) {
		state = { buffer: [], subscribers: new Set(), terminal: false, atLineStart: true };
		live.set(id, state);
	}
	return state;
}

/**
 * Prefixes every log *line* in `chunk` with an ingestion timestamp (`2026-08-31T09:13:25.123Z `), the
 * platform's log format (api.md). Apify clients' log redirection recognizes messages by this prefix,
 * so unstamped lines would never be redirected.
 */
function stampLines(state: LiveLog, chunk: string): string {
	let out = '';
	let from = 0;
	while (from < chunk.length) {
		if (state.atLineStart) out += `${new Date().toISOString()} `;
		const newlineAt = chunk.indexOf('\n', from);
		if (newlineAt === -1) {
			out += chunk.slice(from);
			state.atLineStart = false;
			break;
		}
		out += chunk.slice(from, newlineAt + 1);
		state.atLineStart = true;
		from = newlineAt + 1;
	}
	return out;
}

export function appendLog(id: string, chunk: string): void {
	if (!chunk) return;
	const state = getOrCreate(id);
	const stamped = stampLines(state, chunk);
	state.buffer.push(stamped);
	for (const subscriber of state.subscribers) subscriber(stamped);
}

/** Returns an unsubscribe function. */
export function subscribeLog(id: string, onChunk: (chunk: string) => void): () => void {
	const state = getOrCreate(id);
	state.subscribers.add(onChunk);
	return () => state.subscribers.delete(onChunk);
}

export function markLogTerminal(id: string): void {
	getOrCreate(id).terminal = true;
}

export function isLogTerminal(id: string): boolean {
	return live.get(id)?.terminal ?? false;
}

/**
 * Number of live `?stream=true` subscribers currently fanned out to for `id`. Exists so tests can
 * observe that a disconnected client's subscriber (and, transitively, its poll interval in
 * `api/routes/logs.ts`) was actually cleaned up rather than leaked - there is no other externally
 * visible signal for that cleanup.
 */
export function getSubscriberCount(id: string): number {
	return live.get(id)?.subscribers.size ?? 0;
}

export async function flushLog(id: string): Promise<void> {
	return flushMutex.run(id, async () => {
		const state = live.get(id);
		if (!state || state.buffer.length === 0) return;
		// Snapshot-and-clear the buffer synchronously, before any `await` below, so a chunk appended
		// while this flush's read/write is in flight lands in the *new* (post-swap) buffer array
		// rather than being silently dropped by a `state.buffer = []` that runs after the read.
		const chunk = state.buffer.join('');
		state.buffer = [];
		const { logs } = getRegistries();
		const existing = (await logs.getValue<string>(id)) ?? '';
		await logs.setValue(id, existing + chunk, { contentType: 'text/plain; charset=utf-8' });
	});
}

/**
 * Flushes `id` first, then reads the persisted `__LOGS__` record - the only source of truth this
 * function uses. Reading the persisted record and the live buffer separately (the previous
 * implementation) raced `flushLog`: between a flush's synchronous buffer-clear and its `setValue`
 * completing, a concurrent read would see the buffer already empty but the persisted record not yet
 * updated, silently dropping that flush's chunk from the result. Flushing first removes that window
 * entirely rather than papering over it - `flushLog` is mutex-serialised per id (`flushMutex`), so a
 * `getFullLog` call that lands while another flush for the same id is still in flight simply queues
 * behind it and only proceeds to the read once that flush (buffer-clear *and* `setValue`) has fully
 * settled. `flushLog` is a no-op when the buffer is already empty, so this costs at most one extra
 * `getValue` on the already-flushed-and-idle path.
 */
export async function getFullLog(id: string): Promise<string> {
	await flushLog(id);
	const { logs } = getRegistries();
	return (await logs.getValue<string>(id)) ?? '';
}

export function startLogFlusher(): void {
	if (flushTimer) return;
	flushTimer = setInterval(() => {
		for (const id of live.keys()) void flushLog(id);
	}, FLUSH_INTERVAL_MS);
	flushTimer.unref();
}

export function stopLogFlusher(): void {
	if (flushTimer) clearInterval(flushTimer);
	flushTimer = undefined;
}

/**
 * Flushes every live log's buffered-but-unpersisted content into `__LOGS__`. Called once from graceful
 * shutdown, after `stopLogFlusher` (so no periodic tick races it) and before storage teardown - without
 * this, up to `FLUSH_INTERVAL_MS` of trailing output from an active build/run is lost on every
 * `SIGTERM`/`SIGINT`, since the in-memory buffer holding it (this module's `live` map) disappears with
 * the process.
 */
export async function flushAllLogs(): Promise<void> {
	await Promise.all([...live.keys()].map((id) => flushLog(id)));
}

/** Test-only: drop all in-memory log state. */
export function resetLogsForTests(): void {
	live.clear();
}

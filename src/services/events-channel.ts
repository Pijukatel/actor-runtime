/**
 * Fan-out for the per-run events websocket (`api/events-ws.ts`) - the platform's `systemInfo`/`aborting`
 * channel, modelled directly on `services/logs.ts`'s `live` map + `subscribers: Set`. The one structural
 * difference from `logs.ts`: there is no authentication on this endpoint at all (a deliberate decision,
 * not an oversight - see `requirements/api.md`'s "No authentication at all" note on this endpoint), so
 * strict per-run isolation has to come from somewhere other than a credential check - it comes from here.
 * A subscriber is only ever added to *its own run's* entry in
 * `live`; there is no broadcast/all-runs listener anywhere in this module, so a container that somehow
 * learns another run's id still cannot be handed that other run's frames by anything this module does.
 *
 * This module owns the platform envelope shaping for both frame kinds (`{"name": "...", "data": {...}}`,
 * one text frame per publish) and the running avg/max accumulation `systemInfo` needs - `docker-driver.ts`
 * only ever hands this module a raw `RunResourceSample`; the CPU-percent-of-grant math, the
 * `isCpuOverloaded` threshold, and the avg/max bookkeeping all live here, never in the driver.
 */
import { dedicatedCpusFor } from '../resources.js';
import type { RunResourceSample } from '../driver/types.js';

/** The only part of a run's grant this module needs - `services/runs.ts` passes `record.options`
 * directly, which structurally satisfies this (and nothing more is read off it). */
export interface RunResourceGrant {
	memoryMbytes: number;
}

/** Strict `>`, not `>=` - a sample computing exactly the threshold is not overloaded (see
 * `requirements/actor-driver.md`'s "Run resource telemetry" section for the full `isCpuOverloaded`
 * contract). */
const CPU_OVERLOAD_RATIO_THRESHOLD = 0.95;

interface RunEventsState {
	subscribers: Set<(frame: string) => void>;
	/** Running-average bookkeeping for `systemInfo`'s `memAvgBytes`/`cpuAvgUsage` fields - includes every
	 * sample published for this run so far, this one included. */
	sampleCount: number;
	cpuUsageSum: number;
	cpuUsageMax: number;
	memoryUsageSum: number;
	/** Set by `markEventsTerminal` - `api/events-ws.ts` polls this (mirroring `logs.ts`'s `isLogTerminal`/
	 * `serveLog` pattern) to decide when to close an open connection with `1000`. */
	terminal: boolean;
}

const live = new Map<string, RunEventsState>();

function getOrCreate(runId: string): RunEventsState {
	let state = live.get(runId);
	if (!state) {
		state = {
			subscribers: new Set(),
			sampleCount: 0,
			cpuUsageSum: 0,
			cpuUsageMax: 0,
			memoryUsageSum: 0,
			terminal: false,
		};
		live.set(runId, state);
	}
	return state;
}

function broadcast(state: RunEventsState, frame: string): void {
	for (const subscriber of state.subscribers) subscriber(frame);
}

/**
 * Shapes one `RunResourceSample` into the platform's `systemInfo` envelope and pushes it to every current
 * subscriber of `runId` - a no-op (state still updated, frame still built, simply nothing to send to) when
 * nobody is connected, the same best-effort tolerance `logs.ts`'s `appendLog` has for a run with no
 * `?stream=true` client.
 *
 * All eight fields are present on every frame, never a subset - apify-sdk-python's pydantic model
 * declares every one required with no default, so a frame missing even one is silently dropped there.
 *
 * - `cpuCurrentUsage` is `sample.cpuPercentOfOneCore` verbatim - percent of ONE core, the same convention
 *   `docker stats` itself uses, never percent of `grant`.
 * - `memMaxBytes` is `sample.memoryLimitBytes` - the container's configured memory LIMIT, constant for the
 *   run's whole lifetime, never a genuine running peak (despite the field's upstream name).
 * - `isCpuOverloaded` is the ratio-only test documented in `requirements/actor-driver.md`'s "Run resource
 *   telemetry" section: `usedCores / grantedCores > 0.95`, `usedCores` derived from this same sample's
 *   `cpuCurrentUsage`, `grantedCores` from `grant.memoryMbytes` via `dedicatedCpusFor` - no CFS-throttling
 *   term, no other input.
 * - `memAvgBytes`/`cpuAvgUsage`/`cpuMaxUsage` are running figures over every sample published for this run
 *   so far (this one included), reset only when the run itself is a new one (a fresh `live` entry).
 */
export function publishSystemInfo(runId: string, sample: RunResourceSample, grant: RunResourceGrant): void {
	const state = getOrCreate(runId);
	state.sampleCount += 1;
	state.cpuUsageSum += sample.cpuPercentOfOneCore;
	state.cpuUsageMax = Math.max(state.cpuUsageMax, sample.cpuPercentOfOneCore);
	state.memoryUsageSum += sample.memoryBytes;

	const grantedCores = dedicatedCpusFor(grant.memoryMbytes);
	const usedCores = sample.cpuPercentOfOneCore / 100;
	const isCpuOverloaded = grantedCores > 0 && usedCores / grantedCores > CPU_OVERLOAD_RATIO_THRESHOLD;

	const payload = {
		memAvgBytes: state.memoryUsageSum / state.sampleCount,
		memCurrentBytes: sample.memoryBytes,
		memMaxBytes: sample.memoryLimitBytes,
		cpuAvgUsage: state.cpuUsageSum / state.sampleCount,
		cpuMaxUsage: state.cpuUsageMax,
		cpuCurrentUsage: sample.cpuPercentOfOneCore,
		isCpuOverloaded,
		createdAt: sample.at.toISOString(),
	};
	broadcast(state, JSON.stringify({ name: 'systemInfo', data: payload }));
}

/**
 * Publishes `{"name":"aborting","data":{}}` - a literal empty object, matching apify-sdk-js's own
 * event-name doc table (`aborting`'s payload is `void`) and crawlee-python's zero-field
 * `EventAbortingData`. Best-effort, same no-subscriber tolerance as `publishSystemInfo` above: a graceful
 * abort with nobody connected still calls this, it just reaches no one.
 */
export function publishAborting(runId: string): void {
	broadcast(getOrCreate(runId), JSON.stringify({ name: 'aborting', data: {} }));
}

/** Returns an unsubscribe function, mirroring `logs.ts`'s `subscribeLog`. */
export function subscribeEvents(runId: string, onFrame: (frame: string) => void): () => void {
	const state = getOrCreate(runId);
	state.subscribers.add(onFrame);
	return () => state.subscribers.delete(onFrame);
}

/** Marks `runId` terminal - `api/events-ws.ts`'s connection handler polls `isEventsTerminal` (the same
 * poll-and-close shape `api/routes/logs.ts`'s `serveLog` already uses for `?stream=true`) and closes the
 * socket with `1000` once it observes this flip, which is what actually drives the close; this call
 * itself never touches a socket. */
export function markEventsTerminal(runId: string): void {
	getOrCreate(runId).terminal = true;
}

export function isEventsTerminal(runId: string): boolean {
	return live.get(runId)?.terminal ?? false;
}

/** Number of live subscribers currently fanned out to for `runId` - exists for the same leak-observability
 * reason `logs.ts`'s `getSubscriberCount` does: proof that a disconnected client's subscriber was actually
 * cleaned up, not left dangling. */
export function getSubscriberCount(runId: string): number {
	return live.get(runId)?.subscribers.size ?? 0;
}

/** Test-only: drop all in-memory events state. */
export function resetEventsChannelForTests(): void {
	live.clear();
}

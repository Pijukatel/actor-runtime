/**
 * Fan-out for the per-run events websocket, modelled on `services/logs.ts`. A subscriber is only ever
 * added to its own run's entry and there is no broadcast listener, which is what keeps one run's frames
 * away from another. Owns the envelope shaping and the avg/max accumulation; the driver only measures.
 */
import { dedicatedCpusFor } from '../resources.js';
import type { RunResourceSample } from '../driver/types.js';
import type { ResourceStatsSnapshot } from '../pricing.js';

/** The only part of a run's grant this module needs. */
export interface RunResourceGrant {
	memoryMbytes: number;
}

/** Strict `>`: a sample computing exactly the threshold is not overloaded. */
const CPU_OVERLOAD_RATIO_THRESHOLD = 0.95;

interface RunEventsState {
	subscribers: Set<(frame: string) => void>;
	/** Covers every sample published for this run so far. */
	sampleCount: number;
	cpuUsageSum: number;
	cpuUsageMax: number;
	memoryUsageSum: number;
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
 * Shapes one sample into the `systemInfo` envelope and sends it to `runId`'s subscribers; a run with
 * nobody connected is fine. All eight fields are always present - the Python SDK drops a frame missing
 * any of them. `cpuCurrentUsage` is percent of one core, `memMaxBytes` is the configured limit rather
 * than an observed peak, and `isCpuOverloaded` compares used cores against the grant.
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

/** Publishes `{"name":"aborting","data":{}}` - both SDKs define this event as carrying no data. */
export function publishAborting(runId: string): void {
	broadcast(getOrCreate(runId), JSON.stringify({ name: 'aborting', data: {} }));
}

/** Returns an unsubscribe function, mirroring `logs.ts`'s `subscribeLog`. */
export function subscribeEvents(runId: string, onFrame: (frame: string) => void): () => void {
	const state = getOrCreate(runId);
	state.subscribers.add(onFrame);
	return () => state.subscribers.delete(onFrame);
}

/** Marks `runId` terminal; connections observe this by polling and close themselves. */
export function markEventsTerminal(runId: string): void {
	getOrCreate(runId).terminal = true;
}

export function isEventsTerminal(runId: string): boolean {
	return live.get(runId)?.terminal ?? false;
}

/** Live subscriber count for `runId`, so a leaked subscriber is observable. */
export function getSubscriberCount(runId: string): number {
	return live.get(runId)?.subscribers.size ?? 0;
}

/**
 * The three sampler-derived aggregates this run has accumulated so far - `services/runs.ts` snapshots
 * this onto `RunRecord.resourceStats` in the same terminal-transition write that sets `finishedAt`
 * (`pricing.ts`'s doc comment explains why these can't be derived after the fact the way `computeUnits`
 * can). All-zero for a run that never published a sample (e.g. one that never got a container, or one
 * this process never received samples for after a restart) - never throws, never `undefined`.
 */
export function getResourceStatsSnapshot(runId: string): ResourceStatsSnapshot {
	const state = live.get(runId);
	if (!state || state.sampleCount === 0) {
		return { memAvgBytes: 0, cpuAvgUsage: 0, cpuMaxUsage: 0 };
	}
	return {
		memAvgBytes: state.memoryUsageSum / state.sampleCount,
		cpuAvgUsage: state.cpuUsageSum / state.sampleCount,
		cpuMaxUsage: state.cpuUsageMax,
	};
}

/** Test-only: drop all in-memory events state. */
export function resetEventsChannelForTests(): void {
	live.clear();
}

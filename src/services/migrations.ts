/**
 * Emulated migrations and reboots (`requirements/api.md`, "Migration emulation"). A migration is not a
 * run status - the run keeps running while its container is replaced, so this module only tracks which
 * container stops must restart the run instead of finishing it.
 */
import type { Driver } from '../driver/types.js';
import type { RunRecord } from '../storage/entities.js';
import { getRegistries } from '../storage/registries.js';
import { publishMigrating } from './events-channel.js';

/** The platform promises only "a few seconds"; SDK defaults reboot immediately anyway. */
export const MIGRATING_STOP_WINDOW_MS = 5_000;

export type RunRestartKind = 'migration' | 'reboot';

export type MigrateRunResult = 'migrating' | 'joined' | 'not-running';

const pendingRestarts = new Map<string, RunRestartKind>();

const pendingMigrationStops = new Map<string, ReturnType<typeof setTimeout>>();

export async function migrateRun(driver: Driver, run: RunRecord): Promise<MigrateRunResult> {
	const current = await getRegistries().runs.get(run.id);
	if (!current || current.status !== 'RUNNING') return 'not-running';
	if (pendingMigrationStops.has(run.id)) return 'joined';

	publishMigrating(run.id);
	const timer = setTimeout(() => {
		pendingMigrationStops.delete(run.id);
		void stopForMigration(driver, run.id).catch((error: unknown) => {
			console.error(`run ${run.id}: migration stop failed`, error);
		});
	}, MIGRATING_STOP_WINDOW_MS);
	pendingMigrationStops.set(run.id, timer);
	return 'migrating';
}

/** The status re-check happens inside the serialized write, so an abort that landed mid-window wins. */
async function stopForMigration(driver: Driver, runId: string): Promise<void> {
	let wasRunning = false;
	await getRegistries().runs.update(runId, (current) => {
		if (!current || current.status !== 'RUNNING') return current;
		wasRunning = true;
		return {
			...current,
			stats: { ...current.stats, migrationCount: (current.stats?.migrationCount ?? 0) + 1 },
		};
	});
	if (!wasRunning) return;

	pendingRestarts.set(runId, 'migration');
	await driver.abortRun(runId);
}

/** A reboot cancels an open migration window - the SDKs call the reboot endpoint from their
 * `migrating` handler, and the restarted container must not be killed by the stale stop. Non-`RUNNING`
 * runs get only the count bump, matching the platform. */
export async function rebootRun(driver: Driver, run: RunRecord): Promise<RunRecord | null> {
	const pendingStop = pendingMigrationStops.get(run.id);
	if (pendingStop) {
		clearTimeout(pendingStop);
		pendingMigrationStops.delete(run.id);
	}

	let wasRunning = false;
	const updated = await getRegistries().runs.update(run.id, (current) => {
		if (!current) return null;
		wasRunning = current.status === 'RUNNING';
		if (current.status !== 'RUNNING' && current.status !== 'READY' && current.status !== 'ABORTING') {
			return current; // terminal - the route rejects these already
		}
		return {
			...current,
			stats: { ...current.stats, rebootCount: (current.stats?.rebootCount ?? 0) + 1 },
		};
	});
	if (!wasRunning) return updated;

	pendingRestarts.set(run.id, 'reboot');
	await driver.abortRun(run.id);
	return updated;
}

/** Consumed once per container exit by `runInBackground`. */
export function consumeRunRestart(runId: string): RunRestartKind | undefined {
	const kind = pendingRestarts.get(runId);
	if (kind !== undefined) pendingRestarts.delete(runId);
	return kind;
}

/** Called when a run ends for real, so no armed stop timer outlives it. */
export function clearRunRestartState(runId: string): void {
	pendingRestarts.delete(runId);
	const timer = pendingMigrationStops.get(runId);
	if (timer) {
		clearTimeout(timer);
		pendingMigrationStops.delete(runId);
	}
}

/** Test observability. */
export function hasPendingMigrationStop(runId: string): boolean {
	return pendingMigrationStops.has(runId);
}

/** Test-only. */
export function resetMigrationsForTests(): void {
	for (const timer of pendingMigrationStops.values()) clearTimeout(timer);
	pendingMigrationStops.clear();
	pendingRestarts.clear();
}

/**
 * `.actor/actor.json`'s `storages.datasets` - the named datasets every run of the Actor gets besides its
 * default one - read at build time and created at run start, as on the platform.
 */
import type { RunRecord, SourceFile } from '../storage/entities.js';
import { parseActorJson } from './actor-source-files.js';

export const DEFAULT_STORAGE_ALIAS = 'default';

export type RunStorageIds = NonNullable<RunRecord['storageIds']>;

/** The declared aliases other than `default`, in declaration order; `undefined` when there are none.
 * Assumes the file already passed `describeActorJsonDefect`, which enforces the alias format and limits. */
export function resolveExtraDatasetAliases(sourceFiles: SourceFile[], actorPath = ''): string[] | undefined {
	const actorJson = parseActorJson(sourceFiles, actorPath);
	if (actorJson.outcome !== 'parsed') return undefined;
	const { storages } = (actorJson.specification ?? {}) as { storages?: { datasets?: unknown } };
	const datasets = storages?.datasets;
	if (typeof datasets !== 'object' || datasets === null) return undefined;
	const aliases = Object.keys(datasets).filter((alias) => alias !== DEFAULT_STORAGE_ALIAS);
	return aliases.length > 0 ? aliases : undefined;
}

/** Runs created before `storageIds` was recorded still report their default storages under it. */
export function runStorageIds(run: RunRecord): RunStorageIds {
	return (
		run.storageIds ?? {
			datasets: { [DEFAULT_STORAGE_ALIAS]: run.defaultDatasetId },
			keyValueStores: { [DEFAULT_STORAGE_ALIAS]: run.defaultKeyValueStoreId },
			requestQueues: { [DEFAULT_STORAGE_ALIAS]: run.defaultRequestQueueId },
		}
	);
}

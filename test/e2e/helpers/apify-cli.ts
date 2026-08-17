import { execFileSync, spawnSync } from 'node:child_process';

/**
 * Invokes the stock, unmodified `apify-cli` from npm (v1.8.0 or newer, per `cli.md`) via `npx`, so the
 * e2e suite does not require a global install. No fork/patch of the CLI - exactly `cli.md`'s contract.
 */
export function apify(args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }): string {
	return execFileSync('npx', ['-y', '-p', 'apify-cli', 'apify', ...args], {
		cwd: options.cwd,
		env: options.env,
		encoding: 'utf8',
	});
}

/**
 * Like `apify()`, but returns stdout AND stderr combined. The CLI writes human-readable output —
 * including the log content of `apify runs log` (see `outputJobLog`'s `process.stderr.write`) — to
 * stderr, keeping stdout for machine-readable payloads, so log-content assertions must read stderr.
 */
export function apifyAllOutput(args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }): string {
	const result = spawnSync('npx', ['-y', '-p', 'apify-cli', 'apify', ...args], {
		cwd: options.cwd,
		env: options.env,
		encoding: 'utf8',
	});
	if (result.status !== 0) {
		throw new Error(`apify ${args.join(' ')} exited with ${result.status}:\n${result.stderr}`);
	}
	return `${result.stdout}\n${result.stderr}`;
}

export function apifyEnv(): NodeJS.ProcessEnv {
	return {
		...process.env,
		APIFY_CLIENT_BASE_URL: 'http://localhost:3333',
		APIFY_CONSOLE_URL: 'http://localhost:3000',
	};
}

/** `apify push --json` prints a `PushResult` (see apify-cli `push.ts`) to stdout. */
export interface PushResult {
	ok: boolean;
	actor: { id: string; url: string };
	build: { id: string; number: string; status: string; url: string };
}

/** `apify call --json` prints a `RunResultJson` (see apify-cli `run-result.ts`) to stdout. */
export interface CallResult {
	ok: boolean;
	run: { id: string; status: string; url: string };
	storage: { defaultDatasetId: string; defaultKeyValueStoreId: string; datasetUrl: string };
}

export interface DatasetInfoResult {
	id: string;
	itemCount: number;
}

import { execFileSync } from 'node:child_process';

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

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

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

/** Any non-empty value works - the runtime maps every non-empty token to its single local user. */
const APIFY_TOKEN = 'anything';

export function apifyEnv(): NodeJS.ProcessEnv {
	return {
		...process.env,
		APIFY_CLIENT_BASE_URL: 'http://localhost:3333',
		APIFY_CONSOLE_URL: 'http://localhost:3000',
		APIFY_TOKEN,
		// Forces the CLI's file-based credential store instead of the OS keyring, so
		// `ensureApifyCliAuthenticated()` below (which writes that file directly) is what the CLI
		// actually reads, deterministically, in every environment this suite runs in.
		APIFY_DISABLE_KEYRING: '1',
	};
}

/**
 * `apify login` is no longer a supported command (`requirements/cli.md`). It authenticates by
 * writing a token into the CLI's own on-disk credential store (`~/.apify/auth.json`, per
 * `apify-cli`'s `lib/consts.ts#AUTH_FILE_PATH`) and letting the CLI's first authenticated request
 * resolve and persist the account's username/id (`lib/utils.ts#getLoggedClient`) - exactly what
 * `apify login --token <x>` itself does under the hood (`commands/auth/login.ts#tryToLogin`). This
 * writes that same `{ token }` seed directly, without ever invoking the `login` command.
 *
 * `APIFY_TOKEN` in `apifyEnv()` above is not, by itself, sufficient: real `apify-cli` v1.8.0 only
 * reads that env var for `apify actor:*` commands and `mcp install` (`lib/actor.ts`,
 * `commands/mcp/install.ts`) - `push`/`call`/`runs`/`datasets`/`api` all resolve their token
 * exclusively through `getLoggedClientOrThrow()` -> `getLoggedClient()` -> the credential store, with
 * no env-var fallback. Verified by reading `apify-cli`'s installed source and confirming live: with
 * only `APIFY_TOKEN` set and no stored credentials, `apify info`/`apify api GET v2/users/me` fail with
 * "You are not logged in with your Apify account." Seeding the credential store below is what makes
 * every command actually work.
 */
export function ensureApifyCliAuthenticated(): void {
	const authDir = join(homedir(), '.apify');
	mkdirSync(authDir, { recursive: true });
	const authFilePath = join(authDir, 'auth.json');

	let existing: Record<string, unknown> = {};
	if (existsSync(authFilePath)) {
		try {
			existing = JSON.parse(readFileSync(authFilePath, 'utf8')) as Record<string, unknown>;
		} catch {
			existing = {};
		}
	}

	if (existing.token) return; // already authenticated (e.g. a developer's own real login)

	writeFileSync(authFilePath, JSON.stringify({ ...existing, token: APIFY_TOKEN }, null, '\t'), { mode: 0o600 });
}

/** The `{ data: ... }` envelope every Apify API response (and `apify api`'s printed output) uses. */
export interface ApiEnvelope<T> {
	data: T;
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

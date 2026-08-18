import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

/** Any non-empty value works - the runtime creates a user for this token ad-hoc on its first API
 * request (`cli.md`'s User bootstrap), the same token throughout this e2e run mapping back to that one
 * user on every subsequent request. */
const APIFY_TOKEN = 'anything';

/**
 * Creates a suite-owned, empty directory to serve as `$HOME` (and `$XDG_CONFIG_HOME`, for safety) for
 * every `apify` invocation in the e2e run. `apify-cli`'s credential store path derives from
 * `os.homedir()` (`lib/consts.ts`: `GLOBAL_CONFIGS_FOLDER = () => join(homedir(), '.apify')` ->
 * `AUTH_FILE_PATH = () => join(GLOBAL_CONFIGS_FOLDER(), 'auth.json')`), and Node's `os.homedir()`
 * itself honors `$HOME` on POSIX ("uses the $HOME environment variable if defined" - Node docs) -
 * verified against the installed `apify-cli` source. Pointing `HOME` here means `apify login` below
 * writes and reads `<this dir>/.apify/auth.json`, never the real developer's/runner's `~/.apify`.
 * Call once in `beforeAll`; pass the returned path to `apifyEnv()` and `loginApifyCli()`.
 */
export function createIsolatedApifyHome(): string {
	return mkdtempSync(join(tmpdir(), 'actor-runtime-e2e-apify-home-'));
}

export function removeIsolatedApifyHome(dir: string): void {
	rmSync(dir, { recursive: true, force: true });
}

export function apifyEnv(isolatedApifyHome: string): NodeJS.ProcessEnv {
	return {
		...process.env,
		APIFY_CLIENT_BASE_URL: 'http://localhost:3333',
		APIFY_CONSOLE_URL: 'http://localhost:3000',
		HOME: isolatedApifyHome,
		XDG_CONFIG_HOME: isolatedApifyHome,
		// Forces the CLI's file-based credential store instead of the OS keyring, so the isolated
		// `auth.json` written by `loginApifyCli()` below is what every command actually reads,
		// deterministically, in every environment this suite runs in.
		APIFY_DISABLE_KEYRING: '1',
	};
}

/**
 * Performs one genuine `apify login --token <token>` inside the isolated `$HOME` from
 * `createIsolatedApifyHome()` - the CLI's own supported bootstrap for the "already logged in" state
 * (`commands/auth/login.ts#tryToLogin` -> `lib/utils.ts#getLoggedClient`), not a hand-written
 * `auth.json`. `login`'s own base-URL resolution (`getConsoleUrl().includes('localhost') ?
 * 'http://localhost:3333' : undefined`) targets this runtime because `apifyEnv()` sets
 * `APIFY_CONSOLE_URL` to `http://localhost:3000` - independent of `APIFY_CLIENT_BASE_URL` - verified
 * against apify-cli's installed source. Any non-empty token works: the runtime creates a user for it ad
 * hoc on first use (fabricated unless the token resolves against the real platform -
 * `requirements/cli.md`).
 */
export function loginApifyCli(cwd: string, isolatedApifyHome: string): void {
	apify(['login', '--token', APIFY_TOKEN], { cwd, env: apifyEnv(isolatedApifyHome) });
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

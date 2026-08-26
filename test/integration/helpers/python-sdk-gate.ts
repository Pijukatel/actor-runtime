/**
 * Decision logic for whether `test/integration/python-sdk-charging.test.ts` should run, skip, or fail
 * when the Python `apify` SDK (`python3 -c "import apify"`) isn't importable in the current environment.
 *
 * Extracted as a pure function so the CI-vs-local behaviour can be unit-tested directly, without needing
 * to actually toggle Python availability by spawning subprocesses.
 */

export type PythonSdkGateDecision = 'run' | 'skip' | 'fail';

/**
 * - The SDK is importable -> always `'run'`.
 * - The SDK isn't importable, and this is CI -> `'fail'`. The `checks` job in
 *   `.github/workflows/ci.yml` provisions the `apify` package itself before `pnpm test` runs, so a
 *   missing package there means that provisioning step regressed, not that this environment
 *   legitimately has no Python. `requirements/test.md`'s CI philosophy - stated for the e2e suite's
 *   Docker dependency, "a missing daemon fails the job instead" - applies the same way here: a
 *   dependency CI is expected to provide must never silently no-op when it's absent.
 * - The SDK isn't importable, and this isn't CI -> `'skip'`. A developer's laptop with no Python
 *   installed is the reasonable local case; skip cleanly rather than forcing every contributor to
 *   install Python just to run `pnpm test`.
 */
export function decidePythonSdkGate(options: { available: boolean; ci: boolean }): PythonSdkGateDecision {
	if (options.available) return 'run';
	return options.ci ? 'fail' : 'skip';
}

/** True when running in CI, per GitHub Actions' own convention of always setting `CI=true`. */
export function isCi(env: NodeJS.ProcessEnv = process.env): boolean {
	return Boolean(env.CI);
}

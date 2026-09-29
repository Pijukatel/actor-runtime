/**
 * Whether a registered dev folder is mounted into runs at all (`actor-driver.md`'s "Bind mount volumes
 * with Actor source code"). Off by default and reset on every restart, like the other Settings toggles:
 * `apify push` registers a folder on its own, so mounting it must be an explicit opt-in. Read and written
 * only here, by the API route (`api/routes/live-dev-folder.ts`) and the console's `/settings` page alike.
 */
let enabled = false;

export function isLiveDevFolderEnabled(): boolean {
	return enabled;
}

export function setLiveDevFolderEnabled(value: boolean): void {
	enabled = value;
}

/** Test-only. Never call this from runtime code. */
export function resetLiveDevFolderEnabledForTests(): void {
	enabled = false;
}

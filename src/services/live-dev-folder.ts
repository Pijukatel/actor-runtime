/** Off by default: `apify push` registers a dev folder on its own, so mounting it must be an explicit opt-in. */
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

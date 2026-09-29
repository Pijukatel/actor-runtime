/**
 * Whether the runtime hands a real Apify Proxy password to Actors at all (`console.md`'s "Settings page").
 * On by default and reset on every restart, like the upstream fallback toggles. Read only through
 * `services/users.ts: resolveProxyPassword`, so `/users/me` and run containers never disagree - an SDK
 * that finds no `APIFY_PROXY_PASSWORD` asks `/users/me` for one instead.
 */
let enabled = true;

export function isApifyProxyEnabled(): boolean {
	return enabled;
}

export function setApifyProxyEnabled(value: boolean): void {
	enabled = value;
}

/** Test-only. Never call this from runtime code. */
export function resetApifyProxyEnabledForTests(): void {
	enabled = true;
}

/** Written once per run whose container gets a proxy password: whether the Actor then uses the real
 * proxy is up to its code, and any such traffic is billed - easy to miss in a runtime that otherwise
 * keeps everything local. */
export const REAL_APIFY_PROXY_WARNING =
	'WARNING: This run was given a real Apify Proxy password (APIFY_PROXY_PASSWORD), so the Actor can use ' +
	'the real Apify Proxy, billed to your Apify account. To disable it, turn off "Use Apify Proxy" on the ' +
	"console's Settings page.";

/**
 * The real-platform identity probe (`cli.md`'s User bootstrap): a single, best-effort `GET
 * <upstream>/v2/users/me` per unseen token. This module only knows how to make that one HTTP call and
 * interpret its response - the token->user registry, per-token concurrency, and the fabricated-identity
 * fallback all live in `services/users.ts: getOrCreateUserForToken()`, the only caller of
 * `fetchRealIdentity` below.
 */

/** Overridable for tests (a tiny local stub server) and for pointing at a non-production platform;
 * defaults to the real Apify API. Read fresh on every call, not frozen at import time, so a test can
 * flip it between cases within the same file/process (see `identity-resolution.test.ts`). Trailing
 * slashes are trimmed so a caller concatenating a leading-`/` path (as `services/api-fallback.ts`'s
 * replay does, and as this module's own `/v2/users/me` probe below does) never produces a doubled `//`. */
export function upstreamApiBaseUrl(): string {
	const configured = process.env.APIFY_UPSTREAM_API_BASE_URL ?? 'https://api.apify.com';
	return configured.replace(/\/+$/, '');
}

/** Short and non-retried on purpose - this runs lazily, on the first request for a given token, and
 * must never make the dev loop feel like it is hanging when there is no internet. */
const UPSTREAM_TIMEOUT_MS = 3000;

export interface RealIdentity {
	id: string;
	username: string;
	/** Real Apify Proxy password for this account, when the upstream response includes one - harvested
	 * so the runtime can forward the account's *real* proxy credential into that user's Actor containers
	 * instead of falling back to nothing (see `services/runs.ts: buildEnv()`). */
	proxyPassword?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

/**
 * `GET <upstreamApiBaseUrl()>/v2/users/me` with the CLI's own token, exactly what a real logged-in CLI
 * would send. Returns `null` for anything other than a clean 200 with the expected shape - offline,
 * non-200 (including a token that simply is not a real Apify token), a timeout, or a malformed body all
 * collapse to the same "could not resolve, fabricate a local identity" outcome. No retries: a single
 * attempt per token, ever (see `getOrCreateUserForToken`'s per-token cache).
 */
export async function fetchRealIdentity(token: string): Promise<RealIdentity | null> {
	try {
		const response = await fetch(`${upstreamApiBaseUrl()}/v2/users/me`, {
			headers: { Authorization: `Bearer ${token}` },
			signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
		});
		if (!response.ok) return null;

		const body: unknown = await response.json();
		const data = isRecord(body) && isRecord(body.data) ? body.data : undefined;
		if (!data || typeof data.id !== 'string' || typeof data.username !== 'string') return null;

		const proxy = isRecord(data.proxy) ? data.proxy : undefined;
		const proxyPassword = typeof proxy?.password === 'string' ? proxy.password : undefined;

		return { id: data.id, username: data.username, proxyPassword };
	} catch {
		return null;
	}
}

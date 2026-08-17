import type { UserRecord } from '../storage/entities.js';
import { getRegistries } from '../storage/registries.js';
import { getDefaultUser } from './users.js';

/** Overridable for tests (a tiny local stub server) and for pointing at a non-production platform;
 * defaults to the real Apify API. Read fresh on every call, not frozen at import time, so a test can
 * flip it between cases within the same file/process (see `identity-resolution.test.ts`). */
function upstreamApiBaseUrl(): string {
	return process.env.APIFY_UPSTREAM_API_BASE_URL ?? 'https://api.apify.com';
}

/** Short and non-retried on purpose - this runs lazily, on the first authenticated request for a given
 * token, and must never make the dev loop feel like it is hanging when there is no internet. */
const UPSTREAM_TIMEOUT_MS = 3000;

interface RealIdentity {
	id: string;
	username: string;
	/** Real Apify Proxy password for this account, when the upstream response includes one - harvested
	 * so the runtime can forward the account's *real* proxy credential into Actor containers instead of
	 * always defaulting to the fixed local placeholder (see `services/runs.ts: buildEnv()`). */
	proxyPassword?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

/**
 * `GET <upstreamApiBaseUrl()>/v2/users/me` with the CLI's own token, exactly what a real logged-in CLI
 * would send. Returns `null` for anything other than a clean 200 with the expected shape - offline,
 * non-200 (including a token that simply is not a real Apify token), a timeout, or a malformed body all
 * collapse to the same "could not resolve, stay local" outcome. No retries: a single attempt per token,
 * ever (see `ensureIdentityResolvedForToken`).
 */
async function fetchRealIdentity(token: string): Promise<RealIdentity | null> {
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

/**
 * Per-token, per-process memo of "resolve this token against the real platform, and if it is a real
 * token, adopt that identity onto the single default user record". A map of *promises*, not resolved
 * values, so two concurrent first-requests for a brand-new token also collapse onto one upstream call
 * instead of racing each other. A negative outcome (offline, invalid token, timeout) is cached the same
 * way as a positive one - "stays local for the process lifetime" is an acceptable trade for a dev tool
 * that must never re-probe a dead upstream on every request.
 */
const resolutionByToken = new Map<string, Promise<void>>();

async function resolveAndAdopt(token: string): Promise<void> {
	const identity = await fetchRealIdentity(token);
	if (!identity) {
		console.log(`could not resolve token against ${upstreamApiBaseUrl()}, using local identity`);
		return;
	}

	const user = await getDefaultUser();
	const adopted: UserRecord = {
		...user,
		realId: identity.id,
		realUsername: identity.username,
		realProxyPassword: identity.proxyPassword ?? user.realProxyPassword,
	};
	await getRegistries().users.set(user.id, adopted);
}

/**
 * The proxy password the runtime should hand out - to `/users/me`'s DTO (`api/routes/users.ts`) and to
 * every Actor run container's `APIFY_PROXY_PASSWORD` (`services/runs.ts: buildEnv()`) alike - so both
 * call sites share one precedence: the runtime's own `APIFY_PROXY_PASSWORD` (explicit operator config)
 * always wins when set; otherwise the password harvested from the real platform at identity-adoption
 * time, if any; otherwise `undefined`. Never a placeholder - callers must omit the field/env var
 * entirely rather than invent a value, exactly like `APIFY_PROXY_PASSWORD` already does for run
 * containers (`actor-driver.md`).
 */
export function effectiveProxyPassword(user: UserRecord): string | undefined {
	return process.env.APIFY_PROXY_PASSWORD ?? user.realProxyPassword;
}

/**
 * Ensures the real-platform identity check for `token` has run at least once for this process, and
 * awaits its outcome. Safe (and cheap) to call on every authenticated request: `auth()` does exactly
 * that, and every call after the first for a given token resolves immediately against the cached
 * promise with no I/O.
 */
export function ensureIdentityResolvedForToken(token: string): Promise<void> {
	let pending = resolutionByToken.get(token);
	if (!pending) {
		pending = resolveAndAdopt(token);
		resolutionByToken.set(token, pending);
	}
	return pending;
}

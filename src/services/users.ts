import type { UserRecord } from '../storage/entities.js';
import { getRegistries } from '../storage/registries.js';
import { KeyedMutex } from '../storage/mutex.js';
import { fetchRealIdentity, upstreamApiBaseUrl } from './identity-resolution.js';

/** Serialises "resolve token -> create-if-missing" per token, so two concurrent first-requests for the
 * same brand-new token can never both pass the not-found check and mint two users - the same
 * lookup-then-create race `services/storages.ts`'s `createByNameMutex` guards against for
 * `createStorage`. Different tokens never block each other (`KeyedMutex` serialises per key only). */
const tokenMutex = new KeyedMutex();

/** In-memory, per-process memo of token -> already-resolved user. Warms the hot path (every request
 * after a token's first is a plain map read, no registry access at all) and, within one process, is
 * also what makes a brand-new token's upstream probe run at most once. Empty again after a restart -
 * `getOrCreateUserForToken` re-derives a stored token's user straight from `__USERS__` on that first
 * post-restart request rather than re-probing the upstream (see its doc comment). */
const userByToken = new Map<string, UserRecord>();

/** Count of fabricated users created so far *this process*. Seeded lazily from the existing contents of
 * `__USERS__` (via `seedFabricatedCount`) so a restart's numbering resumes where the previous process
 * left off - `local-user-{n}` must never repeat a number, even across restarts. */
let fabricatedCount: number | undefined;

async function seedFabricatedCount(): Promise<number> {
	if (fabricatedCount === undefined) {
		const existing = await getRegistries().users.list();
		const numbers = existing
			.map((user) => /^local-user-(\d+)$/.exec(user.username)?.[1])
			.filter((n): n is string => n !== undefined)
			.map(Number);
		fabricatedCount = numbers.length > 0 ? Math.max(...numbers) : 0;
	}
	return fabricatedCount;
}

/** `local-user-{number}` / `0000000000000000{number}` - verbatim from `cli.md`'s User bootstrap section.
 * `{number}` is a strictly increasing count of fabricated users, never reused (see `seedFabricatedCount`). */
async function fabricateUser(token: string): Promise<UserRecord> {
	const n = (await seedFabricatedCount()) + 1;
	fabricatedCount = n;
	return {
		id: `0000000000000000${n}`,
		username: `local-user-${n}`,
		token,
		createdAt: new Date().toISOString(),
	};
}

async function findUserByToken(token: string): Promise<UserRecord | null> {
	const all = await getRegistries().users.list();
	return all.find((user) => user.token === token) ?? null;
}

/**
 * Resolves the user owning `token`, creating one ad-hoc on the very first request that ever carries it
 * (`cli.md`'s User bootstrap) - there is no startup-created default user any more. Safe and cheap to
 * call on every authenticated request: `auth()` does exactly that.
 *
 * Three cases, in order:
 *  1. Already resolved this process (`userByToken` hit) - a plain map read, no I/O.
 *  2. Not resolved this process, but already persisted in `__USERS__` from an earlier process against
 *     the same data directory (i.e. this is a restart) - looked up straight from the registry by token,
 *     with **no re-probe of the upstream**: a token that already adopted a real identity (or was already
 *     fabricated) keeps that identity forever, it is not re-checked on every restart.
 *  3. Genuinely unseen (this token is in neither map): the real-platform probe runs exactly once
 *     (`fetchRealIdentity`) - success adopts that account's real `id`/`username`/proxy password as the
 *     new user's actual identity; failure fabricates `local-user-{n}` / `0000000000000000{n}` and logs
 *     one concise line. Either way the new record is written to `__USERS__` before being cached.
 *
 * Case 3's lookup-then-create is serialised per token (`tokenMutex`) so two concurrent first-requests
 * for the same new token can only ever produce one user; different tokens never block each other.
 */
export async function getOrCreateUserForToken(token: string): Promise<UserRecord> {
	const cached = userByToken.get(token);
	if (cached) return cached;

	return tokenMutex.run(token, async () => {
		// Re-check now that we hold the mutex: a concurrent call for the same token may have already
		// resolved (and cached) it while this call was waiting.
		const resolved = userByToken.get(token);
		if (resolved) return resolved;

		const stored = await findUserByToken(token);
		if (stored) {
			userByToken.set(token, stored);
			return stored;
		}

		const identity = await fetchRealIdentity(token);
		let user: UserRecord;
		if (identity) {
			user = {
				id: identity.id,
				username: identity.username,
				token,
				createdAt: new Date().toISOString(),
				proxyPassword: identity.proxyPassword,
			};
		} else {
			console.log(`could not resolve token against ${upstreamApiBaseUrl()}, using local identity`);
			user = await fabricateUser(token);
		}

		await getRegistries().users.set(user.id, user);
		userByToken.set(token, user);
		return user;
	});
}

export async function getUserById(userId: string): Promise<UserRecord | null> {
	return getRegistries().users.get(userId);
}

/**
 * The proxy password the runtime should hand out - to `/users/me`'s DTO (`api/routes/users.ts`) and to
 * every Actor run container's `APIFY_PROXY_PASSWORD` (`services/runs.ts: buildEnv()`) alike - so both
 * call sites share one precedence: the runtime's own `APIFY_PROXY_PASSWORD` (explicit operator config)
 * always wins when set; otherwise the password harvested for `user` at creation time, if any; otherwise
 * `undefined`. Never a placeholder - callers must omit the field/env var entirely rather than invent a
 * value, exactly like `APIFY_PROXY_PASSWORD` already does for run containers (`actor-driver.md`).
 */
export function resolveProxyPassword(user: UserRecord): string | undefined {
	return process.env.APIFY_PROXY_PASSWORD ?? user.proxyPassword;
}

/** Test-only: forget every per-process memo (the token -> user cache and the fabricated-number counter),
 * so a test that resets storage between cases does not hand back a stale mapping, or a fabricated-id
 * sequence, left over from a previous test's registry. Never call this from runtime code. */
export function resetUsersForTests(): void {
	userByToken.clear();
	fabricatedCount = undefined;
}

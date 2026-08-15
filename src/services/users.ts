import { generateId } from '../storage/ids.js';
import type { UserRecord } from '../storage/entities.js';
import { getRegistries } from '../storage/registries.js';

/**
 * Single default user for the POC, created once at startup ("the runtime learns the user" - not the
 * other way around; see `cli.md` amendment). Idempotent: if a user already exists (e.g. after a
 * restart against the same data directory), it is reused rather than duplicated.
 */
export async function bootstrapDefaultUser(): Promise<UserRecord> {
	const { users } = getRegistries();
	const existing = await users.list();
	if (existing[0]) return existing[0];

	const user: UserRecord = {
		id: generateId(),
		username: 'local-user',
		token: 'local-dev-token',
		createdAt: new Date().toISOString(),
	};
	await users.set(user.id, user);
	return user;
}

export async function getUserById(userId: string): Promise<UserRecord | null> {
	return getRegistries().users.get(userId);
}

/** Memoised only by id, not by record: a rename would still be reflected since `getUserById` re-reads
 * the registry every call. */
let cachedUserId: string | undefined;

/**
 * Resolves the single default user for read-only callers (the console) that must never themselves
 * create-if-missing - `bootstrapDefaultUser()` is a startup-time, create-or-reuse operation, and calling
 * it from every request handler (as the console used to) re-runs its whole "list, maybe create" path on
 * every page load for no reason, since `main()` already guarantees a user exists before either server
 * starts listening. Caches the id (not the record) after the first successful resolution so repeated
 * calls are a single `getUserById` read instead of a full `users.list()`.
 */
export async function getDefaultUser(): Promise<UserRecord> {
	if (cachedUserId) {
		const cached = await getUserById(cachedUserId);
		if (cached) return cached;
	}
	const [user] = await getRegistries().users.list();
	if (!user) {
		throw new Error('No default user has been bootstrapped - bootstrapDefaultUser() must run at startup');
	}
	cachedUserId = user.id;
	return user;
}

/** Test-only: forget the cached default-user id, so a test that resets storage between cases does not
 * hand back a stale id from a previous test's registry. Never call this from runtime code. */
export function resetDefaultUserCacheForTests(): void {
	cachedUserId = undefined;
}

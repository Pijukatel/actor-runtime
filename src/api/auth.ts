import type { NextFunction, Request, RequestHandler, Response } from 'express';

import type { UserRecord } from '../storage/entities.js';
import { getDefaultUser } from '../services/users.js';
import { ensureIdentityResolvedForToken } from '../services/identity-resolution.js';
import { sendError } from './envelope.js';

declare module 'express-serve-static-core' {
	interface Request {
		user?: UserRecord;
	}
}

function extractToken(req: Request): string | undefined {
	const header = req.header('authorization');
	if (header?.toLowerCase().startsWith('bearer ')) {
		const token = header.slice('bearer '.length).trim();
		if (token) return token;
	}
	const queryToken = req.query.token;
	if (typeof queryToken === 'string' && queryToken.length > 0) return queryToken;
	return undefined;
}

/**
 * Single default user for the POC: any non-empty bearer token or `?token=` authenticates as the one
 * bootstrap user. No per-user tokens, no ACLs. Resolves through `getDefaultUser()` - the same memoised
 * accessor the console uses - rather than re-implementing "list users, take the first one" here: this
 * runs on every API request, so it is the hot path the memo (one `getValue` instead of a full
 * `Registry.list()` scan) actually matters for.
 *
 * Also gives every token one lazy, best-effort chance to resolve against the real platform
 * (`ensureIdentityResolvedForToken`, `services/identity-resolution.ts`) before `getDefaultUser()` reads
 * the record back - cached per token after the first attempt, so this is a no-op await on every request
 * after that token's first.
 */
export function auth(): RequestHandler {
	return async (req: Request, res: Response, next: NextFunction) => {
		const token = extractToken(req);
		if (!token) {
			sendError(res, 401, 'user-not-authenticated', 'Authentication token is not provided');
			return;
		}
		await ensureIdentityResolvedForToken(token);
		// No try/catch: a `getDefaultUser()` rejection (bootstrap never ran) propagates as a rejected
		// promise, which Express 5 forwards to the generic error middleware in `server.ts` on its own -
		// that middleware already produces the same 500/`internal-error` envelope and (unlike a local
		// catch) logs the real error via `console.error` first.
		req.user = await getDefaultUser();
		next();
	};
}

/**
 * Non-null accessor for `req.user`, for every handler mounted behind `auth()` - past that middleware
 * the invariant "`user` is set" always holds, so this replaces a bare `req.user!` (an unchecked cast
 * repeated at every call site) with one place that actually asserts it. Throwing here is unreachable in
 * practice (surfaces as a 500 through `h`'s error middleware, not a user-facing error) - a route that
 * calls this without `auth()` having run first is a wiring bug, not a request the caller can cause.
 */
export function requireUser(req: Request): UserRecord {
	if (!req.user) {
		throw new Error('requireUser() called outside the authenticated router - auth() did not run first');
	}
	return req.user;
}

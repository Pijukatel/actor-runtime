import type { NextFunction, Request, RequestHandler, Response } from 'express';

import type { UserRecord } from '../storage/entities.js';
import { getOrCreateUserForToken } from '../services/users.js';
import { sendError } from './envelope.js';

// Augmenting a module makes it a real dependency: `@types/express-serve-static-core` is a direct
// devDependency (not reached through `@types/express`) because pnpm's isolated node_modules - unlike
// npm's hoisting - only resolves declared dependencies, and this `declare module` needs to resolve it.
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
 * Per-token multi-user auth: any non-empty bearer token or `?token=` authenticates as *that token's*
 * user, created ad-hoc on first sighting and resolved from cache/registry on every request after
 * (`getOrCreateUserForToken`, `services/users.ts` - which also owns the once-per-token real-platform
 * probe, `cli.md`'s User bootstrap). Different tokens resolve to different users; the same token always
 * resolves back to the same one, including across a restart.
 */
export function auth(): RequestHandler {
	return async (req: Request, res: Response, next: NextFunction) => {
		const token = extractToken(req);
		if (!token) {
			sendError(res, 401, 'user-not-authenticated', 'Authentication token is not provided');
			return;
		}
		// No try/catch: a `getOrCreateUserForToken()` rejection propagates as a rejected promise, which
		// Express 5 forwards to the generic error middleware in `server.ts` on its own - that middleware
		// already produces the same 500/`internal-error` envelope and (unlike a local catch) logs the real
		// error via `console.error` first.
		req.user = await getOrCreateUserForToken(token);
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

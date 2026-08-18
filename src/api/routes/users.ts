import { Router } from 'express';

import type { UserRecord } from '../../storage/entities.js';
import { getUserById, resolveProxyPassword } from '../../services/users.js';
import { requireUser } from '../auth.js';

import { sendData } from '../envelope.js';
import { recordNotFound } from '../errors.js';
import { h } from '../handler.js';

/** Full self DTO: every field the record itself carries, plus `proxy` when a password is actually known
 * (`resolveProxyPassword`) - never a placeholder, since apify-cli's `getLoggedClient` writes whatever
 * this returns straight into the CLI's own `auth.json` on every command. `id`/`username` are the
 * record's own fields outright (real or fabricated) - there is no overlay/display-preference layer on
 * top of them any more. */
function selfDto(user: UserRecord) {
	const proxyPassword = resolveProxyPassword(user);
	return {
		id: user.id,
		username: user.username,
		...(proxyPassword ? { proxy: { password: proxyPassword } } : {}),
	};
}

/**
 * Minimal DTO for a *different* user than the caller, resolved by id (real or fabricated). Mirrors the
 * real platform's `GET /users/:userId` for a non-owner: apify-core's handler
 * (`api/src/routes/users/user.ts`) only ever returns a public-profile subset to a caller who isn't that
 * user themselves - `getProfileOfUser()` (`username` + a profile object), never the id/email/proxy
 * fields it reserves for the owner. This POC has no profile object to expose, so the closest useful
 * analogue is `id` + `username` only - never `token`/`proxy`, which stay exclusive to `selfDto`.
 */
function publicDto(user: UserRecord) {
	return { id: user.id, username: user.username };
}

export function mountUsers(router: Router): void {
	router.get(
		'/users/me',
		h(async (req, res) => {
			sendData(res, selfDto(requireUser(req)));
		}),
	);

	router.get(
		'/users/:userId',
		h(async (req, res) => {
			const { userId } = req.params;
			const caller = requireUser(req);
			if (userId === 'me' || userId === caller.id) {
				sendData(res, selfDto(caller));
				return;
			}
			const other = await getUserById(userId as string);
			if (!other) throw recordNotFound();
			sendData(res, publicDto(other));
		}),
	);
}

import { Router } from 'express';

import type { UserRecord } from '../../storage/entities.js';
import { effectiveProxyPassword } from '../../services/identity-resolution.js';
import { requireUser } from '../auth.js';

import { sendData } from '../envelope.js';
import { recordNotFound } from '../errors.js';
import { h } from '../handler.js';

/**
 * Prefers the real, adopted identity (`realId`/`realUsername`, set once by `identity-resolution.ts`
 * when the caller's token resolves against the real platform) over the internal bootstrap
 * id/username, purely for display: every ownership filter elsewhere is keyed off `user.id`, which
 * never changes. `proxy` is included only when a real password is actually known
 * (`effectiveProxyPassword`) - never a placeholder, since apify-cli's `getLoggedClient` writes whatever
 * this returns straight into the CLI's own `auth.json` on every command.
 */
function userDto(user: UserRecord) {
	const proxyPassword = effectiveProxyPassword(user);
	return {
		id: user.realId ?? user.id,
		username: user.realUsername ?? user.username,
		...(proxyPassword ? { proxy: { password: proxyPassword } } : {}),
	};
}

export function mountUsers(router: Router): void {
	router.get(
		'/users/me',
		h(async (req, res) => {
			sendData(res, userDto(requireUser(req)));
		}),
	);

	router.get(
		'/users/:userId',
		h(async (req, res) => {
			const { userId } = req.params;
			const user = requireUser(req);
			const matchesKnownId = userId === user.id || (user.realId !== undefined && userId === user.realId);
			if (userId !== 'me' && !matchesKnownId) throw recordNotFound();
			sendData(res, userDto(user));
		}),
	);
}

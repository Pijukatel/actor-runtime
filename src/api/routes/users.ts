import { Router } from 'express';

import { requireUser } from '../auth.js';

import { sendData } from '../envelope.js';
import { recordNotFound } from '../errors.js';
import { h } from '../handler.js';

function userDto(user: { id: string; username: string }) {
	return { id: user.id, username: user.username, proxy: { password: 'local-proxy-password' } };
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
			if (userId !== 'me' && userId !== requireUser(req).id) throw recordNotFound();
			sendData(res, userDto(requireUser(req)));
		}),
	);
}

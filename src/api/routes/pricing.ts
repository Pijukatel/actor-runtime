/**
 * `POST|GET /actor-runtime/pricing/:actorId` - deliberately outside the emulated `/v2` surface, exactly
 * like `dev-folder.ts` (`api.md`'s `/actor-runtime/*` namespace). Mounted on the same shared
 * `/actor-runtime` (and `/v2/actor-runtime` alias) sub-router `server.ts` already builds for
 * `mountDevFolder`/`mountApiFallback` - see that module's doc comment for why this namespace owns its
 * own `auth()` rather than inheriting `v2`'s.
 *
 * Canonical body is a JSON value: a `PricingInfo` object to declare PPE pricing, or the JSON string
 * `'""'` to clear (`services/pricing-declaration.ts`'s `setActorPricing`) - byte-identical convention to
 * `dev-folder.ts`'s `POST ... --body '""'`. `GET` reads the same value back; the `POST` response body
 * doubles as a read-back too, matching `dev-folder.ts`'s "no separate read/write shape" choice.
 *
 * Ownership-scoped like every other Actor write on this API port: `resolveOwnedActor`, so a caller can
 * only ever declare pricing for their own Actor.
 */
import type { Router } from 'express';

import { requireUser } from '../auth.js';
import { sendData } from '../envelope.js';
import { invalidRequest, recordNotFound } from '../errors.js';
import { h, jsonBody } from '../handler.js';
import { pricingDeclarationStatus, setActorPricing } from '../../services/pricing-declaration.js';
import { resolveOwnedActor } from '../../services/actors.js';

/** Mounts `/pricing/:actorId` onto `router` - no `deps` needed (unlike `dev-folder.ts`'s host-side
 * probe, a pricing declaration is pure bookkeeping), matching `api-fallback.ts`'s equally
 * driver-independent `mountApiFallback(router)` signature. */
export function mountPricing(router: Router): void {
	router.post(
		'/pricing/:actorId',
		h(async (req, res) => {
			const user = requireUser(req);
			const actor = await resolveOwnedActor(user.id, req.params.actorId as string, user.username);
			if (!actor) throw recordNotFound();

			const raw = jsonBody<unknown>(req);
			const result = await setActorPricing(actor, raw);
			if (result.kind !== 'ok') throw invalidRequest(result.message);

			sendData(res, pricingDeclarationStatus(result.actor));
		}),
	);

	router.get(
		'/pricing/:actorId',
		h(async (req, res) => {
			const user = requireUser(req);
			const actor = await resolveOwnedActor(user.id, req.params.actorId as string, user.username);
			if (!actor) throw recordNotFound();

			sendData(res, pricingDeclarationStatus(actor));
		}),
	);
}

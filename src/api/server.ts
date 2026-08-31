import express, { type Express, type NextFunction, type Request, type Response } from 'express';

import { auth } from './auth.js';
import { sendError } from './envelope.js';
import { ApiError } from './errors.js';
import { matchSpecPath } from './spec-table.js';
import { mountUsers } from './routes/users.js';
import { mountDatasets } from './routes/datasets.js';
import { mountKeyValueStores } from './routes/key-value-stores.js';
import { mountRequestQueues } from './routes/request-queues.js';
import { mountActors } from './routes/actors.js';
import { mountBuilds } from './routes/builds.js';
import { mountRuns } from './routes/runs.js';
import { mountLogs } from './routes/logs.js';
import { mountRunStorageAliases } from './routes/run-storage-aliases.js';
import { mountDevFolder } from './routes/dev-folder.js';
import { mountApiFallback } from './routes/api-fallback.js';
import { attemptFallback, type LocalError } from '../services/api-fallback.js';
import type { Driver } from '../driver/types.js';

export interface ApiServerDeps {
	driver: Driver;
}

/** The one place either local-miss seam below produces its response: try the fallback first (which
 * never rejects - `services/api-fallback.ts`'s own contract), and only send the local error when the
 * fallback declines or abandons. Collapsing both seams' identical two-line sequence into this single
 * helper means there is exactly one place that can get the ordering wrong, not two. */
async function respondWithLocalError(req: Request, res: Response, localError: LocalError): Promise<void> {
	if (await attemptFallback(req, res, localError)) return;
	sendError(res, localError.status, localError.type, localError.message);
}

export function createApiServer(deps: ApiServerDeps): Express {
	const app = express();
	app.disable('x-powered-by');
	// Every body arrives as a raw Buffer regardless of Content-Type: KV records need byte-exact
	// round-tripping, run/build inputs carry arbitrary content types, and everything else is JSON we
	// parse ourselves (see `api/handler.ts`).
	app.use(express.raw({ type: () => true, limit: '256mb' }));

	// `/actor-runtime/*` - a deliberately non-Apify, local-runtime-only namespace (`api.md`), registered
	// before the `v2` router (and its own `auth()`) below entirely, so it gets its own sub-router with its
	// own `auth()` rather than inheriting `v2.use(auth())`. Registered once here, shared by every route
	// module mounted on this router (`mountDevFolder`, `mountApiFallback`) rather than each registering
	// its own - they are the same router instance, so a second registration would just run `auth()`
	// twice per request for no benefit.
	const actorRuntime = express.Router();
	actorRuntime.use(auth());
	mountDevFolder(actorRuntime, deps);
	mountApiFallback(actorRuntime);
	app.use('/actor-runtime', actorRuntime);
	// Also served at `/v2/actor-runtime/*` - the *same* router instance, no duplicated route logic - solely
	// because `apify api`'s own URL-building hardcodes a `/v2`-suffixed base (`${baseUrl}/${endpoint}`,
	// `baseUrl` already ending in `/v2`) and its `normalizePath` only strips a leading `/` and a leading
	// `v2/`, never `..`: `apify api POST /actor-runtime/dev-folder/<id>` (the clean, documented form, no
	// `../`) therefore resolves to exactly this path, never the canonical `/actor-runtime/*` one above.
	// This mount is registered here, before `app.use('/v2', v2)` below - NOT nested under `v2` - so this
	// request is only ever authenticated once, by this router's own `auth()`; nesting it under `v2` would
	// mean `v2.use(auth())` runs first and this router's `auth()` runs again right after, on every request.
	// `/v2/actor-runtime/*` is not part of the emulated Apify API - it is the same deliberately non-Apify
	// namespace as `/actor-runtime/*`, reachable a second way purely for CLI ergonomics (`api.md`). The
	// dev-folder fields are still never exposed on any real `/v2` Actor response either way - `actorDto`
	// is explicit field-by-field regardless of which path reached this router.
	app.use('/v2/actor-runtime', actorRuntime);

	const v2 = express.Router();
	v2.use(auth());

	mountUsers(v2);
	mountActors(v2, deps);
	mountBuilds(v2, deps);
	mountRuns(v2, deps);
	mountDatasets(v2);
	mountKeyValueStores(v2);
	mountRequestQueues(v2);
	mountLogs(v2);
	mountRunStorageAliases(v2);

	app.use('/v2', v2);

	// The first of the two seams `attemptFallback` (`services/api-fallback.ts`) can serve a response
	// from instead of this local error: a request that fell through every mounted router without any
	// route matching at all - a genuinely off-spec path, or a spec-known path this runtime hasn't built
	// (`spec-table.ts`). Both local error shapes are gated by `fallbackUnimplementedEnabled` - from the
	// caller's point of view, "nothing local answers this" either way.
	app.use(async (req: Request, res: Response) => {
		const path = req.path.replace(/^\/+/, '');
		const entry = matchSpecPath(req.method, path);
		const localError =
			entry?.implemented === false
				? {
						status: 501,
						type: 'not-implemented',
						message: `${req.method} ${req.path} is not implemented by this runtime`,
					}
				: { status: 404, type: 'not-found', message: `${req.method} ${req.path} was not found` };

		await respondWithLocalError(req, res, localError);
	});

	// The second seam: a route handler under a matched router rejected with an `ApiError` (`handler.ts`'s
	// `h()` forwards it here via `.catch(next)`). Only a `record-not-found` rejection is ever eligible for
	// fallback (`fallbackNotFoundEnabled`) - `attemptFallback` itself is what enforces that, from the
	// error's own `type`, so every other `ApiError` (`invalid-request`, `cannot-remove-running-run`,
	// `deleting-unfinished-build`, any `dev-folder-*` type, ...) always falls straight through to the
	// local response below, untouched.
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	app.use(async (err: unknown, req: Request, res: Response, next: NextFunction) => {
		if (err instanceof ApiError) {
			await respondWithLocalError(req, res, {
				status: err.status,
				type: err.type,
				message: err.message,
			});
			return;
		}

		console.error(err);
		sendError(res, 500, 'internal-error', err instanceof Error ? err.message : 'Internal error');
	});

	return app;
}

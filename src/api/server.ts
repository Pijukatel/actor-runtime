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
import type { Driver } from '../driver/types.js';

export interface ApiServerDeps {
	driver: Driver;
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
	// own `auth()` (see `mountDevFolder`'s doc comment) rather than inheriting `v2.use(auth())`.
	const devFolder = express.Router();
	mountDevFolder(devFolder, deps);
	app.use('/actor-runtime', devFolder);
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
	app.use('/v2/actor-runtime', devFolder);

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

	app.use((req: Request, res: Response) => {
		const path = req.path.replace(/^\/+/, '');
		const entry = matchSpecPath(req.method, path);
		if (entry && !entry.implemented) {
			sendError(res, 501, 'not-implemented', `${req.method} ${req.path} is not implemented by this runtime`);
			return;
		}
		sendError(res, 404, 'not-found', `${req.method} ${req.path} was not found`);
	});

	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
		if (err instanceof ApiError) {
			sendError(res, err.status, err.type, err.message);
			return;
		}

		console.error(err);
		sendError(res, 500, 'internal-error', err instanceof Error ? err.message : 'Internal error');
	});

	return app;
}

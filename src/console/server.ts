/**
 * Server-rendered console: list + detail views for Actors, builds, runs, logs, and the three
 * user-storage types, each with exactly one inspection widget per storage type (`console.md`). Reads
 * through the same service layer as the API handlers, so ownership filtering (over on the API side) is
 * shared rather than reimplemented.
 *
 * The console itself has no login of its own - it is unauthenticated, and every route is a read except
 * three mutations (`console.md`): the dev-folder form and the debug-mode form, both on the Actor detail
 * view, and the `/settings` form below. With multiple users it does not scope reads to any one of them:
 * every list/detail route below reads through the `listAll*`/`get*ById` cross-user service functions
 * (see e.g. `services/actors.ts: listAllActors`), never the API's own per-user
 * `listOwned*`/`getOwned*`, and every list row and detail view shows the object's owner `userId`
 * (`console.md`: "Frontend shows for each object the owner (userId)"). The dev-folder and debug-mode
 * forms both write cross-user the same way - a deliberate deviation from the API's own strictly-owner-
 * scoped write, not an accident; the `/settings` form is runtime-global by nature (`api.md`'s "Upstream
 * fallback" section), so ownership doesn't apply to it at all.
 */
import express, { type Express, type Request } from 'express';

import { getActorById, listAllActors } from '../services/actors.js';
import type { ActorRecord } from '../storage/entities.js';
import {
	describeDevFolderFailure,
	devFolderStatus,
	setDevFolder,
	type DevFolderStatus,
} from '../services/dev-folder.js';
import { debugStatus, setDebugMode } from '../services/debug-mode.js';
import { getBuildById, listAllBuilds } from '../services/builds.js';
import { getRunById, listAllRuns } from '../services/runs.js';
import { getFullLog } from '../services/logs.js';
import { getStorageById, listAllStorages } from '../services/storages.js';
import { listRequests } from '../services/request-queues.js';
import { openDataset, openKeyValueStore, openRequestQueue } from '../storage/open.js';
import { pageKeys } from '../services/kv-key-listing.js';
import { applyDatasetProjection, type DatasetItem } from '../services/dataset-projection.js';
import { ansiToHtml } from './ansi.js';
import { newestFirst } from './order.js';
import {
	apiFallbackWarning,
	debugModeForm,
	definitionList,
	devFolderForm,
	escapeHtml,
	layout,
	settingsForm,
	table,
	type LinkedCell,
} from './templates.js';
import { getApiFallbackState, setApiFallbackState } from '../services/api-fallback.js';
import { upstreamApiBaseUrl } from '../services/identity-resolution.js';
import type { Driver } from '../driver/types.js';

/** A run's default-storage id rendered as a link to that storage's detail view instead of plain text. */
function storageLink(prefix: '/datasets' | '/key-value-stores' | '/request-queues', id: string): LinkedCell {
	return { text: id, href: `${prefix}/${encodeURIComponent(id)}` };
}

/** Whether `req` carries positive evidence of being a cross-site form submission, for any of the
 * console's three mutating `POST` routes. The console is deliberately unauthenticated - anyone who can
 * reach it can already flip a toggle or register a dev folder (`console.md`) - but all three routes are
 * unauthenticated, state-changing form `POST`s reachable from any origin, and a cross-site page silently
 * driving any one of them is a wider threat model than "reachable": that's true of all three routes on
 * their own, and one of them (`/settings`) also enables credential egress once fallback is switched on,
 * which raises the stakes further. Every modern browser sends `Sec-Fetch-Site` on a form submission (a
 * same-origin one - the only way a human actually uses any of these forms - is always `same-origin` or
 * `none`); a request without the header at all (an older browser, or a non-browser caller like `curl`,
 * which `console.md`'s unauthenticated-by-design model already has to tolerate) reports `false` here -
 * only a header that positively says otherwise blocks the request. This closes off the specific
 * cross-site-form vector without adding authentication or changing any route's documented behaviour for a
 * legitimate same-origin submission. Written as a plain predicate (checked at the top of each handler)
 * rather than an Express middleware, so it needs no generic parameter shared across the handler chain -
 * `req.params` keeps the type each route's own path literal already gives it. */
function isCrossSiteWrite(req: Request): boolean {
	const site = req.header('sec-fetch-site');
	return site !== undefined && site !== 'same-origin' && site !== 'none';
}

export interface ConsoleServerDeps {
	driver: Driver;
}

/** The dev-folder registration form + its one read-only status row, rendered on the Actor detail view
 * (`console.md`'s "Local dev-folder registration form" section). Deliberately shows only the registered
 * folder, never a build's working directory or a "mount will apply" claim - whether a mount actually
 * applies depends on which build a given run resolves, which this Actor-level view has no way to know in
 * advance (`services/dev-folder.ts: devFolderStatus`'s doc comment). `errorMessage` is threaded through
 * from the POST handler's redirect query param below, since a redirect itself carries no state of its
 * own. */
function devFolderSection(actorId: string, status: DevFolderStatus, errorMessage?: string): string {
	return (
		'<h2>Local dev folder</h2>' +
		definitionList([['localDevFolder', status.localDevFolder ?? '(none registered)']]) +
		devFolderForm(actorId, status.localDevFolder ?? '', errorMessage)
	);
}

/** The debug-mode toggle form + its status row, on the Actor detail view (`console.md`'s "Debug-mode form
 * (Actor detail view)" section) - full parity with the API body: `enabled`/`language`/`port`, not a
 * checkbox-only carve-out, so the console produces the same stored `ActorRecord.localDebug` outcome as a
 * direct API call with the same input. Takes the Actor's raw stored `localDebug` (never the whole
 * record - it needs no other field, matching `devFolderSection`'s own actorId-only shape) and derives the
 * display status from it itself, since the form below needs that same raw value pre-`debugStatus` (see
 * `debugModeForm`'s own doc comment for why the display-computed status value must never pre-fill the
 * port input). `errorMessage` is threaded through from the POST handler's redirect query param below,
 * same as `devFolderSection`'s own `devFolderError`. */
function debugModeSection(actorId: string, localDebug: ActorRecord['localDebug'], errorMessage?: string): string {
	const status = debugStatus({ localDebug });
	return (
		'<h2>Debug mode</h2>' +
		definitionList([
			['language', status.localDebug?.language ?? '(debug mode is off)'],
			['port', status.localDebug?.port ?? ''],
		]) +
		debugModeForm(actorId, localDebug ?? null, errorMessage)
	);
}

export function createConsoleServer(deps: ConsoleServerDeps): Express {
	const app = express();
	app.disable('x-powered-by');
	// The dev-folder form, the debug-mode form, and the `/settings` form below are the console's only
	// three writes - every other route is a plain `GET` (`console.md`'s "Every route is a read except
	// the dev-folder form, the debug-mode form, and the Settings form below").
	app.use(express.urlencoded({ extended: false }));

	app.get('/', async (_req, res) => {
		res.send(layout('actor-runtime', '<p>Pick an object type from the navigation above.</p>'));
	});

	app.get('/actors', async (_req, res) => {
		const actors = await listAllActors();
		const rows = actors.map((a) => [
			a.id,
			a.userId,
			a.name,
			a.title ?? '',
			String(a.versions.length),
			Object.keys(a.taggedBuilds).join(', '),
		]);
		res.send(
			layout('Actors', table(['id', 'userId', 'name', 'title', 'versions', 'tagged builds'], rows, 0, '/actors')),
		);
	});

	app.get('/actors/:id', async (req, res) => {
		const actor = await getActorById(req.params.id);
		if (!actor) {
			res.status(404).send(layout('Not found', '<p>Actor not found.</p>'));
			return;
		}
		const devFolderError = typeof req.query.devFolderError === 'string' ? req.query.devFolderError : undefined;
		const debugModeError = typeof req.query.debugModeError === 'string' ? req.query.debugModeError : undefined;
		const body =
			definitionList([
				['id', actor.id],
				['userId', actor.userId],
				['name', actor.name],
				['title', actor.title ?? ''],
				['createdAt', actor.createdAt],
				['modifiedAt', actor.modifiedAt],
			]) +
			'<h2>Versions</h2>' +
			table(
				['versionNumber', 'buildTag', 'files'],
				actor.versions.map((v) => [v.versionNumber, v.buildTag, String(v.sourceFiles.length)]),
			) +
			'<h2>Tagged builds</h2>' +
			table(
				['tag', 'buildId', 'buildNumber'],
				Object.entries(actor.taggedBuilds).map(([tag, b]) => [tag, b.buildId, b.buildNumber]),
				1,
				'/builds',
			) +
			devFolderSection(actor.id, devFolderStatus(actor), devFolderError) +
			debugModeSection(actor.id, actor.localDebug, debugModeError);
		res.send(layout(`Actor ${actor.name}`, body));
	});

	/** One of the console's three mutations - funnels through the same `setDevFolder` the API endpoint uses,
	 * resolving the Actor cross-user by the id already in the page URL (no token) rather than through
	 * `resolveOwnedActor`. A failure redirects back with `describeDevFolderFailure`'s message in a query
	 * param, so it's surfaced inline rather than swallowed by the redirect. */
	app.post('/actors/:id/dev-folder', async (req, res) => {
		if (isCrossSiteWrite(req)) {
			res.status(403).send('Cross-site form submissions are not allowed.');
			return;
		}
		const actor = await getActorById(req.params.id);
		if (!actor) {
			res.status(404).send(layout('Not found', '<p>Actor not found.</p>'));
			return;
		}
		const body = req.body as Record<string, unknown> | undefined;
		// Not trimmed here - `setDevFolder` itself distinguishes an explicit clear (the literal empty
		// string) from a whitespace-only submission (rejected, not treated as a clear); trimming here
		// first would collapse that distinction before it ever reaches the service.
		const submitted = typeof body?.localDevFolder === 'string' ? body.localDevFolder : '';

		const result = await setDevFolder(deps.driver, actor, submitted);
		if (result.kind !== 'ok') {
			const message = describeDevFolderFailure(result);
			res.redirect(`/actors/${encodeURIComponent(actor.id)}?devFolderError=${encodeURIComponent(message)}`);
			return;
		}
		res.redirect(`/actors/${encodeURIComponent(actor.id)}`);
	});

	/** The console's third mutation (`console.md`'s "three writes" correction) - funnels through the same
	 * `setDebugMode` the API endpoint uses, resolving the Actor cross-user by the id already in the page
	 * URL (no token), exactly like the dev-folder form above. Always submits all three fields (`enabled`
	 * as a checkbox, `language` as a select, `port` as a number input, left blank for "no override") -
	 * full parity with the API body, no checkbox-only carve-out. A failure redirects back with the
	 * classified message in a query param, same pattern as the dev-folder form's `devFolderError`. */
	app.post('/actors/:id/debug', async (req, res) => {
		if (isCrossSiteWrite(req)) {
			res.status(403).send('Cross-site form submissions are not allowed.');
			return;
		}
		const actor = await getActorById(req.params.id);
		if (!actor) {
			res.status(404).send(layout('Not found', '<p>Actor not found.</p>'));
			return;
		}
		const body = req.body as Record<string, unknown> | undefined;
		const enabled = body?.enabled === 'on';
		const language = typeof body?.language === 'string' ? body.language : 'auto';
		const portRaw = typeof body?.port === 'string' ? body.port.trim() : '';
		const requestBody: Record<string, unknown> = { enabled };
		if (enabled) {
			requestBody.language = language;
			if (portRaw !== '') requestBody.port = Number(portRaw);
		}

		const result = await setDebugMode(actor, requestBody);
		if (result.kind !== 'ok') {
			res.redirect(
				`/actors/${encodeURIComponent(actor.id)}?debugModeError=${encodeURIComponent(result.message)}`,
			);
			return;
		}
		res.redirect(`/actors/${encodeURIComponent(actor.id)}`);
	});

	// --- Compatibility redirects: stock apify-cli only knows one Console, so it prints links using
	// the real Apify Console's URL shapes (`/actors/:actorId/runs/:runId`,
	// `/actors/:actorId/builds/:buildNumber`, `/storage/datasets/:id`, ...). This console serves its own
	// equivalent pages at flat paths, so redirect each printed shape there instead of 404ing. (The
	// `/actors/:actorId#/builds/:buildNumber` shape some CLI commands print needs no redirect: the `#`
	// fragment never reaches the server, so that request already lands on `/actors/:actorId` above.)
	// These patterns never shadow `/actors/:id` above - Express/path-to-regexp segments don't span `/`,
	// so a two-segment pattern like `:actorId/runs/:runId` only ever matches a three-segment path.

	app.get('/actors/:actorId/runs/:runId', (req, res) => {
		res.redirect(`/runs/${req.params.runId}`);
	});

	app.get('/actors/:actorId/builds/:buildNumber', async (req, res) => {
		// Unlike the run/dataset/KV-store redirects above and below, this one can't be a plain path
		// rewrite: the real Console's build URL carries the human-readable `buildNumber` (e.g. `0.0.1`),
		// but this console's own `/builds/:id` route keys off the build's internal id. Resolve it
		// cross-user (`listAllBuilds`, scoped to the actor in the URL) before redirecting.
		const builds = await listAllBuilds(req.params.actorId);
		const build = builds.find((b) => b.buildNumber === req.params.buildNumber);
		if (!build) {
			res.status(404).send(layout('Not found', '<p>Build not found.</p>'));
			return;
		}
		res.redirect(`/builds/${build.id}`);
	});

	app.get('/storage/datasets/:id', (req, res) => {
		res.redirect(`/datasets/${req.params.id}`);
	});

	app.get('/storage/key-value-stores/:id', (req, res) => {
		res.redirect(`/key-value-stores/${req.params.id}`);
	});

	app.get('/storage/request-queues/:id', (req, res) => {
		res.redirect(`/request-queues/${req.params.id}`);
	});

	app.get('/builds', async (_req, res) => {
		const builds = newestFirst(await listAllBuilds());
		const rows = builds.map((b) => [b.id, b.userId, b.actorId, b.buildNumber, b.status, b.startedAt]);
		res.send(
			layout(
				'Builds',
				table(['id', 'userId', 'actorId', 'buildNumber', 'status', 'startedAt'], rows, 0, '/builds'),
			),
		);
	});

	app.get('/builds/:id', async (req, res) => {
		const build = await getBuildById(req.params.id);
		if (!build) {
			res.status(404).send(layout('Not found', '<p>Build not found.</p>'));
			return;
		}
		const log = await getFullLog(build.id);
		const body =
			definitionList([
				['id', build.id],
				['userId', build.userId],
				['actorId', build.actorId],
				['versionNumber', build.versionNumber],
				['buildNumber', build.buildNumber],
				['tag', build.tag],
				['status', build.status],
				['startedAt', build.startedAt],
				['finishedAt', build.finishedAt ?? ''],
				['statusMessage', build.statusMessage ?? ''],
			]) +
			'<h2>Log</h2><pre>' +
			(log ? ansiToHtml(log) : '(empty)') +
			'</pre>';
		res.send(layout(`Build ${build.id}`, body));
	});

	app.get('/runs', async (_req, res) => {
		const runs = newestFirst(await listAllRuns());
		const rows = runs.map((r) => [
			r.id,
			r.userId,
			r.actorId,
			r.status,
			r.startedAt,
			storageLink('/datasets', r.defaultDatasetId),
		]);
		res.send(
			layout(
				'Runs',
				table(['id', 'userId', 'actorId', 'status', 'startedAt', 'defaultDatasetId'], rows, 0, '/runs'),
			),
		);
	});

	app.get('/runs/:id', async (req, res) => {
		const run = await getRunById(req.params.id);
		if (!run) {
			res.status(404).send(layout('Not found', '<p>Run not found.</p>'));
			return;
		}
		const log = await getFullLog(run.id);
		const rows: Array<[string, unknown]> = [
			['id', run.id],
			['userId', run.userId],
			['actorId', run.actorId],
			['buildId', run.buildId],
			['status', run.status],
			['startedAt', run.startedAt],
			['finishedAt', run.finishedAt ?? ''],
			['defaultDatasetId', storageLink('/datasets', run.defaultDatasetId)],
			['defaultKeyValueStoreId', storageLink('/key-value-stores', run.defaultKeyValueStoreId)],
			['defaultRequestQueueId', storageLink('/request-queues', run.defaultRequestQueueId)],
		];
		// Only present for a run that actually resolved a debug plan (`services/debug-mode.ts`) - local-
		// only, never present on the emulated `/v2` run object (`dto/actors.ts: runDto` is explicit
		// field-by-field, same containment `localDevFolder` already relies on).
		if (run.localDebug) {
			rows.push(['debug', `${run.localDebug.language}, attach at 127.0.0.1:${run.localDebug.port}`]);
		}
		const body = definitionList(rows) + '<h2>Log</h2><pre>' + (log ? ansiToHtml(log) : '(empty)') + '</pre>';
		res.send(layout(`Run ${run.id}`, body));
	});

	app.get('/logs', async (_req, res) => {
		const [builds, runs] = await Promise.all([listAllBuilds(), listAllRuns()]);
		// Builds and runs share this one list, so they're merged before sorting rather than each sorted on
		// its own and concatenated - otherwise every build would still render before every run (or vice
		// versa) regardless of which is actually newer.
		const entries = newestFirst([
			...builds.map((b) => ({
				id: b.id,
				userId: b.userId,
				kind: 'build' as const,
				status: b.status,
				startedAt: b.startedAt,
			})),
			...runs.map((r) => ({
				id: r.id,
				userId: r.userId,
				kind: 'run' as const,
				status: r.status,
				startedAt: r.startedAt,
			})),
		]);
		const rows = entries.map((e) => [e.id, e.userId, e.kind, e.status]);
		res.send(layout('Logs', table(['id', 'userId', 'kind', 'status'], rows, 0, '/logs')));
	});

	app.get('/logs/:id', async (req, res) => {
		// A log id is always either a build id or a run id - resolve existence through whichever one
		// owns it (same 404-before-render pattern as the `/builds/:id` and `/runs/:id` routes above, just
		// cross-user rather than ownership-scoped), so this route doesn't skip the existence check its
		// siblings both enforce.
		const owned = (await getBuildById(req.params.id)) ?? (await getRunById(req.params.id));
		if (!owned) {
			res.status(404).send(layout('Not found', '<p>Log not found.</p>'));
			return;
		}
		const log = await getFullLog(req.params.id);
		res.send(layout(`Log ${req.params.id}`, `<pre>${log ? ansiToHtml(log) : '(empty)'}</pre>`));
	});

	// --- Storage widgets: exactly one per type ---

	app.get('/datasets', async (_req, res) => {
		const records = await listAllStorages('dataset');
		const rows = records.map((r) => [r.id, r.userId, r.name ?? '', r.createdAt]);
		res.send(layout('Datasets', table(['id', 'userId', 'name', 'createdAt'], rows, 0, '/datasets')));
	});

	app.get('/datasets/:id', async (req, res) => {
		const record = await getStorageById(req.params.id, 'dataset');
		if (!record) {
			res.status(404).send(layout('Not found', '<p>Dataset not found.</p>'));
			return;
		}
		const dataset = await openDataset(record.id);
		const info = await dataset.getInfo();
		const page = await dataset.getData({ limit: 20 });
		const items = applyDatasetProjection(page.items as DatasetItem[], {});
		const body =
			definitionList([
				['id', record.id],
				['userId', record.userId],
				['name', record.name ?? ''],
				['itemCount', info.itemCount],
				['createdAt', info.createdAt.toISOString()],
				['modifiedAt', info.modifiedAt.toISOString()],
			]) +
			'<h2>Items (first 20)</h2><pre>' +
			escapeHtml(JSON.stringify(items, null, 2)) +
			'</pre>';
		res.send(layout(`Dataset ${record.id}`, body));
	});

	app.get('/key-value-stores', async (_req, res) => {
		const records = await listAllStorages('keyValueStore');
		const rows = records.map((r) => [r.id, r.userId, r.name ?? '', r.createdAt]);
		res.send(
			layout('Key-value stores', table(['id', 'userId', 'name', 'createdAt'], rows, 0, '/key-value-stores')),
		);
	});

	app.get('/key-value-stores/:id', async (req, res) => {
		const record = await getStorageById(req.params.id, 'keyValueStore');
		if (!record) {
			res.status(404).send(layout('Not found', '<p>Key-value store not found.</p>'));
			return;
		}
		const store = await openKeyValueStore(record.id);
		const allKeys: { key: string; size: number }[] = [];
		await store.forEachKey(async (key, _i, info) => {
			allKeys.push({ key, size: info.size });
		});
		const page = pageKeys(allKeys, { limit: 50 });
		const body =
			definitionList([
				['id', record.id],
				['userId', record.userId],
				['name', record.name ?? ''],
				['createdAt', record.createdAt],
				['keyCount', allKeys.length],
			]) +
			'<h2>Keys (first 50)</h2>' +
			table(
				['key', 'size (bytes)'],
				page.items.map((i) => [i.key, String(i.size)]),
			);
		res.send(layout(`Key-value store ${record.id}`, body));
	});

	app.get('/request-queues', async (_req, res) => {
		const records = await listAllStorages('requestQueue');
		const rows = records.map((r) => [r.id, r.userId, r.name ?? '', r.createdAt]);
		res.send(layout('Request queues', table(['id', 'userId', 'name', 'createdAt'], rows, 0, '/request-queues')));
	});

	app.get('/request-queues/:id', async (req, res) => {
		const record = await getStorageById(req.params.id, 'requestQueue');
		if (!record) {
			res.status(404).send(layout('Not found', '<p>Request queue not found.</p>'));
			return;
		}
		const queue = await openRequestQueue(record.id);
		const info = await queue.getInfo();
		// Deliberately `listRequests`, not `getHead`/`peekHead`: the console is documented as view-only
		// (`console.md`), and `peekHead` calls `fetchNextRequest()` under the hood, which marks requests
		// in-progress in Crawlee - simply *viewing* this page would otherwise mutate the queue's state.
		// `listRequests` only reads the id index this process has already seen plus a `getRequest` lookup
		// per id, neither of which touches in-progress state (same best-effort contract as `GET /requests`).
		const seen = await listRequests(record.id, { limit: 20 });
		const body =
			definitionList([
				['id', record.id],
				['userId', record.userId],
				['name', record.name ?? ''],
				['totalRequestCount', info.totalRequestCount],
				['handledRequestCount', info.handledRequestCount],
				['pendingRequestCount', info.pendingRequestCount],
			]) +
			'<h2>Requests seen so far (best-effort, first 20)</h2>' +
			table(
				['id', 'url', 'method', 'retryCount'],
				seen.items.map((i) => [i.id, i.url, i.method, String(i.retryCount)]),
			);
		res.send(layout(`Request queue ${record.id}`, body));
	});

	// --- Settings: the shared upstream-fallback toggle state (`services/api-fallback.ts`), read/written
	// through the same module the API's `GET`/`POST /actor-runtime/api-fallback` route uses - never
	// through the API port itself (the dev-folder form's precedent). This is the console's third
	// mutation alongside the dev-folder and debug-mode forms - `console.md`'s "every route is a read
	// except..." now names all three.

	app.get('/settings', async (_req, res) => {
		const state = getApiFallbackState();
		const body =
			apiFallbackWarning() +
			definitionList([
				['fallbackUnimplementedEnabled', state.fallbackUnimplementedEnabled],
				['fallbackNotFoundEnabled', state.fallbackNotFoundEnabled],
				['upstreamBaseUrl', upstreamApiBaseUrl()],
			]) +
			'<h2>Change settings</h2>' +
			settingsForm(state);
		res.send(layout('Settings', body));
	});

	/** Always submits both checkboxes' current state, per the form's own contract
	 * (`templates.ts: settingsForm`'s doc comment) - an unchecked box is simply absent from the
	 * urlencoded body, read as `false` here, never as "leave this field unchanged". Funnels into the
	 * same `setApiFallbackState` the API route calls, so the two surfaces can never observe or produce
	 * different toggle states for the same request. */
	app.post('/settings', async (req, res) => {
		if (isCrossSiteWrite(req)) {
			res.status(403).send('Cross-site form submissions are not allowed.');
			return;
		}
		const body = req.body as Record<string, unknown> | undefined;
		setApiFallbackState({
			fallbackUnimplementedEnabled: body?.fallbackUnimplementedEnabled === 'on',
			fallbackNotFoundEnabled: body?.fallbackNotFoundEnabled === 'on',
		});
		res.redirect('/settings');
	});

	return app;
}

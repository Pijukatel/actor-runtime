/**
 * Server-rendered console: list + detail views for Actors, builds, runs, logs, and the three
 * user-storage types, each with exactly one inspection widget per storage type (`console.md`). Reads
 * through the same service layer as the API handlers, so ownership filtering (over on the API side) is
 * shared rather than reimplemented.
 *
 * The console itself has no login of its own - it is unauthenticated, and every route is a read except
 * exactly one mutation (`console.md`'s "Every route is a read except the dev-folder form below, which is
 * the console's one write"): the dev-folder form on the Actor detail view. With multiple users it does
 * not scope reads to any one of them: every list/detail route below reads through the
 * `listAll*`/`get*ById` cross-user service functions (see e.g. `services/actors.ts: listAllActors`),
 * never the API's own per-user `listOwned*`/`getOwned*`, and every list row and detail view shows the
 * object's owner `userId` (`console.md`: "Frontend shows for each object the owner (userId)"). The
 * dev-folder form writes cross-user the same way - a deliberate deviation from the API's own
 * strictly-owner-scoped write, not an accident.
 */
import express, { type Express } from 'express';

import { getActorById, listAllActors } from '../services/actors.js';
import {
	describeDevFolderFailure,
	devFolderStatus,
	setDevFolder,
	type DevFolderStatus,
} from '../services/dev-folder.js';
import { getBuildById, listAllBuilds } from '../services/builds.js';
import { getRunById, listAllRuns } from '../services/runs.js';
import { getFullLog } from '../services/logs.js';
import { getStorageById, listAllStorages } from '../services/storages.js';
import { listRequests } from '../services/request-queues.js';
import { openDataset, openKeyValueStore, openRequestQueue } from '../storage/open.js';
import { pageKeys } from '../services/kv-key-listing.js';
import { applyDatasetProjection, type DatasetItem } from '../services/dataset-projection.js';
import { ansiToHtml } from './ansi.js';
import { definitionList, devFolderForm, escapeHtml, layout, table, type LinkedCell } from './templates.js';
import type { Driver } from '../driver/types.js';

/** A run's default-storage id rendered as a link to that storage's detail view instead of plain text. */
function storageLink(prefix: '/datasets' | '/key-value-stores' | '/request-queues', id: string): LinkedCell {
	return { text: id, href: `${prefix}/${encodeURIComponent(id)}` };
}

export interface ConsoleServerDeps {
	driver: Driver;
}

/** The dev-folder registration form + its three read-only status rows, rendered on the Actor detail
 * view (`console.md`'s "Local dev-folder registration form" section). `errorMessage` is threaded
 * through from the POST handler's redirect query param below, since a redirect itself carries no state
 * of its own. */
function devFolderSection(actorId: string, status: DevFolderStatus, errorMessage?: string): string {
	return (
		'<h2>Local dev folder</h2>' +
		definitionList([
			['localDevFolder', status.localDevFolder ?? '(none registered)'],
			['imageWorkingDirectory', status.imageWorkingDirectory ?? '(not yet detected - build the Actor first)'],
			['mount will apply on the next run', String(status.mountWillApply)],
		]) +
		devFolderForm(actorId, status.localDevFolder ?? '', errorMessage)
	);
}

export function createConsoleServer(deps: ConsoleServerDeps): Express {
	const app = express();
	app.disable('x-powered-by');
	// Only the dev-folder form below posts anything - every other console route is a plain `GET`
	// (`console.md`'s "Every route is a read except the dev-folder form below, which is the console's
	// one write").
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
			devFolderSection(actor.id, await devFolderStatus(actor), devFolderError);
		res.send(layout(`Actor ${actor.name}`, body));
	});

	/** The console's one mutation - funnels through the same `setDevFolder` the API endpoint uses,
	 * resolving the Actor cross-user by the id already in the page URL (no token) rather than through
	 * `resolveOwnedActor`. A failure redirects back with `describeDevFolderFailure`'s message in a query
	 * param, so it's surfaced inline rather than swallowed by the redirect. */
	app.post('/actors/:id/dev-folder', async (req, res) => {
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
		const builds = await listAllBuilds();
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
		const runs = await listAllRuns();
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
		const body =
			definitionList([
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
			]) +
			'<h2>Log</h2><pre>' +
			(log ? ansiToHtml(log) : '(empty)') +
			'</pre>';
		res.send(layout(`Run ${run.id}`, body));
	});

	app.get('/logs', async (_req, res) => {
		const [builds, runs] = await Promise.all([listAllBuilds(), listAllRuns()]);
		const rows = [
			...builds.map((b) => [b.id, b.userId, 'build', b.status]),
			...runs.map((r) => [r.id, r.userId, 'run', r.status]),
		];
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

	return app;
}

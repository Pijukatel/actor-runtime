/**
 * Server-rendered console: list + detail views for Actors, builds, runs, logs, and the three
 * user-storage types, each with exactly one inspection widget per storage type (`console.md`). Reads
 * through the same service layer as the API handlers, so ownership filtering is shared.
 */
import express, { type Express } from 'express';

import { getDefaultUser } from '../services/users.js';
import { listOwnedActors, resolveOwnedActor } from '../services/actors.js';
import { getOwnedBuild, listOwnedBuilds } from '../services/builds.js';
import { getOwnedRun, listOwnedRuns } from '../services/runs.js';
import { getFullLog } from '../services/logs.js';
import { getOwnedStorage, listOwnedStorages } from '../services/storages.js';
import { listRequests } from '../services/request-queues.js';
import { openDataset, openKeyValueStore, openRequestQueue } from '../storage/open.js';
import { pageKeys } from '../services/kv-key-listing.js';
import { applyDatasetProjection, type DatasetItem } from '../services/dataset-projection.js';
import { ansiToHtml } from './ansi.js';
import { definitionList, escapeHtml, layout, table } from './templates.js';

export function createConsoleServer(): Express {
	const app = express();
	app.disable('x-powered-by');

	app.get('/', async (_req, res) => {
		res.send(layout('actor-runtime', '<p>Pick an object type from the navigation above.</p>'));
	});

	app.get('/actors', async (_req, res) => {
		const user = await getDefaultUser();
		const actors = await listOwnedActors(user.id);
		const rows = actors.map((a) => [
			a.id,
			a.name,
			a.title ?? '',
			String(a.versions.length),
			Object.keys(a.taggedBuilds).join(', '),
		]);
		res.send(layout('Actors', table(['id', 'name', 'title', 'versions', 'tagged builds'], rows, 0, '/actors')));
	});

	app.get('/actors/:id', async (req, res) => {
		const user = await getDefaultUser();
		const actor = await resolveOwnedActor(user.id, req.params.id, user.username);
		if (!actor) {
			res.status(404).send(layout('Not found', '<p>Actor not found.</p>'));
			return;
		}
		const body =
			definitionList([
				['id', actor.id],
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
			);
		res.send(layout(`Actor ${actor.name}`, body));
	});

	app.get('/builds', async (_req, res) => {
		const user = await getDefaultUser();
		const builds = await listOwnedBuilds(user.id);
		const rows = builds.map((b) => [b.id, b.actorId, b.buildNumber, b.status, b.startedAt]);
		res.send(layout('Builds', table(['id', 'actorId', 'buildNumber', 'status', 'startedAt'], rows, 0, '/builds')));
	});

	app.get('/builds/:id', async (req, res) => {
		const user = await getDefaultUser();
		const build = await getOwnedBuild(user.id, req.params.id);
		if (!build) {
			res.status(404).send(layout('Not found', '<p>Build not found.</p>'));
			return;
		}
		const log = await getFullLog(build.id);
		const body =
			definitionList([
				['id', build.id],
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
		const user = await getDefaultUser();
		const runs = await listOwnedRuns(user.id);
		const rows = runs.map((r) => [r.id, r.actorId, r.status, r.startedAt, r.defaultDatasetId]);
		res.send(layout('Runs', table(['id', 'actorId', 'status', 'startedAt', 'defaultDatasetId'], rows, 0, '/runs')));
	});

	app.get('/runs/:id', async (req, res) => {
		const user = await getDefaultUser();
		const run = await getOwnedRun(user.id, req.params.id);
		if (!run) {
			res.status(404).send(layout('Not found', '<p>Run not found.</p>'));
			return;
		}
		const log = await getFullLog(run.id);
		const body =
			definitionList([
				['id', run.id],
				['actorId', run.actorId],
				['buildId', run.buildId],
				['status', run.status],
				['startedAt', run.startedAt],
				['finishedAt', run.finishedAt ?? ''],
				['defaultDatasetId', run.defaultDatasetId],
				['defaultKeyValueStoreId', run.defaultKeyValueStoreId],
				['defaultRequestQueueId', run.defaultRequestQueueId],
			]) +
			'<h2>Log</h2><pre>' +
			(log ? ansiToHtml(log) : '(empty)') +
			'</pre>';
		res.send(layout(`Run ${run.id}`, body));
	});

	app.get('/logs', async (_req, res) => {
		const user = await getDefaultUser();
		const [builds, runs] = await Promise.all([listOwnedBuilds(user.id), listOwnedRuns(user.id)]);
		const rows = [...builds.map((b) => [b.id, 'build', b.status]), ...runs.map((r) => [r.id, 'run', r.status])];
		res.send(layout('Logs', table(['id', 'kind', 'status'], rows, 0, '/logs')));
	});

	app.get('/logs/:id', async (req, res) => {
		const user = await getDefaultUser();
		// A log id is always either a build id or a run id - resolve ownership through whichever one
		// owns it (same 404-before-render pattern as the `/builds/:id` and `/runs/:id` routes above),
		// so this route doesn't skip the ownership check its siblings both enforce.
		const owned = (await getOwnedBuild(user.id, req.params.id)) ?? (await getOwnedRun(user.id, req.params.id));
		if (!owned) {
			res.status(404).send(layout('Not found', '<p>Log not found.</p>'));
			return;
		}
		const log = await getFullLog(req.params.id);
		res.send(layout(`Log ${req.params.id}`, `<pre>${log ? ansiToHtml(log) : '(empty)'}</pre>`));
	});

	// --- Storage widgets: exactly one per type ---

	app.get('/datasets', async (_req, res) => {
		const user = await getDefaultUser();
		const records = await listOwnedStorages(user.id, 'dataset');
		const rows = records.map((r) => [r.id, r.name ?? '', r.createdAt]);
		res.send(layout('Datasets', table(['id', 'name', 'createdAt'], rows, 0, '/datasets')));
	});

	app.get('/datasets/:id', async (req, res) => {
		const user = await getDefaultUser();
		const record = await getOwnedStorage(user.id, req.params.id, 'dataset');
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
		const user = await getDefaultUser();
		const records = await listOwnedStorages(user.id, 'keyValueStore');
		const rows = records.map((r) => [r.id, r.name ?? '', r.createdAt]);
		res.send(layout('Key-value stores', table(['id', 'name', 'createdAt'], rows, 0, '/key-value-stores')));
	});

	app.get('/key-value-stores/:id', async (req, res) => {
		const user = await getDefaultUser();
		const record = await getOwnedStorage(user.id, req.params.id, 'keyValueStore');
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
		const user = await getDefaultUser();
		const records = await listOwnedStorages(user.id, 'requestQueue');
		const rows = records.map((r) => [r.id, r.name ?? '', r.createdAt]);
		res.send(layout('Request queues', table(['id', 'name', 'createdAt'], rows, 0, '/request-queues')));
	});

	app.get('/request-queues/:id', async (req, res) => {
		const user = await getDefaultUser();
		const record = await getOwnedStorage(user.id, req.params.id, 'requestQueue');
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

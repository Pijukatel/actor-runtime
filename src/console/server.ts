/**
 * Server-rendered console: list + detail views for Actors, tasks, webhooks, schedules, builds, runs, logs, and the three
 * user-storage types, each with exactly one inspection widget per storage type (`console.md`). Reads
 * through the same service layer as the API handlers, so ownership filtering (over on the API side) is
 * shared rather than reimplemented.
 *
 * The console itself has no login of its own - it is unauthenticated, and every route is a read except
 * six mutations (`console.md`): the pricing, dev-folder, debug-mode and browser-view forms on the Actor
 * detail view, the Migrate button on the run detail view, and the `/settings` form below. With multiple users
 * it does not scope reads to any one of them: every list/detail route below reads through the
 * `listAll*`/`get*ById` cross-user service functions (see e.g. `services/actors.ts: listAllActors`),
 * never the API's own per-user `listOwned*`/`getOwned*`, and every list row and detail view shows the
 * object's owner by username, or its Actor as `username~actorname` (`console.md`). The
 * dev-folder form, the debug-mode form, and the Migrate button all write cross-user the same way - a
 * deliberate deviation from the API's own strictly-owner-scoped writes, not an accident; the `/settings`
 * form is runtime-global by nature (`api.md`'s "Upstream fallback" section), so ownership doesn't apply
 * to it at all.
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import express, { type Express, type Request } from 'express';

import { getActorById, listAllActors, setActorPricingInfos } from '../services/actors.js';
import { getRunTelemetry } from '../services/events-channel.js';
import { computeRunUsage } from '../services/run-usage.js';
import type { ActorRecord, LocalSourceContext, ScheduleAction, WebhookCondition } from '../storage/entities.js';
import {
	describeDevFolderFailure,
	devFolderStatus,
	setDevFolder,
	type DevFolderStatus,
} from '../services/dev-folder.js';
import { debugStatus, setDebugMode } from '../services/debug-mode.js';
import { browserViewStatus, setBrowserView } from '../services/browser-view.js';
import { liveDevFolderStatus, setLiveDevFolder } from '../services/live-dev-folder.js';
import { getBuildById, listAllBuilds } from '../services/builds.js';
import { getRunById, listAllRuns } from '../services/runs.js';
import { standbyUrl } from '../services/standby-config.js';
import { containerUrl } from '../services/container-url.js';
import { describeSourceContextOrigin } from '../services/source-context.js';
import {
	actorStandbyService,
	standbyPoolSnapshot,
	taskStandbyService,
	type StandbyService,
} from '../services/standby.js';
import { getTaskById, listAllTasks } from '../services/tasks.js';
import { getWebhookById, listAllWebhooks } from '../services/webhooks.js';
import { getScheduleById, listAllSchedules } from '../services/schedules.js';
import { getWebhookDispatchById, listAllWebhookDispatches } from '../services/webhook-dispatches.js';
import { getUserById } from '../services/users.js';
import { migrateRun } from '../services/migrations.js';
import { isTerminalJobStatus } from '../services/job-status.js';
import { isBrowserViewPending } from './browser-view-ws.js';
import { getFullLog } from '../services/logs.js';
import { getStorageById, listAllStorages } from '../services/storages.js';
import { listRequests } from '../services/request-queues.js';
import { openDataset, openKeyValueStore, openRequestQueue } from '../storage/open.js';
import { pageKeys } from '../services/kv-key-listing.js';
import { applyDatasetProjection, type DatasetItem } from '../services/dataset-projection.js';
import { ansiToHtml } from './ansi.js';
import { createNameResolver } from './names.js';
import { newestCreatedFirst, newestFirst } from './order.js';
import {
	apiFallbackWarning,
	browserViewForm,
	browserViewPage,
	debugModeForm,
	definitionList,
	devFolderForm,
	liveDevFolderForm,
	escapeHtml,
	formatUsd,
	layout,
	migrateRunForm,
	pricingSection,
	settingsForm,
	standbyLink,
	table,
	runDetailsColumns,
	usageSection,
	type LinkedCell,
} from './templates.js';
import { CONSOLE_CSS } from './styles.js';
import { getApiFallbackState, setApiFallbackState } from '../services/api-fallback.js';
import { isApifyProxyEnabled, setApifyProxyEnabled } from '../services/apify-proxy.js';
import { upstreamApiBaseUrl } from '../services/identity-resolution.js';
import type { Driver } from '../driver/types.js';

/** A run's default-storage id rendered as a link to that storage's detail view instead of plain text. */
function storageLink(prefix: '/datasets' | '/key-value-stores' | '/request-queues', id: string): LinkedCell {
	return { text: id, href: `${prefix}/${encodeURIComponent(id)}` };
}

function dockerContextCell(context: LocalSourceContext): string {
	return `${context.actorPath} (pushed ${context.uploadedAt}${describeSourceContextOrigin(context.git)})`;
}

/** Whether `req` carries positive evidence of being a cross-site form submission, for any of the
 * console's four mutating `POST` routes. The console is deliberately unauthenticated - anyone who can
 * reach it can already flip a toggle, register a dev folder, or migrate a run (`console.md`) - but all
 * four routes are unauthenticated, state-changing form `POST`s reachable from any origin, and a
 * cross-site page silently driving any one of them is a wider threat model than "reachable": that's true
 * of each route on its own, and one of them (`/settings`) also enables credential egress once fallback is
 * switched on, which raises the stakes further. Every modern browser sends `Sec-Fetch-Site` on a form
 * submission (a same-origin one - the only way a human actually uses any of these forms - is always
 * `same-origin` or `none`); a request without the header at all (an older browser, or a non-browser
 * caller like `curl`, which `console.md`'s unauthenticated-by-design model already has to tolerate)
 * reports `false` here - only a header that positively says otherwise blocks the request. This closes off
 * the specific cross-site-form vector without adding authentication or changing any route's documented
 * behaviour for a legitimate same-origin submission. Written as a plain predicate (checked at the top of
 * each handler) rather than an Express middleware, so it needs no generic parameter shared across the
 * handler chain - `req.params` keeps the type each route's own path literal already gives it. */
function isCrossSiteWrite(req: Request): boolean {
	const site = req.header('sec-fetch-site');
	return site !== undefined && site !== 'same-origin' && site !== 'none';
}

export interface ConsoleServerDeps {
	driver: Driver;
}

/** `@novnc/novnc`'s `exports` points at `core/rfb.js`; the package root is two levels up from it. */
const NOVNC_ROOT = dirname(dirname(createRequire(import.meta.url).resolve('@novnc/novnc')));

/** The dev-folder registration form, rendered on the Actor detail view (`console.md`'s "Local dev-folder
 * registration form" section). Deliberately shows only the registered folder, never a build's working directory or a "mount will apply" claim - whether a mount actually
 * applies depends on which build a given run resolves, which this Actor-level view has no way to know in
 * advance (`services/dev-folder.ts: devFolderStatus`'s doc comment). `errorMessage` is threaded through
 * from the POST handler's redirect query param below, since a redirect itself carries no state of its
 * own. */
function devFolderSection(
	actorId: string,
	status: DevFolderStatus,
	liveDevFolderEnabled: boolean,
	errorMessage?: string,
): string {
	return (
		'<h2>Local dev folder</h2>' +
		devFolderForm(actorId, status.localDevFolder ?? '', errorMessage) +
		liveDevFolderForm(actorId, liveDevFolderEnabled)
	);
}

/** The debug-mode toggle form + status row on the Actor detail view. Full API-body parity
 * (`enabled`/`language`/`port`), not a checkbox-only carve-out. Passes the raw stored `localDebug` (not
 * `debugStatus`'s display-computed version) through to `debugModeForm`, which needs the raw value to
 * decide what to pre-fill. */
function debugModeSection(actorId: string, localDebug: ActorRecord['localDebug'], errorMessage?: string): string {
	const status = debugStatus({ localDebug });
	return (
		'<section id="debug-mode" data-live>' +
		'<h2>Debug mode</h2>' +
		definitionList([
			['language', status.localDebug?.language ?? '(debug mode is off)'],
			['port', status.localDebug?.port ?? ''],
		]) +
		debugModeForm(actorId, localDebug ?? null, errorMessage) +
		'</section>'
	);
}

function browserViewSection(
	actorId: string,
	localBrowserView: ActorRecord['localBrowserView'],
	errorMessage?: string,
): string {
	const status = browserViewStatus({ localBrowserView });
	return (
		'<section id="browser-view" data-live>' +
		'<h2>Browser view</h2>' +
		definitionList([
			[
				'browser view',
				status.localBrowserView
					? `on, ${status.localBrowserView.interactive ? 'interactive' : 'view-only'}`
					: '(browser view is off)',
			],
		]) +
		browserViewForm(actorId, localBrowserView ?? null, errorMessage) +
		'</section>'
	);
}

export function createConsoleServer(deps: ConsoleServerDeps): Express {
	const app = express();
	app.disable('x-powered-by');
	// The noVNC client for the browser-view page, served straight from the installed package.
	app.use('/vendor/novnc/core', express.static(join(NOVNC_ROOT, 'core')));
	app.use('/vendor/novnc/vendor', express.static(join(NOVNC_ROOT, 'vendor')));
	// The one stylesheet every page links (`console/styles.ts`). `no-cache` rather than a max-age: it
	// revalidates on each page load, so a runtime upgrade is picked up immediately, while Express's own
	// ETag still turns the repeat request into a 304 with no body.
	app.get('/console.css', (_req, res) => {
		res.set('Cache-Control', 'no-cache');
		res.type('text/css').send(CONSOLE_CSS);
	});
	// The Actor detail view's four forms (pricing, dev folder, debug mode, browser view), the run detail
	// view's Migrate button, and the `/settings` form below are the console's only six writes - every other
	// route is a plain `GET` (`console.md`'s "Every route is a read except..." list).
	app.use(express.urlencoded({ extended: false }));

	app.get('/', async (_req, res) => {
		res.send(layout('actor-runtime', '<p>Pick an object type from the navigation above.</p>'));
	});

	app.get('/actors', async (_req, res) => {
		const actors = await listAllActors();
		const names = createNameResolver();
		const rows = await Promise.all(
			actors.map(async (a) => [
				a.id,
				await names.userName(a.userId),
				a.name,
				a.title ?? '',
				String(a.versions.length),
				Object.keys(a.taggedBuilds).join(', '),
			]),
		);
		res.send(
			layout('Actors', table(['id', 'user', 'name', 'title', 'versions', 'tagged builds'], rows, 0, '/actors')),
		);
	});

	/** Read-only: the settings are changed through the API, as on the platform. A task shows the settings
	 * its runs use: its own over the Actor's. */
	async function standbySection(service: StandbyService): Promise<string> {
		const { config } = service;
		if (!config) {
			return '<h2>Actor Standby</h2><p class="empty">(Actor Standby is off)</p>';
		}
		const owner = await getUserById(service.actor.userId);
		const url = owner ? standbyUrl(service.task ?? service.actor, owner.username) : '';
		const pool = standbyPoolSnapshot(service);
		return (
			'<h2>Actor Standby</h2>' +
			(owner
				? "<p>Open or copy the standby URL with the owner's token already in it:</p>" +
					standbyLink(url, owner.token)
				: '') +
			definitionList([
				['standbyUrl', url],
				['build', config.build],
				['memoryMbytes', config.memoryMbytes],
				['desiredRequestsPerActorRun', config.desiredRequestsPerActorRun],
				['maxRequestsPerActorRun', config.maxRequestsPerActorRun],
				['idleTimeoutSecs', config.idleTimeoutSecs],
				['shouldPassActorInput', String(config.shouldPassActorInput)],
			]) +
			'<h3>Standby runs</h3>' +
			(pool.length === 0
				? '<p class="empty">(none running - the next request starts one)</p>'
				: table(
						['runId', 'open requests', 'ready'],
						pool.map((entry) => [
							entry.runId
								? { text: entry.runId, href: `/runs/${encodeURIComponent(entry.runId)}` }
								: '(starting)',
							String(entry.openRequests),
							entry.ready ? 'yes' : 'no',
						]),
					))
		);
	}

	app.get('/actors/:id', async (req, res) => {
		const actor = await getActorById(req.params.id);
		if (!actor) {
			res.status(404).send(layout('Not found', '<p>Actor not found.</p>'));
			return;
		}
		const devFolderError = typeof req.query.devFolderError === 'string' ? req.query.devFolderError : undefined;
		const debugModeError = typeof req.query.debugModeError === 'string' ? req.query.debugModeError : undefined;
		const browserViewError =
			typeof req.query.browserViewError === 'string' ? req.query.browserViewError : undefined;
		const pricingError = typeof req.query.pricingError === 'string' ? req.query.pricingError : undefined;
		const body =
			definitionList([
				['id', actor.id],
				['user', await createNameResolver().userName(actor.userId)],
				['name', actor.name],
				['title', actor.title ?? ''],
				['createdAt', actor.createdAt],
				['modifiedAt', actor.modifiedAt],
			]) +
			'<h2>Versions</h2>' +
			table(
				['versionNumber', 'buildTag', 'files', 'dockerContext'],
				actor.versions.map((v) => [
					v.versionNumber,
					v.buildTag,
					String(v.localSourceContext?.fileCount ?? v.sourceFiles.length),
					v.localSourceContext ? dockerContextCell(v.localSourceContext) : '',
				]),
			) +
			'<h2>Tagged builds</h2>' +
			table(
				['tag', 'buildId', 'buildNumber'],
				Object.entries(actor.taggedBuilds).map(([tag, b]) => [tag, b.buildId, b.buildNumber]),
				1,
				'/builds',
			) +
			pricingSection(actor.id, actor.pricingInfos, pricingError) +
			devFolderSection(actor.id, devFolderStatus(actor), liveDevFolderStatus(actor).enabled, devFolderError) +
			debugModeSection(actor.id, actor.localDebug, debugModeError) +
			browserViewSection(actor.id, actor.localBrowserView, browserViewError) +
			(await standbySection(actorStandbyService(actor))) +
			'<h2>Tasks</h2>' +
			table(
				['id', 'name', 'title'],
				newestCreatedFirst((await listAllTasks()).filter((task) => task.actorId === actor.id)).map((task) => [
					task.id,
					task.name,
					task.title,
				]),
				0,
				'/tasks',
			) +
			(await webhooksSection('actorId', actor.id)) +
			(await schedulesSection('actorId', actor.id));
		res.send(layout(`Actor ${actor.name}`, body));
	});

	app.get('/tasks', async (_req, res) => {
		const tasks = newestCreatedFirst(await listAllTasks());
		const runs = await listAllRuns();
		const names = createNameResolver();
		const rows = await Promise.all(
			tasks.map(async (task) => [
				task.id,
				await names.userName(task.userId),
				task.name,
				task.title,
				await names.actorLink(task.actorId),
				String(runs.filter((run) => run.actorTaskId === task.id).length),
			]),
		);
		res.send(layout('Tasks', table(['id', 'user', 'name', 'title', 'actor', 'runs'], rows, 0, '/tasks')));
	});

	app.get('/tasks/:id', async (req, res) => {
		const task = await getTaskById(req.params.id);
		if (!task) {
			res.status(404).send(layout('Not found', '<p>Task not found.</p>'));
			return;
		}
		const names = createNameResolver();
		const actor = await getActorById(task.actorId);
		const options = Object.entries(task.options ?? {});
		const runs = newestFirst((await listAllRuns()).filter((run) => run.actorTaskId === task.id));
		const body =
			definitionList([
				['id', task.id],
				['user', await names.userName(task.userId)],
				['name', task.name],
				['title', task.title],
				['description', task.description ?? ''],
				['actor', await names.actorLink(task.actorId)],
				['createdAt', task.createdAt],
				['modifiedAt', task.modifiedAt],
			]) +
			'<h2>Run options</h2>' +
			(options.length > 0
				? definitionList(options)
				: '<p class="empty">(none - runs use the Actor\'s default run options)</p>') +
			'<h2>Input</h2><pre>' +
			escapeHtml(JSON.stringify(task.input ?? {}, null, 2)) +
			'</pre>' +
			(actor ? await standbySection(taskStandbyService(actor, task)) : '') +
			'<h2>Runs</h2>' +
			table(
				['id', 'status', 'origin', 'startedAt', 'usageTotalUsd'],
				runs.map((r) => [
					r.id,
					r.status,
					r.meta.origin,
					r.startedAt,
					formatUsd(computeRunUsage(r, getRunTelemetry(r.id)).usageTotalUsd),
				]),
				0,
				'/runs',
			) +
			(await webhooksSection('actorTaskId', task.id)) +
			(await schedulesSection('actorTaskId', task.id));
		res.send(layout(`Task ${task.name}`, body));
	});

	/** The webhooks that fire for one Actor or task. */
	async function webhooksSection(key: 'actorId' | 'actorTaskId', id: string): Promise<string> {
		const webhooks = (await listAllWebhooks()).filter(
			(webhook) => (webhook.condition as Record<string, string>)[key] === id,
		);
		return (
			'<h2>Webhooks</h2>' +
			table(
				['id', 'event types', 'request URL', 'enabled'],
				newestCreatedFirst(webhooks).map((webhook) => [
					webhook.id,
					webhook.eventTypes.join(', '),
					webhook.requestUrl,
					webhook.isEnabled ? 'yes' : 'no',
				]),
				0,
				'/webhooks',
			)
		);
	}

	/** The Actor, task or run a webhook fires for, linked to its page. */
	async function conditionCell(names: ReturnType<typeof createNameResolver>, condition: WebhookCondition) {
		if ('actorId' in condition) return names.actorLink(condition.actorId);
		if ('actorTaskId' in condition) return names.taskLink(condition.actorTaskId);
		return { text: `run ${condition.actorRunId}`, href: `/runs/${encodeURIComponent(condition.actorRunId)}` };
	}

	app.get('/webhooks', async (_req, res) => {
		const webhooks = newestCreatedFirst(await listAllWebhooks());
		const names = createNameResolver();
		const rows = await Promise.all(
			webhooks.map(async (webhook) => [
				webhook.id,
				await names.userName(webhook.userId),
				await conditionCell(names, webhook.condition),
				webhook.eventTypes.join(', '),
				webhook.requestUrl,
				webhook.isEnabled ? 'yes' : 'no',
				String(webhook.stats.totalDispatches),
				webhook.lastDispatch?.status ?? '',
			]),
		);
		res.send(
			layout(
				'Webhooks',
				table(
					['id', 'user', 'fires for', 'event types', 'request URL', 'enabled', 'dispatches', 'last dispatch'],
					rows,
					0,
					'/webhooks',
				),
			),
		);
	});

	app.get('/webhooks/:id', async (req, res) => {
		const webhook = await getWebhookById(req.params.id);
		if (!webhook) {
			res.status(404).send(layout('Not found', '<p>Webhook not found.</p>'));
			return;
		}
		const names = createNameResolver();
		const dispatches = newestCreatedFirst(
			(await listAllWebhookDispatches()).filter((dispatch) => dispatch.webhookId === webhook.id),
		);
		const body =
			definitionList([
				['id', webhook.id],
				['user', await names.userName(webhook.userId)],
				['title', webhook.title ?? ''],
				['description', webhook.description ?? ''],
				['fires for', await conditionCell(names, webhook.condition)],
				['event types', webhook.eventTypes.join(', ')],
				['request URL', webhook.requestUrl],
				['enabled', webhook.isEnabled ? 'yes' : 'no'],
				['ad hoc', webhook.isAdHoc ? 'yes' : 'no'],
				['retries', webhook.doNotRetry ? 'no' : 'yes'],
				['ignore SSL errors', webhook.ignoreSslErrors ? 'yes' : 'no'],
				['interpolate strings', webhook.shouldInterpolateStrings ? 'yes' : 'no'],
				['createdAt', webhook.createdAt],
				['modifiedAt', webhook.modifiedAt],
			]) +
			'<h2>Payload template</h2><pre>' +
			escapeHtml(webhook.payloadTemplate) +
			'</pre>' +
			(webhook.headersTemplate
				? `<h2>Headers template</h2><pre>${escapeHtml(webhook.headersTemplate)}</pre>`
				: '') +
			'<h2>Dispatches</h2>' +
			table(
				['id', 'event type', 'status', 'createdAt', 'calls'],
				dispatches.map((dispatch) => [
					dispatch.id,
					dispatch.eventType,
					dispatch.status,
					dispatch.createdAt,
					String(dispatch.calls.length),
				]),
				0,
				'/webhook-dispatches',
			);
		res.send(layout(`Webhook ${webhook.title ?? webhook.id}`, body));
	});

	app.get('/webhook-dispatches/:id', async (req, res) => {
		const dispatch = await getWebhookDispatchById(req.params.id);
		if (!dispatch) {
			res.status(404).send(layout('Not found', '<p>Webhook dispatch not found.</p>'));
			return;
		}
		const names = createNameResolver();
		const body =
			definitionList([
				['id', dispatch.id],
				['user', await names.userName(dispatch.userId)],
				['webhook', { text: dispatch.webhookId, href: `/webhooks/${encodeURIComponent(dispatch.webhookId)}` }],
				['event type', dispatch.eventType],
				['status', dispatch.status],
				['request URL', dispatch.webhook.requestUrl],
				['createdAt', dispatch.createdAt],
				['finishedAt', dispatch.finishedAt ?? ''],
				...(dispatch.status === 'ACTIVE'
					? ([['next attempt', dispatch.callAt]] as Array<[string, string]>)
					: []),
			]) +
			'<h2>Calls</h2>' +
			table(
				['startedAt', 'finishedAt', 'response status', 'error', 'response body'],
				dispatch.calls.map((call) => [
					call.startedAt,
					call.finishedAt ?? '',
					call.responseStatus === null ? '' : String(call.responseStatus),
					call.errorMessage ?? '',
					call.responseBody ?? '',
				]),
			) +
			'<h2>Event data</h2><pre>' +
			escapeHtml(JSON.stringify(dispatch.eventData, null, 2)) +
			'</pre>';
		res.send(layout(`Webhook dispatch ${dispatch.id}`, body));
	});

	/** The schedules with an action that runs one Actor or task. */
	async function schedulesSection(key: 'actorId' | 'actorTaskId', id: string): Promise<string> {
		const schedules = (await listAllSchedules()).filter((schedule) =>
			schedule.actions.some((action) => (action as unknown as Record<string, string>)[key] === id),
		);
		return (
			'<h2>Schedules</h2>' +
			table(
				['id', 'name', 'cron expression', 'enabled', 'nextRunAt'],
				newestCreatedFirst(schedules).map((schedule) => [
					schedule.id,
					schedule.name,
					schedule.cronExpression,
					schedule.isEnabled ? 'yes' : 'no',
					schedule.nextRunAt ?? '',
				]),
				0,
				'/schedules',
			)
		);
	}

	/** What an action runs, linked to its page. */
	async function actionTargetCell(names: ReturnType<typeof createNameResolver>, action: ScheduleAction) {
		return action.type === 'RUN_ACTOR' ? names.actorLink(action.actorId) : names.taskLink(action.actorTaskId);
	}

	app.get('/schedules', async (_req, res) => {
		const schedules = newestCreatedFirst(await listAllSchedules());
		const names = createNameResolver();
		const rows = await Promise.all(
			schedules.map(async (schedule) => [
				schedule.id,
				await names.userName(schedule.userId),
				schedule.name,
				schedule.cronExpression,
				schedule.timezone,
				schedule.isEnabled ? 'yes' : 'no',
				String(schedule.actions.length),
				schedule.nextRunAt ?? '',
				schedule.lastRunAt ?? '',
			]),
		);
		res.send(
			layout(
				'Schedules',
				table(
					[
						'id',
						'user',
						'name',
						'cron expression',
						'timezone',
						'enabled',
						'actions',
						'nextRunAt',
						'lastRunAt',
					],
					rows,
					0,
					'/schedules',
				),
			),
		);
	});

	app.get('/schedules/:id', async (req, res) => {
		const schedule = await getScheduleById(req.params.id);
		if (!schedule) {
			res.status(404).send(layout('Not found', '<p>Schedule not found.</p>'));
			return;
		}
		const names = createNameResolver();
		const runs = newestFirst((await listAllRuns()).filter((run) => run.meta.scheduleId === schedule.id));
		const actionRows = await Promise.all(
			schedule.actions.map(async (action) => [
				action.id,
				action.type,
				await actionTargetCell(names, action),
				action.type === 'RUN_ACTOR'
					? (action.runInput?.body ?? '')
					: action.input
						? JSON.stringify(action.input)
						: '',
				action.type === 'RUN_ACTOR' && action.runOptions ? JSON.stringify(action.runOptions) : '',
			]),
		);
		const body =
			definitionList([
				['id', schedule.id],
				['user', await names.userName(schedule.userId)],
				['name', schedule.name],
				['title', schedule.title],
				['description', schedule.description ?? ''],
				['cron expression', schedule.cronExpression],
				['timezone', schedule.timezone],
				['enabled', schedule.isEnabled ? 'yes' : 'no'],
				['exclusive', schedule.isExclusive ? 'yes' : 'no'],
				['nextRunAt', schedule.nextRunAt ?? ''],
				['lastRunAt', schedule.lastRunAt ?? ''],
				['createdAt', schedule.createdAt],
				['modifiedAt', schedule.modifiedAt],
			]) +
			'<h2>Actions</h2>' +
			table(['id', 'type', 'runs', 'input', 'run options'], actionRows) +
			'<h2>Runs</h2>' +
			table(
				['id', 'actor', 'status', 'scheduledAt', 'startedAt', 'usageTotalUsd'],
				await Promise.all(
					runs.map(async (r) => [
						r.id,
						await names.actorLink(r.actorId),
						r.status,
						r.meta.scheduledAt ?? '',
						r.startedAt,
						formatUsd(computeRunUsage(r, getRunTelemetry(r.id)).usageTotalUsd),
					]),
				),
				0,
				'/runs',
			) +
			'<h2>Log</h2>' +
			table(
				['createdAt', 'level', 'message'],
				[...schedule.log].reverse().map((entry) => [entry.createdAt, entry.level, entry.message]),
			);
		res.send(layout(`Schedule ${schedule.name}`, body));
	});

	/** Same `setActorPricingInfos` as the API, cross-user like the other Actor forms. Only the JSON parse
	 * is this route's own; every other rejection comes from the shared validator. */
	app.post('/actors/:id/pricing', async (req, res) => {
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
		const submitted = typeof body?.pricingInfos === 'string' ? body.pricingInfos.trim() : '';
		let parsed: unknown;
		try {
			parsed = submitted === '' ? [] : JSON.parse(submitted);
		} catch (error) {
			const message = `Not valid JSON: ${error instanceof Error ? error.message : String(error)}`;
			res.redirect(`/actors/${encodeURIComponent(actor.id)}?pricingError=${encodeURIComponent(message)}`);
			return;
		}
		const result = await setActorPricingInfos(actor, parsed);
		if (result.kind !== 'ok') {
			res.redirect(`/actors/${encodeURIComponent(actor.id)}?pricingError=${encodeURIComponent(result.message)}`);
			return;
		}
		res.redirect(`/actors/${encodeURIComponent(actor.id)}`);
	});

	app.post('/actors/:id/live-dev-folder', async (req, res) => {
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
		await setLiveDevFolder(actor, { enabled: body?.enabled === 'on' });
		res.redirect(`/actors/${encodeURIComponent(actor.id)}`);
	});

	/** Same `setBrowserView` as the API endpoint, cross-user like the debug-mode form above. */
	app.post('/actors/:id/browser-view', async (req, res) => {
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
		const mode = typeof body?.mode === 'string' ? body.mode : 'off';
		const enabled = mode !== 'off';
		const requestBody: Record<string, unknown> = { enabled };
		if (enabled) requestBody.interactive = mode === 'interactive';

		const result = await setBrowserView(actor, requestBody);
		if (result.kind !== 'ok') {
			res.redirect(
				`/actors/${encodeURIComponent(actor.id)}?browserViewError=${encodeURIComponent(result.message)}`,
			);
			return;
		}
		res.redirect(`/actors/${encodeURIComponent(actor.id)}`);
	});

	/** One of the console's six mutations - funnels through the same `setDevFolder` the API endpoint uses,
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

	/** One of the console's six mutations - funnels through the same `setDebugMode` the API endpoint
	 * uses, resolving the Actor cross-user by the id already in the page URL, like the dev-folder form
	 * above. A failure redirects back with the classified message in a query param. */
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
		const language = typeof body?.language === 'string' ? body.language : 'off';
		const enabled = language !== 'off';
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
		const names = createNameResolver();
		const rows = await Promise.all(
			builds.map(async (b) => [b.id, await names.actorLink(b.actorId), b.buildNumber, b.status, b.startedAt]),
		);
		res.send(layout('Builds', table(['id', 'actor', 'buildNumber', 'status', 'startedAt'], rows, 0, '/builds')));
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
				['actor', await createNameResolver().actorLink(build.actorId)],
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
		const names = createNameResolver();
		const rows = await Promise.all(
			runs.map(async (r) => [
				r.id,
				await names.actorLink(r.actorId),
				r.status,
				r.startedAt,
				storageLink('/datasets', r.defaultDatasetId),
				formatUsd(computeRunUsage(r, getRunTelemetry(r.id)).usageTotalUsd),
			]),
		);
		res.send(
			layout(
				'Runs',
				table(['id', 'actor', 'status', 'startedAt', 'defaultDatasetId', 'usageTotalUsd'], rows, 0, '/runs'),
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
		const migrateError = typeof req.query.migrateError === 'string' ? req.query.migrateError : undefined;
		// migrateError renders regardless of status - a raced press usually means the run just ended.
		const migrateErrorHtml = migrateError
			? `<p class="error"><strong>Error:</strong> ${escapeHtml(migrateError)}</p>`
			: '';
		const migrateSection =
			'<h2>Migration</h2>' +
			migrateErrorHtml +
			(run.status === 'RUNNING'
				? migrateRunForm(run.id)
				: `<p class="empty">Only a RUNNING run can be migrated (current status: ${escapeHtml(run.status)}).</p>`);
		const rows: Array<[string, unknown]> = [
			['id', run.id],
			['actor', await createNameResolver().actorLink(run.actorId)],
			...(run.actorTaskId
				? ([['task', await createNameResolver().taskLink(run.actorTaskId)]] as Array<[string, unknown]>)
				: []),
			['build', { text: run.buildNumber, href: `/builds/${encodeURIComponent(run.buildId)}` }],
			['status', run.status],
			['startedAt', run.startedAt],
			['finishedAt', run.finishedAt ?? ''],
			['statusMessage', run.statusMessage ?? ''],
			['origin', run.meta.origin],
			...(run.meta.scheduleId
				? ([['schedule', await createNameResolver().scheduleLink(run.meta.scheduleId)]] as Array<
						[string, unknown]
					>)
				: []),
			['migrationCount', run.stats?.migrationCount ?? 0],
			['rebootCount', run.stats?.rebootCount ?? 0],
		];
		// Only present for a run that resolved a debug plan; never on the emulated `/v2` run object.
		if (run.localDebug) {
			rows.push(['debug', `${run.localDebug.language}, attach at 127.0.0.1:${run.localDebug.port}`]);
		}
		if (run.localBrowserView) {
			rows.push([
				'browser view',
				{
					text: `${run.localBrowserView.interactive ? 'interactive' : 'view-only'} live mirror of the run's display`,
					href: `/runs/${encodeURIComponent(run.id)}/browser`,
				},
			]);
		}
		// Every run has one, as on the platform (`actor-driver.md`'s "Web server (live view)").
		const url = containerUrl(run.id);
		rows.push(['containerUrl (live view)', { text: url, href: url }]);
		const usage = computeRunUsage(run, getRunTelemetry(run.id));
		const body =
			runDetailsColumns(run, rows) +
			usageSection(run, usage) +
			migrateSection +
			'<h2>Log</h2><pre>' +
			(log ? ansiToHtml(log) : '(empty)') +
			'</pre>';
		res.send(layout(`Run ${run.id}`, body));
	});

	/** The viewer page; its websocket is handled by `console/browser-view-ws.ts`, not Express. */
	app.get('/runs/:id/browser', async (req, res) => {
		const run = await getRunById(req.params.id);
		if (!run) {
			res.status(404).send(layout('Not found', '<p>Run not found.</p>'));
			return;
		}
		const backLink = `<p><a href="/runs/${encodeURIComponent(run.id)}">Back to the run</a></p>`;
		// Mirror still starting: render the client, which retries.
		if (!run.localBrowserView && (await isBrowserViewPending(run))) {
			const actor = await getActorById(run.actorId);
			res.send(
				layout(
					`Browser view of run ${run.id}`,
					browserViewPage({
						...run,
						localBrowserView: {
							interactive: actor?.localBrowserView?.interactive ?? false,
							vncHost: '',
							vncPort: 0,
						},
					}),
				),
			);
			return;
		}
		if (!run.localBrowserView) {
			res.status(404).send(
				layout(
					`Browser view of run ${run.id}`,
					'<p class="empty">Browser view was not on for this run when it started, so there is no display ' +
						'mirror to show. Turn it on for the Actor and start a new run.</p>' +
						backLink,
				),
			);
			return;
		}
		if (isTerminalJobStatus(run.status)) {
			res.send(
				layout(
					`Browser view of run ${run.id}`,
					`<p class="empty">This run has ended (status: ${escapeHtml(run.status)}); its display mirror is gone.</p>` +
						backLink,
				),
			);
			return;
		}
		res.send(
			layout(
				`Browser view of run ${run.id}`,
				browserViewPage(run as typeof run & { localBrowserView: NonNullable<typeof run.localBrowserView> }),
			),
		);
	});

	/** One of the console's six writes (`console.md`) - the same `migrateRun` as the API endpoint, cross-user
	 * like the dev-folder form. */
	app.post('/runs/:id/migrate', async (req, res) => {
		if (isCrossSiteWrite(req)) {
			res.status(403).send('Cross-site form submissions are not allowed.');
			return;
		}
		const run = await getRunById(req.params.id);
		if (!run) {
			res.status(404).send(layout('Not found', '<p>Run not found.</p>'));
			return;
		}
		const result = await migrateRun(deps.driver, run);
		if (result === 'not-running') {
			const message = `Only a RUNNING run can be migrated (current status: ${run.status}).`;
			res.redirect(`/runs/${encodeURIComponent(run.id)}?migrateError=${encodeURIComponent(message)}`);
			return;
		}
		res.redirect(`/runs/${encodeURIComponent(run.id)}`);
	});

	app.get('/logs', async (_req, res) => {
		const [builds, runs] = await Promise.all([listAllBuilds(), listAllRuns()]);
		// Builds and runs share this one list, so they're merged before sorting rather than each sorted on
		// its own and concatenated - otherwise every build would still render before every run (or vice
		// versa) regardless of which is actually newer.
		const entries = newestFirst([
			...builds.map((b) => ({
				id: b.id,
				actorId: b.actorId,
				kind: 'build' as const,
				status: b.status,
				startedAt: b.startedAt,
			})),
			...runs.map((r) => ({
				id: r.id,
				actorId: r.actorId,
				kind: 'run' as const,
				status: r.status,
				startedAt: r.startedAt,
			})),
		]);
		const names = createNameResolver();
		const rows = await Promise.all(
			entries.map(async (e) => [e.id, await names.actorLink(e.actorId), e.kind, e.status]),
		);
		res.send(layout('Logs', table(['id', 'actor', 'kind', 'status'], rows, 0, '/logs')));
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
		const names = createNameResolver();
		const rows = await Promise.all(
			records.map(async (r) => [r.id, await names.userName(r.userId), r.name ?? '', r.createdAt]),
		);
		res.send(layout('Datasets', table(['id', 'user', 'name', 'createdAt'], rows, 0, '/datasets')));
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
				['user', await createNameResolver().userName(record.userId)],
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
		const names = createNameResolver();
		const rows = await Promise.all(
			records.map(async (r) => [r.id, await names.userName(r.userId), r.name ?? '', r.createdAt]),
		);
		res.send(layout('Key-value stores', table(['id', 'user', 'name', 'createdAt'], rows, 0, '/key-value-stores')));
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
				['user', await createNameResolver().userName(record.userId)],
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
		const names = createNameResolver();
		const rows = await Promise.all(
			records.map(async (r) => [r.id, await names.userName(r.userId), r.name ?? '', r.createdAt]),
		);
		res.send(layout('Request queues', table(['id', 'user', 'name', 'createdAt'], rows, 0, '/request-queues')));
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
				['user', await createNameResolver().userName(record.userId)],
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
	// through the API port itself (the dev-folder form's precedent). This is one of the console's four
	// mutations, alongside the dev-folder form, the debug-mode form, and the run detail view's Migrate
	// button - `console.md`'s "every route is a read except..." names all four.

	app.get('/settings', async (_req, res) => {
		const state = getApiFallbackState();
		const body =
			apiFallbackWarning() +
			'<section id="settings" data-live>' +
			definitionList([
				['fallbackUnimplementedEnabled', state.fallbackUnimplementedEnabled],
				['fallbackNotFoundEnabled', state.fallbackNotFoundEnabled],
				['upstreamBaseUrl', upstreamApiBaseUrl()],
				['apifyProxyEnabled', isApifyProxyEnabled()],
			]) +
			'<h2>Change settings</h2>' +
			settingsForm(state, isApifyProxyEnabled()) +
			'</section>';
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
		setApifyProxyEnabled(body?.apifyProxyEnabled === 'on');
		res.redirect('/settings');
	});

	return app;
}

/** Minimal server-rendered HTML helpers. No SPA, no bundler, no build step (`console.md`). */

import { getApiFallbackState, type ApiFallbackState } from '../services/api-fallback.js';
import type { ActorLocalBrowserView, ActorLocalDebug, ActorPricingInfoRecord, RunRecord } from '../storage/entities.js';
import { effectivePricingInfo, RESOLVED_PRICING_TIER } from '../services/pricing.js';
import { STARTER_PLAN_COMPUTE_UNIT_PRICE_USD, type RunUsage } from '../services/run-usage.js';

export function escapeHtml(value: unknown): string {
	return String(value ?? '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

const NAV = [
	['/actors', 'Actors'],
	['/builds', 'Builds'],
	['/runs', 'Runs'],
	['/logs', 'Logs'],
	['/datasets', 'Datasets'],
	['/key-value-stores', 'Key-value stores'],
	['/request-queues', 'Request queues'],
] as const;

function onOff(enabled: boolean): 'on' | 'off' {
	return enabled ? 'on' : 'off';
}

/** The final nav entry, present on every page (`console.md`'s "header state indicator") - "Settings"
 * plus both fallback toggles' current state, so neither toggle can ever be on without being visible from
 * anywhere in the console. Read fresh on every render, straight from `services/api-fallback.ts` - the
 * one module both the API route and the `/settings` form write through - never threaded in as an
 * argument, so this needs no change to `layout()`'s signature or any of its call sites. */
function fallbackNavEntry(): string {
	const state = getApiFallbackState();
	const label = `Settings — fallback (unimplemented: ${onOff(state.fallbackUnimplementedEnabled)}, not-found: ${onOff(state.fallbackNotFoundEnabled)})`;
	return `<a href="/settings">${label}</a>`;
}

/**
 * Saves `form[data-autosave]` in the background - on a checkbox/select change, or a submit - through the
 * same POST route a plain submit would hit, then swaps each `[data-live]` element (matched by id) for the
 * version in the page the route redirects to, so status rows and inline errors stay server-rendered.
 * Submissions of one form are serialized, and only the latest one's page is applied, so rapid clicks
 * cannot land out of order. Any failure falls back to a plain submit.
 */
const AUTOSAVE_SCRIPT = `
const inFlight = new WeakMap();
async function save(form) {
	const state = inFlight.get(form);
	if (state) { state.again = true; return; }
	inFlight.set(form, { again: false });
	let page;
	try {
		do {
			inFlight.get(form).again = false;
			const res = await fetch(form.action, { method: 'POST', body: new URLSearchParams(new FormData(form)) });
			if (!res.ok) throw new Error(res.statusText);
			page = await res.text();
		} while (inFlight.get(form).again);
	} catch {
		inFlight.delete(form);
		form.submit();
		return;
	}
	inFlight.delete(form);
	const focused = document.activeElement?.name;
	const fresh = new DOMParser().parseFromString(page, 'text/html');
	for (const el of fresh.querySelectorAll('[data-live][id]')) document.getElementById(el.id)?.replaceWith(el);
	if (focused) document.querySelector('#' + form.closest('[data-live]')?.id + ' [name="' + focused + '"]')?.focus();
}
document.addEventListener('change', (e) => {
	const form = e.target.closest('form[data-autosave]');
	if (form && e.target.matches('input[type=checkbox], select')) save(form);
});
document.addEventListener('submit', (e) => {
	if (!e.target.matches('form[data-autosave]')) return;
	e.preventDefault();
	save(e.target);
});
`;

export function layout(title: string, body: string): string {
	const nav = [...NAV.map(([href, label]) => `<a href="${href}">${label}</a>`), fallbackNavEntry()].join('');
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} - actor-runtime console</title>
<link rel="stylesheet" href="/console.css">
</head>
<body>
<header class="topbar">
<div class="topbar-inner">
<span class="brand">Apify <span>actor-runtime</span></span>
<nav id="nav" data-live>${nav}</nav>
</div>
</header>
<main>
<h1>${escapeHtml(title)}</h1>
${body}
</main>
<script>${AUTOSAVE_SCRIPT}</script>
</body>
</html>`;
}

/** A table cell (or definition-list value) rendered as a link to another console page. */
export interface LinkedCell {
	text: string;
	href: string;
}

function renderValue(value: unknown): string {
	if (value !== null && typeof value === 'object' && 'href' in value) {
		const { text, href } = value as LinkedCell;
		return `<a href="${escapeHtml(href)}">${escapeHtml(text)}</a>`;
	}
	return escapeHtml(value);
}

export function table(
	headers: string[],
	rows: Array<Array<string | LinkedCell>>,
	linkColumn = 0,
	linkPrefix = '',
): string {
	if (rows.length === 0) return '<p class="empty">Nothing here yet.</p>';
	const head = `<tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join('')}</tr>`;
	const body = rows
		.map((row) => {
			const cells = row
				.map((cell, i) =>
					i === linkColumn && linkPrefix && typeof cell === 'string'
						? `<td><a href="${linkPrefix}/${encodeURIComponent(cell)}">${escapeHtml(cell)}</a></td>`
						: `<td>${renderValue(cell)}</td>`,
				)
				.join('');
			return `<tr>${cells}</tr>`;
		})
		.join('');
	return `<table>${head}${body}</table>`;
}

/** The dev-folder registration form on the Actor detail view - a single text field plus a submit
 * button, styled via this file's shared `<style>` block (`.error`/`.wide-input`/`.empty`), matching
 * every other console page's convention of no inline `style=` attributes. */
export function devFolderForm(actorId: string, currentValue: string, errorMessage?: string): string {
	const errorHtml = errorMessage ? `<p class="error"><strong>Error:</strong> ${escapeHtml(errorMessage)}</p>` : '';
	return (
		errorHtml +
		`<form method="post" action="/actors/${encodeURIComponent(actorId)}/dev-folder">` +
		`<input type="text" name="localDevFolder" value="${escapeHtml(currentValue)}" ` +
		'placeholder="/abs/path/to/src" class="wide-input"> ' +
		'<button type="submit">Save</button>' +
		'</form>' +
		'<p class="empty">Submit an empty value to clear the registration.</p>'
	);
}

/** The debug-mode toggle form on the Actor detail view - full parity with the API body's three fields
 * (`enabled`/`language`/`port`), submitted together, never a partial-merge PATCH.
 *
 * `current` must be the *raw stored* `ActorLocalDebug`, not `debugStatus`'s display-computed value:
 * rendering the computed default port would pre-fill the port input, so an unrelated resubmission would
 * silently persist it as an explicit override. */
export function debugModeForm(
	actorId: string,
	current: ActorLocalDebug | null | undefined,
	errorMessage?: string,
): string {
	const errorHtml = errorMessage ? `<p class="error"><strong>Error:</strong> ${escapeHtml(errorMessage)}</p>` : '';
	const language = current?.language ?? 'auto';
	const portValue = current?.port !== undefined ? String(current.port) : '';
	const option = (value: string, label: string) =>
		`<option value="${value}"${language === value ? ' selected' : ''}>${label}</option>`;
	return (
		errorHtml +
		`<form method="post" action="/actors/${encodeURIComponent(actorId)}/debug" data-autosave>` +
		`<label><input type="checkbox" name="enabled"${current ? ' checked' : ''}> enabled</label> ` +
		`<label>language: <select name="language">` +
		option('auto', 'auto') +
		option('node', 'node') +
		option('python', 'python') +
		'</select></label> ' +
		`<label>port: <input type="number" name="port" value="${escapeHtml(portValue)}" min="1024" max="65535" ` +
		'placeholder="(default)"></label> ' +
		'<button type="submit">Save</button>' +
		'</form>' +
		'<p class="empty">"enabled" and "language" save on change; "Save" applies the port. Leave "port" blank to use the ' +
		"resolved language's own default port (5678 Python / 9229 Node) at run start.</p>"
	);
}

/** The browser-view toggle form; both API fields, submitted together like `debugModeForm`. */
export function browserViewForm(
	actorId: string,
	current: ActorLocalBrowserView | null | undefined,
	errorMessage?: string,
): string {
	const errorHtml = errorMessage ? `<p class="error"><strong>Error:</strong> ${escapeHtml(errorMessage)}</p>` : '';
	return (
		errorHtml +
		`<form method="post" action="/actors/${encodeURIComponent(actorId)}/browser-view" data-autosave>` +
		`<label><input type="checkbox" name="enabled"${current ? ' checked' : ''}> enabled</label> ` +
		`<label><input type="checkbox" name="interactive"${current?.interactive ? ' checked' : ''}> interactive ` +
		'(deliver mouse/keyboard input from the viewer)</label>' +
		'</form>' +
		'<p class="empty">When on, every run of this Actor gets a live mirror of its display, linked from the ' +
		"run's page. The browser must run headful to show anything (Crawlee JS: <code>headless: false</code>, " +
		'Python: <code>headless=False</code>).</p>'
	);
}

/** The viewer page: noVNC (served under `/vendor/novnc/`) connected to `console/browser-view-ws.ts`. The
 * run id is embedded as a JSON literal with `<` escaped so it cannot break out of the script element. */
export function browserViewPage(
	run: RunRecord & { localBrowserView: NonNullable<RunRecord['localBrowserView']> },
): string {
	const runIdLiteral = JSON.stringify(run.id).replace(/</g, '\\u003c');
	const viewOnly = run.localBrowserView.interactive ? 'false' : 'true';
	const mode = run.localBrowserView.interactive ? 'interactive' : 'view-only';
	return (
		`<p>Live mirror of the X display of run <a href="/runs/${encodeURIComponent(run.id)}">${escapeHtml(run.id)}</a> ` +
		`(${mode}). ` +
		(run.localBrowserView.interactive
			? 'Your mouse and keyboard input is delivered to the display. Nothing else is: no clipboard, no data to the Actor. '
			: 'Nothing is sent to the display, the browser, or the Actor: no input, no clipboard. ') +
		'The picture is read from the display the browser draws on.</p>' +
		'<p id="browser-view-status" class="empty">Connecting…</p>' +
		'<div id="browser-view-screen" class="browser-view-screen"></div>' +
		`<script type="module">
import RFB from '/vendor/novnc/core/rfb.js';
const runId = ${runIdLiteral};
const viewOnly = ${viewOnly};
const status = document.getElementById('browser-view-status');
const screen = document.getElementById('browser-view-screen');
const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
const url = scheme + '://' + location.host + '/runs/' + encodeURIComponent(runId) + '/browser/ws';
let attempts = 0;
function connect() {
	attempts += 1;
	status.textContent = attempts === 1 ? 'Connecting…' : 'Reconnecting (attempt ' + attempts + ')…';
	const rfb = new RFB(screen, url, { shared: true });
	rfb.viewOnly = viewOnly;
	rfb.scaleViewport = true;
	rfb.background = '#222';
	rfb.addEventListener('connect', () => {
		attempts = 0;
		status.textContent = "Connected - live view of the run's display" + (viewOnly ? ' (view-only).' : ' (interactive).') +
			' A black picture means nothing is drawn on the display: the browser is running headless. Launch it with headless off (Crawlee JS: headless: false; Python: headless=False).';
	});
	rfb.addEventListener('disconnect', () => {
		if (attempts >= 40) {
			status.textContent = 'Disconnected - the run has ended, or its display never came up. Reload to try again.';
			return;
		}
		status.textContent = 'Disconnected - the display is not up yet or went away; retrying…';
		setTimeout(connect, 3000);
	});
}
connect();
</script>`
	);
}

/** Six decimals at most, trailing zeros trimmed, never exponent notation. */
export function formatUsd(value: number): string {
	return `$${Number(value.toFixed(6)).toString()}`;
}

/** The pricing in effect plus a form carrying the whole array, the same value the API takes
 * (`console.md`). Tiered prices are shown resolved, since that is what a local run would be charged. */
export function pricingSection(
	actorId: string,
	pricingInfos: ActorPricingInfoRecord[] | undefined,
	errorMessage?: string,
): string {
	const effective = effectivePricingInfo(pricingInfos);
	let summary: string;
	if (!effective) {
		summary = '<p class="empty">No pricing - the Actor is free. Runs report platform usage only.</p>';
	} else if (effective.pricingModel !== 'PAY_PER_EVENT' || !effective.pricingPerEvent) {
		summary = definitionList([
			['pricingModel', effective.pricingModel],
			['startedAt', effective.startedAt],
		]);
	} else {
		const rows = Object.entries(effective.pricingPerEvent.actorChargeEvents).map(([eventName, event]) => [
			eventName,
			event.eventTitle,
			event.eventPriceUsd !== undefined
				? formatUsd(event.eventPriceUsd)
				: `${formatUsd(event.eventTieredPricingUsd?.[RESOLVED_PRICING_TIER]?.tieredEventPriceUsd ?? 0)} (${RESOLVED_PRICING_TIER} tier)`,
			event.isOneTimeEvent ? 'yes' : '',
		]);
		summary =
			definitionList([
				['pricingModel', effective.pricingModel],
				['startedAt', effective.startedAt],
			]) + table(['event', 'title', 'price per event', 'one-time'], rows);
	}
	const errorHtml = errorMessage ? `<p class="error"><strong>Error:</strong> ${escapeHtml(errorMessage)}</p>` : '';
	const currentJson = JSON.stringify(pricingInfos ?? [], null, 2);
	return (
		'<h2>Pricing</h2>' +
		summary +
		errorHtml +
		`<form method="post" action="/actors/${encodeURIComponent(actorId)}/pricing">` +
		`<textarea name="pricingInfos" class="json-input" rows="12" spellcheck="false">${escapeHtml(currentJson)}</textarea>` +
		'<button type="submit">Save</button>' +
		'</form>' +
		'<p class="empty">The whole <code>pricingInfos</code> array, as <code>PUT /v2/actors/:actorId</code> takes it - ' +
		'only <code>FREE</code> and <code>PAY_PER_EVENT</code> are emulated. The array is append-only: keep the entries ' +
		'already in the box and add at most one below them, starting after all of them. An entry with ' +
		'<code>"pricingModel":"FREE"</code> makes the Actor free again. ' +
		`Example: <code>[{"pricingModel":"PAY_PER_EVENT","pricingPerEvent":{"actorChargeEvents":{"page-scraped":{"eventTitle":"Page scraped","eventPriceUsd":0.002}}}}]</code></p>`
	);
}

/** The run object's own estimate, with the compute and event components split and the assumptions named
 * (`console.md`) - the figures are easy to mistake for a bill otherwise. */
export function usageSection(run: RunRecord, usage: RunUsage): string {
	const { stats } = usage;
	const megabytes = (bytes: number | undefined) =>
		bytes === undefined ? '' : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
	const percent = (value: number | undefined) => (value === undefined ? '' : `${value.toFixed(1)} %`);
	const rows: Array<[string, unknown]> = [
		['run time', `${stats.runTimeSecs.toFixed(1)} s`],
		[
			'compute units',
			`${stats.computeUnits.toFixed(6)} (${run.options.memoryMbytes} MB for ${stats.runTimeSecs.toFixed(1)} s)`,
		],
		[
			'platform usage',
			`${formatUsd(usage.platformUsageUsd)} (compute units at ${formatUsd(STARTER_PLAN_COMPUTE_UNIT_PRICE_USD)} each)`,
		],
		[
			'memory avg / max / current',
			[stats.memAvgBytes, stats.memMaxBytes, stats.memCurrentBytes].map(megabytes).join(' / '),
		],
		[
			'CPU avg / max / current (of one core)',
			[stats.cpuAvgUsage, stats.cpuMaxUsage, stats.cpuCurrentUsage].map(percent).join(' / '),
		],
	];
	let events = '';
	if (usage.eventUsage) {
		rows.push(['pay-per-event charges', formatUsd(usage.eventsUsd)]);
		rows.push([
			'maxTotalChargeUsd',
			run.options.maxTotalChargeUsd !== undefined && run.options.maxTotalChargeUsd > 0
				? formatUsd(run.options.maxTotalChargeUsd) +
					(run.chargingStoppedAt ? ` - reached at ${run.chargingStoppedAt}` : '')
				: '(no cap)',
		]);
		const eventRows = Object.entries(usage.eventUsage).map(([eventName, event]) => [
			eventName,
			event.eventTitle,
			String(run.chargedEventCounts?.[eventName] ?? 0),
			formatUsd(run.pricingInfo?.pricingPerEvent?.actorChargeEvents[eventName]?.eventPriceUsd ?? 0),
			formatUsd(event.eventTotalUsd),
		]);
		events =
			'<h3>Charged events</h3>' + table(['event', 'title', 'charged', 'price per event', 'total'], eventRows);
	}
	rows.push(['usageTotalUsd', formatUsd(usage.usageTotalUsd)]);
	return (
		'<h2>Usage and cost</h2>' +
		definitionList(rows) +
		events +
		`<p class="empty">An estimate, not a bill: compute units are the run's memory times its wall-clock time, priced at the ` +
		`lowest paid subscription tier (${RESOLVED_PRICING_TIER}). Storage operations, data transfer and proxy usage are not counted. ` +
		'<code>usageTotalUsd</code> is the platform usage plus the pay-per-event charges; on the platform a user of a ' +
		'pay-per-event Actor pays only the events unless the pricing says otherwise.</p>'
	);
}

/** Rendered only for a `RUNNING` run (`console.md`, "Migrate button"). */
export function migrateRunForm(runId: string): string {
	return (
		`<form method="post" action="/runs/${encodeURIComponent(runId)}/migrate">` +
		'<button type="submit">Migrate</button>' +
		'</form>' +
		'<p class="empty">Emulates a platform migration: sends the <code>migrating</code> event, stops the ' +
		'container a few seconds later (immediately if the Actor reboots itself), and restarts the same run. ' +
		'Reload this page to watch the log and stats change.</p>'
	);
}

/** The one-line credential-forwarding warning the `/settings` page shows above its form
 * (`console.md`'s "Settings page" section) - both toggles forward the caller's own Apify token the
 * moment either is on, so this is shown unconditionally, not only once a toggle is already on. */
export function apiFallbackWarning(): string {
	return '<p class="warning">Enabling either option below forwards the caller\'s own Apify token to the upstream API shown above.</p>';
}

/** The `/settings` page's one form (`console.md`): two checkboxes, each saving on change, always submitting both
 * checkboxes' current state together - an unchecked box is simply absent from the submitted body, which
 * the POST route (`console/server.ts`) reads as `false` for that field, never as "leave unchanged" (the
 * console form's own single-submit contract, unlike the API route's genuinely partial `POST`). */
export function settingsForm(state: ApiFallbackState): string {
	const checkedAttr = (enabled: boolean) => (enabled ? ' checked' : '');
	return (
		'<form method="post" action="/settings" data-autosave>' +
		'<p><label><input type="checkbox" name="fallbackUnimplementedEnabled"' +
		checkedAttr(state.fallbackUnimplementedEnabled) +
		'> Fall back for unimplemented endpoints</label></p>' +
		'<p><label><input type="checkbox" name="fallbackNotFoundEnabled"' +
		checkedAttr(state.fallbackNotFoundEnabled) +
		'> Fall back for not-found records</label></p>' +
		'</form>'
	);
}

export function definitionList(fields: Array<[string, unknown]>): string {
	const rows = fields.map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${renderValue(value)}</dd>`).join('');
	return `<dl>${rows}</dl>`;
}

/**
 * The standby URL with the owner's token in it, ready to open or copy. The token is masked on screen
 * only, so it does not end up in a screenshot or a screen share; the link and the copied text carry it.
 */
export function standbyLink(standbyUrl: string, token: string): string {
	const full = `${standbyUrl}/?token=${encodeURIComponent(token)}`;
	return (
		'<p class="standby-link">' +
		`<a href="${escapeHtml(full)}" target="_blank" rel="noopener">${escapeHtml(standbyUrl)}/?token=••••••••</a> ` +
		`<button type="button" data-copy="${escapeHtml(full)}">Copy link</button>` +
		'</p>' +
		`<script>
for (const button of document.querySelectorAll('button[data-copy]')) {
	button.addEventListener('click', async () => {
		const text = button.dataset.copy;
		try {
			await navigator.clipboard.writeText(text);
		} catch {
			// No clipboard API outside a secure context (the console opened by a non-localhost address).
			const field = Object.assign(document.createElement('textarea'), { value: text });
			document.body.append(field);
			field.select();
			document.execCommand('copy');
			field.remove();
		}
		button.textContent = 'Copied';
		setTimeout(() => (button.textContent = 'Copy link'), 1500);
	});
}
</script>`
	);
}

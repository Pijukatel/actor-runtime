/** Minimal server-rendered HTML helpers. No SPA, no bundler, no build step (`console.md`). */

import { getApiFallbackState, type ApiFallbackState } from '../services/api-fallback.js';

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

export function layout(title: string, body: string): string {
	const nav = [...NAV.map(([href, label]) => `<a href="${href}">${label}</a>`), fallbackNavEntry()].join(' | ');
	return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)} - actor-runtime console</title>
<style>
	body { font-family: -apple-system, sans-serif; margin: 2rem; color: #1a1a1a; }
	nav { margin-bottom: 1.5rem; padding-bottom: 0.5rem; border-bottom: 1px solid #ccc; }
	nav a { margin-right: 0.5rem; text-decoration: none; color: #0b5fff; }
	table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
	th, td { border: 1px solid #ddd; padding: 0.4rem 0.6rem; text-align: left; font-size: 0.9rem; }
	th { background: #f5f5f5; }
	dl { display: grid; grid-template-columns: max-content 1fr; gap: 0.25rem 1rem; }
	dt { font-weight: 600; }
	pre { background: #f5f5f5; padding: 1rem; overflow-x: auto; white-space: pre-wrap; }
	.empty { color: #777; font-style: italic; }
	.error { color: #b00020; }
	.warning { color: #94600b; }
	.wide-input { width: 28rem; }
	h1 { margin-top: 0; }
</style>
</head>
<body>
<nav>${nav}</nav>
<h1>${escapeHtml(title)}</h1>
${body}
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

/** The `/settings` page's one form (`console.md`): two checkboxes, one submit, always submitting both
 * checkboxes' current state together - an unchecked box is simply absent from the submitted body, which
 * the POST route (`console/server.ts`) reads as `false` for that field, never as "leave unchanged" (the
 * console form's own single-submit contract, unlike the API route's genuinely partial `POST`). */
export function settingsForm(state: ApiFallbackState): string {
	const checkedAttr = (enabled: boolean) => (enabled ? ' checked' : '');
	return (
		'<form method="post" action="/settings">' +
		'<p><label><input type="checkbox" name="fallbackUnimplementedEnabled"' +
		checkedAttr(state.fallbackUnimplementedEnabled) +
		'> Fall back for unimplemented endpoints</label></p>' +
		'<p><label><input type="checkbox" name="fallbackNotFoundEnabled"' +
		checkedAttr(state.fallbackNotFoundEnabled) +
		'> Fall back for not-found records</label></p>' +
		'<button type="submit">Save</button>' +
		'</form>'
	);
}

export function definitionList(fields: Array<[string, unknown]>): string {
	const rows = fields.map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${renderValue(value)}</dd>`).join('');
	return `<dl>${rows}</dl>`;
}

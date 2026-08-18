/** Minimal server-rendered HTML helpers. No SPA, no bundler, no build step (`console.md`). */

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

export function layout(title: string, body: string): string {
	const nav = NAV.map(([href, label]) => `<a href="${href}">${label}</a>`).join(' | ');
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

export function definitionList(fields: Array<[string, unknown]>): string {
	const rows = fields.map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${renderValue(value)}</dd>`).join('');
	return `<dl>${rows}</dl>`;
}

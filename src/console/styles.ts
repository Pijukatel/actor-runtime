/**
 * The console's single stylesheet, served at `/console.css` by `console/server.ts` and linked from
 * `templates.ts`'s `layout()`.
 *
 * A string constant rather than a `.css` file on disk because the build is `tsc` alone (`package.json`):
 * a `.css` next to this module would not be copied into `dist/`, so it would need either a build step or
 * a Dockerfile `COPY` that silently rots. Shipping it as a module keeps the console's "no SPA, no
 * bundler, no build step" contract (`templates.ts`) intact while still being one cacheable request
 * rather than a `<style>` block re-sent with every page.
 */

/**
 * Apify's design-system color tokens - a hand-picked subset of `@apify/ui-library`'s
 * `style/colors/tokens.light.css` and `tokens.dark.css` (Apache-2.0, public on npm), copied verbatim,
 * light values here and the dark overrides below.
 *
 * Copied rather than depended on, deliberately: `@apify/ui-library` is a React + styled-components
 * library whose runtime this server-rendered HTML has no use for, and pulling it in for two files of
 * custom properties would put React, Radix and ~25 other packages into the runtime image. The token
 * *names* are upstream's, unchanged, so adopting the real files later is a delete plus an import - and
 * the palette can be re-synced by diffing against the package.
 *
 * Only tokens this stylesheet actually uses are here; upstream ships ~150 per theme.
 */
const COLOR_TOKENS = `:root {
	color-scheme: light dark;

	--color-neutral-text: #1f2123;
	--color-neutral-text-muted: #3d3f43;
	--color-neutral-text-subtle: #6d7178;
	--color-neutral-text-on-primary: #ffffff;
	--color-neutral-background: #ffffff;
	--color-neutral-background-muted: #f9f9fa;
	--color-neutral-background-subtle: #f4f4f5;
	--color-neutral-card-background: #ffffff;
	--color-neutral-border: #d2d3d6;
	--color-neutral-separator-subtle: #e4e5e6;
	--color-neutral-hover: #edeeef;

	--color-primary-text: #246dff;
	--color-primary-action: #246dff;
	--color-primary-action-hover: #4788ff;
	--color-primary-action-active: #0043ca;
	--color-primary-background: #e0ebff;
	--color-primary-border-subtle: #c2d7ff;

	--color-danger-text: #e3231d;
	--color-danger-background: #fff0ec;
	--color-danger-border-subtle: #ffb39f;

	--color-warning-text: #a96600;
	--color-warning-background: #f9f0db;
	--color-warning-border-subtle: #f5b315;
}

@media (prefers-color-scheme: dark) {
	:root {
		--color-neutral-text: #f4f4f5;
		--color-neutral-text-muted: #bfc1c5;
		--color-neutral-text-subtle: #9ea2a8;
		--color-neutral-text-on-primary: #161718;
		--color-neutral-background: #161718;
		--color-neutral-background-muted: #1f2123;
		--color-neutral-background-subtle: #242528;
		--color-neutral-card-background: #1b1c1d;
		--color-neutral-border: #3d3f43;
		--color-neutral-separator-subtle: #333538;
		--color-neutral-hover: #292b2e;

		--color-primary-text: #6b9fff;
		--color-primary-action: #528fff;
		--color-primary-action-hover: #7aa8ff;
		--color-primary-action-active: #246dff;
		--color-primary-background: #152447;
		--color-primary-border-subtle: #1e52e0;

		--color-danger-text: #ff7157;
		--color-danger-background: #672523;
		--color-danger-border-subtle: #aa3229;

		--color-warning-text: #f9ce4b;
		--color-warning-background: #5d2e0e;
		--color-warning-border-subtle: #8a4f05;
	}
}`;

/**
 * Everything else, written against the tokens above.
 *
 * Two upstream conventions are load-bearing here and are why the numbers look odd out of context:
 *
 * - `font-size: 62.5%` on `html` makes `1rem` = `10px`, the scale every Apify spacing and typography
 *   token is expressed in (`space8` is `0.8rem`, body text is `1.4rem`). Copying a token value without
 *   it renders everything 1.6x too large. Upstream pins `font-size: 10px`; `62.5%` is the same default
 *   while still scaling with a reader's own browser font-size setting.
 * - Fonts are Inter and IBM Plex Mono, matching `ui-library`'s typography tokens, but neither is
 *   bundled or fetched: the runtime is meant to work offline and a webfont would be a network
 *   dependency on every page. Both are used only if the reader already has them, falling back to the
 *   platform's own UI and monospace faces.
 *
 * Styling is by element selector wherever possible. `templates.ts` emits bare `<a>`, `<table>` and
 * `<h2>` markup that several integration tests assert on as exact strings (e.g.
 * `settings-console.test.ts`'s check for the header's `/settings` anchor), so adding class attributes
 * to that markup would break them for no visual gain.
 */
const BASE_STYLES = `*,
*::before,
*::after {
	box-sizing: border-box;
}

html {
	font-size: 62.5%;
}

body {
	margin: 0;
	font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
	font-size: 1.4rem;
	line-height: 2rem;
	color: var(--color-neutral-text);
	background: var(--color-neutral-background-muted);
	-webkit-font-smoothing: antialiased;
}

/* Header: brand, then the nav links as pills. Sticky so the fallback state indicator that
   \`templates.ts\` keeps in the nav stays visible while reading a long log or dataset page. */
.topbar {
	position: sticky;
	top: 0;
	z-index: 1;
	background: var(--color-neutral-card-background);
	border-bottom: 1px solid var(--color-neutral-separator-subtle);
}

.topbar-inner {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 0.8rem 1.6rem;
	max-width: 132rem;
	margin: 0 auto;
	padding: 1.2rem 2.4rem;
}

.brand {
	font-size: 1.6rem;
	line-height: 2.4rem;
	font-weight: 650;
	letter-spacing: -0.01em;
	white-space: nowrap;
}

.brand span {
	color: var(--color-neutral-text-subtle);
	font-weight: 400;
}

nav {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 0.4rem;
}

nav a {
	display: inline-block;
	padding: 0.4rem 1rem;
	border-radius: 6px;
	color: var(--color-neutral-text-muted);
	font-weight: 500;
	text-decoration: none;
}

nav a:hover {
	background: var(--color-neutral-hover);
	color: var(--color-neutral-text);
}

main {
	max-width: 132rem;
	margin: 0 auto;
	padding: 2.4rem 2.4rem 6.4rem;
}

a {
	color: var(--color-primary-text);
	text-decoration: none;
}

a:hover {
	text-decoration: underline;
}

h1 {
	margin: 0 0 2.4rem;
	font-size: 2.4rem;
	line-height: 2.8rem;
	font-weight: 700;
	letter-spacing: -0.01em;
}

h2 {
	margin: 3.2rem 0 1.2rem;
	font-size: 1.8rem;
	line-height: 2.4rem;
	font-weight: 650;
}

p {
	margin: 0 0 1.2rem;
}

/* Tables and definition lists are the console's two data surfaces, so both get the same card
   treatment: a bordered, rounded panel on the page's muted background. */
table {
	width: 100%;
	margin: 0 0 2.4rem;
	border-collapse: separate;
	border-spacing: 0;
	border: 1px solid var(--color-neutral-border);
	border-radius: 8px;
	background: var(--color-neutral-card-background);
	overflow: hidden;
}

th,
td {
	padding: 0.8rem 1.2rem;
	text-align: left;
	border-bottom: 1px solid var(--color-neutral-separator-subtle);
}

th {
	background: var(--color-neutral-background-subtle);
	color: var(--color-neutral-text-muted);
	font-size: 1.2rem;
	line-height: 1.6rem;
	font-weight: 600;
	white-space: nowrap;
}

tr:last-child td {
	border-bottom: 0;
}

tbody tr:hover td,
table tr:hover td {
	background: var(--color-neutral-background-muted);
}

dl {
	display: grid;
	grid-template-columns: minmax(12rem, max-content) minmax(0, 1fr);
	gap: 0;
	margin: 0 0 2.4rem;
	border: 1px solid var(--color-neutral-border);
	border-radius: 8px;
	background: var(--color-neutral-card-background);
	overflow: hidden;
}

dt,
dd {
	margin: 0;
	padding: 0.8rem 1.2rem;
	border-bottom: 1px solid var(--color-neutral-separator-subtle);
}

dt {
	color: var(--color-neutral-text-subtle);
	font-weight: 500;
	background: var(--color-neutral-background-subtle);
	white-space: nowrap;
}

dd {
	word-break: break-word;
}

dl > :nth-last-child(-n + 2) {
	border-bottom: 0;
}

code,
pre {
	font-family: 'IBM Plex Mono', Consolas, 'Liberation Mono', Menlo, monospace;
}

code {
	padding: 0.1rem 0.5rem;
	border-radius: 4px;
	background: var(--color-neutral-background-subtle);
	font-size: 1.3rem;
}

pre code {
	padding: 0;
	border-radius: 0;
	background: none;
	font-size: inherit;
}

pre {
	margin: 0 0 2.4rem;
	padding: 1.6rem;
	border: 1px solid var(--color-neutral-border);
	border-radius: 8px;
	background: var(--color-neutral-card-background);
	font-size: 1.3rem;
	line-height: 2rem;
	overflow-x: auto;
	white-space: pre-wrap;
	word-break: break-word;
}

/* The console's forms are single-row affairs (\`templates.ts\`), so they lay out inline and wrap. */
form {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 0.8rem 1.2rem;
	margin: 0 0 1.2rem;
}

form p {
	flex-basis: 100%;
	margin: 0;
}

label {
	display: inline-flex;
	align-items: center;
	gap: 0.6rem;
	color: var(--color-neutral-text-muted);
}

input[type='text'],
input[type='number'],
textarea,
select {
	padding: 0.6rem 1rem;
	border: 1px solid var(--color-neutral-border);
	border-radius: 6px;
	background: var(--color-neutral-card-background);
	color: var(--color-neutral-text);
	font-family: inherit;
	font-size: 1.4rem;
	line-height: 2rem;
}

input[type='text']:focus,
input[type='number']:focus,
select:focus {
	outline: none;
	border-color: var(--color-primary-action);
	box-shadow: 0 0 0 3px var(--color-primary-background);
}

input[type='checkbox'] {
	width: 1.6rem;
	height: 1.6rem;
	margin: 0;
	accent-color: var(--color-primary-action);
}

button {
	padding: 0.6rem 1.4rem;
	border: 0;
	border-radius: 6px;
	background: var(--color-primary-action);
	color: var(--color-neutral-text-on-primary);
	font-family: inherit;
	font-size: 1.4rem;
	line-height: 2rem;
	font-weight: 500;
	cursor: pointer;
}

button:hover {
	background: var(--color-primary-action-hover);
}

button:active {
	background: var(--color-primary-action-active);
}

/* The three status classes \`templates.ts\` emits. \`.error\` and \`.warning\` become banners, since both
   only ever carry a message the reader has to act on; \`.empty\` stays plain muted text. */
.empty {
	color: var(--color-neutral-text-subtle);
}

.error,
.warning {
	padding: 1.2rem 1.6rem;
	border: 1px solid;
	border-radius: 8px;
}

.error {
	border-color: var(--color-danger-border-subtle);
	background: var(--color-danger-background);
	color: var(--color-danger-text);
}

.warning {
	border-color: var(--color-warning-border-subtle);
	background: var(--color-warning-background);
	color: var(--color-warning-text);
}

.wide-input {
	width: 40rem;
	max-width: 100%;
}

/* The pricing form's JSON editor: full width, monospace, resizable downwards only. */
.json-input {
	flex-basis: 100%;
	width: 100%;
	font-family: 'IBM Plex Mono', Consolas, 'Liberation Mono', Menlo, monospace;
	font-size: 1.3rem;
	resize: vertical;
}

.browser-view-screen {
	width: 100%;
	height: 75vh;
	border-radius: 8px;
	background: #222;
	overflow: hidden;
}

.browser-view-screen canvas {
	outline: none;
}`;

/** The stylesheet `console/server.ts` serves at `/console.css`. */
export const CONSOLE_CSS = `${COLOR_TOKENS}\n\n${BASE_STYLES}\n`;

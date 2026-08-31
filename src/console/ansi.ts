/**
 * Dependency-free ANSI SGR (Select Graphic Rendition) to HTML converter, used only by the console's
 * log views (`server.ts`). The API and raw `__LOGS__` storage keep the original bytes untouched - the
 * CLI needs those raw ANSI codes to render colors in a terminal (`console.md`) - this module exists
 * purely to turn the same bytes into readable `<span>`s when a log is rendered into an HTML `<pre>`.
 *
 * Only `ESC [ ... m` (SGR) sequences are turned into styling. Every other ANSI/control sequence -
 * cursor moves, erase-line, OSC window-title sequences, etc. - is recognised structurally and
 * stripped entirely, never leaking into the output. Text content is HTML-escaped before any `<span>`
 * is written around it, so there is no injection path through log content.
 *
 * This is a single left-to-right scan with no backtracking: every branch either consumes a fixed
 * chunk of the input and advances `i`, or reaches the end of the string, so the loop always
 * terminates in O(n).
 */
import { escapeHtml } from './templates.js';

const ESC = '\x1b';

/** Standard 30-37 and bright 90-97 SGR foreground codes, mapped to colors readable on the console's
 * light background (`templates.ts`'s `<pre>` uses a light-gray background, near-white page background) -
 * darkened versions of the usual terminal palette rather than the terminal-standard bright hues, which
 * would be too low-contrast here (e.g. bright yellow/white on a light background). */
const FG_COLOR_HEX: Readonly<Record<number, string>> = {
	30: '#000000',
	31: '#c62828',
	32: '#2e7d32',
	33: '#b8860b',
	34: '#1565c0',
	35: '#8e24aa',
	36: '#00838f',
	37: '#555555',
	90: '#757575',
	91: '#e53935',
	92: '#43a047',
	93: '#f9a825',
	94: '#1e88e5',
	95: '#ab47bc',
	96: '#00acc1',
	97: '#333333',
};

interface SgrStyle {
	color: number | null;
	bold: boolean;
	dim: boolean;
}

function isCsiFinalByte(code: number): boolean {
	// ECMA-48: CSI sequences end with a "final byte" in the 0x40-0x7E range; everything before it
	// (parameter bytes 0x30-0x3F, intermediate bytes 0x20-0x2F) is skipped over uninterpreted here.
	return code >= 0x40 && code <= 0x7e;
}

/** Mutates `style` in place per the (already-split-by-`;`) SGR parameter list. Unrecognised or
 * unsupported codes (underline, blink, background colors, 256-color/truecolor extended sequences,
 * ...) are simply no-ops - they neither throw nor corrupt the rest of the scan. */
function applySgrParams(params: string, style: SgrStyle): void {
	const tokens = params.length === 0 ? [''] : params.split(';');
	for (let idx = 0; idx < tokens.length; idx += 1) {
		const token = tokens[idx];
		// An empty parameter (e.g. bare `ESC[m`, or a stray `;;`) defaults to 0 per ECMA-48.
		const code = token === '' ? 0 : Number(token);
		if (!Number.isInteger(code)) continue; // malformed token - ignore and keep scanning

		if (code === 0) {
			style.color = null;
			style.bold = false;
			style.dim = false;
		} else if (code === 1) {
			style.bold = true;
		} else if (code === 2) {
			style.dim = true;
		} else if (code === 39) {
			style.color = null;
		} else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
			style.color = code;
		} else if (code === 38 || code === 48) {
			// Extended foreground/background (256-color `38;5;n` or truecolor `38;2;r;g;b`) - unsupported,
			// so skip its trailing parameters too. Without this, e.g. the `2` in `38;2;r;g;b` would
			// otherwise be misread on the next loop iteration as the unrelated "dim" code (2).
			const mode = tokens[idx + 1];
			if (mode === '5') idx += 2;
			else if (mode === '2') idx += 4;
			// Anything else (malformed extended sequence) - nothing extra to skip.
		}
		// Any other numeric code (underline, blink, background 40-47/100-107, etc.) - unsupported, no-op.
	}
}

function styleToCss(style: SgrStyle): string | null {
	const parts: string[] = [];
	if (style.color !== null) parts.push(`color:${FG_COLOR_HEX[style.color]}`);
	if (style.bold) parts.push('font-weight:bold');
	if (style.dim) parts.push('opacity:0.65');
	return parts.length > 0 ? parts.join(';') : null;
}

/**
 * Converts a raw log string that may contain ANSI escape sequences into HTML: SGR color/bold/dim
 * sequences become `<span style="...">`, everything else ANSI-shaped is stripped, and all text content
 * is HTML-escaped. Safe to drop straight into a `<pre>`.
 */
export function ansiToHtml(input: string): string {
	let output = '';
	const style: SgrStyle = { color: null, bold: false, dim: false };
	let spanOpen = false;
	let i = 0;

	const closeSpanIfOpen = (): void => {
		if (spanOpen) {
			output += '</span>';
			spanOpen = false;
		}
	};

	const reopenSpanForCurrentStyle = (): void => {
		closeSpanIfOpen();
		const css = styleToCss(style);
		if (css) {
			output += `<span style="${css}">`;
			spanOpen = true;
		}
	};

	while (i < input.length) {
		const escIndex = input.indexOf(ESC, i);
		if (escIndex === -1) {
			output += escapeHtml(input.slice(i));
			break;
		}
		if (escIndex > i) output += escapeHtml(input.slice(i, escIndex));

		const next = input[escIndex + 1];
		if (next === '[') {
			// CSI sequence: `ESC [ <params/intermediates> <final byte>`.
			let j = escIndex + 2;
			while (j < input.length && !isCsiFinalByte(input.charCodeAt(j))) j += 1;
			if (j < input.length) {
				const finalByte = input[j];
				if (finalByte === 'm') {
					applySgrParams(input.slice(escIndex + 2, j), style);
					reopenSpanForCurrentStyle();
				}
				// Any other final byte (cursor moves `A-H`, erase `J`/`K`, etc.) - not SGR, strip silently.
				i = j + 1;
			} else {
				// Truncated CSI sequence with no final byte before the string ends - drop the remainder.
				i = input.length;
			}
		} else if (next === ']') {
			// OSC sequence: `ESC ] ... BEL` or `ESC ] ... ESC \`. Strip through the terminator.
			let j = escIndex + 2;
			let terminatorEnd = -1;
			while (j < input.length) {
				if (input[j] === '\x07') {
					terminatorEnd = j + 1;
					break;
				}
				if (input[j] === ESC && input[j + 1] === '\\') {
					terminatorEnd = j + 2;
					break;
				}
				j += 1;
			}
			i = terminatorEnd === -1 ? input.length : terminatorEnd;
		} else if (next === undefined) {
			// Trailing lone ESC at the very end of the string.
			i = escIndex + 1;
		} else {
			// Other short escape sequences (ESC followed by a single letter, e.g. cursor save/restore) -
			// not SGR, strip the two-byte sequence.
			i = escIndex + 2;
		}
	}

	closeSpanIfOpen();
	return output;
}

import { describe, expect, it } from 'vitest';
import { ansiToHtml } from '../../src/console/ansi.js';

const ESC = '\x1b';

describe('ansiToHtml', () => {
	it('renders the SDK logger sample line as colored spans with no raw escape bytes', () => {
		const line = `${ESC}[32mINFO${ESC}[39m ${ESC}[33m CheerioCrawler:${ESC}[39m All requests have been processed.`;
		const html = ansiToHtml(line);

		expect(html).not.toContain(ESC);
		expect(html).toBe(
			'<span style="color:#2e7d32">INFO</span> <span style="color:#b8860b"> CheerioCrawler:</span> All requests have been processed.',
		);
	});

	it('renders bright foreground colors (90-97)', () => {
		const html = ansiToHtml(`${ESC}[91mfail${ESC}[39m`);
		expect(html).toBe('<span style="color:#e53935">fail</span>');
	});

	it('renders bold (1) combined with a color', () => {
		const html = ansiToHtml(`${ESC}[1;34mBOLD BLUE${ESC}[0m`);
		expect(html).toBe('<span style="color:#1565c0;font-weight:bold">BOLD BLUE</span>');
	});

	it('renders dim (2) as reduced opacity', () => {
		const html = ansiToHtml(`${ESC}[2mfaint${ESC}[0m`);
		expect(html).toBe('<span style="opacity:0.65">faint</span>');
	});

	it('reset (0) clears color, bold, and dim and closes the span', () => {
		const html = ansiToHtml(`${ESC}[1;31mred bold${ESC}[0m plain`);
		expect(html).toBe('<span style="color:#c62828;font-weight:bold">red bold</span> plain');
	});

	it('ignores unknown/unsupported SGR params without crashing or emitting a span', () => {
		// 4 = underline, 41 = background red - neither is supported, both are no-ops.
		const html = ansiToHtml(`${ESC}[4mplain text${ESC}[0m${ESC}[41mstill plain${ESC}[0m`);
		expect(html).toBe('plain textstill plain');
	});

	it('ignores extended 256-color and truecolor foreground sequences without corrupting later state', () => {
		// The `2` inside `38;2;255;0;0` must not be misread as the "dim" SGR code.
		const html = ansiToHtml(`${ESC}[38;2;255;0;0mtruecolor${ESC}[0m${ESC}[38;5;196m256color${ESC}[0m`);
		expect(html).toBe('truecolor256color');
	});

	it('strips non-SGR CSI sequences (cursor moves, erase-line) entirely', () => {
		const html = ansiToHtml(`${ESC}[2K${ESC}[1;1Hplain${ESC}[10A`);
		expect(html).toBe('plain');
	});

	it('strips OSC sequences (e.g. window title) terminated by BEL', () => {
		const html = ansiToHtml(`${ESC}]0;some title\x07plain`);
		expect(html).toBe('plain');
	});

	it('strips OSC sequences terminated by ESC \\ (ST)', () => {
		const html = ansiToHtml(`${ESC}]0;some title${ESC}\\plain`);
		expect(html).toBe('plain');
	});

	it('drops a truncated/unterminated CSI sequence at the end of the string instead of hanging', () => {
		const html = ansiToHtml(`plain${ESC}[1;3`);
		expect(html).toBe('plain');
	});

	it('drops a lone trailing ESC with nothing after it', () => {
		const html = ansiToHtml(`plain${ESC}`);
		expect(html).toBe('plain');
	});

	it('HTML-escapes text content, including inside a colored span', () => {
		const html = ansiToHtml(`${ESC}[31m<script>alert(1)</script>${ESC}[39m`);
		expect(html).toBe('<span style="color:#c62828">&lt;script&gt;alert(1)&lt;/script&gt;</span>');
		expect(html).not.toContain('<script>');
	});

	it('closes any span still open at the end of the string', () => {
		const html = ansiToHtml(`${ESC}[32munterminated`);
		expect(html).toBe('<span style="color:#2e7d32">unterminated</span>');
	});

	it('returns escaped plain text unchanged when there is no ANSI at all', () => {
		expect(ansiToHtml('plain log line')).toBe('plain log line');
	});

	it('returns an empty string for empty input', () => {
		expect(ansiToHtml('')).toBe('');
	});
});

/** What the platform prints in place of a redacted value, whatever its length. */
export const REDACTION_MASK = '*********';

export interface LogRedactor {
	/** The chunk with every secret masked, minus a tail that could be the start of a secret split across
	 * chunks; that tail is held back until the next chunk or `flush`. */
	redact(chunk: string): string;
	/** Whatever is still held back, masked as far as it can be. */
	flush(): string;
}

/**
 * Masks exact occurrences of `secrets` in a stream of log chunks, as the platform does in run logs. The
 * values are matched as they are: a secret printed reversed, encoded or split by other output is not
 * caught, on the platform either.
 */
export function createLogRedactor(secrets: readonly string[]): LogRedactor {
	// Longest first, so a secret containing a shorter one is masked whole.
	const values = [...new Set(secrets.filter((value) => value.length > 0))].sort((a, b) => b.length - a.length);
	let held = '';

	const mask = (text: string): string =>
		values.reduce((masked, value) => masked.split(value).join(REDACTION_MASK), text);

	/** Length of the longest suffix of `text` that is a proper prefix of some secret. */
	const heldBackLength = (text: string): number => {
		for (let length = Math.min(text.length, values[0]!.length - 1); length > 0; length--) {
			const suffix = text.slice(-length);
			if (values.some((value) => value.length > length && value.startsWith(suffix))) return length;
		}
		return 0;
	};

	return {
		redact(chunk) {
			if (values.length === 0) return chunk;
			const masked = mask(held + chunk);
			const keep = heldBackLength(masked);
			held = masked.slice(masked.length - keep);
			return masked.slice(0, masked.length - keep);
		},
		flush() {
			const rest = held;
			held = '';
			return rest;
		},
	};
}

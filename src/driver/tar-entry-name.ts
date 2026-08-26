import * as path from 'node:path';

/** Canonicalizes a source-file name to a tar entry name: POSIX separators, no leading `./`, then
 * `path.posix.normalize` (a leading `../` is left alone). */
export function normalizeEntryName(name: string): string {
	const posixName = name.replace(/\\/g, '/');
	const withoutLeadingDotSlash = posixName.replace(/^(?:\.\/)+/, '');
	return path.posix.normalize(withoutLeadingDotSlash);
}

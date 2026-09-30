/**
 * What both build-time resolvers (`dockerfile-location.ts`, `input-schema-location.ts`) need from a
 * version's pushed `sourceFiles`: the parsed `.actor/actor.json`, and the path fields inside it that
 * name another pushed file.
 *
 * Shared rather than written per field so the Actor-root containment check has one implementation:
 * a traversal hole patched in one copy would otherwise stay open in the other.
 *
 * `actorPath` is where the Actor sits inside the pushed files: `''` for an ordinary push, the Actor's
 * folder for a monorepo build context. Path fields may then leave the Actor's folder, never the context.
 */
import * as path from 'node:path';
import JSON5 from 'json5';

import { normalizeEntryName } from '../driver/tar-entry-name.js';
import type { SourceFile } from '../storage/entities.js';

export const ACTOR_DIR = '.actor';
export const ACTOR_JSON_NAME = `${ACTOR_DIR}/actor.json`;

export function sourceFileToText(file: SourceFile): string {
	return file.format === 'BASE64' ? Buffer.from(file.content, 'base64').toString('utf8') : file.content;
}

export interface IndexedFile {
	normalizedName: string;
	lowerName: string;
	file: SourceFile;
}

export function indexSourceFiles(sourceFiles: SourceFile[]): IndexedFile[] {
	return sourceFiles.map((file) => {
		const normalizedName = normalizeEntryName(file.name);
		return { normalizedName, lowerName: normalizedName.toLowerCase(), file };
	});
}

/** Exact-case match wins; otherwise the first match in `sourceFiles` order. */
export function findCaseInsensitive(indexed: IndexedFile[], candidate: string): IndexedFile | undefined {
	const lowerCandidate = candidate.toLowerCase();
	let firstMatch: IndexedFile | undefined;
	for (const file of indexed) {
		if (file.lowerName !== lowerCandidate) continue;
		if (file.normalizedName === candidate) return file; // exact case always wins immediately
		firstMatch ??= file;
	}
	return firstMatch;
}

/** `relativePath` inside the Actor at `actorPath`, as a normalized tar entry name. */
export function actorFilePath(actorPath: string, relativePath: string): string {
	return normalizeEntryName(actorPath === '' ? relativePath : path.posix.join(actorPath, relativePath));
}

/** `.actor/actor.json`'s own path is not case-folded, unlike the files its fields name. */
export function findExact(sourceFiles: SourceFile[], normalizedTarget: string): SourceFile | undefined {
	return sourceFiles.find((file) => normalizeEntryName(file.name) === normalizedTarget);
}

/** `absent` is not an error: an Actor need not push `.actor/actor.json` at all. */
export type ActorJsonParse =
	{ outcome: 'parsed'; specification: unknown } | { outcome: 'absent' } | { outcome: 'unparseable'; message: string };

export function parseActorJson(sourceFiles: SourceFile[], actorPath = ''): ActorJsonParse {
	const file = findExact(sourceFiles, actorFilePath(actorPath, ACTOR_JSON_NAME));
	if (!file) return { outcome: 'absent' };
	try {
		return { outcome: 'parsed', specification: JSON5.parse(sourceFileToText(file)) as unknown };
	} catch (error) {
		return { outcome: 'unparseable', message: `Could not parse .actor/actor.json: ${(error as Error).message}` };
	}
}

/** Where a `.actor/actor.json` path field points. `not-found` carries the path to name in the caller's
 * warning - the empty field and a path naming no pushed file are the same outcome, both falling through
 * to the default locations rather than failing. */
export type ActorJsonPathField =
	| { outcome: 'match'; file: IndexedFile }
	| { outcome: 'not-found'; shownPath: string }
	| { outcome: 'escapes-actor-root' };

/** `field` is resolved relative to `.actor/`, and may not leave the pushed files - which, for an ordinary
 * push, are the Actor root. */
export function resolveActorJsonPathField(indexed: IndexedFile[], field: string, actorPath = ''): ActorJsonPathField {
	if (field === '') return { outcome: 'not-found', shownPath: '' };
	if (field.startsWith('/')) return { outcome: 'escapes-actor-root' };

	const joined = normalizeEntryName(path.posix.join(actorFilePath(actorPath, ACTOR_DIR), field));
	if (joined === '..' || joined.startsWith('../')) return { outcome: 'escapes-actor-root' };

	const match = findCaseInsensitive(indexed, joined);
	return match ? { outcome: 'match', file: match } : { outcome: 'not-found', shownPath: joined };
}

export function fallbackWarningLine(shownPath: string, fieldName: string): string {
	return `Warning: "${shownPath}" (from the "${fieldName}" field in .actor/actor.json) is not in the pushed source; falling back to the default locations.\n`;
}

export function escapesActorRootMessage(rawField: string, subject: string, actorPath = ''): string {
	const boundary = actorPath === '' ? 'the Actor root directory' : 'the Docker context directory';
	return `${subject} path "${rawField}" in .actor/actor.json points outside ${boundary}.`;
}

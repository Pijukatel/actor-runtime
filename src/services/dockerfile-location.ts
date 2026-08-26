/**
 * Resolves which Dockerfile a build should use from the version's `sourceFiles`. Candidate order,
 * stopping at the first hit: 1) the `dockerfile` field of `.actor/actor.json`, relative to `.actor` 2)
 * `.actor/Dockerfile` 3) `Dockerfile` at the Actor root 4) the bundled default. Matching is
 * case-insensitive; the returned path is always the matched file's own name, never the candidate's
 * casing - Docker's tar lookup is case-sensitive. An exact-case match wins over a case-differing one.
 */
import * as path from 'node:path';
import JSON5 from 'json5';

import { normalizeEntryName } from '../driver/tar-entry-name.js';
import type { SourceFile } from '../storage/entities.js';
import { DEFAULT_DOCKERFILE_CONTENT, DEFAULT_DOCKERFILE_NAME } from './default-dockerfile.js';

const ACTOR_DIR = '.actor';
const ACTOR_JSON_NAME = `${ACTOR_DIR}/actor.json`;

/** Why Dockerfile resolution failed. */
export type DockerfileResolutionFailureReason =
	'escapes-actor-root' | 'invalid-dockerfile-field' | 'unparseable-actor-json';

/** `resolveDockerfileLocation`'s outcomes: `resolved` (a candidate matched), `default` (nothing matched
 * - `extraSourceFile` must be appended to this build's context only, never persisted), or `failure`. */
export type DockerfileResolution =
	| { outcome: 'resolved'; dockerfilePath: string; logLines: string[] }
	| { outcome: 'default'; dockerfilePath: string; logLines: string[]; extraSourceFile: SourceFile }
	| { outcome: 'failure'; reason: DockerfileResolutionFailureReason; message: string };

function sourceFileToText(file: SourceFile): string {
	return file.format === 'BASE64' ? Buffer.from(file.content, 'base64').toString('utf8') : file.content;
}

interface IndexedFile {
	normalizedName: string;
	lowerName: string;
}

function indexSourceFiles(sourceFiles: SourceFile[]): IndexedFile[] {
	return sourceFiles.map((file) => {
		const normalizedName = normalizeEntryName(file.name);
		return { normalizedName, lowerName: normalizedName.toLowerCase() };
	});
}

/** Exact-case match wins; otherwise the first match in `sourceFiles` order. */
function findCaseInsensitive(indexed: IndexedFile[], candidate: string): IndexedFile | undefined {
	const lowerCandidate = candidate.toLowerCase();
	let firstMatch: IndexedFile | undefined;
	for (const file of indexed) {
		if (file.lowerName !== lowerCandidate) continue;
		if (file.normalizedName === candidate) return file; // exact case always wins immediately
		firstMatch ??= file;
	}
	return firstMatch;
}

/** `.actor/actor.json`'s own path is not case-folded, unlike the Dockerfile candidates. */
function findExact(sourceFiles: SourceFile[], normalizedTarget: string): SourceFile | undefined {
	return sourceFiles.find((file) => normalizeEntryName(file.name) === normalizedTarget);
}

function escapesActorRootFailure(rawField: string): DockerfileResolution {
	return {
		outcome: 'failure',
		reason: 'escapes-actor-root',
		message: `Dockerfile path "${rawField}" in .actor/actor.json points outside the Actor root directory.`,
	};
}

export function resolveDockerfileLocation(sourceFiles: SourceFile[]): DockerfileResolution {
	const indexed = indexSourceFiles(sourceFiles);
	const logLines: string[] = [];

	const actorJsonFile = findExact(sourceFiles, ACTOR_JSON_NAME);
	let actorSpecification: unknown;
	if (actorJsonFile) {
		try {
			actorSpecification = JSON5.parse(sourceFileToText(actorJsonFile));
		} catch (error) {
			return {
				outcome: 'failure',
				reason: 'unparseable-actor-json',
				message: `Could not parse .actor/actor.json: ${(error as Error).message}`,
			};
		}
	}

	if (actorSpecification !== null && typeof actorSpecification === 'object' && 'dockerfile' in actorSpecification) {
		const field: unknown = actorSpecification.dockerfile;
		if (typeof field !== 'string') {
			return {
				outcome: 'failure',
				reason: 'invalid-dockerfile-field',
				message: '.actor/actor.json has invalid format: "dockerfile" must be a string.',
			};
		}

		if (field === '') {
			logLines.push(
				'Warning: "" (from the "dockerfile" field in .actor/actor.json) is not in the pushed source; falling back to the default locations.\n',
			);
		} else if (field.startsWith('/')) {
			return escapesActorRootFailure(field);
		} else {
			const joined = normalizeEntryName(path.posix.join(ACTOR_DIR, field));
			if (joined === '..' || joined.startsWith('../')) {
				return escapesActorRootFailure(field);
			}

			const match = findCaseInsensitive(indexed, joined);
			if (match) {
				return {
					outcome: 'resolved',
					dockerfilePath: match.normalizedName,
					logLines: [
						...logLines,
						`Using Dockerfile "${match.normalizedName}" (from the "dockerfile" field in .actor/actor.json).\n`,
					],
				};
			}

			logLines.push(
				`Warning: "${joined}" (from the "dockerfile" field in .actor/actor.json) is not in the pushed source; falling back to the default locations.\n`,
			);
		}
	}

	const actorDirCandidate = normalizeEntryName(`${ACTOR_DIR}/${DEFAULT_DOCKERFILE_NAME}`);
	const actorDirMatch = findCaseInsensitive(indexed, actorDirCandidate);
	if (actorDirMatch) {
		return {
			outcome: 'resolved',
			dockerfilePath: actorDirMatch.normalizedName,
			logLines: [
				...logLines,
				`Using Dockerfile "${actorDirMatch.normalizedName}" (found at .actor/Dockerfile).\n`,
			],
		};
	}

	const rootCandidate = normalizeEntryName(DEFAULT_DOCKERFILE_NAME);
	const rootMatch = findCaseInsensitive(indexed, rootCandidate);
	if (rootMatch) {
		return {
			outcome: 'resolved',
			dockerfilePath: rootMatch.normalizedName,
			logLines: [...logLines, `Using Dockerfile "${rootMatch.normalizedName}" (found at the Actor root).\n`],
		};
	}

	logLines.push(`${DEFAULT_DOCKERFILE_NAME} not found, using the default one.\n`);
	return {
		outcome: 'default',
		dockerfilePath: DEFAULT_DOCKERFILE_NAME,
		logLines,
		extraSourceFile: { name: DEFAULT_DOCKERFILE_NAME, format: 'TEXT', content: DEFAULT_DOCKERFILE_CONTENT },
	};
}

/**
 * Resolves which Dockerfile a build should use, from the version's flat, in-memory `SourceFile[]` -
 * mirroring apify-worker's own `ensureDockerfileExists` (`act2_build_job.ts`) so that "builds locally"
 * keeps predicting "builds on the platform" (`2-design.md`). Pure: no filesystem, no Docker. "Does this
 * file exist" is a lookup in a normalized-name index built over `sourceFiles`; "does it escape the
 * root" is POSIX path arithmetic on strings.
 *
 * Candidate order, stopping at the first hit:
 *   1. the `dockerfile` field of `.actor/actor.json`, resolved relative to the `.actor` directory
 *   2. `.actor/Dockerfile`
 *   3. `Dockerfile` at the Actor root
 *   4. (nothing resolved) the bundled default Dockerfile (`default-dockerfile.ts`), platform-parity
 *      with apify-worker rather than failing the build.
 *
 * Matching against `sourceFiles` names is case-insensitive (candidates 1-3), but the path handed back
 * is always the matched source file's OWN name (post-normalization) - never the candidate's canonical
 * casing - because Docker's lookup inside the tar is case-sensitive. When both a case-exact and a
 * case-differing match exist, the case-exact one wins; otherwise the first match in `sourceFiles` order.
 */
import * as path from 'node:path';
import JSON5 from 'json5';

import type { SourceFile } from '../storage/entities.js';
import { DEFAULT_DOCKERFILE_CONTENT, DEFAULT_DOCKERFILE_NAME } from './default-dockerfile.js';

const ACTOR_DIR = '.actor';
const ACTOR_JSON_NAME = `${ACTOR_DIR}/actor.json`;
const DOCKERFILE_BASENAME = 'Dockerfile';

/**
 * Why resolution failed - each has its own message, computed once at the failure site (see
 * `resolveDockerfileLocation`'s call sites below) and carried through verbatim rather than
 * reconstructed by the caller. `services/builds.ts` only needs `message` to fail the build; `reason`
 * exists so tests can assert *which* failure fired without string-matching the message.
 */
export type DockerfileResolutionFailureReason =
	'escapes-actor-root' | 'invalid-dockerfile-field' | 'unparseable-actor-json';

/**
 * The three outcomes `resolveDockerfileLocation` can return - see this module's doc comment for the
 * candidate order each represents.
 *
 * - `resolved`: a candidate (1, 2, or 3) matched an existing source file. `dockerfilePath` is that
 *   file's own (normalized) name - exactly the string `docker-driver.ts` must hand dockerode as its
 *   `dockerfile` build option, and exactly the tar entry name `buildTarball` will produce for it (both
 *   go through the same normalizer, see `normalizeEntryName` below).
 * - `default`: nothing resolved. `dockerfilePath` is always `'Dockerfile'` (free by construction - see
 *   this module's doc comment), and `extraSourceFile` is the one extra `SourceFile` the caller must
 *   append to `BuildContext.sourceFiles` for this one build only - never written back to the version's
 *   persisted `sourceFiles`.
 * - `failure`: a typed, build-ending problem found before any Docker/daemon call - an escaping
 *   `dockerfile` field path, a non-string `dockerfile` field, or an unparseable `.actor/actor.json`.
 *
 * Every outcome (including `failure`) carries its own diagnostic text in `logLines`/`message` - the
 * choice is never made silently (`3-success-criteria.md` #14).
 */
export type DockerfileResolution =
	| { outcome: 'resolved'; dockerfilePath: string; logLines: string[] }
	| { outcome: 'default'; dockerfilePath: string; logLines: string[]; extraSourceFile: SourceFile }
	| { outcome: 'failure'; reason: DockerfileResolutionFailureReason; message: string };

/**
 * The one name-normalizer shared by this resolver's index and `docker-driver.ts`'s `buildTarball` -
 * the string handed to the daemon as the `dockerfile` option is only ever correct if it is exactly the
 * tar entry name Docker will look for, so both sides must agree on what a `SourceFile.name` (or a
 * candidate path built from `.actor/actor.json`) canonicalizes to. Three steps, in order: backslashes
 * become POSIX separators (a Windows-authored tree's `sourceFiles` names might carry them), a leading
 * `./` is stripped, and the result is run through `path.posix.normalize` (collapses `a/./b` and
 * `a/b/../c`, but deliberately leaves a leading `../` alone - that is exactly what the escape check
 * below looks for).
 */
export function normalizeEntryName(name: string): string {
	const posixName = name.replace(/\\/g, '/');
	const withoutLeadingDotSlash = posixName.replace(/^(?:\.\/)+/, '');
	return path.posix.normalize(withoutLeadingDotSlash);
}

/** Decodes a `SourceFile`'s content to text, the same `BASE64`/`TEXT` split `docker-driver.ts`'s
 * `sourceFileToBuffer` uses for the tar - duplicated here (rather than imported) because this module is
 * deliberately Docker-free; the two are one line each and drifting apart would be immediately obvious
 * from `dockerfile-location.test.ts`. */
function sourceFileToText(file: SourceFile): string {
	return file.format === 'BASE64' ? Buffer.from(file.content, 'base64').toString('utf8') : file.content;
}

/** One `SourceFile`, indexed by its normalized name (for the exact `.actor/actor.json` lookup) and by
 * that name's lowercase (for the case-insensitive Dockerfile candidate lookups) - built once per
 * resolution, in `sourceFiles` order, which is exactly the tie-break order `findCaseInsensitive` below
 * relies on. */
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

/** Case-insensitive lookup for a Dockerfile candidate: among every indexed file whose normalized name
 * matches `candidate` case-insensitively, an exact-case match wins; otherwise the first match in
 * `sourceFiles` order (`indexed` is already in that order, so "first" here just means "first found"). */
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

/** Exact (case-sensitive) lookup, used only for `.actor/actor.json` itself - unlike the Dockerfile
 * candidates, the platform does not case-fold the spec file's own path. */
function findExact(
	sourceFiles: SourceFile[],
	indexed: IndexedFile[],
	normalizedTarget: string,
): SourceFile | undefined {
	const position = indexed.findIndex((file) => file.normalizedName === normalizedTarget);
	return position === -1 ? undefined : sourceFiles[position];
}

/** Builds the `escapes-actor-root` failure for a `dockerfile` field value, matching apify-worker's own
 * `UserError` for the same condition - always keyed off the raw field value the developer actually
 * wrote, never the joined/normalized path, so the message names exactly what they typed. */
function escapesActorRootFailure(rawField: string): DockerfileResolution {
	return {
		outcome: 'failure',
		reason: 'escapes-actor-root',
		message: `Dockerfile path "${rawField}" in .actor/actor.json points outside the Actor root directory.`,
	};
}

/**
 * Resolves the Dockerfile for a build from its version's `sourceFiles`. See this module's doc comment
 * for the candidate order and outcome shapes.
 */
export function resolveDockerfileLocation(sourceFiles: SourceFile[]): DockerfileResolution {
	const indexed = indexSourceFiles(sourceFiles);
	const logLines: string[] = [];

	// `.actor/actor.json` is optional - a missing file is not an error, it just means candidate 1 never
	// applies (mirrors apify-worker's `readActorSpecificationFile`, which swallows ENOENT).
	const actorJsonFile = findExact(sourceFiles, indexed, ACTOR_JSON_NAME);
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

	// Candidate 1: the "dockerfile" field, only when actor.json parsed to an object that actually has
	// one (a missing field is not an error - it just means this candidate is skipped, same as apify-
	// worker's `actorSpecification?.dockerfile` optional chain).
	if (actorSpecification !== null && typeof actorSpecification === 'object' && 'dockerfile' in actorSpecification) {
		const field = (actorSpecification as { dockerfile?: unknown }).dockerfile;
		if (typeof field !== 'string') {
			return {
				outcome: 'failure',
				reason: 'invalid-dockerfile-field',
				message: '.actor/actor.json has invalid format: "dockerfile" must be a string.',
			};
		}

		if (field === '') {
			// An empty string is a valid string that simply names no file - indistinguishable from a typo
			// (candidate C below), never the invalid-format failure above (2-design.md, Example G).
			logLines.push(
				'Warning: "" (from the "dockerfile" field in .actor/actor.json) is not in the pushed source; falling back to the default locations.\n',
			);
		} else if (field.startsWith('/')) {
			// An absolute path can never be "relative to .actor" - checked before joining, exactly like
			// apify-worker's `ensureActorDirFileInActorSourceRoot` (path.join would otherwise silently fold
			// a leading "/" into a same-directory join instead of rejecting it).
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

			// Names nothing in the pushed source - warn and fall through to candidate 2, never fail the
			// build on this account (2-design.md, Example C; apify-worker's own would-be-breaking `throw`
			// stays commented out).
			logLines.push(
				`Warning: "${joined}" (from the "dockerfile" field in .actor/actor.json) is not in the pushed source; falling back to the default locations.\n`,
			);
		}
	}

	// Candidate 2: .actor/Dockerfile
	const actorDirCandidate = normalizeEntryName(`${ACTOR_DIR}/${DOCKERFILE_BASENAME}`);
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

	// Candidate 3: Dockerfile at the Actor root
	const rootCandidate = normalizeEntryName(DOCKERFILE_BASENAME);
	const rootMatch = findCaseInsensitive(indexed, rootCandidate);
	if (rootMatch) {
		return {
			outcome: 'resolved',
			dockerfilePath: rootMatch.normalizedName,
			logLines: [...logLines, `Using Dockerfile "${rootMatch.normalizedName}" (found at the Actor root).\n`],
		};
	}

	// Nothing resolved: inject the bundled default (2-design.md, Example F; Decisions #1). Plain
	// "Dockerfile" at the tar root is free by construction here - reaching this branch already required
	// that no case-insensitive Dockerfile matched at candidate 2 or 3.
	logLines.push(`${DOCKERFILE_BASENAME} not found, using the default one.\n`);
	return {
		outcome: 'default',
		dockerfilePath: DEFAULT_DOCKERFILE_NAME,
		logLines,
		extraSourceFile: { name: DEFAULT_DOCKERFILE_NAME, format: 'TEXT', content: DEFAULT_DOCKERFILE_CONTENT },
	};
}

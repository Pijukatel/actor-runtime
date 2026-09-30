/**
 * Resolves which Dockerfile a build should use from the version's `sourceFiles`. Candidate order,
 * stopping at the first hit: 1) the `dockerfile` field of `.actor/actor.json`, relative to `.actor` 2)
 * `.actor/Dockerfile` 3) `Dockerfile` at the Actor root 4) the bundled default. Matching is
 * case-insensitive; the returned path is always the matched file's own name, never the candidate's
 * casing - Docker's tar lookup is case-sensitive. An exact-case match wins over a case-differing one.
 */
import type { SourceFile } from '../storage/entities.js';
import {
	ACTOR_DIR,
	actorFilePath,
	escapesActorRootMessage,
	fallbackWarningLine,
	findCaseInsensitive,
	indexSourceFiles,
	parseActorJson,
	resolveActorJsonPathField,
} from './actor-source-files.js';
import { DEFAULT_DOCKERFILE_CONTENT, DEFAULT_DOCKERFILE_NAME } from './default-dockerfile.js';

/** Why Dockerfile resolution failed. */
export type DockerfileResolutionFailureReason =
	'escapes-actor-root' | 'invalid-dockerfile-field' | 'unparseable-actor-json';

/** `resolveDockerfileLocation`'s outcomes: `resolved` (a candidate matched), `default` (nothing matched
 * - `extraSourceFile` goes to this build's Docker context only, never persisted), or `failure`. */
export type DockerfileResolution =
	| { outcome: 'resolved'; dockerfilePath: string; logLines: string[] }
	| { outcome: 'default'; dockerfilePath: string; logLines: string[]; extraSourceFile: SourceFile }
	| { outcome: 'failure'; reason: DockerfileResolutionFailureReason; message: string };

function escapesActorRootFailure(rawField: string): DockerfileResolution {
	return {
		outcome: 'failure',
		reason: 'escapes-actor-root',
		message: escapesActorRootMessage(rawField, 'Dockerfile'),
	};
}

export function resolveDockerfileLocation(sourceFiles: SourceFile[], actorPath = ''): DockerfileResolution {
	const indexed = indexSourceFiles(sourceFiles);
	const logLines: string[] = [];

	const actorJson = parseActorJson(sourceFiles, actorPath);
	if (actorJson.outcome === 'unparseable') {
		return { outcome: 'failure', reason: 'unparseable-actor-json', message: actorJson.message };
	}
	const specification = actorJson.outcome === 'parsed' ? actorJson.specification : undefined;

	if (specification !== null && typeof specification === 'object' && 'dockerfile' in specification) {
		const field: unknown = specification.dockerfile;
		if (typeof field !== 'string') {
			return {
				outcome: 'failure',
				reason: 'invalid-dockerfile-field',
				message: '.actor/actor.json has invalid format: "dockerfile" must be a string.',
			};
		}

		const resolved = resolveActorJsonPathField(indexed, field, actorPath);
		if (resolved.outcome === 'escapes-actor-root') return escapesActorRootFailure(field);
		if (resolved.outcome === 'match') {
			return {
				outcome: 'resolved',
				dockerfilePath: resolved.file.normalizedName,
				logLines: [
					...logLines,
					`Using Dockerfile "${resolved.file.normalizedName}" (from the "dockerfile" field in .actor/actor.json).\n`,
				],
			};
		}
		logLines.push(fallbackWarningLine(resolved.shownPath, 'dockerfile'));
	}

	const actorDirCandidate = actorFilePath(actorPath, `${ACTOR_DIR}/${DEFAULT_DOCKERFILE_NAME}`);
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

	const rootCandidate = actorFilePath(actorPath, DEFAULT_DOCKERFILE_NAME);
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

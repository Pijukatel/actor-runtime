/**
 * Which pushed files form the Docker context, as the platform's builder decides it for every source type:
 * the Actor's folder, unless `.actor/actor.json` sets `dockerContextDir` - a folder relative to `.actor/`,
 * which may leave the Actor's folder but not the pushed source root (for a Git source, the whole clone).
 */
import * as path from 'node:path';

import { normalizeEntryName } from '../driver/tar-entry-name.js';
import type { SourceFile } from '../storage/entities.js';
import { ACTOR_DIR, actorFilePath, parseActorJson } from './actor-source-files.js';

export type DockerContextResolution =
	| {
			outcome: 'resolved';
			/** The context's folder within the pushed files; `''` is their root. */
			contextPath: string;
			/** The Actor's folder relative to the context - the `ACTOR_PATH_IN_DOCKER_CONTEXT` build argument. */
			actorPathInContext: string;
	  }
	| { outcome: 'failure'; message: string };

function isUnder(name: string, folder: string): boolean {
	return folder === '' || name.startsWith(`${folder}/`);
}

export function resolveDockerContext(sourceFiles: SourceFile[], actorPath = ''): DockerContextResolution {
	const actorJson = parseActorJson(sourceFiles, actorPath);
	const specification = actorJson.outcome === 'parsed' ? actorJson.specification : undefined;
	const field =
		specification !== null && typeof specification === 'object' && 'dockerContextDir' in specification
			? specification.dockerContextDir
			: undefined;

	let contextPath = actorPath;
	if (field !== undefined && field !== null && field !== '') {
		if (typeof field !== 'string') {
			return {
				outcome: 'failure',
				message: '.actor/actor.json has invalid format: "dockerContextDir" must be a string.',
			};
		}
		const joined = normalizeEntryName(path.posix.join(actorFilePath(actorPath, ACTOR_DIR), field));
		if (field.startsWith('/') || joined === '..' || joined.startsWith('../')) {
			return { outcome: 'failure', message: `Actor context path "${field}" is outside of Actor root directory!` };
		}
		contextPath = joined === '.' ? '' : joined;
		if (!sourceFiles.some((file) => isUnder(normalizeEntryName(file.name), contextPath))) {
			return { outcome: 'failure', message: `Actor context path "${field}" does not exist!` };
		}
	}

	const actorPathInContext = path.posix.relative(contextPath || '.', actorPath || '.');
	return { outcome: 'resolved', contextPath, actorPathInContext };
}

/** `name`, a path within the pushed files, relative to the context; `undefined` when outside it. */
export function nameInDockerContext(name: string, contextPath: string): string | undefined {
	const normalized = normalizeEntryName(name);
	if (!isUnder(normalized, contextPath)) return undefined;
	return contextPath === '' ? normalized : normalized.slice(contextPath.length + 1);
}

/** The pushed files inside the context, named relative to it. */
export function dockerContextFiles(sourceFiles: SourceFile[], contextPath: string): SourceFile[] {
	return sourceFiles.flatMap((file) => {
		const name = nameInDockerContext(file.name, contextPath);
		return name === undefined ? [] : [{ ...file, name }];
	});
}

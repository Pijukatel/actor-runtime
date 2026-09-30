/** The Docker context, chosen as the platform's builder chooses it: the Actor's folder, or `dockerContextDir`. */
import * as path from 'node:path';

import { normalizeEntryName } from '../driver/tar-entry-name.js';
import type { SourceFile } from '../storage/entities.js';
import { ACTOR_DIR, actorFilePath, parseActorJson } from './actor-source-files.js';

export type DockerContextResolution =
	| {
			outcome: 'resolved';
			/** `''` is the root of the pushed files. */
			contextPath: string;
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

/** `undefined` when `name` is outside the context. */
export function nameInDockerContext(name: string, contextPath: string): string | undefined {
	const normalized = normalizeEntryName(name);
	if (!isUnder(normalized, contextPath)) return undefined;
	return contextPath === '' ? normalized : normalized.slice(contextPath.length + 1);
}

export function dockerContextFiles(sourceFiles: SourceFile[], contextPath: string): SourceFile[] {
	return sourceFiles.flatMap((file) => {
		const name = nameInDockerContext(file.name, contextPath);
		return name === undefined ? [] : [{ ...file, name }];
	});
}

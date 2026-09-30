/** The platform builder's own `.actor/actor.json` check. */
import { getActorSchemaValidator } from '@apify/json_schemas';

import type { SourceFile } from '../storage/entities.js';
import { parseActorJson } from './actor-source-files.js';

/** `null` when the file is valid or absent. */
export function describeActorJsonDefect(sourceFiles: SourceFile[], actorPath = ''): string | null {
	const actorJson = parseActorJson(sourceFiles, actorPath);
	if (actorJson.outcome === 'absent') return null;
	if (actorJson.outcome === 'unparseable') return actorJson.message;

	const validate = getActorSchemaValidator();
	if (validate(actorJson.specification)) return null;
	return `.actor/actor.json has invalid format ${JSON.stringify(validate.errors, null, 4)}`;
}

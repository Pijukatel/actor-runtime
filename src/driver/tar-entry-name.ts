import * as path from 'node:path';

/**
 * The one name-normalizer shared by the Dockerfile resolver's source-file index
 * (`services/dockerfile-location.ts`) and `docker-driver.ts`'s `buildTarball` - the string handed to
 * the daemon as the `dockerfile` option is only ever correct if it is exactly the tar entry name Docker
 * will look for, so both sides must agree on what a `SourceFile.name` (or a candidate path built from
 * `.actor/actor.json`) canonicalizes to. Three steps, in order: backslashes become POSIX separators (a
 * Windows-authored tree's `sourceFiles` names might carry them), a leading `./` is stripped, and the
 * result is run through `path.posix.normalize` (collapses `a/./b` and `a/b/../c`, but deliberately
 * leaves a leading `../` alone - that is exactly what the Dockerfile resolver's escape check looks for).
 *
 * Lives in the driver layer (not `services/`) since `docker-driver.ts`'s own tar-building is what this
 * normalizer must stay byte-for-byte consistent with; `services/dockerfile-location.ts` imports it from
 * here rather than the driver reaching up into `services/`.
 */
export function normalizeEntryName(name: string): string {
	const posixName = name.replace(/\\/g, '/');
	const withoutLeadingDotSlash = posixName.replace(/^(?:\.\/)+/, '');
	return path.posix.normalize(withoutLeadingDotSlash);
}

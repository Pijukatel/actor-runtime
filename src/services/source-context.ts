/**
 * Monorepo build contexts (`actor-driver.md`'s "Monorepo Actors"): `apify push` of an Actor whose
 * `.actor/actor.json` sets `dockerContextDir` uploads the whole context, and names the Actor's folder
 * inside it. The files go to `__FILES__`; the version only points at them.
 */
import { generateId } from '../storage/ids.js';
import type {
	ActorRecord,
	ActorVersionRecord,
	LocalSourceContext,
	LocalSourceContextGit,
	SourceFile,
} from '../storage/entities.js';
import { getRegistries } from '../storage/registries.js';
import { normalizeEntryName } from '../driver/tar-entry-name.js';
import { ACTOR_JSON_NAME, actorFilePath, findExact } from './actor-source-files.js';
import { addOrReplaceVersion, findVersion, updateActor } from './actors.js';

export interface SourceContextUpload {
	actorPath: string;
	sourceFiles: SourceFile[];
	git?: LocalSourceContextGit;
}

export type SourceContextUploadValidation =
	{ kind: 'ok'; upload: SourceContextUpload } | { kind: 'invalid'; message: string };

/** `null` for a relative path that stays inside the context, the rejection reason otherwise. */
function describeContextPathDefect(normalized: string): string | null {
	if (normalized.includes('\0')) return 'must not contain a NUL byte';
	if (normalized.startsWith('/')) return 'must be relative to the Docker context';
	if (normalized === '..' || normalized.startsWith('../')) return 'must not point outside the Docker context';
	return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateGit(raw: unknown): LocalSourceContextGit | string {
	if (!isRecord(raw)) return '"git" must be an object';
	const git: LocalSourceContextGit = {};
	for (const field of ['remoteUrl', 'branch', 'commit'] as const) {
		const value = raw[field];
		if (value === undefined) continue;
		if (typeof value !== 'string') return `"git.${field}" must be a string`;
		git[field] = value;
	}
	if (raw.dirty !== undefined) {
		if (typeof raw.dirty !== 'boolean') return '"git.dirty" must be a boolean';
		git.dirty = raw.dirty;
	}
	return git;
}

export function validateSourceContextUpload(body: unknown): SourceContextUploadValidation {
	const invalid = (message: string): SourceContextUploadValidation => ({ kind: 'invalid', message });
	if (!isRecord(body)) return invalid('Request body must be a JSON object');

	if (typeof body.actorPath !== 'string') return invalid('"actorPath" must be a string');
	const actorPath = normalizeEntryName(body.actorPath).replace(/\/+$/, '');
	if (actorPath === '.' || actorPath === '') {
		return invalid('"actorPath" must name the Actor\'s folder inside the Docker context, not the context itself');
	}
	const actorPathDefect = describeContextPathDefect(actorPath);
	if (actorPathDefect) return invalid(`"actorPath" ${actorPathDefect}`);

	if (!Array.isArray(body.sourceFiles)) return invalid('"sourceFiles" must be an array');
	const sourceFiles: SourceFile[] = [];
	for (const file of body.sourceFiles as unknown[]) {
		if (
			!isRecord(file) ||
			typeof file.name !== 'string' ||
			typeof file.content !== 'string' ||
			(file.format !== 'TEXT' && file.format !== 'BASE64')
		) {
			return invalid('Every item of "sourceFiles" must be { name, format: "TEXT" | "BASE64", content }');
		}
		const nameDefect = describeContextPathDefect(normalizeEntryName(file.name));
		if (nameDefect) return invalid(`Source file "${file.name}" ${nameDefect}`);
		sourceFiles.push({ name: file.name, format: file.format, content: file.content });
	}
	if (!findExact(sourceFiles, actorFilePath(actorPath, ACTOR_JSON_NAME))) {
		return invalid(`"sourceFiles" has no "${actorFilePath(actorPath, ACTOR_JSON_NAME)}"`);
	}

	let git: LocalSourceContextGit | undefined;
	if (body.git !== undefined && body.git !== null) {
		const result = validateGit(body.git);
		if (typeof result === 'string') return invalid(result);
		git = result;
	}

	return { kind: 'ok', upload: { actorPath, sourceFiles, ...(git ? { git } : {}) } };
}

function sourceFileSizeBytes(file: SourceFile): number {
	return file.format === 'BASE64' ? Buffer.from(file.content, 'base64').length : Buffer.byteLength(file.content);
}

/**
 * Replaces the version's source with `upload`. The version must exist already - `apify push` creates or
 * updates it first, with its build tag and environment variables, the same way as for any other push.
 * `null` when the version does not exist.
 */
export async function setSourceContext(
	actor: ActorRecord,
	versionNumber: string,
	upload: SourceContextUpload,
): Promise<ActorVersionRecord | null> {
	if (!findVersion(actor, versionNumber)) return null;

	const { files } = getRegistries();
	const localSourceContext: LocalSourceContext = {
		fileId: generateId(),
		actorPath: upload.actorPath,
		fileCount: upload.sourceFiles.length,
		sizeBytes: upload.sourceFiles.reduce((sum, file) => sum + sourceFileSizeBytes(file), 0),
		uploadedAt: new Date().toISOString(),
		...(upload.git ? { git: upload.git } : {}),
	};
	await files.setValue(localSourceContext.fileId, upload.sourceFiles);

	let replaced: LocalSourceContext | undefined;
	let written: ActorVersionRecord | undefined;
	await updateActor(actor.id, (current) => {
		const existing = findVersion(current, versionNumber);
		// Deleted between the check above and here: nothing to attach the files to.
		if (!existing) return current;
		replaced = existing.localSourceContext;
		written = { ...existing, sourceFiles: [], localSourceContext };
		return addOrReplaceVersion(current, written);
	});

	if (!written) {
		await deleteSourceContextFiles(localSourceContext);
		return null;
	}
	await deleteSourceContextFiles(replaced);
	return written;
}

export async function loadSourceContextFiles(context: LocalSourceContext): Promise<SourceFile[] | null> {
	return getRegistries().files.getValue<SourceFile[]>(context.fileId);
}

/** Drops the stored files of a context no version points at any more. */
export async function deleteSourceContextFiles(context: LocalSourceContext | undefined): Promise<void> {
	if (!context) return;
	await getRegistries().files.setValue(context.fileId, null);
}

/** What the API and console report about a context - everything except where its files are stored. */
export function sourceContextSummary(context: LocalSourceContext): Omit<LocalSourceContext, 'fileId'> {
	const { actorPath, fileCount, sizeBytes, uploadedAt, git } = context;
	return { actorPath, fileCount, sizeBytes, uploadedAt, ...(git ? { git } : {}) };
}

/** `", from <remote>, branch <branch>, commit <commit>"` (plus a note on uncommitted changes), or `""` when
 * nothing is known - appended to a sentence about the context. */
export function describeSourceContextOrigin(git: LocalSourceContextGit | undefined): string {
	if (!git) return '';
	const parts = [
		git.remoteUrl,
		git.branch ? `branch ${git.branch}` : undefined,
		git.commit ? `commit ${git.commit.slice(0, 12)}` : undefined,
	].filter(Boolean);
	if (parts.length === 0) return '';
	return `, from ${parts.join(', ')}${git.dirty ? ' with uncommitted changes' : ''}`;
}

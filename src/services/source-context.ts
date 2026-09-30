/** A monorepo Actor's pushed repository (`actor-driver.md`'s "Monorepo Actors"), stored in `__FILES__`. */
import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';

import * as tar from 'tar-stream';

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
import { standbyEnabledBy } from './standby-config.js';

const TARBALL_CONTENT_TYPE = 'application/gzip';

export interface SourceContextUpload {
	actorPath: string;
	tarball: Buffer;
	files: SourceFile[];
	sizeBytes: number;
	git?: LocalSourceContextGit;
}

export interface SourceContextUploadParams {
	actorPath?: string;
	gitRemoteUrl?: string;
	gitBranch?: string;
	gitCommit?: string;
	gitDirty?: string;
}

export type SourceContextUploadValidation =
	{ kind: 'ok'; upload: SourceContextUpload } | { kind: 'invalid'; message: string };

function describeContextPathDefect(normalized: string): string | null {
	if (normalized.includes('\0')) return 'must not contain a NUL byte';
	if (normalized.startsWith('/')) return 'must be relative to the Docker context';
	if (normalized === '..' || normalized.startsWith('../')) return 'must not point outside the Docker context';
	return null;
}

function isGzip(buffer: Buffer): boolean {
	return buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
}

/** Regular files and symlinks only; a symlink stays a link, as in a Git clone. */
export async function readTarballFiles(tarball: Buffer): Promise<SourceFile[]> {
	const archive = isGzip(tarball) ? await promisify(gunzip)(tarball) : tarball;
	const files: SourceFile[] = [];
	const extract = tar.extract();
	await new Promise<void>((resolve, reject) => {
		extract.on('entry', (header, content, next) => {
			const chunks: Buffer[] = [];
			content.on('data', (chunk: Buffer) => chunks.push(chunk));
			content.once('error', reject);
			content.once('end', () => {
				if (header.type === 'file') {
					files.push({
						name: header.name,
						format: 'BASE64',
						content: Buffer.concat(chunks).toString('base64'),
					});
				} else if (header.type === 'symlink' && header.linkname) {
					files.push({ name: header.name, format: 'TEXT', content: '', linkTarget: header.linkname });
				}
				next();
			});
		});
		extract.once('error', reject);
		extract.once('finish', resolve);
		extract.end(archive);
	});
	return files;
}

function gitFromParams(params: SourceContextUploadParams): LocalSourceContextGit | string | undefined {
	const git: LocalSourceContextGit = {};
	if (params.gitRemoteUrl) git.remoteUrl = params.gitRemoteUrl;
	if (params.gitBranch) git.branch = params.gitBranch;
	if (params.gitCommit) git.commit = params.gitCommit;
	if (params.gitDirty !== undefined) {
		if (params.gitDirty !== 'true' && params.gitDirty !== 'false') return '"gitDirty" must be "true" or "false"';
		git.dirty = params.gitDirty === 'true';
	}
	return Object.keys(git).length > 0 ? git : undefined;
}

export async function validateSourceContextUpload(
	params: SourceContextUploadParams,
	tarball: Buffer,
): Promise<SourceContextUploadValidation> {
	const invalid = (message: string): SourceContextUploadValidation => ({ kind: 'invalid', message });

	if (typeof params.actorPath !== 'string') return invalid('"actorPath" query parameter is required');
	const normalizedActorPath = normalizeEntryName(params.actorPath);
	const actorPathDefect = describeContextPathDefect(normalizedActorPath);
	if (actorPathDefect) return invalid(`"actorPath" ${actorPathDefect}`);
	const actorPath = normalizedActorPath.replace(/\/+$/, '');
	if (actorPath === '.' || actorPath === '') {
		return invalid('"actorPath" must name the Actor\'s folder inside the Docker context, not the context itself');
	}

	const git = gitFromParams(params);
	if (typeof git === 'string') return invalid(git);

	if (tarball.length === 0) return invalid('Request body must be the Docker context as a .tar.gz archive');
	let files: SourceFile[];
	try {
		files = await readTarballFiles(tarball);
	} catch (error) {
		return invalid(`Request body is not a readable .tar.gz archive: ${(error as Error).message}`);
	}
	for (const file of files) {
		const nameDefect = describeContextPathDefect(normalizeEntryName(file.name));
		if (nameDefect) return invalid(`Archive entry "${file.name}" ${nameDefect}`);
	}
	if (!findExact(files, actorFilePath(actorPath, ACTOR_JSON_NAME))) {
		return invalid(`The archive has no "${actorFilePath(actorPath, ACTOR_JSON_NAME)}"`);
	}

	return {
		kind: 'ok',
		upload: {
			actorPath,
			tarball,
			files,
			sizeBytes: files.reduce((sum, file) => sum + Buffer.from(file.content, 'base64').length, 0),
			...(git ? { git } : {}),
		},
	};
}

/** `null` when the version does not exist: `apify push` creates it first, as for any push. */
export async function setSourceContext(
	actor: ActorRecord,
	versionNumber: string,
	upload: SourceContextUpload,
): Promise<(ActorVersionRecord & { localSourceContext: LocalSourceContext }) | null> {
	if (!findVersion(actor, versionNumber)) return null;

	const { files } = getRegistries();
	const localSourceContext: LocalSourceContext = {
		fileId: generateId(),
		actorPath: upload.actorPath,
		fileCount: upload.files.length,
		sizeBytes: upload.sizeBytes,
		uploadedAt: new Date().toISOString(),
		...(upload.git ? { git: upload.git } : {}),
	};
	await files.setValue(localSourceContext.fileId, upload.tarball, { contentType: TARBALL_CONTENT_TYPE });

	let replaced: LocalSourceContext | undefined;
	let written: (ActorVersionRecord & { localSourceContext: LocalSourceContext }) | undefined;
	await updateActor(actor.id, (current) => {
		const existing = findVersion(current, versionNumber);
		if (!existing) return current;
		replaced = existing.localSourceContext;
		written = { ...existing, sourceFiles: [], localSourceContext };
		const actorStandby = standbyEnabledBy(current.actorStandby, upload.files, upload.actorPath);
		return { ...addOrReplaceVersion(current, written), ...(actorStandby ? { actorStandby } : {}) };
	});

	if (!written) {
		await deleteSourceContextFiles(localSourceContext);
		return null;
	}
	await deleteSourceContextFiles(replaced);
	return written;
}

export async function loadSourceContextFiles(context: LocalSourceContext): Promise<SourceFile[] | null> {
	const tarball = await getRegistries().files.getValue<Buffer>(context.fileId);
	return tarball ? readTarballFiles(Buffer.from(tarball)) : null;
}

export async function deleteSourceContextFiles(context: LocalSourceContext | undefined): Promise<void> {
	if (!context) return;
	await getRegistries().files.setValue(context.fileId, null);
}

export function sourceContextSummary(context: LocalSourceContext): Omit<LocalSourceContext, 'fileId'> {
	const { actorPath, fileCount, sizeBytes, uploadedAt, git } = context;
	return { actorPath, fileCount, sizeBytes, uploadedAt, ...(git ? { git } : {}) };
}

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

import { generateId } from '../storage/ids.js';
import type { BuildRecord, JobStatus, SourceFile } from '../storage/entities.js';
import { getRegistries } from '../storage/registries.js';
import type { ActorRecord, ActorVersionRecord } from '../storage/entities.js';
import { recordTaggedBuild, updateActor } from './actors.js';
import type { Driver } from '../driver/types.js';
import { DriverTimedOutError } from '../driver/types.js';
import { normalizeEntryName } from '../driver/tar-entry-name.js';
import { sourceFileToText } from './actor-source-files.js';
import { qualifyDockerfileImageReferences } from './dockerfile-image-refs.js';
import { resolveDockerfileLocation } from './dockerfile-location.js';
import { resolveInputSchemaLocation } from './input-schema-location.js';
import { resolveActorMemorySettings } from './actor-memory.js';
import { appendLog, appendRuntimeLog, flushLog, markLogTerminal } from './logs.js';
import { registeredDevFolderBuildLine } from './dev-folder.js';
import { isTerminalJobStatus, transitionJobStatus } from './job-status.js';

/**
 * The runtime does not expose a per-build `timeoutSecs` option (there is no `POST .../builds` query
 * param for it, matching the public API: builds time out against a fixed platform-wide limit, not a
 * per-build one). This mirrors that: one fixed internal default, not user-configurable. The value is a
 * reasonable placeholder for this runtime, not a matched platform constant.
 */
const DEFAULT_BUILD_TIMEOUT_SECS = 1800;

export async function listOwnedBuilds(userId: string, actorId?: string): Promise<BuildRecord[]> {
	const all = await getRegistries().builds.list();
	return all.filter((build) => build.userId === userId && (!actorId || build.actorId === actorId));
}

export async function getOwnedBuild(userId: string, id: string): Promise<BuildRecord | null> {
	const record = await getRegistries().builds.get(id);
	if (!record || record.userId !== userId) return null;
	return record;
}

/** Cross-user listing, for the console only (see `services/actors.ts: listAllActors`'s doc comment). */
export async function listAllBuilds(actorId?: string): Promise<BuildRecord[]> {
	const all = await getRegistries().builds.list();
	return actorId ? all.filter((build) => build.actorId === actorId) : all;
}

/** Cross-user lookup by id, for the console only (see `listAllBuilds`). */
export async function getBuildById(id: string): Promise<BuildRecord | null> {
	return getRegistries().builds.get(id);
}

/** The two ways `tag` can fail to resolve on an Actor, kept distinguishable rather than collapsed to one
 * generic "not found": `no-such-tag` when `tag` was never recorded at all, `build-deleted` when the tag
 * *is* recorded but its `BuildRecord` is gone (`deleteBuild` below removes the record without clearing
 * any tag that pointed at it). */
export type TaggedBuildLookup =
	{ found: false; reason: 'no-such-tag' | 'build-deleted' } | { found: true; build: BuildRecord };

/** Resolves `tag` on `actor` to its `BuildRecord` - the exact lookup `POST /actors/:actorId/runs`
 * performs, and the one `services/dev-folder.ts`'s registration probe reuses to find an image to check
 * against. No fallback to any other tag. */
export async function resolveTaggedBuild(actor: ActorRecord, tag: string): Promise<TaggedBuildLookup> {
	const tagged = actor.taggedBuilds[tag];
	if (!tagged) return { found: false, reason: 'no-such-tag' };
	const build = await getBuildById(tagged.buildId);
	if (!build) return { found: false, reason: 'build-deleted' };
	return { found: true, build };
}

/** Mirrors `deleteActor` (`services/actors.ts`) - the route layer resolves+authorizes the record (via
 * `getOwnedBuild`) and passes only its id down, same split as every other service-layer mutation. */
export async function deleteBuild(id: string): Promise<void> {
	await getRegistries().builds.delete(id);
}

/** Build numbers count from 1, never 0: the real platform's build-number pattern
 * (`^([0-9]|[1-9][0-9])\.([0-9]|[1-9][0-9])(\.[1-9][0-9]{0,4})$`, matched exactly by `apify-client`'s
 * `Build`/`Run` pydantic models) requires the third component to be 1-99999 with no leading zero - a
 * `.0` build number is not just unconventional, it fails validation for any client that enforces this
 * pattern (confirmed against the real `apify-client` Python package: `RunResponse.model_validate` rejects
 * `buildNumber: '0.0.0'`). */
async function nextBuildNumber(actorId: string, versionNumber: string): Promise<string> {
	const existing = await getRegistries().builds.list();
	const count = existing.filter((b) => b.actorId === actorId && b.versionNumber === versionNumber).length;
	return `${versionNumber}.${count + 1}`;
}

/**
 * The build's Dockerfile with every short `FROM` image name qualified to Docker Hub
 * (`services/dockerfile-image-refs.ts`), each rewrite stated in the build log. Only this build's copy
 * of the file changes - the pushed source is never modified. The other files pass through untouched.
 */
function qualifyDockerfileImages(
	sourceFiles: SourceFile[],
	dockerfilePath: string,
	log: (line: string) => void,
): SourceFile[] {
	return sourceFiles.map((file) => {
		if (normalizeEntryName(file.name) !== dockerfilePath) return file;
		const { dockerfile, qualified } = qualifyDockerfileImageReferences(sourceFileToText(file));
		if (qualified.length === 0) return file;
		for (const { from, to } of qualified) {
			log(`Using "${to}" for FROM "${from}" - a short image name means Docker Hub, as on the platform.\n`);
		}
		return { ...file, format: 'TEXT', content: dockerfile };
	});
}

export interface StartBuildOptions {
	tag: string;
	useCache: boolean;
}

/** Creates the build record and kicks off the driver build in the background; returns immediately. */
export async function startBuild(
	driver: Driver,
	actor: ActorRecord,
	version: ActorVersionRecord,
	options: StartBuildOptions,
): Promise<BuildRecord> {
	const { builds } = getRegistries();
	const buildNumber = await nextBuildNumber(actor.id, version.versionNumber);
	const record: BuildRecord = {
		id: generateId(),
		userId: actor.userId,
		actorId: actor.id,
		versionNumber: version.versionNumber,
		buildNumber,
		tag: options.tag,
		status: 'READY',
		startedAt: new Date().toISOString(),
	};
	await builds.set(record.id, record);

	void runBuildInBackground(driver, actor, version, record, options).catch(async (error: unknown) => {
		// Every *expected* failure mode inside `runBuildInBackground` is already caught internally and
		// mapped to a terminal status - this is only reached by a genuinely unexpected exception (e.g. a
		// registry/storage failure from the pre-start re-check or `updateActor`). Without a best-effort
		// terminal write here the record would stay stuck non-terminal forever - `waitForBuildFinish`
		// would block until its timeout and every future abort/status check would just see a permanently
		// "running" build.
		console.error(`build ${record.id}: unexpected error escaped runBuildInBackground`, error);
		try {
			await transitionJobStatus(builds, record.id, 'FAILED', {
				finishedAt: new Date().toISOString(),
				statusMessage: `Unexpected internal error: ${error instanceof Error ? error.message : String(error)}`,
			});
		} catch (innerError) {
			console.error(`build ${record.id}: failed to mark FAILED after unexpected error`, innerError);
		}
	});

	return record;
}

/** Fails a build before any image exists, mirroring `services/runs.ts`'s `failBeforeContainer`: the
 * reason reaches both the build log and the status message, which default to the same text. */
async function failBuild(buildId: string, logMessage: string, statusMessage = logMessage): Promise<void> {
	const { builds } = getRegistries();
	appendRuntimeLog(buildId, logMessage);
	await flushLog(buildId);
	markLogTerminal(buildId);
	await transitionJobStatus(builds, buildId, 'FAILED', {
		finishedAt: new Date().toISOString(),
		statusMessage,
	});
}

/**
 * Exported only for direct testing of the guarded transitions/pre-start abort window (see
 * `test/integration/job-lifecycle.test.ts`) - not part of the service's public surface for callers
 * outside this module, which should only ever go through `startBuild`.
 */
export async function runBuildInBackground(
	driver: Driver,
	actor: ActorRecord,
	version: ActorVersionRecord,
	record: BuildRecord,
	options: StartBuildOptions,
): Promise<void> {
	const { builds } = getRegistries();

	const afterStart = await transitionJobStatus(builds, record.id, 'RUNNING');
	if (!afterStart || afterStart.status !== 'RUNNING') {
		// An abort issued during the READY window already moved (or is moving) the record past RUNNING -
		// finalise it as ABORTED without ever starting the build. `driver.abortBuild` is called
		// defensively even though no build can be in flight yet on this path (harmless no-op if so; a
		// real cancellation if some future change ever lets a build start before this check runs).
		// `afterStart.status` can legitimately be `ABORTED` here too, not just `ABORTING`: `job-status.ts`
		// allows `READY -> ABORTED` directly (used by `reconcileOrphanedJobs`), and `abortBuild` can also
		// complete its whole `ABORTING -> ABORTED` two-write sequence before this function's own `RUNNING`
		// transition attempt above ever runs - there is no ordering guarantee between the two. In that
		// case the record is already terminal and there is genuinely nothing left to finalise, so the bare
		// `return` below is correct. If the record simply vanished, same thing.
		if (afterStart?.status === 'ABORTING') {
			await driver.abortBuild(record.id).catch(() => undefined);
			await transitionJobStatus(builds, record.id, 'ABORTED', { finishedAt: new Date().toISOString() });
		}
		return;
	}

	if (!driver.available) {
		await failBuild(record.id, `Docker is not available: ${driver.unavailableReason}`, driver.unavailableReason);
		return;
	}

	// Re-check right before kicking off the actual `docker build`: an abort issued while the two awaits
	// above (log flush aside, the driver-availability check itself is synchronous, but this still closes
	// the window against an abort landing between the RUNNING transition above and this line).
	const preStart = await builds.get(record.id);
	if (!preStart || preStart.status !== 'RUNNING') {
		if (preStart?.status === 'ABORTING') {
			await driver.abortBuild(record.id).catch(() => undefined);
			await transitionJobStatus(builds, record.id, 'ABORTED', { finishedAt: new Date().toISOString() });
		}
		return;
	}

	const dockerfileResolution = resolveDockerfileLocation(version.sourceFiles);
	if (dockerfileResolution.outcome === 'failure') {
		await failBuild(record.id, dockerfileResolution.message);
		return;
	}
	for (const line of dockerfileResolution.logLines) appendRuntimeLog(record.id, line);

	// Before the image is built, not after: an Actor whose declared input contract cannot be read fails
	// the build, rather than producing an image whose every run would skip validation.
	const inputSchemaResolution = resolveInputSchemaLocation(version.sourceFiles);
	if (inputSchemaResolution.outcome === 'failure') {
		await failBuild(record.id, inputSchemaResolution.message);
		return;
	}
	for (const line of inputSchemaResolution.logLines) appendRuntimeLog(record.id, line);
	const inputSchema = inputSchemaResolution.outcome === 'resolved' ? inputSchemaResolution.schema : undefined;

	const memoryResolution = resolveActorMemorySettings(version.sourceFiles);
	if (memoryResolution.outcome === 'failure') {
		await failBuild(record.id, memoryResolution.message);
		return;
	}
	const memorySettings = memoryResolution.settings;

	const sourceFiles: SourceFile[] = qualifyDockerfileImages(
		dockerfileResolution.outcome === 'default'
			? [...version.sourceFiles, dockerfileResolution.extraSourceFile]
			: version.sourceFiles,
		dockerfileResolution.dockerfilePath,
		(line) => appendRuntimeLog(record.id, line),
	);

	try {
		const outcome = await driver.startBuild(
			{
				buildId: record.id,
				actorName: actor.name,
				sourceFiles,
				useCache: options.useCache,
				timeoutSecs: DEFAULT_BUILD_TIMEOUT_SECS,
				dockerfilePath: dockerfileResolution.dockerfilePath,
			},
			(chunk) => appendLog(record.id, chunk),
		);
		// Re-read: `apify push` registers the folder right before starting the build, and the console can
		// change it mid-build. No working directory means no mount - the run log explains that instead.
		const { localDevFolder } = (await getRegistries().actors.get(actor.id)) ?? actor;
		if (localDevFolder && outcome.imageWorkingDirectory) {
			appendRuntimeLog(record.id, registeredDevFolderBuildLine(localDevFolder, outcome.imageWorkingDirectory));
		}
		// Flush before writing the terminal status, not after (mirrors the same fix in
		// `services/runs.ts`'s `runInBackground`): by the time `driver.startBuild` resolves every `onLog`
		// call has already happened, so flushing here guarantees the persisted log is complete before a
		// client that just observed the terminal status can possibly read it.
		await flushLog(record.id);
		// Guarded: if an abort raced ahead and already moved the record to ABORTING/ABORTED, this write
		// is refused (`RUNNING` is the only status `SUCCEEDED` is a legal next-state from) rather than
		// clobbering the abort - see `job-status.ts`. `imageWorkingDirectory` lands on the *build* record
		// itself here, not the Actor - build-specific, not Actor-specific (`actor-driver.md`; the human
		// directed this after a multi-tag Actor's most-recently-built, differently-tagged image could
		// otherwise silently overwrite the value a same-run, different-tag mount was built from). Omitted
		// entirely from the patch when the inspect produced nothing (`outcome.imageWorkingDirectory` is
		// `undefined` on an inspect failure or an empty/`/` working directory) rather than written as
		// `undefined` - `entities.ts`'s doc comment on the field: "never present on a non-SUCCEEDED build"
		// stays true for the value too, there is simply nothing to record for this build.
		// The tag is recorded BEFORE the SUCCEEDED write lands: a client that polls the build to SUCCEEDED
		// and immediately starts a run against the tag (apify-client's `build(..., { waitForFinish })`
		// followed by `start()`) must never find the tag still missing - with the writes the other way
		// round that was a real, if narrow, window. The tag is still never left pointing at an aborted
		// build: if the SUCCEEDED write below is refused because an abort won the race (`RUNNING` is the
		// only status `SUCCEEDED` is a legal next-state from - see `job-status.ts`), the tag is put back to
		// whatever it pointed at before, so `apify call`/`POST .../runs` against it keep working exactly as
		// they did.
		let previousTag: ActorRecord['taggedBuilds'][string] | undefined;
		await updateActor(actor.id, (current) => {
			previousTag = current.taggedBuilds[options.tag];
			return recordTaggedBuild(current, options.tag, record.id, record.buildNumber);
		});
		const succeeded = await transitionJobStatus(builds, record.id, 'SUCCEEDED', {
			finishedAt: new Date().toISOString(),
			imageId: outcome.imageId,
			exitCode: 0,
			...(outcome.imageWorkingDirectory !== undefined
				? { imageWorkingDirectory: outcome.imageWorkingDirectory }
				: {}),
			...(inputSchema !== undefined ? { inputSchema } : {}),
			...(memorySettings !== undefined ? { memorySettings } : {}),
		});
		if (succeeded?.status !== 'SUCCEEDED') {
			await updateActor(actor.id, (current) => {
				if (current.taggedBuilds[options.tag]?.buildId !== record.id) return current;
				const taggedBuilds = { ...current.taggedBuilds };
				if (previousTag) taggedBuilds[options.tag] = previousTag;
				else delete taggedBuilds[options.tag];
				return { ...current, taggedBuilds };
			});
		}
	} catch (error) {
		const status: JobStatus = error instanceof DriverTimedOutError ? 'TIMED-OUT' : 'FAILED';
		await flushLog(record.id);
		// Same guard: an aborted build's driver call also rejects (the destroyed HTTP request surfaces
		// as an error here too), but by the time that rejection is caught, `abortBuild` below has almost
		// certainly already moved the record to ABORTED - and even in the pathological ordering where it
		// hasn't yet, the record is at worst ABORTING, from which only `ABORTED` is a legal next status,
		// so this write is refused either way and the abort always wins.
		await transitionJobStatus(builds, record.id, status, {
			finishedAt: new Date().toISOString(),
			statusMessage: (error as Error).message,
		});
	} finally {
		markLogTerminal(record.id);
	}
}

/**
 * Interrupts the in-flight build for real (destroys its HTTP request to the Docker daemon - see
 * `DockerDriver`'s class doc comment), then reports `ABORTED` back to the caller. The record is moved
 * to `ABORTING` *before* `driver.abortBuild` is even called, which is what makes the result race-proof:
 * from that point on, `runBuildInBackground`'s own eventual completion write - whatever status it
 * computes, whenever it lands - can never overwrite this call's outcome. It is either blocked outright
 * (the record already terminal by the time it runs) or refused (an `ABORTING` record only accepts
 * `ABORTED` as its next status, per `job-status.ts`), regardless of which write actually reaches the
 * record first.
 */
export async function abortBuild(driver: Driver, build: BuildRecord): Promise<BuildRecord | null> {
	if (isTerminalJobStatus(build.status)) return build;
	const { builds } = getRegistries();
	const aborting = await transitionJobStatus(builds, build.id, 'ABORTING');
	if (!aborting || aborting.status !== 'ABORTING') return aborting;
	await driver.abortBuild(build.id);
	return transitionJobStatus(builds, build.id, 'ABORTED', { finishedAt: new Date().toISOString() });
}

/** Poll the build registry until terminal or `seconds` elapse (real API's `waitForFinish` contract). */
export async function waitForBuildFinish(buildId: string, seconds: number): Promise<BuildRecord | null> {
	const deadline = Date.now() + seconds * 1000;
	for (;;) {
		const current = await getRegistries().builds.get(buildId);
		if (!current || isTerminalJobStatus(current.status) || Date.now() >= deadline) return current;
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
}

import type { Router } from 'express';

import { requireUser } from '../auth.js';

import { paginate, sendData, sendPaginated, sortByTimestamp } from '../envelope.js';
import {
	ApiError,
	cannotRenameEnvVar,
	cannotSetPricingOnCreate,
	envVarAlreadyExists,
	invalidInput,
	invalidInputSchema,
	invalidRequest,
	recordNotFound,
	schemaValidation,
} from '../errors.js';
import { h, jsonBody, paginationParams, queryBoolean, queryNumber, queryString, rawBody } from '../handler.js';
import {
	addOrReplaceVersion,
	createActor,
	DEFAULT_BUILD_TAG as DEFAULT_TAG,
	deleteActor,
	findVersion,
	listOwnedActors,
	updateActor,
} from '../../services/actors.js';
import { resolveActorParam } from '../resolve-reference.js';
import {
	listOwnedBuilds,
	resolveTaggedBuild,
	startBuild,
	waitForBuildFinish,
	type StartBuildOptions,
} from '../../services/builds.js';
import { listOwnedRuns, startRun, waitForRunFinish } from '../../services/runs.js';
import { getRegistries } from '../../storage/registries.js';
import { actorDto, buildDto, runDto, versionDto } from '../dto/actors.js';
import type {
	ActorEnvVarRecord,
	ActorPricingInfoRecord,
	ActorRecord,
	ActorStandbyRecord,
	ActorVersionRecord,
} from '../../storage/entities.js';
import type { ApiServerDeps } from '../server.js';
import { CONTAINER_API_BASE_URL } from '../../config.js';
import { resolveProxyPassword } from '../../services/users.js';
import { validatePricingInfosUpdate } from '../../services/pricing.js';
import { resolveBuildInput } from '../../services/input-schema.js';
import { publicEnvVar, validateEnvVar, validateEnvVars } from '../../services/env-vars.js';
import {
	declaresStandbyMode,
	mergeStandbyUpdate,
	standbyUrl,
	standbyUrlAudienceOf,
} from '../../services/standby-config.js';
import { deleteSourceContextFiles } from '../../services/source-context.js';

/** `undefined` when the body does not mention the field; an invalid one throws. */
function actorStandbyFromBody(body: { actorStandby?: unknown }, actor?: ActorRecord): ActorStandbyRecord | undefined {
	if (body.actorStandby === undefined || body.actorStandby === null) return undefined;
	const result = mergeStandbyUpdate(body.actorStandby, actor?.actorStandby);
	if (result.kind === 'invalid') throw invalidRequest(result.message);
	return result.actorStandby;
}

/** The platform enables standby, never disables it, for a version whose `.actor/actor.json` asks for it;
 * `undefined` when that changes nothing. */
function standbyEnabledByVersions(
	current: ActorStandbyRecord | undefined,
	versions: ActorVersionRecord[],
): ActorStandbyRecord | undefined {
	if (current?.isEnabled) return undefined;
	if (!versions.some((version) => declaresStandbyMode(version.sourceFiles ?? []))) return undefined;
	const result = mergeStandbyUpdate({ isEnabled: true }, current);
	return result.kind === 'ok' ? result.actorStandby : undefined;
}

/**
 * `undefined` when the body does not mention the field; a body that does but is invalid throws, with the
 * platform's own error type where it has one for the same rule.
 */
function pricingInfosFromBody(
	body: { pricingInfos?: unknown },
	actor: ActorRecord,
): ActorPricingInfoRecord[] | undefined {
	if (body.pricingInfos === undefined) return undefined;
	const result = validatePricingInfosUpdate(body.pricingInfos, actor.pricingInfos);
	if (result.kind === 'invalid') {
		throw result.type ? new ApiError(400, result.type, result.message) : invalidRequest(result.message);
	}
	return result.pricingInfos;
}

/** `undefined` when the body does not mention the field; an invalid list throws. */
function envVarsFromBody(raw: unknown): ActorEnvVarRecord[] | undefined {
	const result = validateEnvVars(raw);
	if (result.kind === 'invalid') throw schemaValidation(result.message);
	return result.value;
}

function envVarFromBody(raw: unknown): ActorEnvVarRecord {
	const result = validateEnvVar(raw);
	if (result.kind === 'invalid') throw schemaValidation(result.message);
	return result.value;
}

function applyEnvVarsToBuildFromBody(raw: unknown): boolean | undefined {
	if (raw === undefined || raw === null) return undefined;
	if (typeof raw !== 'boolean') throw schemaValidation('"applyEnvVarsToBuild" must be a boolean');
	return raw;
}

/** A version body's env-var fields, falling back to `existing`'s for a field the body leaves out. */
function versionEnvFieldsFromBody(
	body: { envVars?: unknown; applyEnvVarsToBuild?: unknown },
	existing?: ActorVersionRecord,
): Pick<ActorVersionRecord, 'envVars' | 'applyEnvVarsToBuild'> {
	const envVars = envVarsFromBody(body.envVars) ?? existing?.envVars;
	const applyEnvVarsToBuild = applyEnvVarsToBuildFromBody(body.applyEnvVarsToBuild) ?? existing?.applyEnvVarsToBuild;
	return {
		...(envVars !== undefined ? { envVars } : {}),
		...(applyEnvVarsToBuild !== undefined ? { applyEnvVarsToBuild } : {}),
	};
}

async function resolveVersionParam(req: Parameters<typeof resolveActorParam>[0]) {
	const actor = await resolveActorParam(req);
	if (!actor) throw recordNotFound();
	const version = findVersion(actor, req.params.versionNumber as string);
	if (!version) throw recordNotFound();
	return { actor, version };
}

/** The version as stored, so a response shows its secrets exactly as a later read will - encrypted, as
 * the platform answers from the stored version too. */
function storedVersion(actor: ActorRecord | null, versionNumber: string): ActorVersionRecord {
	const version = actor && findVersion(actor, versionNumber);
	if (!version) throw recordNotFound();
	return version;
}

function findEnvVarOrThrow(version: ActorVersionRecord, name: string): ActorEnvVarRecord {
	const envVar = version.envVars?.find((entry) => entry.name === name);
	if (!envVar) throw recordNotFound('Environment variable was not found');
	return envVar;
}

export function mountActors(router: Router, deps: ApiServerDeps): void {
	router.get(
		'/actors',
		h(async (req, res) => {
			const actors = await listOwnedActors(requireUser(req).id);
			const sorted = sortByTimestamp(actors, (actor) => actor.createdAt);
			const envelope = paginate(sorted, paginationParams(req));
			sendData(res, {
				...envelope,
				items: envelope.items.map((actor) =>
					actorDto(actor, requireUser(req).username, standbyUrlAudienceOf(req.headers.host)),
				),
			});
		}),
	);

	router.post(
		'/actors',
		h(async (req, res) => {
			const body = jsonBody<{
				name: string;
				title?: string;
				versions?: ActorVersionRecord[];
				pricingInfos?: unknown;
				actorStandby?: unknown;
			}>(req);
			if (!body.name) throw invalidRequest('Actor "name" is required');
			if (body.pricingInfos !== undefined) throw cannotSetPricingOnCreate();
			// An explicit `actorStandby` wins over `usesStandbyMode`, even one that disables it.
			const actorStandby = actorStandbyFromBody(body) ?? standbyEnabledByVersions(undefined, body.versions ?? []);
			// A context is set only through its own endpoint, never smuggled in with the Actor.
			const versions = body.versions?.map(({ localSourceContext: _ignored, ...version }) => ({
				...version,
				envVars: undefined,
				applyEnvVarsToBuild: undefined,
				...versionEnvFieldsFromBody(version),
			}));
			const actor = await createActor(requireUser(req).id, { ...body, versions, actorStandby });
			sendData(res, actorDto(actor, requireUser(req).username, standbyUrlAudienceOf(req.headers.host)), 201);
		}),
	);

	router.get(
		'/actors/:actorId',
		h(async (req, res) => {
			const actor = await resolveActorParam(req);
			if (!actor) throw recordNotFound();
			sendData(res, actorDto(actor, requireUser(req).username, standbyUrlAudienceOf(req.headers.host)));
		}),
	);

	router.put(
		'/actors/:actorId',
		h(async (req, res) => {
			const actor = await resolveActorParam(req);
			if (!actor) throw recordNotFound();
			const body = jsonBody<{ name?: string; title?: string; pricingInfos?: unknown; actorStandby?: unknown }>(
				req,
			);
			const pricingInfos = pricingInfosFromBody(body, actor);
			const actorStandby = actorStandbyFromBody(body, actor);
			const updated = await updateActor(actor.id, (current) => ({
				...current,
				name: body.name ?? current.name,
				title: body.title ?? current.title,
				...(pricingInfos !== undefined ? { pricingInfos } : {}),
				...(actorStandby !== undefined ? { actorStandby } : {}),
			}));
			sendData(
				res,
				actorDto(updated ?? actor, requireUser(req).username, standbyUrlAudienceOf(req.headers.host)),
			);
		}),
	);

	router.delete(
		'/actors/:actorId',
		h(async (req, res) => {
			const actor = await resolveActorParam(req);
			// Matches the real platform: DELETE of a missing Actor 404s the same as GET (api.md's
			// "applies uniformly to every DELETE").
			if (!actor) throw recordNotFound();
			await deleteActor(actor.id);
			for (const version of actor.versions) await deleteSourceContextFiles(version.localSourceContext);
			res.status(204).end();
		}),
	);

	router.get(
		'/actors/:actorId/versions',
		h(async (req, res) => {
			const actor = await resolveActorParam(req);
			if (!actor) throw recordNotFound();
			sendPaginated(res, actor.versions.map(versionDto), paginationParams(req));
		}),
	);

	router.post(
		'/actors/:actorId/versions',
		h(async (req, res) => {
			const actor = await resolveActorParam(req);
			if (!actor) throw recordNotFound();
			const body = jsonBody<ActorVersionRecord>(req);
			if (!body.versionNumber) throw invalidRequest('"versionNumber" is required');
			const version: ActorVersionRecord = {
				versionNumber: body.versionNumber,
				buildTag: body.buildTag ?? DEFAULT_TAG,
				sourceType: 'SOURCE_FILES',
				sourceFiles: body.sourceFiles ?? [],
				...versionEnvFieldsFromBody(body),
			};
			let replaced: ActorVersionRecord | undefined;
			const updated = await updateActor(actor.id, (current) => {
				replaced = findVersion(current, version.versionNumber);
				const actorStandby = standbyEnabledByVersions(current.actorStandby, [version]);
				return { ...addOrReplaceVersion(current, version), ...(actorStandby ? { actorStandby } : {}) };
			});
			await deleteSourceContextFiles(replaced?.localSourceContext);
			sendData(res, versionDto(storedVersion(updated, version.versionNumber)), 201);
		}),
	);

	router.get(
		'/actors/:actorId/versions/:versionNumber',
		h(async (req, res) => {
			const { version } = await resolveVersionParam(req);
			sendData(res, versionDto(version));
		}),
	);

	router.put(
		'/actors/:actorId/versions/:versionNumber',
		h(async (req, res) => {
			const actor = await resolveActorParam(req);
			if (!actor) throw recordNotFound();
			const existing = findVersion(actor, req.params.versionNumber as string);
			if (!existing) throw recordNotFound();
			const body = jsonBody<Partial<ActorVersionRecord>>(req);
			// New `sourceFiles` replace the source, a monorepo context included; without them, it stays.
			const keptContext = body.sourceFiles === undefined ? existing.localSourceContext : undefined;
			const version: ActorVersionRecord = {
				versionNumber: req.params.versionNumber as string,
				buildTag: body.buildTag ?? existing.buildTag,
				sourceType: 'SOURCE_FILES',
				sourceFiles: body.sourceFiles ?? existing.sourceFiles,
				...versionEnvFieldsFromBody(body, existing),
				...(keptContext ? { localSourceContext: keptContext } : {}),
			};
			const updated = await updateActor(actor.id, (current) => addOrReplaceVersion(current, version));
			if (!keptContext) await deleteSourceContextFiles(existing.localSourceContext);
			sendData(res, versionDto(storedVersion(updated, version.versionNumber)));
		}),
	);

	router.get(
		'/actors/:actorId/versions/:versionNumber/env-vars',
		h(async (req, res) => {
			const { version } = await resolveVersionParam(req);
			const items = (version.envVars ?? []).map((envVar) => publicEnvVar(envVar, false));
			sendData(res, { total: items.length, items });
		}),
	);

	router.post(
		'/actors/:actorId/versions/:versionNumber/env-vars',
		h(async (req, res) => {
			const { actor, version } = await resolveVersionParam(req);
			const envVar = envVarFromBody(jsonBody(req));
			await updateActor(actor.id, (current) => {
				const currentVersion = findVersion(current, version.versionNumber);
				if (!currentVersion) throw recordNotFound();
				if (currentVersion.envVars?.some((entry) => entry.name === envVar.name)) throw envVarAlreadyExists();
				return addOrReplaceVersion(current, {
					...currentVersion,
					envVars: [...(currentVersion.envVars ?? []), envVar],
				});
			});
			sendData(res, publicEnvVar(envVar, false), 201);
		}),
	);

	router.get(
		'/actors/:actorId/versions/:versionNumber/env-vars/:envVarName',
		h(async (req, res) => {
			const { version } = await resolveVersionParam(req);
			sendData(res, publicEnvVar(findEnvVarOrThrow(version, req.params.envVarName as string), false));
		}),
	);

	router.put(
		'/actors/:actorId/versions/:versionNumber/env-vars/:envVarName',
		h(async (req, res) => {
			const { actor, version } = await resolveVersionParam(req);
			const oldName = req.params.envVarName as string;
			findEnvVarOrThrow(version, oldName);
			const envVar = envVarFromBody(jsonBody(req));
			await updateActor(actor.id, (current) => {
				const currentVersion = findVersion(current, version.versionNumber);
				if (!currentVersion) throw recordNotFound();
				const envVars = currentVersion.envVars ?? [];
				findEnvVarOrThrow(currentVersion, oldName);
				if (oldName !== envVar.name && envVars.some((entry) => entry.name === envVar.name)) {
					throw cannotRenameEnvVar();
				}
				return addOrReplaceVersion(current, {
					...currentVersion,
					envVars: envVars.map((entry) => (entry.name === oldName ? envVar : entry)),
				});
			});
			sendData(res, publicEnvVar(envVar, false));
		}),
	);

	router.delete(
		'/actors/:actorId/versions/:versionNumber/env-vars/:envVarName',
		h(async (req, res) => {
			const { actor, version } = await resolveVersionParam(req);
			const name = req.params.envVarName as string;
			findEnvVarOrThrow(version, name);
			await updateActor(actor.id, (current) => {
				const currentVersion = findVersion(current, version.versionNumber);
				if (!currentVersion) throw recordNotFound();
				return addOrReplaceVersion(current, {
					...currentVersion,
					envVars: (currentVersion.envVars ?? []).filter((entry) => entry.name !== name),
				});
			});
			res.status(204).end();
		}),
	);

	router.delete(
		'/actors/:actorId/versions/:versionNumber',
		h(async (req, res) => {
			const actor = await resolveActorParam(req);
			// Matches the real platform: a missing Actor and a missing version both 404, never a silent 204.
			if (!actor) throw recordNotFound();
			const existing = findVersion(actor, req.params.versionNumber as string);
			if (!existing) throw recordNotFound();
			await updateActor(actor.id, (current) => ({
				...current,
				versions: current.versions.filter((v) => v.versionNumber !== req.params.versionNumber),
			}));
			await deleteSourceContextFiles(existing.localSourceContext);
			res.status(204).end();
		}),
	);

	router.get(
		'/actors/:actorId/builds',
		h(async (req, res) => {
			const actor = await resolveActorParam(req);
			if (!actor) throw recordNotFound();
			const builds = await listOwnedBuilds(requireUser(req).id, actor.id);
			const sorted = sortByTimestamp(builds, (build) => build.startedAt);
			const envelope = paginate(sorted, paginationParams(req));
			sendData(res, { ...envelope, items: envelope.items.map(buildDto) });
		}),
	);

	router.post(
		'/actors/:actorId/builds',
		h(async (req, res) => {
			const actor = await resolveActorParam(req);
			if (!actor) throw recordNotFound();
			const versionNumber = queryString(req, 'version');
			if (!versionNumber) throw invalidRequest('"version" query parameter is required');
			const version = findVersion(actor, versionNumber);
			if (!version) throw recordNotFound(`Version "${versionNumber}" was not found`);

			const options: StartBuildOptions = {
				tag: queryString(req, 'tag') ?? version.buildTag ?? DEFAULT_TAG,
				useCache: queryBoolean(req, 'useCache') ?? true,
			};
			const build = await startBuild(deps.driver, actor, version, options);

			const waitSecs = queryNumber(req, 'waitForFinish');
			const finalBuild = waitSecs ? ((await waitForBuildFinish(build.id, waitSecs)) ?? build) : build;
			sendData(res, buildDto(finalBuild), 201);
		}),
	);

	router.get(
		'/actors/:actorId/builds/default',
		h(async (req, res) => {
			const actor = await resolveActorParam(req);
			if (!actor) throw recordNotFound();
			const tagged = actor.taggedBuilds[DEFAULT_TAG];
			if (!tagged) throw recordNotFound('Actor has no default build yet');
			const { builds } = getRegistries();
			const build = await builds.get(tagged.buildId);
			if (!build) throw recordNotFound();
			sendData(res, buildDto(build));
		}),
	);

	router.get(
		'/actors/:actorId/runs',
		h(async (req, res) => {
			const actor = await resolveActorParam(req);
			if (!actor) throw recordNotFound();
			const runs = await listOwnedRuns(requireUser(req).id, actor.id);
			const sorted = sortByTimestamp(runs, (run) => run.startedAt);
			const envelope = paginate(sorted, paginationParams(req));
			sendData(res, { ...envelope, items: envelope.items.map(runDto) });
		}),
	);

	router.post(
		'/actors/:actorId/runs',
		h(async (req, res) => {
			const actor = await resolveActorParam(req);
			if (!actor) throw recordNotFound();

			const tag = queryString(req, 'build') ?? DEFAULT_TAG;
			const maxTotalChargeUsd = queryNumber(req, 'maxTotalChargeUsd');
			if (maxTotalChargeUsd !== undefined && maxTotalChargeUsd < 0) {
				throw invalidRequest('"maxTotalChargeUsd" must be a number >= 0');
			}
			const lookup = await resolveTaggedBuild(actor, tag);
			if (!lookup.found) {
				// `no-such-tag` names the tag, matching base behavior exactly. `build-deleted` (the tag
				// exists, but its BuildRecord was removed via `DELETE /actor-builds/:buildId`, which does
				// not clear the tag pointing at it) throws the same bare `recordNotFound()` base did for
				// this case too - not a custom message - so run-start stays byte-for-byte base-identical
				// for every input class; `resolveTaggedBuild` (services/builds.ts) only exists so this
				// route and the dev-folder probe can each still branch on *which* reason it was, without
				// duplicating the tag/build lookup itself.
				if (lookup.reason === 'build-deleted') throw recordNotFound();
				throw recordNotFound(`Actor has no build tagged "${tag}"`);
			}
			const build = lookup.build;

			const body = rawBody(req);
			const processed = resolveBuildInput(
				build,
				body.length > 0 ? { body, contentType: req.header('content-type') ?? 'application/json' } : undefined,
			);
			if (processed.kind !== 'ok') {
				throw processed.kind === 'invalid-input-schema'
					? invalidInputSchema(processed.message)
					: invalidInput(processed.message);
			}

			// `resolveProxyPassword(requireUser(req))` is the *run owner's* proxy password, not just "the
			// caller's": `actor` was resolved via `resolveActorParam(req)` above, so
			// `actor.userId === requireUser(req).id` always holds - the caller can only ever start a run on
			// their own Actor - which makes the two the same user record (`actor-driver.md`'s "one
			// harvested-per-account password used specifically for each user").
			const run = await startRun(deps.driver, actor, build, {
				input: processed.input,
				memoryMbytes: queryNumber(req, 'memory'),
				timeoutSecs: queryNumber(req, 'timeout'),
				maxTotalChargeUsd,
				build: tag,
				// Runtime-only extension (`api.md`): `?devFolder=false` skips the dev-folder mount for this run.
				devFolder: queryBoolean(req, 'devFolder'),
				standbyUrl: standbyUrl(actor, requireUser(req).username),
				proxyPassword: resolveProxyPassword(requireUser(req)),
				apiBaseUrl: CONTAINER_API_BASE_URL,
				token: requireUser(req).token,
			});

			const waitSecs = queryNumber(req, 'waitForFinish');
			const finalRun = waitSecs ? ((await waitForRunFinish(run.id, waitSecs)) ?? run) : run;
			sendData(res, runDto(finalRun), 201);
		}),
	);
}

import type { Router } from 'express';

import { requireUser } from '../auth.js';

import { paginate, sendData, sendPaginated, sortByTimestamp } from '../envelope.js';
import { recordNotFound, invalidRequest } from '../errors.js';
import { h, jsonBody, paginationParams, queryBoolean, queryNumber, queryString, rawBody } from '../handler.js';
import {
	addOrReplaceVersion,
	createActor,
	deleteActor,
	findVersion,
	listOwnedActors,
	resolveOwnedActor,
	updateActor,
} from '../../services/actors.js';
import { listOwnedBuilds, startBuild, waitForBuildFinish, type StartBuildOptions } from '../../services/builds.js';
import { listOwnedRuns, startRun, waitForRunFinish } from '../../services/runs.js';
import { getRegistries } from '../../storage/registries.js';
import { actorDto, buildDto, runDto } from '../dto/actors.js';
import type { ActorVersionRecord } from '../../storage/entities.js';
import type { ApiServerDeps } from '../server.js';
import { CONTAINER_API_BASE_URL } from '../../config.js';
import { effectiveProxyPassword } from '../../services/identity-resolution.js';

const DEFAULT_TAG = 'latest';

export function mountActors(router: Router, deps: ApiServerDeps): void {
	router.get(
		'/actors',
		h(async (req, res) => {
			const actors = await listOwnedActors(requireUser(req).id);
			const sorted = sortByTimestamp(actors, (actor) => actor.createdAt);
			const envelope = paginate(sorted, paginationParams(req));
			sendData(res, {
				...envelope,
				items: envelope.items.map((actor) => actorDto(actor, requireUser(req).username)),
			});
		}),
	);

	router.post(
		'/actors',
		h(async (req, res) => {
			const body = jsonBody<{ name: string; title?: string; versions?: ActorVersionRecord[] }>(req);
			if (!body.name) throw invalidRequest('Actor "name" is required');
			const actor = await createActor(requireUser(req).id, body);
			sendData(res, actorDto(actor, requireUser(req).username), 201);
		}),
	);

	router.get(
		'/actors/:actorId',
		h(async (req, res) => {
			const actor = await resolveOwnedActor(
				requireUser(req).id,
				req.params.actorId as string,
				requireUser(req).username,
			);
			if (!actor) throw recordNotFound();
			sendData(res, actorDto(actor, requireUser(req).username));
		}),
	);

	router.put(
		'/actors/:actorId',
		h(async (req, res) => {
			const actor = await resolveOwnedActor(
				requireUser(req).id,
				req.params.actorId as string,
				requireUser(req).username,
			);
			if (!actor) throw recordNotFound();
			const body = jsonBody<{ name?: string; title?: string }>(req);
			const updated = await updateActor(actor.id, (current) => ({
				...current,
				name: body.name ?? current.name,
				title: body.title ?? current.title,
			}));
			sendData(res, actorDto(updated ?? actor, requireUser(req).username));
		}),
	);

	router.delete(
		'/actors/:actorId',
		h(async (req, res) => {
			const actor = await resolveOwnedActor(
				requireUser(req).id,
				req.params.actorId as string,
				requireUser(req).username,
			);
			if (actor) await deleteActor(actor.id);
			res.status(204).end();
		}),
	);

	router.get(
		'/actors/:actorId/versions',
		h(async (req, res) => {
			const actor = await resolveOwnedActor(
				requireUser(req).id,
				req.params.actorId as string,
				requireUser(req).username,
			);
			if (!actor) throw recordNotFound();
			sendPaginated(res, actor.versions, paginationParams(req));
		}),
	);

	router.post(
		'/actors/:actorId/versions',
		h(async (req, res) => {
			const actor = await resolveOwnedActor(
				requireUser(req).id,
				req.params.actorId as string,
				requireUser(req).username,
			);
			if (!actor) throw recordNotFound();
			const body = jsonBody<ActorVersionRecord>(req);
			if (!body.versionNumber) throw invalidRequest('"versionNumber" is required');
			const version: ActorVersionRecord = {
				versionNumber: body.versionNumber,
				buildTag: body.buildTag ?? DEFAULT_TAG,
				sourceType: 'SOURCE_FILES',
				sourceFiles: body.sourceFiles ?? [],
				envVars: body.envVars,
			};
			await updateActor(actor.id, (current) => addOrReplaceVersion(current, version));
			sendData(res, version, 201);
		}),
	);

	router.get(
		'/actors/:actorId/versions/:versionNumber',
		h(async (req, res) => {
			const actor = await resolveOwnedActor(
				requireUser(req).id,
				req.params.actorId as string,
				requireUser(req).username,
			);
			if (!actor) throw recordNotFound();
			const version = findVersion(actor, req.params.versionNumber as string);
			if (!version) throw recordNotFound();
			sendData(res, version);
		}),
	);

	router.put(
		'/actors/:actorId/versions/:versionNumber',
		h(async (req, res) => {
			const actor = await resolveOwnedActor(
				requireUser(req).id,
				req.params.actorId as string,
				requireUser(req).username,
			);
			if (!actor) throw recordNotFound();
			const existing = findVersion(actor, req.params.versionNumber as string);
			if (!existing) throw recordNotFound();
			const body = jsonBody<Partial<ActorVersionRecord>>(req);
			const version: ActorVersionRecord = {
				versionNumber: req.params.versionNumber as string,
				buildTag: body.buildTag ?? existing.buildTag,
				sourceType: 'SOURCE_FILES',
				sourceFiles: body.sourceFiles ?? existing.sourceFiles,
				envVars: body.envVars ?? existing.envVars,
			};
			await updateActor(actor.id, (current) => addOrReplaceVersion(current, version));
			sendData(res, version);
		}),
	);

	router.delete(
		'/actors/:actorId/versions/:versionNumber',
		h(async (req, res) => {
			const actor = await resolveOwnedActor(
				requireUser(req).id,
				req.params.actorId as string,
				requireUser(req).username,
			);
			if (actor) {
				await updateActor(actor.id, (current) => ({
					...current,
					versions: current.versions.filter((v) => v.versionNumber !== req.params.versionNumber),
				}));
			}
			res.status(204).end();
		}),
	);

	router.get(
		'/actors/:actorId/builds',
		h(async (req, res) => {
			const actor = await resolveOwnedActor(
				requireUser(req).id,
				req.params.actorId as string,
				requireUser(req).username,
			);
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
			const actor = await resolveOwnedActor(
				requireUser(req).id,
				req.params.actorId as string,
				requireUser(req).username,
			);
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
			const actor = await resolveOwnedActor(
				requireUser(req).id,
				req.params.actorId as string,
				requireUser(req).username,
			);
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
			const actor = await resolveOwnedActor(
				requireUser(req).id,
				req.params.actorId as string,
				requireUser(req).username,
			);
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
			const actor = await resolveOwnedActor(
				requireUser(req).id,
				req.params.actorId as string,
				requireUser(req).username,
			);
			if (!actor) throw recordNotFound();

			const tag = queryString(req, 'build') ?? DEFAULT_TAG;
			const tagged = actor.taggedBuilds[tag];
			if (!tagged) throw recordNotFound(`Actor has no build tagged "${tag}"`);
			const { builds } = getRegistries();
			const build = await builds.get(tagged.buildId);
			if (!build) throw recordNotFound();

			const body = rawBody(req);
			const input =
				body.length > 0 ? { body, contentType: req.header('content-type') ?? 'application/json' } : undefined;

			const run = await startRun(deps.driver, actor, build, {
				input,
				memoryMbytes: queryNumber(req, 'memory'),
				timeoutSecs: queryNumber(req, 'timeout'),
				build: tag,
				proxyPassword: effectiveProxyPassword(requireUser(req)),
				apiBaseUrl: CONTAINER_API_BASE_URL,
				token: requireUser(req).token,
			});

			const waitSecs = queryNumber(req, 'waitForFinish');
			const finalRun = waitSecs ? ((await waitForRunFinish(run.id, waitSecs)) ?? run) : run;
			sendData(res, runDto(finalRun), 201);
		}),
	);
}

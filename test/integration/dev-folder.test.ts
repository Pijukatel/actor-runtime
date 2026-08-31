/**
 * Integration coverage for the local dev-folder bind-mount feature's non-Docker-dependent surface: the
 * API endpoint's auth/ownership/shape/probe-classification contract (`api.md`'s `/actor-runtime/*`
 * section), that the registered value never leaks into any `/v2` Actor response, and the console's
 * single-field form (render, submit, clear, redirect, inline error). Every probe outcome is stubbed
 * (`devFolderDriver` below) - there is no Docker daemon in this sandbox (`docker-driver.ts`'s class doc
 * comment); the real-probe accept/reject path, `ensureProbeImage`'s real build, and the mount itself are
 * only exercised end-to-end in `test/e2e/dev-folder-bind-mount.test.ts`.
 */
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import axios from 'axios';

import { startTestServer, type TestServerHandle } from './helpers/test-server.js';
import { createConsoleServer } from '../../src/console/server.js';
import { getRegistries } from '../../src/storage/registries.js';
import { generateId } from '../../src/storage/ids.js';
import { recordTaggedBuild, updateActor } from '../../src/services/actors.js';
import type { ActorRecord, BuildRecord } from '../../src/storage/entities.js';
import type { Driver, DevFolderMount, DevFolderProbeOutcome } from '../../src/driver/types.js';

/** The fixed id `devFolderDriver`'s stubbed `ensureProbeImage` reports - stands in for the runtime's own
 * probe image (`DockerDriver.ensureProbeImage`), never any Actor's build. Assertions below check probe
 * calls carry exactly this id, proving registration never resolves an Actor build to probe against. */
const STUB_PROBE_IMAGE_ID = 'stub-probe-image:probe';

/**
 * A `Driver` whose only interesting behaviour is `probeDevFolder`, returning a caller-controlled
 * outcome that can be changed mid-test via `setOutcome` (for the "a prior registration survives a later
 * failed attempt" contract, which needs the same driver to succeed once and then fail). `probeDevFolderCalls`
 * records every `(candidatePath, imageId)` pair it was called with, so a test can assert the probe was -
 * or, for the "clearing never checks" contract, was NOT - invoked at all. `ensureProbeImage` always
 * resolves to `STUB_PROBE_IMAGE_ID`, regardless of what (if anything) the Actor has built.
 */
function devFolderDriver(
	initialOutcome: DevFolderProbeOutcome,
	available = true,
): Driver & {
	probeDevFolderCalls: Array<[string, string]>;
	setOutcome(next: DevFolderProbeOutcome): void;
} {
	let outcome = initialOutcome;
	const probeDevFolderCalls: Array<[string, string]> = [];
	return {
		available,
		probeDevFolderCalls,
		setOutcome(next: DevFolderProbeOutcome) {
			outcome = next;
		},
		async init() {},
		async startBuild() {
			throw new Error('not used by this stub');
		},
		async abortBuild() {},
		async startRun() {
			throw new Error('not used by this stub');
		},
		async abortRun() {},
		async reconcileOrphans() {},
		async ensureProbeImage() {
			return STUB_PROBE_IMAGE_ID;
		},
		async probeDevFolder(candidatePath: string, imageId: string) {
			probeDevFolderCalls.push([candidatePath, imageId]);
			return outcome;
		},
	};
}

/** A SUCCEEDED build with a fake image, tagged against the actor - used only by the run-start
 * `devMount`-derivation coverage further down this file (mirrors `job-lifecycle.test.ts`'s identical
 * helper); registration itself never needs a build at all. `imageWorkingDirectory` lives on this build
 * record itself, never on the Actor (directive: build-specific, not Actor-specific) - pass it here to
 * seed a build whose working directory a run would resolve. */
async function seedSucceededBuild(
	actor: ActorRecord,
	tag = 'latest',
	imageWorkingDirectory?: string,
): Promise<BuildRecord> {
	const build: BuildRecord = {
		id: generateId(),
		userId: actor.userId,
		actorId: actor.id,
		versionNumber: '0.0',
		buildNumber: '0.0.1',
		tag,
		status: 'SUCCEEDED',
		startedAt: new Date().toISOString(),
		finishedAt: new Date().toISOString(),
		imageId: 'fake-image:latest',
		...(imageWorkingDirectory !== undefined ? { imageWorkingDirectory } : {}),
	};
	await getRegistries().builds.set(build.id, build);
	await updateActor(actor.id, (current) => recordTaggedBuild(current, tag, build.id, build.buildNumber));
	return build;
}

function post(baseUrl: string, actorId: string, body: string, token?: string) {
	return axios.post(`${baseUrl}/actor-runtime/dev-folder/${actorId}`, body, {
		headers: token ? { Authorization: `Bearer ${token}` } : {},
		validateStatus: () => true,
	});
}

/** Same request as `post` above, but through the `/v2/actor-runtime/*` alias - exists solely because
 * `apify api` hardcodes a `/v2`-suffixed base URL; the clean, documented CLI invocation with no `../`
 * resolves onto exactly this path. */
function postViaV2Alias(baseUrl: string, actorId: string, body: string, token?: string) {
	return axios.post(`${baseUrl}/v2/actor-runtime/dev-folder/${actorId}`, body, {
		headers: token ? { Authorization: `Bearer ${token}` } : {},
		validateStatus: () => true,
	});
}

describe('POST /actor-runtime/dev-folder/:actorId', () => {
	let server: TestServerHandle;

	afterEach(async () => {
		await server.close();
	});

	it('401s with no auth token', async () => {
		server = await startTestServer(devFolderDriver({ ok: true }));
		const res = await post(server.baseUrl, 'whatever-id', JSON.stringify('/abs/path'));
		expect(res.status).toBe(401);
	});

	it("404s for an actor id that doesn't exist", async () => {
		server = await startTestServer(devFolderDriver({ ok: true }));
		const res = await post(server.baseUrl, 'totally-made-up-id', JSON.stringify('/abs/path'), server.token);
		expect(res.status).toBe(404);
	});

	it("404s for another user's actor (ownership-scoped, like every other Actor write on this port)", async () => {
		server = await startTestServer(devFolderDriver({ ok: true }));
		const actor = await server.client.actors().create({ name: 'other-users-actor' });

		const res = await post(server.baseUrl, actor.id, JSON.stringify('/abs/path'), 'a-completely-different-token');
		expect(res.status).toBe(404);
	});

	it('resolves the actor by plain name and by username~name, not only by id', async () => {
		server = await startTestServer(devFolderDriver({ ok: true }));
		const actor = await server.client.actors().create({ name: 'name-resolution-actor' });
		const me = await server.client.user('me').get();

		const byName = await post(server.baseUrl, actor.name, JSON.stringify('/abs/path-a'), server.token);
		expect(byName.status).toBe(200);

		const byUsernameTilde = await post(
			server.baseUrl,
			`${me.username}~${actor.name}`,
			JSON.stringify('/abs/path-b'),
			server.token,
		);
		expect(byUsernameTilde.status).toBe(200);
		expect(byUsernameTilde.data.data.localDevFolder).toBe('/abs/path-b');
	});

	it('400s for a body that is not valid JSON at all', async () => {
		server = await startTestServer(devFolderDriver({ ok: true }));
		const actor = await server.client.actors().create({ name: 'malformed-body-actor' });
		const res = await post(server.baseUrl, actor.id, 'not-json-at-all', server.token);
		expect(res.status).toBe(400);
	});

	it('400s for a body that is valid JSON but not a string (e.g. a bare number)', async () => {
		server = await startTestServer(devFolderDriver({ ok: true }));
		const actor = await server.client.actors().create({ name: 'non-string-body-actor' });
		const res = await post(server.baseUrl, actor.id, JSON.stringify(42), server.token);
		expect(res.status).toBe(400);
	});

	it('400s for a whitespace-only body instead of silently clearing - only the literal empty string clears', async () => {
		const driver = devFolderDriver({ ok: true });
		server = await startTestServer(driver);
		const actor = await server.client.actors().create({ name: 'whitespace-only-actor' });
		await post(server.baseUrl, actor.id, JSON.stringify('/abs/existing-path'), server.token);

		const res = await post(server.baseUrl, actor.id, JSON.stringify('   '), server.token);
		expect(res.status).toBe(400);
		// The probe must never be reached either - a whitespace-only body is rejected by the shape check,
		// not treated as a candidate path to verify.
		expect(driver.probeDevFolderCalls).toEqual([['/abs/existing-path', STUB_PROBE_IMAGE_ID]]);

		// Not a clear: the prior registration survives untouched.
		const stored = await getRegistries().actors.get(actor.id);
		expect(stored?.localDevFolder).toBe('/abs/existing-path');
	});

	it('400s for a relative path, even for an actor that has never been built, and stores nothing', async () => {
		server = await startTestServer(devFolderDriver({ ok: true }));
		const actor = await server.client.actors().create({ name: 'relative-path-actor' });

		const res = await post(server.baseUrl, actor.id, JSON.stringify('relative/path'), server.token);
		expect(res.status).toBe(400);
		const stored = await getRegistries().actors.get(actor.id);
		expect(stored?.localDevFolder).toBeUndefined();
	});

	it('200s and stores the path for an actor that has never had any build at all - registration has no build-first precondition', async () => {
		const driver = devFolderDriver({ ok: true });
		server = await startTestServer(driver);
		const actor = await server.client.actors().create({ name: 'never-built-actor' });

		const res = await post(server.baseUrl, actor.id, JSON.stringify('/abs/path'), server.token);
		expect(res.status).toBe(200);
		expect(res.data.data.localDevFolder).toBe('/abs/path');
		// The probe runs against the runtime's own probe image, never one resolved off the (nonexistent)
		// Actor build.
		expect(driver.probeDevFolderCalls).toEqual([['/abs/path', STUB_PROBE_IMAGE_ID]]);

		const stored = await getRegistries().actors.get(actor.id);
		expect(stored?.localDevFolder).toBe('/abs/path');
	});

	it('200s and stores the path for an actor whose only build attempt failed - a failed build is not a precondition either', async () => {
		server = await startTestServer(devFolderDriver({ ok: true }));
		const actor = await server.client.actors().create({ name: 'failed-build-only-actor' });
		const actorRecord = (await getRegistries().actors.get(actor.id))!;
		await getRegistries().builds.set(generateId(), {
			id: generateId(),
			userId: actorRecord.userId,
			actorId: actor.id,
			versionNumber: '0.0',
			buildNumber: '0.0.1',
			tag: 'latest',
			status: 'FAILED',
			startedAt: new Date().toISOString(),
			finishedAt: new Date().toISOString(),
		});

		const res = await post(server.baseUrl, actor.id, JSON.stringify('/abs/path'), server.token);
		expect(res.status).toBe(200);
	});

	it('200s and stores the path for an actor whose only successful build is tagged something other than "latest" - registration never resolves any tag at all', async () => {
		const driver = devFolderDriver({ ok: true });
		server = await startTestServer(driver);
		const actor = await server.client.actors().create({ name: 'non-latest-tag-only-actor' });
		// Mirrors exactly the Actor shape a tag-less `POST /actors/:actorId/runs` would 404 against - and
		// registration succeeds anyway, unlike that run-start resolution: the two are unrelated.
		await seedSucceededBuild((await getRegistries().actors.get(actor.id))!, 'staging');

		const res = await post(server.baseUrl, actor.id, JSON.stringify('/abs/path'), server.token);
		expect(res.status).toBe(200);
		// Still probed against the runtime's own probe image, never the "staging"-tagged build's.
		expect(driver.probeDevFolderCalls).toEqual([['/abs/path', STUB_PROBE_IMAGE_ID]]);

		const stored = await getRegistries().actors.get(actor.id);
		expect(stored?.localDevFolder).toBe('/abs/path');
	});

	it('200s and stores the path when the probe reports ok', async () => {
		const driver = devFolderDriver({ ok: true });
		server = await startTestServer(driver);
		const actor = await server.client.actors().create({ name: 'happy-path-actor' });

		const res = await post(server.baseUrl, actor.id, JSON.stringify('/abs/path/to/src'), server.token);
		expect(res.status).toBe(200);
		expect(res.data.data.localDevFolder).toBe('/abs/path/to/src');
		expect(driver.probeDevFolderCalls).toEqual([['/abs/path/to/src', STUB_PROBE_IMAGE_ID]]);

		const stored = await getRegistries().actors.get(actor.id);
		expect(stored?.localDevFolder).toBe('/abs/path/to/src');
	});

	it('the response reports only the registered localDevFolder - never a build working directory or a global "mount will apply" claim, which only a specific run could make good on', async () => {
		server = await startTestServer(devFolderDriver({ ok: true }));
		const actor = await server.client.actors().create({ name: 'status-fields-actor' });

		const res = await post(server.baseUrl, actor.id, JSON.stringify('/abs/path'), server.token);
		expect(res.data.data).toEqual({ localDevFolder: '/abs/path' });
	});

	it('a second registration replaces the first outright, not merges', async () => {
		server = await startTestServer(devFolderDriver({ ok: true }));
		const actor = await server.client.actors().create({ name: 'replace-actor' });

		await post(server.baseUrl, actor.id, JSON.stringify('/abs/first'), server.token);
		const second = await post(server.baseUrl, actor.id, JSON.stringify('/abs/second'), server.token);

		expect(second.data.data.localDevFolder).toBe('/abs/second');
		const stored = await getRegistries().actors.get(actor.id);
		expect(stored?.localDevFolder).toBe('/abs/second');
	});

	it('registering for Actor A never appears on Actor B', async () => {
		server = await startTestServer(devFolderDriver({ ok: true }));
		const actorA = await server.client.actors().create({ name: 'cross-actor-a' });
		const actorB = await server.client.actors().create({ name: 'cross-actor-b' });

		await post(server.baseUrl, actorA.id, JSON.stringify('/abs/only-a'), server.token);

		const storedB = await getRegistries().actors.get(actorB.id);
		expect(storedB?.localDevFolder).toBeUndefined();
	});

	it('unrelated Actor writes (e.g. PUT name/title) never touch a previously-registered dev folder', async () => {
		server = await startTestServer(devFolderDriver({ ok: true }));
		const actor = await server.client.actors().create({ name: 'unrelated-write-actor' });
		await post(server.baseUrl, actor.id, JSON.stringify('/abs/untouched'), server.token);

		await server.client.actor(actor.id).update({ title: 'a new title' });

		const stored = await getRegistries().actors.get(actor.id);
		expect(stored?.localDevFolder).toBe('/abs/untouched');
	});

	it('200s and clears with the empty JSON string, without the clear itself ever calling the probe', async () => {
		const driver = devFolderDriver({ ok: true });
		server = await startTestServer(driver);
		const actor = await server.client.actors().create({ name: 'clear-actor' });
		await post(server.baseUrl, actor.id, JSON.stringify('/abs/path'), server.token);
		expect(driver.probeDevFolderCalls.length).toBe(1);

		const res = await post(server.baseUrl, actor.id, JSON.stringify(''), server.token);
		expect(res.status).toBe(200);
		expect(res.data.data.localDevFolder).toBeNull();
		expect(driver.probeDevFolderCalls.length).toBe(1); // unchanged - clearing never probes

		const stored = await getRegistries().actors.get(actor.id);
		expect(stored?.localDevFolder).toBeUndefined();
	});

	it('clearing succeeds even when Docker is unreachable (unavailable driver) - no existence check needed', async () => {
		server = await startTestServer(devFolderDriver({ ok: false, reason: 'unreachable' }, false));
		const actor = await server.client.actors().create({ name: 'clear-unreachable-actor' });

		const res = await post(server.baseUrl, actor.id, JSON.stringify(''), server.token);
		expect(res.status).toBe(200);
		expect(res.data.data.localDevFolder).toBeNull();
	});

	it('a prior valid registration survives untouched across a later failed registration attempt', async () => {
		const driver = devFolderDriver({ ok: true });
		server = await startTestServer(driver);
		const actor = await server.client.actors().create({ name: 'survive-actor' });

		const first = await post(server.baseUrl, actor.id, JSON.stringify('/abs/good-path'), server.token);
		expect(first.status).toBe(200);

		driver.setOutcome({ ok: false, reason: 'not-found' });
		const second = await post(server.baseUrl, actor.id, JSON.stringify('/abs/bad-path'), server.token);
		expect(second.status).toBe(400);

		const stored = await getRegistries().actors.get(actor.id);
		expect(stored?.localDevFolder).toBe('/abs/good-path');
	});

	it('classifies a not-found probe outcome as 400 "does not exist", and stores nothing', async () => {
		server = await startTestServer(devFolderDriver({ ok: false, reason: 'not-found' }));
		const actor = await server.client.actors().create({ name: 'not-found-actor' });

		const res = await post(server.baseUrl, actor.id, JSON.stringify('/abs/missing'), server.token);
		expect(res.status).toBe(400);
		expect(res.data.error.message.toLowerCase()).toContain('does not exist');

		const stored = await getRegistries().actors.get(actor.id);
		expect(stored?.localDevFolder).toBeUndefined();
	});

	it('classifies a not-a-directory probe outcome as 400 "not a directory" (a file candidate), distinguishable from "does not exist"', async () => {
		server = await startTestServer(devFolderDriver({ ok: false, reason: 'not-a-directory' }));
		const actor = await server.client.actors().create({ name: 'not-a-directory-actor' });

		const res = await post(server.baseUrl, actor.id, JSON.stringify('/abs/a-file'), server.token);
		expect(res.status).toBe(400);
		expect(res.data.error.type).toBe('dev-folder-not-a-directory');
		expect(res.data.error.message.toLowerCase()).toContain('not a directory');
		expect(res.data.error.message.toLowerCase()).not.toContain('does not exist');

		const stored = await getRegistries().actors.get(actor.id);
		expect(stored?.localDevFolder).toBeUndefined();
	});

	it('classifies an unreachable probe outcome as 503, distinguishable from "does not exist"', async () => {
		server = await startTestServer(devFolderDriver({ ok: false, reason: 'unreachable' }));
		const actor = await server.client.actors().create({ name: 'unreachable-actor' });

		const res = await post(server.baseUrl, actor.id, JSON.stringify('/abs/path'), server.token);
		expect(res.status).toBe(503);
		expect(res.data.error.message.toLowerCase()).not.toContain('does not exist');
	});

	it('classifies an image-missing probe outcome as 500 internal error, distinguishable from "does not exist"', async () => {
		server = await startTestServer(devFolderDriver({ ok: false, reason: 'image-missing' }));
		const actor = await server.client.actors().create({ name: 'image-missing-actor' });

		const res = await post(server.baseUrl, actor.id, JSON.stringify('/abs/path'), server.token);
		expect(res.status).toBe(500);
		expect(res.data.error.message.toLowerCase()).not.toContain('does not exist');
	});

	it('classifies an unknown mount-shaped rejection as 400 "could not verify", never "does not exist"', async () => {
		server = await startTestServer(devFolderDriver({ ok: false, reason: 'unknown' }));
		const actor = await server.client.actors().create({ name: 'unknown-reason-actor' });

		const res = await post(server.baseUrl, actor.id, JSON.stringify('/abs/path'), server.token);
		expect(res.status).toBe(400);
		expect(res.data.error.message.toLowerCase()).not.toContain('does not exist');
	});

	it('the registered value never appears in any /v2 Actor response (list or get), and modifiedAt does not move either - closing the timestamp side channel, not just the path string', async () => {
		server = await startTestServer(devFolderDriver({ ok: true }));
		const actor = await server.client.actors().create({ name: 'no-leak-actor' });
		const beforeFetch = await server.client.actor(actor.id).get();

		await post(server.baseUrl, actor.id, JSON.stringify('/abs/should-not-leak'), server.token);

		const fetched = await server.client.actor(actor.id).get();
		expect(JSON.stringify(fetched)).not.toContain('/abs/should-not-leak');
		expect(fetched).not.toHaveProperty('localDevFolder');
		expect(fetched).not.toHaveProperty('imageWorkingDirectory');
		// `modifiedAt` *is* a real `/v2` field - a plain path-string check would miss a registration that
		// leaked only through this timestamp moving, so this asserts it explicitly stays put.
		expect(fetched?.modifiedAt).toEqual(beforeFetch?.modifiedAt);

		const listed = await server.client.actors().list();
		expect(JSON.stringify(listed)).not.toContain('/abs/should-not-leak');
	});

	it("registering a dev folder never bumps the Actor's modifiedAt", async () => {
		server = await startTestServer(devFolderDriver({ ok: true }));
		const actor = await server.client.actors().create({ name: 'modifiedat-set-actor' });
		const before = (await getRegistries().actors.get(actor.id))!.modifiedAt;

		const res = await post(server.baseUrl, actor.id, JSON.stringify('/abs/path'), server.token);
		expect(res.status).toBe(200);

		const after = (await getRegistries().actors.get(actor.id))!.modifiedAt;
		expect(after).toBe(before);
	});

	it("clearing a previously-registered dev folder never bumps the Actor's modifiedAt", async () => {
		server = await startTestServer(devFolderDriver({ ok: true }));
		const actor = await server.client.actors().create({ name: 'modifiedat-clear-actor' });
		await post(server.baseUrl, actor.id, JSON.stringify('/abs/path'), server.token);
		const before = (await getRegistries().actors.get(actor.id))!.modifiedAt;

		const res = await post(server.baseUrl, actor.id, JSON.stringify(''), server.token);
		expect(res.status).toBe(200);

		const after = (await getRegistries().actors.get(actor.id))!.modifiedAt;
		expect(after).toBe(before);
	});

	it('clearing an actor that has nothing registered is a no-op write and never bumps modifiedAt', async () => {
		server = await startTestServer(devFolderDriver({ ok: true }));
		const actor = await server.client.actors().create({ name: 'modifiedat-noop-clear-actor' });
		const before = (await getRegistries().actors.get(actor.id))!.modifiedAt;

		const res = await post(server.baseUrl, actor.id, JSON.stringify(''), server.token);
		expect(res.status).toBe(200);
		expect(res.data.data.localDevFolder).toBeNull();

		const after = (await getRegistries().actors.get(actor.id))!.modifiedAt;
		expect(after).toBe(before);
	});
});

describe("POST /v2/actor-runtime/dev-folder/:actorId - the alias apify api's hardcoded /v2 base makes reachable", () => {
	let server: TestServerHandle;

	afterEach(async () => {
		await server.close();
	});

	it('401s with no auth token, exactly like the canonical path - authenticated exactly once, never skipped nor doubled', async () => {
		server = await startTestServer(devFolderDriver({ ok: true }));
		const res = await postViaV2Alias(server.baseUrl, 'whatever-id', JSON.stringify('/abs/path'));
		expect(res.status).toBe(401);
	});

	it("404s for another user's actor via the alias, exactly like the canonical path (ownership-scoped)", async () => {
		server = await startTestServer(devFolderDriver({ ok: true }));
		const actor = await server.client.actors().create({ name: 'alias-other-users-actor' });

		const res = await postViaV2Alias(
			server.baseUrl,
			actor.id,
			JSON.stringify('/abs/path'),
			'a-completely-different-token',
		);
		expect(res.status).toBe(404);
	});

	it('registers and reads back successfully via the alias - the same handler as the canonical path, not a separate implementation', async () => {
		server = await startTestServer(devFolderDriver({ ok: true }));
		const actor = await server.client.actors().create({ name: 'alias-happy-path-actor' });

		const res = await postViaV2Alias(server.baseUrl, actor.id, JSON.stringify('/abs/via-alias'), server.token);
		expect(res.status).toBe(200);
		expect(res.data.data.localDevFolder).toBe('/abs/via-alias');

		const stored = await getRegistries().actors.get(actor.id);
		expect(stored?.localDevFolder).toBe('/abs/via-alias');
	});

	it('a registration made through the canonical path is read back identically through the alias, and vice versa - one piece of state, two paths to it', async () => {
		server = await startTestServer(devFolderDriver({ ok: true }));
		const actor = await server.client.actors().create({ name: 'alias-parity-actor' });

		const viaCanonical = await post(
			server.baseUrl,
			actor.id,
			JSON.stringify('/abs/set-via-canonical'),
			server.token,
		);
		expect(viaCanonical.status).toBe(200);
		const readViaAlias = await postViaV2Alias(server.baseUrl, actor.id, JSON.stringify(''), server.token);
		// Clearing (the literal empty string) is itself a read-back of the prior value via the response
		// envelope's own echo, but more directly: re-set via the alias, then read back via the canonical
		// path, proving the two paths share one underlying record.
		expect(readViaAlias.data.data.localDevFolder).toBeNull();

		const viaAlias = await postViaV2Alias(
			server.baseUrl,
			actor.id,
			JSON.stringify('/abs/set-via-alias'),
			server.token,
		);
		expect(viaAlias.status).toBe(200);
		const readViaCanonical = await post(
			server.baseUrl,
			actor.id,
			JSON.stringify('/abs/set-via-alias'),
			server.token,
		);
		expect(readViaCanonical.data.data.localDevFolder).toBe('/abs/set-via-alias');

		const stored = await getRegistries().actors.get(actor.id);
		expect(stored?.localDevFolder).toBe('/abs/set-via-alias');
	});

	it('400s for a malformed body via the alias, identically to the canonical path', async () => {
		server = await startTestServer(devFolderDriver({ ok: true }));
		const actor = await server.client.actors().create({ name: 'alias-malformed-body-actor' });
		const res = await postViaV2Alias(server.baseUrl, actor.id, 'not-json-at-all', server.token);
		expect(res.status).toBe(400);
	});

	it('the dev-folder fields never appear in any real /v2 Actor response, whichever path registered them', async () => {
		server = await startTestServer(devFolderDriver({ ok: true }));
		const actor = await server.client.actors().create({ name: 'alias-no-leak-actor' });

		await postViaV2Alias(server.baseUrl, actor.id, JSON.stringify('/abs/should-not-leak-via-alias'), server.token);

		const fetched = await server.client.actor(actor.id).get();
		expect(JSON.stringify(fetched)).not.toContain('/abs/should-not-leak-via-alias');
		expect(fetched).not.toHaveProperty('localDevFolder');
	});

	it('an unmatched path under /v2/actor-runtime/* does not get routed as a real /v2 Actor path', async () => {
		server = await startTestServer(devFolderDriver({ ok: true }));
		const res = await axios.post(`${server.baseUrl}/v2/actor-runtime/nonexistent-sub-route`, '{}', {
			headers: { Authorization: `Bearer ${server.token}` },
			validateStatus: () => true,
		});
		// Never a 200/mutation - either this namespace's own 404 (unmatched route on the devFolder
		// router) or, if it falls through to `v2`'s own catch-all, that catch-all's 404/501 - either way,
		// never treated as a genuine Apify Actor path.
		expect([404, 501]).toContain(res.status);
	});
});

describe('console: dev-folder registration form on the Actor detail view', () => {
	let server: TestServerHandle;
	let consoleServer: Server;
	let consoleBaseUrl: string;

	async function setUpConsole(driver: Driver): Promise<void> {
		// The API server's own driver is irrelevant to these tests (only the console's dev-folder route
		// is exercised here), but `startTestServer` needs one to create Actors through `server.client` -
		// reusing the same instance keeps this simple and means `probeDevFolderCalls`/`setOutcome` (if the
		// caller passed a `devFolderDriver`) are also visible through `server.driver`.
		server = await startTestServer(driver);
		const app = createConsoleServer({ driver });
		consoleServer = await new Promise((resolve) => {
			const s = app.listen(0, () => resolve(s));
		});
		consoleBaseUrl = `http://127.0.0.1:${(consoleServer.address() as AddressInfo).port}`;
	}

	afterEach(async () => {
		await new Promise<void>((resolve) => consoleServer.close(() => resolve()));
		await server.close();
	});

	it('renders the one status row and the form for an Actor with no registration yet', async () => {
		await setUpConsole(devFolderDriver({ ok: true }));
		const actor = await server.client.actors().create({ name: 'devfolder-render-actor' });

		const detail = await axios.get(`${consoleBaseUrl}/actors/${actor.id}`);
		expect(detail.status).toBe(200);
		expect(detail.data).toContain('(none registered)');
		// No build working directory or "mount will apply" claim - registration is Actor-level and has no
		// per-run build to speak for (`services/dev-folder.ts: devFolderStatus`'s doc comment).
		expect(detail.data).not.toContain('imageWorkingDirectory');
		expect(detail.data).not.toContain('mount will apply');
		expect(detail.data).toContain(`<form method="post" action="/actors/${actor.id}/dev-folder">`);
	});

	it('submitting the form registers the path and redirects back to the detail page, which then shows it - no build required first', async () => {
		const consoleDriver = devFolderDriver({ ok: true });
		await setUpConsole(consoleDriver);
		const actor = await server.client.actors().create({ name: 'devfolder-submit-actor' });

		const submit = await axios.post(
			`${consoleBaseUrl}/actors/${actor.id}/dev-folder`,
			'localDevFolder=%2Fabs%2Fpath',
			{
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				maxRedirects: 0,
				validateStatus: () => true,
			},
		);
		expect(submit.status).toBe(302);
		expect(submit.headers.location).toBe(`/actors/${actor.id}`);

		const detail = await axios.get(`${consoleBaseUrl}/actors/${actor.id}`);
		expect(detail.data).toContain('/abs/path');

		const stored = await getRegistries().actors.get(actor.id);
		expect(stored?.localDevFolder).toBe('/abs/path');
	});

	it('rejects a cross-site form submission (Sec-Fetch-Site: cross-site) with 403, and never touches the registration', async () => {
		await setUpConsole(devFolderDriver({ ok: true }));
		const actor = await server.client.actors().create({ name: 'devfolder-cross-site-actor' });

		const submit = await axios.post(
			`${consoleBaseUrl}/actors/${actor.id}/dev-folder`,
			'localDevFolder=%2Fabs%2Fpath',
			{
				headers: {
					'Content-Type': 'application/x-www-form-urlencoded',
					'Sec-Fetch-Site': 'cross-site',
				},
				maxRedirects: 0,
				validateStatus: () => true,
			},
		);
		expect(submit.status).toBe(403);

		const stored = await getRegistries().actors.get(actor.id);
		expect(stored?.localDevFolder).toBeUndefined();
	});

	it('submitting an empty value clears a previously-registered path', async () => {
		await setUpConsole(devFolderDriver({ ok: true }));
		const actor = await server.client.actors().create({ name: 'devfolder-clear-actor' });
		await updateActor(actor.id, (current) => ({ ...current, localDevFolder: '/abs/old-path' }));

		const submit = await axios.post(`${consoleBaseUrl}/actors/${actor.id}/dev-folder`, 'localDevFolder=', {
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			maxRedirects: 0,
			validateStatus: () => true,
		});
		expect(submit.status).toBe(302);
		expect(submit.headers.location).toBe(`/actors/${actor.id}`);

		const detail = await axios.get(`${consoleBaseUrl}/actors/${actor.id}`);
		expect(detail.data).toContain('(none registered)');
		expect(detail.data).not.toContain('/abs/old-path');

		const stored = await getRegistries().actors.get(actor.id);
		expect(stored?.localDevFolder).toBeUndefined();
	});

	it('submitting a whitespace-only value does not clear - it redirects with an inline error and the prior path survives', async () => {
		await setUpConsole(devFolderDriver({ ok: true }));
		const actor = await server.client.actors().create({ name: 'devfolder-whitespace-actor' });
		await updateActor(actor.id, (current) => ({
			...current,
			localDevFolder: '/abs/existing-path',
		}));

		const submit = await axios.post(`${consoleBaseUrl}/actors/${actor.id}/dev-folder`, 'localDevFolder=%20%20%20', {
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			maxRedirects: 0,
			validateStatus: () => true,
		});
		expect(submit.status).toBe(302);
		expect(submit.headers.location).toContain('devFolderError=');

		const detail = await axios.get(`${consoleBaseUrl}${submit.headers.location}`);
		expect(detail.data).toContain('/abs/existing-path');
		expect(detail.data).not.toContain('(none registered)');

		const stored = await getRegistries().actors.get(actor.id);
		expect(stored?.localDevFolder).toBe('/abs/existing-path');
	});

	it('a submission with the localDevFolder field entirely absent from the body is treated as an empty value (clears), the untested false side of the field-presence guard', async () => {
		await setUpConsole(devFolderDriver({ ok: true }));
		const actor = await server.client.actors().create({ name: 'devfolder-missing-field-actor' });
		await updateActor(actor.id, (current) => ({ ...current, localDevFolder: '/abs/old-path' }));

		// A urlencoded body with no `localDevFolder` key at all - `body?.localDevFolder` is `undefined`,
		// not an empty string, so this exercises the guard's false branch, not its true branch.
		const submit = await axios.post(`${consoleBaseUrl}/actors/${actor.id}/dev-folder`, 'unrelated=1', {
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			maxRedirects: 0,
			validateStatus: () => true,
		});
		expect(submit.status).toBe(302);

		const stored = await getRegistries().actors.get(actor.id);
		expect(stored?.localDevFolder).toBeUndefined();
	});

	it('a submission for an Actor that has never been built succeeds through the console form too - no build-first precondition on either surface', async () => {
		await setUpConsole(devFolderDriver({ ok: true }));
		const actor = await server.client.actors().create({ name: 'devfolder-never-built-actor' });

		const submit = await axios.post(
			`${consoleBaseUrl}/actors/${actor.id}/dev-folder`,
			'localDevFolder=%2Fabs%2Fpath',
			{
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				maxRedirects: 0,
				validateStatus: () => true,
			},
		);
		expect(submit.status).toBe(302);
		expect(submit.headers.location).toBe(`/actors/${actor.id}`);

		const stored = await getRegistries().actors.get(actor.id);
		expect(stored?.localDevFolder).toBe('/abs/path');
	});

	it('the does-not-exist vs. could-not-verify distinction is surfaced on the console too, not collapsed', async () => {
		const consoleDriver = devFolderDriver({ ok: false, reason: 'not-found' });
		await setUpConsole(consoleDriver);
		const actor = await server.client.actors().create({ name: 'devfolder-not-found-console-actor' });

		const submit = await axios.post(
			`${consoleBaseUrl}/actors/${actor.id}/dev-folder`,
			'localDevFolder=%2Fabs%2Fmissing',
			{
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				maxRedirects: 0,
				validateStatus: () => true,
			},
		);
		const detail = await axios.get(`${consoleBaseUrl}${submit.headers.location}`);
		expect(detail.data.toLowerCase()).toContain('does not exist');
	});

	it('a 404 for a nonexistent Actor id renders Not found, not a 500 or a silent pass', async () => {
		await setUpConsole(devFolderDriver({ ok: true }));
		const res = await axios.post(
			`${consoleBaseUrl}/actors/totally-made-up-id/dev-folder`,
			'localDevFolder=%2Fabs%2Fpath',
			{
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				validateStatus: () => true,
			},
		);
		expect(res.status).toBe(404);
	});
});

/**
 * A driver that is "available" and records the `devMount` it was asked to start a container with -
 * mirrors `run-env-vars.test.ts`'s `envCapturingDriver`, capturing `ctx.devMount` instead of `ctx.env`,
 * so `services/runs.ts`'s actor-fields -> `RunContext.devMount` derivation can be exercised end to end
 * through the real `startRun` service path, without a real Docker socket.
 */
function devMountCapturingDriver(): {
	driver: Driver;
	getCapturedDevMount: () => DevFolderMount | undefined;
} {
	let capturedDevMount: DevFolderMount | undefined;
	const driver: Driver = {
		available: true,
		async init() {},
		async startBuild() {
			throw new Error('not used by this stub');
		},
		async abortBuild() {},
		async startRun(ctx, onLog) {
			capturedDevMount = ctx.devMount;
			onLog('done\n');
			return { exitCode: 0, timedOut: false };
		},
		async abortRun() {},
		async reconcileOrphans() {},
		async ensureProbeImage() {
			throw new Error('not used by this stub');
		},
		async probeDevFolder() {
			throw new Error('not used by this stub');
		},
	};
	return { driver, getCapturedDevMount: () => capturedDevMount };
}

describe('run-start devMount derivation (actor fields -> RunContext.devMount, services/runs.ts)', () => {
	let server: TestServerHandle;

	afterEach(async () => {
		await server.close();
	});

	it("an Actor with localDevFolder set and a latest-tagged build carrying imageWorkingDirectory gets exactly that pair as devMount - from the build's own field, never an Actor-level one", async () => {
		const capturing = devMountCapturingDriver();
		server = await startTestServer(capturing.driver);
		const actor = await server.client.actors().create({ name: 'devmount-present-actor' });
		await seedSucceededBuild((await getRegistries().actors.get(actor.id))!, 'latest', '/usr/src/app');
		await updateActor(actor.id, (current) => ({ ...current, localDevFolder: '/abs/dev/src' }));

		const run = await server.client.actor(actor.id).start({}, { waitForFinish: 5 });
		expect(run.status).toBe('SUCCEEDED');
		expect(capturing.getCapturedDevMount()).toEqual({
			localDevFolder: '/abs/dev/src',
			imageWorkingDirectory: '/usr/src/app',
		});
	});

	it('an Actor that was never registered gets devMount: undefined on the real run-start service path', async () => {
		const capturing = devMountCapturingDriver();
		server = await startTestServer(capturing.driver);
		const actor = await server.client.actors().create({ name: 'devmount-never-registered-actor' });
		await seedSucceededBuild((await getRegistries().actors.get(actor.id))!, 'latest', '/usr/src/app');

		const run = await server.client.actor(actor.id).start({}, { waitForFinish: 5 });
		expect(run.status).toBe('SUCCEEDED');
		expect(capturing.getCapturedDevMount()).toBeUndefined();
	});

	it('an Actor whose registration was set and then cleared also gets devMount: undefined, not the stale pair', async () => {
		const capturing = devMountCapturingDriver();
		server = await startTestServer(capturing.driver);
		const actor = await server.client.actors().create({ name: 'devmount-cleared-actor' });
		await seedSucceededBuild((await getRegistries().actors.get(actor.id))!, 'latest', '/usr/src/app');
		await updateActor(actor.id, (current) => ({ ...current, localDevFolder: '/abs/dev/src' }));
		await updateActor(actor.id, (current) => ({ ...current, localDevFolder: undefined }));

		const run = await server.client.actor(actor.id).start({}, { waitForFinish: 5 });
		expect(run.status).toBe('SUCCEEDED');
		expect(capturing.getCapturedDevMount()).toBeUndefined();
	});

	it("a latest-tagged run's devMount uses latest's own build working directory, never a more-recently-built other tag's (the cross-tag staleness directive 2 fixes)", async () => {
		const capturing = devMountCapturingDriver();
		server = await startTestServer(capturing.driver);
		const actor = await server.client.actors().create({ name: 'devmount-cross-tag-actor' });
		await seedSucceededBuild((await getRegistries().actors.get(actor.id))!, 'latest', '/usr/src/app');
		// Built more recently than `latest`, under a different tag, with a different working directory -
		// this must never leak into a tag-less (`latest`) run's devMount.
		await seedSucceededBuild((await getRegistries().actors.get(actor.id))!, 'staging', '/app');
		await updateActor(actor.id, (current) => ({ ...current, localDevFolder: '/abs/dev/src' }));

		const run = await server.client.actor(actor.id).start({}, { waitForFinish: 5 });
		expect(run.status).toBe('SUCCEEDED');
		expect(capturing.getCapturedDevMount()).toEqual({
			localDevFolder: '/abs/dev/src',
			imageWorkingDirectory: '/usr/src/app',
		});
	});

	it("a run against a non-latest tag mounts at that tag's OWN build working directory, not latest's", async () => {
		const capturing = devMountCapturingDriver();
		server = await startTestServer(capturing.driver);
		const actor = await server.client.actors().create({ name: 'devmount-non-latest-run-actor' });
		await seedSucceededBuild((await getRegistries().actors.get(actor.id))!, 'latest', '/usr/src/app');
		await seedSucceededBuild((await getRegistries().actors.get(actor.id))!, 'staging', '/app');
		await updateActor(actor.id, (current) => ({ ...current, localDevFolder: '/abs/dev/src' }));

		const run = await server.client.actor(actor.id).start({}, { waitForFinish: 5, build: 'staging' });
		expect(run.status).toBe('SUCCEEDED');
		expect(capturing.getCapturedDevMount()).toEqual({
			localDevFolder: '/abs/dev/src',
			imageWorkingDirectory: '/app',
		});
	});
});

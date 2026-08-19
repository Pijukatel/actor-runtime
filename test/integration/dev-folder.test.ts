/**
 * Integration coverage for the local dev-folder bind-mount feature's non-Docker-dependent surface: the
 * API endpoint's auth/ownership/shape/build-first/probe-classification contract (`api.md`'s
 * `/actor-runtime/*` section), that the registered value never leaks into any `/v2` Actor response, and
 * the console's single-field
 * form (render, submit, clear, redirect, inline error). Every probe outcome is stubbed
 * (`devFolderDriver` below) - there is no Docker daemon in this sandbox (`docker-driver.ts`'s class doc
 * comment); the real-probe accept/reject path and the mount itself are only exercised end-to-end in
 * `test/e2e/dev-folder-bind-mount.test.ts`.
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

/**
 * A `Driver` whose only interesting behaviour is `probeDevFolder`, returning a caller-controlled
 * outcome that can be changed mid-test via `setOutcome` (for the "a prior registration survives a later
 * failed attempt" contract, which needs the same driver to succeed once and then fail). `probeDevFolderCalls`
 * records every `(candidatePath, imageId)` pair it was called with, so a test can assert the probe was -
 * or, for the "clearing never checks" contract, was NOT - invoked at all.
 */
function devFolderDriver(
	initialOutcome: DevFolderProbeOutcome,
	available = true,
): Driver & { probeDevFolderCalls: Array<[string, string]>; setOutcome(next: DevFolderProbeOutcome): void } {
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
		async probeDevFolder(candidatePath: string, imageId: string) {
			probeDevFolderCalls.push([candidatePath, imageId]);
			return outcome;
		},
	};
}

/** A SUCCEEDED build with a fake image, tagged against the actor - the build-first precondition's
 * "happy path" state (mirrors `job-lifecycle.test.ts`'s identical helper). */
async function seedSucceededBuild(actor: ActorRecord, tag = 'latest'): Promise<BuildRecord> {
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
		await seedSucceededBuild((await getRegistries().actors.get(actor.id))!);
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
		await seedSucceededBuild((await getRegistries().actors.get(actor.id))!);
		await post(server.baseUrl, actor.id, JSON.stringify('/abs/existing-path'), server.token);

		const res = await post(server.baseUrl, actor.id, JSON.stringify('   '), server.token);
		expect(res.status).toBe(400);
		// The probe must never be reached either - a whitespace-only body is rejected by the shape check,
		// not treated as a candidate path to verify.
		expect(driver.probeDevFolderCalls).toEqual([['/abs/existing-path', 'fake-image:latest']]);

		// Not a clear: the prior registration survives untouched.
		const stored = await getRegistries().actors.get(actor.id);
		expect(stored?.localDevFolder).toBe('/abs/existing-path');
	});

	it('400s for a relative path, even for an actor with a successful build, and stores nothing', async () => {
		server = await startTestServer(devFolderDriver({ ok: true }));
		const actor = await server.client.actors().create({ name: 'relative-path-actor' });
		await seedSucceededBuild((await getRegistries().actors.get(actor.id))!);

		const res = await post(server.baseUrl, actor.id, JSON.stringify('relative/path'), server.token);
		expect(res.status).toBe(400);
		const stored = await getRegistries().actors.get(actor.id);
		expect(stored?.localDevFolder).toBeUndefined();
	});

	it('400s for a non-empty path when the actor has never had a successful build, and never even calls the probe', async () => {
		const driver = devFolderDriver({ ok: true });
		server = await startTestServer(driver);
		const actor = await server.client.actors().create({ name: 'never-built-actor' });

		const res = await post(server.baseUrl, actor.id, JSON.stringify('/abs/path'), server.token);
		expect(res.status).toBe(400);
		expect(driver.probeDevFolderCalls).toEqual([]);

		const stored = await getRegistries().actors.get(actor.id);
		expect(stored?.localDevFolder).toBeUndefined();
	});

	it('rejects the same way for an actor whose only build attempt failed (no successful build ever)', async () => {
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
		expect(res.status).toBe(400);
	});

	it('rejects the same way for an actor whose only successful build is tagged something other than "latest" - no fallback to an arbitrary other tag', async () => {
		const driver = devFolderDriver({ ok: true });
		server = await startTestServer(driver);
		const actor = await server.client.actors().create({ name: 'non-latest-tag-only-actor' });
		// Mirrors exactly the Actor shape a tag-less `POST /actors/:actorId/runs` would 404 against: a
		// successful build exists, but not tagged `latest`.
		await seedSucceededBuild((await getRegistries().actors.get(actor.id))!, 'staging');

		const res = await post(server.baseUrl, actor.id, JSON.stringify('/abs/path'), server.token);
		expect(res.status).toBe(400);
		expect(res.data.error.type).toBe('dev-folder-not-buildable');
		// The probe must never be reached - there is no image to probe against without a `latest` tag.
		expect(driver.probeDevFolderCalls).toEqual([]);

		const stored = await getRegistries().actors.get(actor.id);
		expect(stored?.localDevFolder).toBeUndefined();
	});

	it('200s and stores the path when the probe reports ok, for an actor with a successful build', async () => {
		const driver = devFolderDriver({ ok: true });
		server = await startTestServer(driver);
		const actor = await server.client.actors().create({ name: 'happy-path-actor' });
		const build = await seedSucceededBuild((await getRegistries().actors.get(actor.id))!);

		const res = await post(server.baseUrl, actor.id, JSON.stringify('/abs/path/to/src'), server.token);
		expect(res.status).toBe(200);
		expect(res.data.data.localDevFolder).toBe('/abs/path/to/src');
		expect(driver.probeDevFolderCalls).toEqual([['/abs/path/to/src', build.imageId]]);

		const stored = await getRegistries().actors.get(actor.id);
		expect(stored?.localDevFolder).toBe('/abs/path/to/src');
	});

	it('the response reports the detected imageWorkingDirectory and whether a mount will apply', async () => {
		server = await startTestServer(devFolderDriver({ ok: true }));
		const actor = await server.client.actors().create({ name: 'status-fields-actor' });
		await seedSucceededBuild((await getRegistries().actors.get(actor.id))!);
		await updateActor(actor.id, (current) => ({ ...current, imageWorkingDirectory: '/usr/src/app' }));

		const res = await post(server.baseUrl, actor.id, JSON.stringify('/abs/path'), server.token);
		expect(res.data.data).toEqual({
			localDevFolder: '/abs/path',
			imageWorkingDirectory: '/usr/src/app',
			mountWillApply: true,
		});
	});

	it('a second registration replaces the first outright, not merges', async () => {
		server = await startTestServer(devFolderDriver({ ok: true }));
		const actor = await server.client.actors().create({ name: 'replace-actor' });
		await seedSucceededBuild((await getRegistries().actors.get(actor.id))!);

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
		await seedSucceededBuild((await getRegistries().actors.get(actorA.id))!);

		await post(server.baseUrl, actorA.id, JSON.stringify('/abs/only-a'), server.token);

		const storedB = await getRegistries().actors.get(actorB.id);
		expect(storedB?.localDevFolder).toBeUndefined();
	});

	it('unrelated Actor writes (e.g. PUT name/title) never touch a previously-registered dev folder', async () => {
		server = await startTestServer(devFolderDriver({ ok: true }));
		const actor = await server.client.actors().create({ name: 'unrelated-write-actor' });
		await seedSucceededBuild((await getRegistries().actors.get(actor.id))!);
		await post(server.baseUrl, actor.id, JSON.stringify('/abs/untouched'), server.token);

		await server.client.actor(actor.id).update({ title: 'a new title' });

		const stored = await getRegistries().actors.get(actor.id);
		expect(stored?.localDevFolder).toBe('/abs/untouched');
	});

	it('200s and clears with the empty JSON string, without the clear itself ever calling the probe', async () => {
		const driver = devFolderDriver({ ok: true });
		server = await startTestServer(driver);
		const actor = await server.client.actors().create({ name: 'clear-actor' });
		await seedSucceededBuild((await getRegistries().actors.get(actor.id))!);
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
		await seedSucceededBuild((await getRegistries().actors.get(actor.id))!);

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
		await seedSucceededBuild((await getRegistries().actors.get(actor.id))!);

		const res = await post(server.baseUrl, actor.id, JSON.stringify('/abs/missing'), server.token);
		expect(res.status).toBe(400);
		expect(res.data.error.message.toLowerCase()).toContain('does not exist');

		const stored = await getRegistries().actors.get(actor.id);
		expect(stored?.localDevFolder).toBeUndefined();
	});

	it('classifies an unreachable probe outcome as 503, distinguishable from "does not exist"', async () => {
		server = await startTestServer(devFolderDriver({ ok: false, reason: 'unreachable' }));
		const actor = await server.client.actors().create({ name: 'unreachable-actor' });
		await seedSucceededBuild((await getRegistries().actors.get(actor.id))!);

		const res = await post(server.baseUrl, actor.id, JSON.stringify('/abs/path'), server.token);
		expect(res.status).toBe(503);
		expect(res.data.error.message.toLowerCase()).not.toContain('does not exist');
	});

	it('classifies an image-missing probe outcome as 500 internal error, distinguishable from "does not exist"', async () => {
		server = await startTestServer(devFolderDriver({ ok: false, reason: 'image-missing' }));
		const actor = await server.client.actors().create({ name: 'image-missing-actor' });
		await seedSucceededBuild((await getRegistries().actors.get(actor.id))!);

		const res = await post(server.baseUrl, actor.id, JSON.stringify('/abs/path'), server.token);
		expect(res.status).toBe(500);
		expect(res.data.error.message.toLowerCase()).not.toContain('does not exist');
	});

	it('classifies an unknown mount-shaped rejection as 400 "could not verify", never "does not exist"', async () => {
		server = await startTestServer(devFolderDriver({ ok: false, reason: 'unknown' }));
		const actor = await server.client.actors().create({ name: 'unknown-reason-actor' });
		await seedSucceededBuild((await getRegistries().actors.get(actor.id))!);

		const res = await post(server.baseUrl, actor.id, JSON.stringify('/abs/path'), server.token);
		expect(res.status).toBe(400);
		expect(res.data.error.message.toLowerCase()).not.toContain('does not exist');
	});

	it('the registered value never appears in any /v2 Actor response (list or get), and modifiedAt does not move either - closing the timestamp side channel, not just the path string', async () => {
		server = await startTestServer(devFolderDriver({ ok: true }));
		const actor = await server.client.actors().create({ name: 'no-leak-actor' });
		await seedSucceededBuild((await getRegistries().actors.get(actor.id))!);
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
		await seedSucceededBuild((await getRegistries().actors.get(actor.id))!);
		const before = (await getRegistries().actors.get(actor.id))!.modifiedAt;

		const res = await post(server.baseUrl, actor.id, JSON.stringify('/abs/path'), server.token);
		expect(res.status).toBe(200);

		const after = (await getRegistries().actors.get(actor.id))!.modifiedAt;
		expect(after).toBe(before);
	});

	it("clearing a previously-registered dev folder never bumps the Actor's modifiedAt", async () => {
		server = await startTestServer(devFolderDriver({ ok: true }));
		const actor = await server.client.actors().create({ name: 'modifiedat-clear-actor' });
		await seedSucceededBuild((await getRegistries().actors.get(actor.id))!);
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

	it('renders the three status rows and the form for an Actor with no registration yet', async () => {
		await setUpConsole(devFolderDriver({ ok: true }));
		const actor = await server.client.actors().create({ name: 'devfolder-render-actor' });

		const detail = await axios.get(`${consoleBaseUrl}/actors/${actor.id}`);
		expect(detail.status).toBe(200);
		expect(detail.data).toContain('(none registered)');
		expect(detail.data).toContain('not yet detected');
		expect(detail.data).toContain('mount will apply on the next run');
		expect(detail.data).toContain(`<form method="post" action="/actors/${actor.id}/dev-folder">`);
	});

	it('submitting the form registers the path and redirects back to the detail page, which then shows it', async () => {
		const consoleDriver = devFolderDriver({ ok: true });
		await setUpConsole(consoleDriver);
		const actor = await server.client.actors().create({ name: 'devfolder-submit-actor' });
		await seedSucceededBuild((await getRegistries().actors.get(actor.id))!);

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

	it('submitting an empty value clears a previously-registered path', async () => {
		await setUpConsole(devFolderDriver({ ok: true }));
		const actor = await server.client.actors().create({ name: 'devfolder-clear-actor' });
		await seedSucceededBuild((await getRegistries().actors.get(actor.id))!);
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
		await seedSucceededBuild((await getRegistries().actors.get(actor.id))!);
		await updateActor(actor.id, (current) => ({ ...current, localDevFolder: '/abs/existing-path' }));

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
		await seedSucceededBuild((await getRegistries().actors.get(actor.id))!);
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

	it('a rejected submission (no successful build) redirects with the classified error surfaced inline, not swallowed', async () => {
		await setUpConsole(devFolderDriver({ ok: true }));
		const actor = await server.client.actors().create({ name: 'devfolder-error-actor' });

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
		expect(submit.headers.location).toContain('devFolderError=');

		const detail = await axios.get(`${consoleBaseUrl}${submit.headers.location}`);
		expect(detail.status).toBe(200);
		expect(detail.data).toContain('Error');
		expect(detail.data.toLowerCase()).toContain('no build tagged');

		// The rejected submission stored nothing.
		const stored = await getRegistries().actors.get(actor.id);
		expect(stored?.localDevFolder).toBeUndefined();
	});

	it('the does-not-exist vs. could-not-verify distinction is surfaced on the console too, not collapsed', async () => {
		const consoleDriver = devFolderDriver({ ok: false, reason: 'not-found' });
		await setUpConsole(consoleDriver);
		const actor = await server.client.actors().create({ name: 'devfolder-not-found-console-actor' });
		await seedSucceededBuild((await getRegistries().actors.get(actor.id))!);

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
function devMountCapturingDriver(): { driver: Driver; getCapturedDevMount: () => DevFolderMount | undefined } {
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

	it('an Actor with both localDevFolder and imageWorkingDirectory set gets exactly that pair as devMount on the real run-start service path', async () => {
		const capturing = devMountCapturingDriver();
		server = await startTestServer(capturing.driver);
		const actor = await server.client.actors().create({ name: 'devmount-present-actor' });
		await seedSucceededBuild((await getRegistries().actors.get(actor.id))!);
		await updateActor(actor.id, (current) => ({
			...current,
			localDevFolder: '/abs/dev/src',
			imageWorkingDirectory: '/usr/src/app',
		}));

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
		await seedSucceededBuild((await getRegistries().actors.get(actor.id))!);

		const run = await server.client.actor(actor.id).start({}, { waitForFinish: 5 });
		expect(run.status).toBe('SUCCEEDED');
		expect(capturing.getCapturedDevMount()).toBeUndefined();
	});

	it('an Actor whose registration was set and then cleared also gets devMount: undefined, not the stale pair', async () => {
		const capturing = devMountCapturingDriver();
		server = await startTestServer(capturing.driver);
		const actor = await server.client.actors().create({ name: 'devmount-cleared-actor' });
		await seedSucceededBuild((await getRegistries().actors.get(actor.id))!);
		await updateActor(actor.id, (current) => ({
			...current,
			localDevFolder: '/abs/dev/src',
			imageWorkingDirectory: '/usr/src/app',
		}));
		await updateActor(actor.id, (current) => ({ ...current, localDevFolder: undefined }));

		const run = await server.client.actor(actor.id).start({}, { waitForFinish: 5 });
		expect(run.status).toBe('SUCCEEDED');
		expect(capturing.getCapturedDevMount()).toBeUndefined();
	});
});

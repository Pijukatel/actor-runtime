/**
 * Criterion-12, made real: with per-token multi-user (`services/users.ts: getOrCreateUserForToken`)
 * every resource is genuinely owned by the requesting token's user, and every list/get is genuinely
 * filtered by that ownership - not just structurally (the filter always existed) but *actually*, since
 * two different tokens now resolve to two different users instead of the same single bootstrap one.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApifyClient } from 'apify-client';

import { startTestServer, type TestServerHandle } from './helpers/test-server.js';

describe('cross-user isolation', () => {
	let server: TestServerHandle;
	let clientA: ApifyClient;
	let clientB: ApifyClient;

	beforeEach(async () => {
		server = await startTestServer();
		clientA = server.client;
		clientB = new ApifyClient({ baseUrl: server.baseUrl, token: 'user-b-token', maxRetries: 0 });
	});

	afterEach(async () => {
		await server.close();
	});

	it("token A cannot see token B's actor by id, and vice versa", async () => {
		const actorA = await clientA.actors().create({ name: 'isolation-actor-a' });
		const actorB = await clientB.actors().create({ name: 'isolation-actor-b' });

		expect(await clientB.actor(actorA.id).get()).toBeUndefined();
		expect(await clientA.actor(actorB.id).get()).toBeUndefined();

		expect((await clientA.actor(actorA.id).get())?.id).toBe(actorA.id);
		expect((await clientB.actor(actorB.id).get())?.id).toBe(actorB.id);
	});

	it("token A's actor list never contains token B's actors", async () => {
		await clientA.actors().create({ name: 'isolation-list-a-1' });
		await clientA.actors().create({ name: 'isolation-list-a-2' });
		await clientB.actors().create({ name: 'isolation-list-b-1' });

		const { items: actorsA } = await clientA.actors().list();
		const { items: actorsB } = await clientB.actors().list();

		expect(actorsA.map((a) => a.name).sort()).toEqual(['isolation-list-a-1', 'isolation-list-a-2']);
		expect(actorsB.map((a) => a.name)).toEqual(['isolation-list-b-1']);
	});

	it("token A cannot see or list token B's storages (datasets, key-value stores, request queues)", async () => {
		const datasetA = await clientA.datasets().getOrCreate('isolation-dataset-a');
		const datasetB = await clientB.datasets().getOrCreate('isolation-dataset-b');
		const kvA = await clientA.keyValueStores().getOrCreate('isolation-kv-a');
		const kvB = await clientB.keyValueStores().getOrCreate('isolation-kv-b');
		const rqA = await clientA.requestQueues().getOrCreate('isolation-rq-a');
		const rqB = await clientB.requestQueues().getOrCreate('isolation-rq-b');

		expect(await clientB.dataset(datasetA.id).get()).toBeUndefined();
		expect(await clientA.dataset(datasetB.id).get()).toBeUndefined();
		expect(await clientB.keyValueStore(kvA.id).get()).toBeUndefined();
		expect(await clientA.keyValueStore(kvB.id).get()).toBeUndefined();
		expect(await clientB.requestQueue(rqA.id).get()).toBeUndefined();
		expect(await clientA.requestQueue(rqB.id).get()).toBeUndefined();

		const { items: datasetsA } = await clientA.datasets().list();
		expect(datasetsA.map((d) => d.id)).toEqual([datasetA.id]);
		const { items: datasetsB } = await clientB.datasets().list();
		expect(datasetsB.map((d) => d.id)).toEqual([datasetB.id]);
	});

	it("token B cannot list token A's actor's runs (even though both actors share a name)", async () => {
		const actorA = await clientA.actors().create({ name: 'isolation-run-actor' });
		const actorB = await clientB.actors().create({ name: 'isolation-run-actor' });
		expect(actorA.id).not.toBe(actorB.id);

		// B addressing A's actor id 404s (unowned) - the real client surfaces this as a rejected list()
		// call, not an empty page, since the actor itself can't be resolved for B's token.
		await expect(clientB.actor(actorA.id).runs().list()).rejects.toThrow();
		// A addressing its own actor still works fine.
		await expect(clientA.actor(actorA.id).runs().list()).resolves.toMatchObject({ items: [] });
	});

	it("GET /users/me returns each token's own user, never the other token's", async () => {
		const userA = await clientA.user('me').get();
		const userB = await clientB.user('me').get();
		expect(userA.id).not.toBe(userB.id);

		// A's actor is genuinely owned by A's own user id, not some shared bootstrap id.
		const actorA = await clientA.actors().create({ name: 'isolation-owner-check' });
		expect(actorA.userId).toBe(userA.id);
	});
});

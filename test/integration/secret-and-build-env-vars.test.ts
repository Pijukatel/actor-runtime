import { privateDecrypt, publicEncrypt } from '@apify/utilities';
import { ApifyApiError } from 'apify-client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createPrivateKey, createPublicKey } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { startTestServer, type TestServerHandle } from './helpers/test-server.js';
import type { BuildContext, Driver } from '../../src/driver/types.js';
import { getRegistries } from '../../src/storage/registries.js';
import { decryptedEnvVars } from '../../src/services/secrets.js';

/** Records what the builds and runs were handed, so env vars can be checked end to end without Docker. */
function capturingDriver() {
	const captured: { build?: BuildContext; runEnv?: Record<string, string> } = {};
	const notUsed = async (): Promise<never> => {
		throw new Error('not used by this stub');
	};
	const driver: Driver = {
		available: true,
		unavailableReason: undefined,
		async init() {},
		async startBuild(ctx, onLog) {
			captured.build = ctx;
			onLog('build ok\n');
			return { imageId: 'fake-image:test' };
		},
		async abortBuild() {},
		async startRun(ctx, onLog) {
			captured.runEnv = ctx.env;
			onLog('done\n');
			return { exitCode: 0 };
		},
		async abortRun() {},
		async reconcileOrphans() {},
		probeDevFolder: notUsed,
		ensureProbeImage: notUsed,
		startBrowserViewer: notUsed,
		async stopBrowserViewer() {},
		async containerServerAddress() {
			return undefined;
		},
		inspectDebugTarget: notUsed,
	};
	return { driver, captured };
}

const ENV_VARS = [
	{ name: 'PLAIN_VAR', value: 'plain-value' },
	{ name: 'SECRET_VAR', value: 'secret-value', isSecret: true },
];

describe('secret and build-time environment variables', () => {
	let server: TestServerHandle;
	let captured: ReturnType<typeof capturingDriver>['captured'];

	beforeEach(async () => {
		const stub = capturingDriver();
		captured = stub.captured;
		server = await startTestServer(stub.driver);
	});

	afterEach(async () => {
		await server.close();
	});

	async function createActorWithVersion(name: string, version: Record<string, unknown> = {}) {
		const actor = await server.client.actors().create({ name });
		await server.client
			.actor(actor.id)
			.versions()
			.create({
				versionNumber: '0.0',
				buildTag: 'latest',
				sourceType: 'SOURCE_FILES',
				sourceFiles: [],
				envVars: ENV_VARS,
				...version,
			} as never);
		return actor;
	}

	it('hides a secret value from every version response, with a stable valueHash', async () => {
		const actor = await createActorWithVersion('secret-hidden');
		const versionClient = server.client.actor(actor.id).version('0.0');

		const fromGet = await versionClient.get();
		expect(fromGet?.envVars?.[0]).toEqual({ name: 'PLAIN_VAR', value: 'plain-value' });
		expect(fromGet?.envVars?.[1]).toEqual({
			name: 'SECRET_VAR',
			isSecret: true,
			valueHash: expect.stringMatching(/^.{6}$/),
		});

		const fromActor = await server.client.actor(actor.id).get();
		expect(JSON.stringify(fromActor)).not.toContain('secret-value');
		const fromList = await server.client.actor(actor.id).versions().list();
		expect(JSON.stringify(fromList)).not.toContain('secret-value');

		const updated = await versionClient.update({ buildTag: 'beta' });
		expect(updated.envVars?.[1]).toEqual(fromGet?.envVars?.[1]);

		const changed = await versionClient.update({
			envVars: [{ name: 'SECRET_VAR', value: 'another-secret', isSecret: true }],
		});
		expect(changed.envVars?.[0]?.valueHash).not.toBe(fromGet?.envVars?.[1]?.valueHash);
	});

	it("stores a secret encrypted with its own Actor's key pair, never in plain text", async () => {
		const first = await createActorWithVersion('secret-encrypted-first');
		const second = await createActorWithVersion('secret-encrypted-second');
		const plainOnly = await server.client.actors().create({
			name: 'no-secrets',
			versions: [{ versionNumber: '0.0', sourceType: 'SOURCE_FILES', envVars: [ENV_VARS[0]] }],
		} as never);

		const { actors } = getRegistries();
		const [firstRecord, secondRecord, plainRecord] = await Promise.all(
			[first.id, second.id, plainOnly.id].map((id) => actors.get(id)),
		);
		const stored = firstRecord!.versions[0]!.envVars!;
		expect(stored[0]).toEqual(ENV_VARS[0]);
		expect(stored[1]!.value).not.toBe('secret-value');
		expect(stored[1]!.encryptedAes256Password).toEqual(expect.any(String));
		expect(firstRecord!.secretKeys!.publicKey).toContain('BEGIN PUBLIC KEY');
		expect(secondRecord!.secretKeys!.privateKey).not.toBe(firstRecord!.secretKeys!.privateKey);
		expect(plainRecord!.secretKeys).toBeUndefined();

		expect(decryptedEnvVars(firstRecord!, stored)[1]!.value).toBe('secret-value');
		// Another Actor's key, or a sealed value moved to another Actor, does not decrypt it.
		expect(() => decryptedEnvVars({ ...firstRecord!, secretKeys: secondRecord!.secretKeys }, stored)).toThrow();
		expect(() => decryptedEnvVars({ ...secondRecord!, id: second.id }, stored)).toThrow();

		const files = await readdir(server.dataDir, { recursive: true, withFileTypes: true });
		const contents = await Promise.all(
			files
				.filter((entry) => entry.isFile())
				.map((entry) => readFile(path.join(entry.parentPath, entry.name), 'utf8')),
		);
		// The plain var is found where the secret is not, so the scan does read the stored Actors.
		expect(contents.some((content) => content.includes('plain-value'))).toBe(true);
		expect(contents.some((content) => content.includes('secret-value'))).toBe(false);

		const fromApi = JSON.stringify(await server.client.actor(first.id).get());
		expect(fromApi).not.toContain(stored[1]!.encryptedAes256Password!);
		expect(fromApi).not.toContain('PRIVATE KEY');
	});

	it("gives every run its own Actor's private key, the way the Apify SDKs read it for input secrets", async () => {
		const actor = await server.client.actors().create({
			name: 'input-secrets-key',
			versions: [{ versionNumber: '0.0', sourceType: 'SOURCE_FILES', sourceFiles: [] }],
		} as never);
		await server.client.actor(actor.id).build('0.0', { waitForFinish: 5 });
		const modifiedAt = (await server.client.actor(actor.id).get())!.modifiedAt;
		await server.client.actor(actor.id).start({}, { waitForFinish: 5 });

		const secretKeys = (await getRegistries().actors.get(actor.id))!.secretKeys!;
		const env = captured.runEnv!;
		// What `Actor.getInput()` does with the two vars (apify-sdk-js `actor.ts`).
		const privateKey = createPrivateKey({
			key: Buffer.from(env.APIFY_INPUT_SECRETS_PRIVATE_KEY_FILE!, 'base64'),
			passphrase: env.APIFY_INPUT_SECRETS_PRIVATE_KEY_PASSPHRASE!,
		});
		const sealed = publicEncrypt({ publicKey: createPublicKey(secretKeys.publicKey), value: 'input-secret' });
		expect(privateDecrypt({ privateKey, ...sealed })).toBe('input-secret');

		// Created for the run without counting as a change to the Actor, so `apify push` is unaffected.
		expect((await server.client.actor(actor.id).get())!.modifiedAt).toEqual(modifiedAt);
		await server.client.actor(actor.id).start({}, { waitForFinish: 5 });
		expect(captured.runEnv!.APIFY_INPUT_SECRETS_PRIVATE_KEY_FILE).toBe(env.APIFY_INPUT_SECRETS_PRIVATE_KEY_FILE);
	});

	it('a version cannot override the input secrets key vars', async () => {
		const actor = await createActorWithVersion('input-secrets-key-override', {
			envVars: [{ name: 'APIFY_INPUT_SECRETS_PRIVATE_KEY_PASSPHRASE', value: 'mine' }],
		});
		await server.client.actor(actor.id).build('0.0', { waitForFinish: 5 });
		await server.client.actor(actor.id).start({}, { waitForFinish: 5 });
		const { passphrase } = (await getRegistries().actors.get(actor.id))!.secretKeys!;
		expect(captured.runEnv!.APIFY_INPUT_SECRETS_PRIVATE_KEY_PASSPHRASE).toBe(passphrase);
	});

	it('passes secret values into the run container', async () => {
		const actor = await createActorWithVersion('secret-in-run');
		await server.client.actor(actor.id).build('0.0', { waitForFinish: 5 });
		const run = await server.client.actor(actor.id).start({}, { waitForFinish: 5 });

		expect(run.status).toBe('SUCCEEDED');
		expect(captured.runEnv?.PLAIN_VAR).toBe('plain-value');
		expect(captured.runEnv?.SECRET_VAR).toBe('secret-value');
	});

	it('passes env vars, secrets included, to the build only when applyEnvVarsToBuild is on', async () => {
		const actor = await createActorWithVersion('build-args-off');
		await server.client.actor(actor.id).build('0.0', { waitForFinish: 5 });
		expect(captured.build?.buildArgs).toBeUndefined();

		await server.client.actor(actor.id).version('0.0').update({ applyEnvVarsToBuild: true });
		const build = await server.client.actor(actor.id).build('0.0', { waitForFinish: 5 });

		expect(build.status).toBe('SUCCEEDED');
		expect(captured.build?.buildArgs).toEqual({ PLAIN_VAR: 'plain-value', SECRET_VAR: 'secret-value' });
		const log = await server.client.build(build.id).log().get();
		expect(log).toContain('PLAIN_VAR, SECRET_VAR');
		expect(log).not.toContain('secret-value');
		expect((await server.client.actor(actor.id).version('0.0').get())?.applyEnvVarsToBuild).toBe(true);
	});

	it('accepts env vars and applyEnvVarsToBuild on Actor create', async () => {
		const actor = await server.client.actors().create({
			name: 'env-vars-on-create',
			versions: [
				{
					versionNumber: '0.0',
					buildTag: 'latest',
					sourceType: 'SOURCE_FILES',
					sourceFiles: [],
					envVars: ENV_VARS,
					applyEnvVarsToBuild: true,
				},
			],
		} as never);

		expect(JSON.stringify(actor)).not.toContain('secret-value');
		await server.client.actor(actor.id).build('0.0', { waitForFinish: 5 });
		expect(captured.build?.buildArgs?.SECRET_VAR).toBe('secret-value');
	});

	it('rejects a malformed env var', async () => {
		const actor = await server.client.actors().create({ name: 'env-var-invalid' });
		const create = server.client
			.actor(actor.id)
			.versions()
			.create({
				versionNumber: '0.0',
				sourceType: 'SOURCE_FILES',
				envVars: [{ name: 'A=B', value: 'x' }],
			} as never);

		await expect(create).rejects.toMatchObject({ statusCode: 400, type: 'schema-validation' });
	});

	describe('env-vars endpoints', () => {
		it('lists, creates, gets, updates and deletes env vars, hiding secret values', async () => {
			const actor = await createActorWithVersion('env-vars-endpoints');
			const envVars = server.client.actor(actor.id).version('0.0').envVars();

			const list = await envVars.list();
			expect(list.total).toBe(2);
			expect(list.items).toEqual([ENV_VARS[0], { name: 'SECRET_VAR', isSecret: true }]);

			const created = await envVars.create({ name: 'NEW_SECRET', value: 'new-secret', isSecret: true });
			expect(created).toEqual({ name: 'NEW_SECRET', isSecret: true });
			await expect(envVars.create({ name: 'NEW_SECRET', value: 'again' })).rejects.toMatchObject({
				statusCode: 403,
				type: 'env-var-already-exists',
			});

			const envVar = server.client.actor(actor.id).version('0.0').envVar('NEW_SECRET');
			expect(await envVar.get()).toEqual({ name: 'NEW_SECRET', isSecret: true });

			const renamed = await envVar.update({ name: 'RENAMED', value: 'now-plain', isSecret: false });
			expect(renamed).toEqual({ name: 'RENAMED', value: 'now-plain', isSecret: false });
			await expect(
				server.client
					.actor(actor.id)
					.version('0.0')
					.envVar('RENAMED')
					.update({ name: 'PLAIN_VAR', value: 'x' }),
			).rejects.toMatchObject({ statusCode: 403, type: 'cannot-rename-env-var' });

			await server.client.actor(actor.id).version('0.0').envVar('PLAIN_VAR').delete();
			expect(await server.client.actor(actor.id).version('0.0').envVar('PLAIN_VAR').get()).toBeUndefined();

			await server.client.actor(actor.id).build('0.0', { waitForFinish: 5 });
			await server.client.actor(actor.id).start({}, { waitForFinish: 5 });
			expect(captured.runEnv?.RENAMED).toBe('now-plain');
			expect(captured.runEnv?.SECRET_VAR).toBe('secret-value');
			expect(captured.runEnv).not.toHaveProperty('PLAIN_VAR');
		});

		it('404s a missing env var', async () => {
			const actor = await createActorWithVersion('env-var-missing');
			const error = await server.client
				.actor(actor.id)
				.version('0.0')
				.envVar('NOPE')
				.update({ name: 'NOPE', value: 'x' })
				.catch((e: unknown) => e);
			expect(error).toBeInstanceOf(ApifyApiError);
			expect(error).toMatchObject({ statusCode: 404, type: 'record-not-found' });
		});
	});
});

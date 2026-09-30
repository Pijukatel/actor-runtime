import { createPrivateKey, createPublicKey, generateKeyPair, randomBytes } from 'node:crypto';
import { promisify } from 'node:util';

import { encryptInputSecrets, getInputSchemaSecretFieldKeys } from '@apify/input_secrets';
import { privateDecrypt, publicEncrypt } from '@apify/utilities';

import type { ActorEnvVarRecord, ActorRecord, ActorSecretKeys, InputSchema } from '../storage/entities.js';
import type { ActorInput } from './input-schema.js';
import { getRegistries } from '../storage/registries.js';

/**
 * A simplified take on the platform's secrets (`actor-driver.md`): each Actor gets its own RSA key pair,
 * kept on the Actor record, instead of the platform's managed one. The scheme itself is the platform's
 * (`@apify/utilities`' `publicEncrypt`), so the private key is exactly what the Apify SDKs expect in
 * `APIFY_INPUT_SECRETS_PRIVATE_KEY_FILE`/`_PASSPHRASE`. As on the platform, a sealed env var carries its
 * Actor id and name, so it does not decrypt under another Actor or name.
 */

const generateKeyPairAsync = promisify(generateKeyPair);

/** Asynchronous: an RSA key takes tens of milliseconds to generate, which would otherwise stall the API. */
export async function generateSecretKeys(): Promise<ActorSecretKeys> {
	const passphrase = randomBytes(32).toString('hex');
	const { publicKey, privateKey } = await generateKeyPairAsync('rsa', {
		modulusLength: 2048,
		publicKeyEncoding: { type: 'spki', format: 'pem' },
		privateKeyEncoding: { type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase },
	});
	return { publicKey, privateKey, passphrase };
}

function needsSealing(envVar: ActorEnvVarRecord): boolean {
	return envVar.isSecret === true && envVar.encryptedAes256Password === undefined;
}

/**
 * Encrypts every secret env var not encrypted yet. Every Actor write goes through this, so a secret is
 * never stored in plain text, whichever route set it; the Actor already has its key pair by then
 * (`services/actors.ts`).
 */
export function sealActorSecrets(actor: ActorRecord): ActorRecord {
	if (!actor.versions.some((version) => version.envVars?.some(needsSealing))) return actor;
	const { secretKeys } = actor;
	if (!secretKeys) throw new Error(`Actor ${actor.id} has no key pair to encrypt its secrets with`);
	const seal = (envVar: ActorEnvVarRecord): ActorEnvVarRecord => {
		if (!needsSealing(envVar)) return envVar;
		const { encryptedValue, encryptedPassword } = publicEncrypt({
			publicKey: createPublicKey(secretKeys.publicKey),
			value: JSON.stringify({ actId: actor.id, name: envVar.name, value: envVar.value }),
		});
		return { ...envVar, value: encryptedValue, encryptedAes256Password: encryptedPassword };
	};
	return {
		...actor,
		versions: actor.versions.map((version) =>
			version.envVars?.some(needsSealing) ? { ...version, envVars: version.envVars.map(seal) } : version,
		),
	};
}

/**
 * The Actor with its key pair, creating one for an Actor stored before Actors got one on creation.
 * Written straight to the registry, not through `updateActor`: a key pair is not a change to the Actor,
 * so it must not bump `modifiedAt` (which would make the next `apify push` ask for `--force`).
 */
export async function ensureSecretKeys(actor: ActorRecord): Promise<ActorRecord> {
	if (actor.secretKeys) return actor;
	const secretKeys = await generateSecretKeys();
	const updated = await getRegistries().actors.update(actor.id, (current) =>
		current && !current.secretKeys ? { ...current, secretKeys } : current,
	);
	return updated ?? actor;
}

/**
 * The run's input with every `isSecret` field of `inputSchema` encrypted with the Actor's public key, as
 * the platform stores it; the SDKs' `getInput()` decrypts it with `inputSecretsEnv`. A value that is
 * already encrypted stays as it is. `input` is the validated input, so its body is JSON.
 */
export async function sealInputSecrets(
	actor: ActorRecord,
	inputSchema: InputSchema | undefined,
	input: ActorInput | undefined,
): Promise<ActorInput | undefined> {
	if (!input || !inputSchema || getInputSchemaSecretFieldKeys(inputSchema).length === 0) return input;
	const { secretKeys } = await ensureSecretKeys(actor);
	// Failing the run is better than writing the secret out in plain text.
	if (!secretKeys) throw new Error(`Actor ${actor.id} has no key pair to encrypt its secret input with`);
	const encrypted = encryptInputSecrets({
		input: JSON.parse(input.body.toString('utf8')) as Record<string, unknown>,
		inputSchema,
		publicKey: createPublicKey(secretKeys.publicKey),
	});
	return { ...input, body: Buffer.from(JSON.stringify(encrypted), 'utf8') };
}

/** The two env vars the Apify SDKs read to decrypt secret input fields. */
export function inputSecretsEnv(secretKeys: ActorSecretKeys): Record<string, string> {
	return {
		APIFY_INPUT_SECRETS_PRIVATE_KEY_FILE: Buffer.from(secretKeys.privateKey).toString('base64'),
		APIFY_INPUT_SECRETS_PRIVATE_KEY_PASSPHRASE: secretKeys.passphrase,
	};
}

/** The env vars with every secret decrypted, for a build or run of `actor` - the only place a secret's
 * plain value exists again. */
export function decryptedEnvVars(actor: ActorRecord, envVars: ActorEnvVarRecord[] | undefined): ActorEnvVarRecord[] {
	const sealed = (envVars ?? []).filter((envVar) => envVar.isSecret && envVar.encryptedAes256Password);
	if (sealed.length === 0) return envVars ?? [];
	if (!actor.secretKeys) throw new Error(`Actor ${actor.id} has an encrypted secret but no key pair`);
	const privateKey = createPrivateKey({ key: actor.secretKeys.privateKey, passphrase: actor.secretKeys.passphrase });
	return (envVars ?? []).map((envVar) => {
		if (!sealed.includes(envVar)) return envVar;
		const opened = JSON.parse(
			privateDecrypt({
				privateKey,
				encryptedPassword: envVar.encryptedAes256Password!,
				encryptedValue: envVar.value,
			}),
		) as { actId?: string; name?: string; value?: string };
		if (opened.actId !== actor.id || opened.name !== envVar.name || typeof opened.value !== 'string') {
			throw new Error(`Secret env var "${envVar.name}" was not encrypted for Actor ${actor.id}`);
		}
		return { name: envVar.name, value: opened.value, isSecret: true };
	});
}

/**
 * Monorepo Actors (`actor-driver.md`'s "Monorepo Actors"): `PUT /actor-runtime/source-context/...` and the
 * build it feeds. The driver is stubbed, so what is checked is the build context handed to Docker - the
 * Dockerfile path, the files, the build argument - not a real image.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import axios from 'axios';
import { gzipSync } from 'node:zlib';
import * as tar from 'tar-stream';

import { fixedBuildOutcomeDriver, startTestServer, type TestServerHandle } from './helpers/test-server.js';
import { getRegistries } from '../../src/storage/registries.js';
import type { SourceFile } from '../../src/storage/entities.js';

/** The `.tar.gz` `apify push` sends: every file of the context, named relative to the context root. */
async function tarball(files: SourceFile[]): Promise<Buffer> {
	const pack = tar.pack();
	const chunks: Buffer[] = [];
	pack.on('data', (chunk: Buffer) => chunks.push(chunk));
	const done = new Promise<void>((resolve) => pack.once('end', resolve));
	for (const file of files) pack.entry({ name: file.name }, Buffer.from(file.content, 'utf8'));
	pack.finalize();
	await done;
	return gzipSync(Buffer.concat(chunks));
}

const ACTOR_PATH = 'actors/typescript-actor';

/** The layout of `apify/actor-monorepo-example`: the Dockerfile and input schema are shared by every Actor. */
const MONOREPO_FILES: SourceFile[] = [
	{ name: 'package.json', format: 'TEXT', content: '{"workspaces":["actors/**","packages/**"]}' },
	{
		name: 'shared/TypeScript_Dockerfile',
		format: 'TEXT',
		content: 'FROM apify/actor-node:20\nARG ACTOR_PATH_IN_DOCKER_CONTEXT\nCOPY . ./\n',
	},
	{
		name: 'shared/input_schema.json',
		format: 'TEXT',
		content: JSON.stringify({ title: 'Input', type: 'object', schemaVersion: 1, properties: {} }),
	},
	{ name: 'packages/typescript-utils/src/index.ts', format: 'TEXT', content: 'export const x = 1;\n' },
	{
		name: `${ACTOR_PATH}/.actor/actor.json`,
		format: 'TEXT',
		content: JSON.stringify({
			actorSpecification: 1,
			name: 'example-monorepo-actor-typescript',
			version: '0.0',
			dockerContextDir: '../../..',
			dockerfile: '../../../shared/TypeScript_Dockerfile',
			input: '../../../shared/input_schema.json',
		}),
	},
	{ name: `${ACTOR_PATH}/src/index.ts`, format: 'TEXT', content: 'console.log(1);\n' },
];

describe('monorepo source context', () => {
	let server: TestServerHandle;
	let driver: ReturnType<typeof fixedBuildOutcomeDriver>;

	beforeEach(async () => {
		driver = fixedBuildOutcomeDriver({ imageId: 'built-image:latest' });
		server = await startTestServer(driver);
	});

	afterEach(async () => {
		await server.close();
	});

	async function createActor(name = 'monorepo-actor'): Promise<string> {
		const actor = await server.client.actors().create({
			name,
			versions: [
				{ versionNumber: '0.0', buildTag: 'latest', sourceType: 'SOURCE_FILES', sourceFiles: [] } as never,
			],
		});
		return actor.id;
	}

	interface ContextUpload {
		actorPath?: string;
		/** Packed into the `.tar.gz` body; a `Buffer` is sent as the body as it is. */
		sourceFiles: SourceFile[] | Buffer;
		git?: { remoteUrl?: string; branch?: string; commit?: string; dirty?: string };
	}

	async function putContext(actorId: string, upload: ContextUpload, versionNumber = '0.0') {
		const params = new URLSearchParams();
		if (upload.actorPath !== undefined) params.set('actorPath', upload.actorPath);
		if (upload.git?.remoteUrl) params.set('gitRemoteUrl', upload.git.remoteUrl);
		if (upload.git?.branch) params.set('gitBranch', upload.git.branch);
		if (upload.git?.commit) params.set('gitCommit', upload.git.commit);
		if (upload.git?.dirty !== undefined) params.set('gitDirty', upload.git.dirty);
		const body = Buffer.isBuffer(upload.sourceFiles) ? upload.sourceFiles : await tarball(upload.sourceFiles);
		return axios.put(
			`${server.baseUrl}/v2/actor-runtime/source-context/${actorId}/${versionNumber}?${params.toString()}`,
			body,
			{
				headers: { Authorization: `Bearer ${server.token}`, 'Content-Type': 'application/gzip' },
				validateStatus: () => true,
			},
		);
	}

	it('builds the Actor from the context, with the Dockerfile and schema it names outside its folder', async () => {
		const actorId = await createActor();
		const git = { remoteUrl: 'git@github.com:acme/monorepo.git', branch: 'main', commit: 'abcdef1234567890' };
		const res = await putContext(actorId, {
			actorPath: `./${ACTOR_PATH}/`,
			sourceFiles: MONOREPO_FILES,
			git: { ...git, dirty: 'false' },
		});

		expect(res.status).toBe(200);
		expect(res.data.data).toMatchObject({
			versionNumber: '0.0',
			localSourceContext: {
				actorPath: ACTOR_PATH,
				fileCount: MONOREPO_FILES.length,
				git: { ...git, dirty: false },
			},
		});
		expect(res.data.data.localSourceContext.fileId).toBeUndefined();

		const build = await server.client.actor(actorId).build('0.0', { waitForFinish: 10 });
		expect(build.status).toBe('SUCCEEDED');

		const [ctx] = driver.startBuildContexts;
		expect(ctx.dockerfilePath).toBe('shared/TypeScript_Dockerfile');
		expect(ctx.buildArgs).toEqual({ ACTOR_PATH_IN_DOCKER_CONTEXT: ACTOR_PATH });
		expect(ctx.sourceFiles.map((file) => file.name)).toEqual(
			expect.arrayContaining(['package.json', 'packages/typescript-utils/src/index.ts']),
		);
		// Short `FROM` names are still qualified, in the context's Dockerfile.
		expect(ctx.sourceFiles.find((file) => file.name === 'shared/TypeScript_Dockerfile')?.content).toContain(
			'FROM docker.io/apify/actor-node:20',
		);

		expect((await getRegistries().builds.get(build.id))?.inputSchema).toMatchObject({ title: 'Input' });
		const log = await server.client.log(build.id).get();
		expect(log).toContain(`Building "${ACTOR_PATH}" from a Docker context of ${MONOREPO_FILES.length} files`);
		expect(log).toContain('branch main, commit abcdef123456');
	});

	it('keeps the context off /v2, and drops it when sourceFiles replace the source', async () => {
		const actorId = await createActor();
		expect((await putContext(actorId, { actorPath: ACTOR_PATH, sourceFiles: MONOREPO_FILES })).status).toBe(200);
		const { fileId } = (await getRegistries().actors.get(actorId))!.versions[0].localSourceContext!;

		const version = await server.client.actor(actorId).version('0.0').get();
		expect(version).not.toHaveProperty('localSourceContext');
		expect(version?.sourceType).toBe('SOURCE_FILES');
		const actor = await server.client.actor(actorId).get();
		expect(actor?.versions[0]).not.toHaveProperty('localSourceContext');

		// A build tag change alone keeps the context...
		await server.client
			.actor(actorId)
			.version('0.0')
			.update({ buildTag: 'beta' } as never);
		expect((await getRegistries().actors.get(actorId))!.versions[0].localSourceContext?.fileId).toBe(fileId);

		// ...an ordinary push replaces it, and its stored files go with it.
		const plainFiles = [
			{ name: '.actor/actor.json', format: 'TEXT', content: '{"actorSpecification":1,"name":"a"}' },
			{ name: 'Dockerfile', format: 'TEXT', content: 'FROM node:20\n' },
		];
		await server.client
			.actor(actorId)
			.version('0.0')
			.update({ sourceFiles: plainFiles } as never);
		expect((await getRegistries().actors.get(actorId))!.versions[0].localSourceContext).toBeUndefined();
		expect(await getRegistries().files.getValue(fileId)).toBeNull();

		await server.client.actor(actorId).build('0.0', { waitForFinish: 10 });
		const [ctx] = driver.startBuildContexts;
		expect(ctx.dockerfilePath).toBe('Dockerfile');
		expect(ctx.buildArgs).toBeUndefined();
	});

	it('deletes the stored files with the version and with the Actor', async () => {
		const actorId = await createActor();
		await putContext(actorId, { actorPath: ACTOR_PATH, sourceFiles: MONOREPO_FILES });
		const first = (await getRegistries().actors.get(actorId))!.versions[0].localSourceContext!.fileId;

		// A second upload replaces the first one's files.
		await putContext(actorId, { actorPath: ACTOR_PATH, sourceFiles: MONOREPO_FILES });
		const second = (await getRegistries().actors.get(actorId))!.versions[0].localSourceContext!.fileId;
		expect(await getRegistries().files.getValue(first)).toBeNull();

		await server.client.actor(actorId).version('0.0').delete();
		expect(await getRegistries().files.getValue(second)).toBeNull();

		const otherId = await createActor('other-monorepo-actor');
		await putContext(otherId, { actorPath: ACTOR_PATH, sourceFiles: MONOREPO_FILES });
		const third = (await getRegistries().actors.get(otherId))!.versions[0].localSourceContext!.fileId;
		await server.client.actor(otherId).delete();
		expect(await getRegistries().files.getValue(third)).toBeNull();
	});

	it('rejects a context the Actor cannot be built from, and an unknown version', async () => {
		const actorId = await createActor();

		const cases: Array<[ContextUpload, string]> = [
			[{ sourceFiles: MONOREPO_FILES }, '"actorPath" query parameter is required'],
			[{ actorPath: '.', sourceFiles: MONOREPO_FILES }, 'not the context itself'],
			[{ actorPath: '../outside', sourceFiles: MONOREPO_FILES }, 'must not point outside the Docker context'],
			[{ actorPath: '/abs', sourceFiles: MONOREPO_FILES }, 'must be relative to the Docker context'],
			[
				{ actorPath: ACTOR_PATH, sourceFiles: Buffer.alloc(0) },
				'must be the Docker context as a .tar.gz archive',
			],
			[{ actorPath: ACTOR_PATH, sourceFiles: Buffer.from('not a tarball') }, 'is not a readable .tar.gz archive'],
			[
				{
					actorPath: ACTOR_PATH,
					sourceFiles: [...MONOREPO_FILES, { name: '../x', format: 'TEXT', content: '' }],
				},
				'must not point outside the Docker context',
			],
			[{ actorPath: 'actors/missing', sourceFiles: MONOREPO_FILES }, 'has no "actors/missing/.actor/actor.json"'],
			[{ actorPath: ACTOR_PATH, sourceFiles: MONOREPO_FILES, git: { dirty: 'yes' } }, '"gitDirty" must be'],
		];
		for (const [upload, message] of cases) {
			const res = await putContext(actorId, upload);
			expect(res.status, message).toBe(400);
			expect(res.data.error.message).toContain(message);
		}

		const missingVersion = await putContext(actorId, { actorPath: ACTOR_PATH, sourceFiles: MONOREPO_FILES }, '9.9');
		expect(missingVersion.status).toBe(404);
		const missingActor = await putContext('no-such-actor', { actorPath: ACTOR_PATH, sourceFiles: MONOREPO_FILES });
		expect(missingActor.status).toBe(404);
	});

	it('fails the build when a path field leaves the Docker context', async () => {
		const actorId = await createActor();
		const escaping = MONOREPO_FILES.map((file) =>
			file.name === `${ACTOR_PATH}/.actor/actor.json`
				? { ...file, content: JSON.stringify({ actorSpecification: 1, dockerfile: '../../../../Dockerfile' }) }
				: file,
		);
		await putContext(actorId, { actorPath: ACTOR_PATH, sourceFiles: escaping });

		const build = await server.client.actor(actorId).build('0.0', { waitForFinish: 10 });
		expect(build.status).toBe('FAILED');
		expect(build.statusMessage).toBe(
			'Dockerfile path "../../../../Dockerfile" in .actor/actor.json points outside the Docker context directory.',
		);
	});
});

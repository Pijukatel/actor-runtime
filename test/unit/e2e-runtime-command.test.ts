/**
 * The e2e suite starts the runtime container with the command `apify runtime start` runs (apify-cli's
 * `buildRuntimeRunArgs`), so that CI exercises the CLI's own start commands on every engine. These
 * expectations are the CLI's, verbatim; a change on either side must land on both.
 */
import { describe, expect, it } from 'vitest';

import { runtimeRunArgs } from '../../test/e2e/helpers/docker.js';

const options = {
	image: 'apify/actor-runtime:latest',
	containerName: 'apify-actor-runtime',
	hostSocketPath: '/var/run/docker.sock',
	dataMount: '/home/me/.apify/actor-runtime/data',
};

const common = [
	'-p',
	'3333:3333',
	'-p',
	'3000:3000',
	'-v',
	'/var/run/docker.sock:/var/run/docker.sock',
	'-v',
	'/home/me/.apify/actor-runtime/data:/data',
	'apify/actor-runtime:latest',
];

describe("the e2e suite's runtime start command mirrors apify runtime start", () => {
	it('Docker, rootful Podman and rootless Podman 4+ get the plain command', () => {
		const plain = ['run', '--rm', '--init', '--name', 'apify-actor-runtime', '--detach', ...common];
		expect(runtimeRunArgs({ cli: 'docker', rootless: false }, options)).toEqual(plain);
		expect(runtimeRunArgs({ cli: 'podman', rootless: false, podmanMajorVersion: 3 }, options)).toEqual(plain);
		expect(runtimeRunArgs({ cli: 'podman', rootless: true, podmanMajorVersion: 4 }, options)).toEqual(plain);
		expect(runtimeRunArgs({ cli: 'podman', rootless: true }, options)).toEqual(plain);
	});

	it("rootless Podman 3.x gets the runtime container a route to the host's loopback", () => {
		expect(runtimeRunArgs({ cli: 'podman', rootless: true, podmanMajorVersion: 3 }, options)).toEqual([
			'run',
			'--rm',
			'--init',
			'--name',
			'apify-actor-runtime',
			'--detach',
			'--network',
			'slirp4netns:allow_host_loopback=true',
			...common,
		]);
	});
});

/** `DockerDriver.startRun`'s server surface: how a run container's HTTP server is made reachable. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DockerDriver } from '../../src/driver/docker-driver.js';
import { stubDockerForRun } from './helpers/docker-stubs.js';

function stubWithInspect(info: Record<string, unknown>) {
	const stub = stubDockerForRun();
	Object.assign(stub.container, { inspect: vi.fn(async () => info) });
	return stub;
}

async function settle(): Promise<void> {
	for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
}

describe('DockerDriver.startRun - containerServerPort', () => {
	const ORIGINAL_HOSTNAME = process.env.HOSTNAME;
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'actor-runtime-standby-driver-'));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		if (ORIGINAL_HOSTNAME === undefined) delete process.env.HOSTNAME;
		else process.env.HOSTNAME = ORIGINAL_HOSTNAME;
	});

	it('publishes nothing on apify-local and reaches the container at its network address', async () => {
		const stub = stubWithInspect({ NetworkSettings: { Networks: { 'apify-local': { IPAddress: '10.1.2.3' } } } });
		const driver = new DockerDriver(stub.docker);
		driver.available = true;
		(driver as unknown as { onActorNetwork: boolean }).onActorNetwork = true;

		const outcome = driver.startRun(
			{ runId: 'r1', imageId: 'img', env: {}, memoryMbytes: 128, timeoutSecs: 0, containerServerPort: 4321 },
			() => {},
		);
		await settle();

		const [options] = stub.createContainer.mock.calls[0]!;
		expect(options.ExposedPorts).toBeUndefined();
		expect(options.HostConfig?.PortBindings).toBeUndefined();
		expect(await driver.containerServerAddress('r1')).toEqual({ host: '10.1.2.3', port: 4321 });

		stub.triggerContainerExit(0);
		stub.endLogStream();
		await outcome;
		expect(await driver.containerServerAddress('r1')).toBeUndefined();
	});

	it('from a process on the host itself, publishes the port on loopback at an engine-picked port', async () => {
		delete process.env.HOSTNAME;
		const stub = stubWithInspect({
			NetworkSettings: { Ports: { '4321/tcp': [{ HostIp: '127.0.0.1', HostPort: '49153' }] } },
		});
		const driver = new DockerDriver(stub.docker);
		driver.available = true;

		const outcome = driver.startRun(
			{ runId: 'r2', imageId: 'img', env: {}, memoryMbytes: 128, timeoutSecs: 0, containerServerPort: 4321 },
			() => {},
		);
		await settle();

		const [options] = stub.createContainer.mock.calls[0]!;
		expect(options.ExposedPorts).toEqual({ '4321/tcp': {} });
		expect(options.HostConfig?.PortBindings).toEqual({ '4321/tcp': [{ HostIp: '127.0.0.1', HostPort: '' }] });
		expect(await driver.containerServerAddress('r2')).toEqual({ host: '127.0.0.1', port: 49153 });

		stub.triggerContainerExit(0);
		stub.endLogStream();
		await outcome;
	});

	it("from a container off apify-local, publishes on the host and reaches it at the engine's host address", async () => {
		process.env.HOSTNAME = 'self';
		const hostsFile = join(dir, 'hosts');
		writeFileSync(hostsFile, '127.0.0.1 localhost\n169.254.1.2 host.containers.internal\n');
		const stub = stubWithInspect({
			NetworkSettings: { Ports: { '4321/tcp': [{ HostIp: '0.0.0.0', HostPort: '40000' }] } },
		});
		const driver = new DockerDriver(stub.docker, { hostsFile });
		driver.available = true;

		const outcome = driver.startRun(
			{ runId: 'r3', imageId: 'img', env: {}, memoryMbytes: 128, timeoutSecs: 0, containerServerPort: 4321 },
			() => {},
		);
		await settle();

		const [options] = stub.createContainer.mock.calls[0]!;
		expect(options.HostConfig?.PortBindings).toEqual({ '4321/tcp': [{ HostIp: '', HostPort: '' }] });
		// The hosts file is read from disk, which outlasts a few event-loop turns.
		await vi.waitFor(async () =>
			expect(await driver.containerServerAddress('r3')).toEqual({ host: '169.254.1.2', port: 40000 }),
		);

		stub.triggerContainerExit(0);
		stub.endLogStream();
		await outcome;
	});

	it("on Podman 3.x, joins this container's network namespace on a port of its own, with the API on loopback", async () => {
		process.env.HOSTNAME = 'self';
		const stub = stubWithInspect({});
		const driver = new DockerDriver(stub.docker);
		driver.available = true;
		(driver as unknown as { actorsOnDefaultNetwork: boolean }).actorsOnDefaultNetwork = true;

		const outcome = driver.startRun(
			{
				runId: 'r5',
				imageId: 'img',
				env: {
					APIFY_API_BASE_URL: 'http://apify-api:3333',
					ACTOR_EVENTS_WEBSOCKET_URL: 'ws://apify-api:3333/actor-runtime/events/r5',
					ACTOR_STANDBY_PORT: '4321',
					ACTOR_WEB_SERVER_PORT: '4321',
				},
				memoryMbytes: 128,
				timeoutSecs: 0,
				containerServerPort: 4321,
				containerServerRequired: true,
			},
			() => {},
		);
		await vi.waitFor(() => expect(stub.createContainer).toHaveBeenCalled());
		await settle();

		const [options] = stub.createContainer.mock.calls[0]!;
		expect(options.HostConfig?.NetworkMode).toBe('container:self');
		expect(options.HostConfig?.ExtraHosts).toBeUndefined();
		expect(options.HostConfig?.PortBindings).toBeUndefined();
		expect(options.ExposedPorts).toBeUndefined();
		const env = Object.fromEntries(options.Env!.map((entry: string) => entry.split(/=(.*)/s).slice(0, 2)));
		expect(env.APIFY_API_BASE_URL).toBe('http://127.0.0.1:3333');
		expect(env.ACTOR_EVENTS_WEBSOCKET_URL).toBe('ws://127.0.0.1:3333/actor-runtime/events/r5');
		const port = Number(env.ACTOR_STANDBY_PORT);
		expect(port).toBeGreaterThan(0);
		expect(env.ACTOR_WEB_SERVER_PORT).toBe(String(port));
		expect(await driver.containerServerAddress('r5')).toEqual({ host: '127.0.0.1', port });

		stub.triggerContainerExit(0);
		stub.endLogStream();
		await outcome;
	});

	it('on Podman 3.x, an ordinary run keeps its own networking: no namespace join, its server unreachable, said in its log', async () => {
		process.env.HOSTNAME = 'self';
		const stub = stubWithInspect({});
		const driver = new DockerDriver(stub.docker);
		driver.available = true;
		(driver as unknown as { actorsOnDefaultNetwork: boolean }).actorsOnDefaultNetwork = true;
		const log: string[] = [];

		const outcome = driver.startRun(
			{
				runId: 'r6',
				imageId: 'img',
				env: { APIFY_API_BASE_URL: 'http://apify-api:3333', ACTOR_WEB_SERVER_PORT: '4321' },
				memoryMbytes: 128,
				timeoutSecs: 0,
				containerServerPort: 4321,
			},
			(chunk) => log.push(chunk),
		);
		await vi.waitFor(() => expect(stub.createContainer).toHaveBeenCalled());
		await settle();

		const [options] = stub.createContainer.mock.calls[0]!;
		expect(options.HostConfig?.NetworkMode).not.toBe('container:self');
		expect(options.HostConfig?.PortBindings).toBeUndefined();
		const env = Object.fromEntries(options.Env!.map((entry: string) => entry.split(/=(.*)/s).slice(0, 2)));
		expect(env.APIFY_API_BASE_URL).toBe('http://apify-api:3333');
		expect(env.ACTOR_WEB_SERVER_PORT).toBe('4321');
		expect(await driver.containerServerAddress('r6')).toBeUndefined();
		expect(log.join('')).toContain('web server on port 4321 is not reachable by this runtime');

		stub.triggerContainerExit(0);
		stub.endLogStream();
		await outcome;
	});

	it('arms no timeout for a run with timeoutSecs 0', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout'] });
		try {
			const stub = stubWithInspect({});
			const driver = new DockerDriver(stub.docker);
			driver.available = true;
			const outcome = driver.startRun(
				{ runId: 'r4', imageId: 'img', env: {}, memoryMbytes: 128, timeoutSecs: 0 },
				() => {},
			);
			await settle();
			await vi.advanceTimersByTimeAsync(10 * 24 * 3600 * 1000);
			expect(stub.container.stop).not.toHaveBeenCalled();
			stub.triggerContainerExit(0);
			stub.endLogStream();
			await vi.advanceTimersByTimeAsync(10);
			expect((await outcome).timedOut).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});
});

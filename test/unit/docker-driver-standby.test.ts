/** `DockerDriver.startRun`'s server surface: how a run container's HTTP server is made reachable. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
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

const ROUTE_HEADER = 'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\n';

/** This process's own container as seen from inside, for `DockerDriver`'s constructor options. */
function ownNetwork(
	dir: string,
	view: { hostEntry: string; gatewayHex: string; iface: string; address: string },
): { hostsFile: string; routeFile: string; networkInterfaces: () => NodeJS.Dict<os.NetworkInterfaceInfo[]> } {
	const hostsFile = join(dir, 'hosts');
	const routeFile = join(dir, 'route');
	writeFileSync(hostsFile, `127.0.0.1 localhost\n${view.hostEntry} host.containers.internal\n`);
	writeFileSync(
		routeFile,
		`${ROUTE_HEADER}${view.iface}\t00000000\t${view.gatewayHex}\t0003\t0\t0\t0\t00000000\t0\t0\t0\n`,
	);
	return {
		hostsFile,
		routeFile,
		networkInterfaces: () => ({
			lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true } as os.NetworkInterfaceInfo],
			[view.iface]: [{ address: view.address, family: 'IPv4', internal: false } as os.NetworkInterfaceInfo],
		}),
	};
}

/** Rootless Podman 3.x: both containers under slirp4netns, the engine's host entry being the gateway. */
const rootlessPodman3 = (dir: string) =>
	ownNetwork(dir, { hostEntry: '10.0.2.2', gatewayHex: '0202000A', iface: 'tap0', address: '10.0.2.100' });

/** Rootful Podman 3.x: this container on the default bridge, where every Actor container lands too. */
const rootfulPodman3 = (dir: string) =>
	ownNetwork(dir, { hostEntry: '10.88.0.1', gatewayHex: '0100580A', iface: 'eth0', address: '10.88.0.5' });

function podman3Driver(
	docker: ConstructorParameters<typeof DockerDriver>[0],
	options: ConstructorParameters<typeof DockerDriver>[1],
) {
	const driver = new DockerDriver(docker, options);
	driver.available = true;
	(driver as unknown as { actorsOnDefaultNetwork: boolean }).actorsOnDefaultNetwork = true;
	return driver;
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

	it("on rootless Podman 3.x without host loopback, a standby run joins this container's network namespace on a port of its own, with the API on loopback", async () => {
		process.env.HOSTNAME = 'self';
		const stub = stubWithInspect({});
		const driver = podman3Driver(stub.docker, { ...rootlessPodman3(dir), tcpConnects: async () => false });

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

	it('on rootless Podman 3.x without host loopback, an ordinary run keeps its own networking: no namespace join, its server unreachable, said in its log', async () => {
		process.env.HOSTNAME = 'self';
		const stub = stubWithInspect({});
		const driver = podman3Driver(stub.docker, { ...rootlessPodman3(dir), tcpConnects: async () => false });
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
		expect(log.join('')).toContain('--network slirp4netns:allow_host_loopback=true');

		stub.triggerContainerExit(0);
		stub.endLogStream();
		await outcome;
	});

	it('on rootless Podman 3.x with host loopback, publishes the port on loopback and reaches it through the gateway, for any run', async () => {
		process.env.HOSTNAME = 'self';
		const probed: string[] = [];
		const stub = stubWithInspect({
			NetworkSettings: { Ports: { '4321/tcp': [{ HostIp: '127.0.0.1', HostPort: '41000' }] } },
		});
		const driver = podman3Driver(stub.docker, {
			...rootlessPodman3(dir),
			tcpConnects: async (host, port) => {
				probed.push(`${host}:${port}`);
				return true;
			},
		});

		const outcome = driver.startRun(
			{ runId: 'r7', imageId: 'img', env: {}, memoryMbytes: 128, timeoutSecs: 0, containerServerPort: 4321 },
			() => {},
		);
		await vi.waitFor(() => expect(stub.createContainer).toHaveBeenCalled());
		await settle();

		// The probe asked this container's own API through the gateway, once.
		expect(probed).toEqual(['10.0.2.2:3333']);
		const [options] = stub.createContainer.mock.calls[0]!;
		expect(options.HostConfig?.NetworkMode).toBe('slirp4netns:allow_host_loopback=true');
		expect(options.HostConfig?.PortBindings).toEqual({ '4321/tcp': [{ HostIp: '127.0.0.1', HostPort: '' }] });
		await vi.waitFor(async () =>
			expect(await driver.containerServerAddress('r7')).toEqual({ host: '10.0.2.2', port: 41000 }),
		);

		stub.triggerContainerExit(0);
		stub.endLogStream();
		await outcome;

		// A standby run takes the same route, never the namespace join, and the probe is not repeated.
		const routes = driver as unknown as { containerServerRoute(): Promise<string> };
		expect(await routes.containerServerRoute()).toBe('gateway-loopback');
		expect(probed).toHaveLength(1);
	});

	it("on rootful Podman 3.x, reaches the container at its address on the engine's default bridge, publishing nothing", async () => {
		process.env.HOSTNAME = 'self';
		const stub = stubWithInspect({ NetworkSettings: { Networks: { podman: { IPAddress: '10.88.0.7' } } } });
		const driver = podman3Driver(stub.docker, {
			...rootfulPodman3(dir),
			tcpConnects: async () => {
				throw new Error('no probe is needed on a shared bridge');
			},
		});

		const outcome = driver.startRun(
			{ runId: 'r9', imageId: 'img', env: {}, memoryMbytes: 128, timeoutSecs: 0, containerServerPort: 4321 },
			() => {},
		);
		await vi.waitFor(() => expect(stub.createContainer).toHaveBeenCalled());
		await settle();

		const [options] = stub.createContainer.mock.calls[0]!;
		expect(options.HostConfig?.NetworkMode).toBeUndefined();
		expect(options.HostConfig?.PortBindings).toBeUndefined();
		expect(options.ExposedPorts).toBeUndefined();
		await vi.waitFor(async () =>
			expect(await driver.containerServerAddress('r9')).toEqual({ host: '10.88.0.7', port: 4321 }),
		);

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

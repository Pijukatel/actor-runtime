/**
 * `DockerDriver`'s debug-mode surface (`actor-driver.md`'s "Debug mode" section): `inspectDebugTarget`
 * (the `services/debug-mode.ts: resolveDebugPlan` input it reads off an image) and `startRun`'s
 * debug-only behavior - `ExposedPorts`/`PortBindings`, the debugpy payload upload via `putArchive`, the
 * attach log line, and the port-conflict/missing-payload failures. Split out of `docker-driver.test.ts`
 * (this repo's one-file-per-area convention) into its own file, with its own imports and describe
 * placement. The two port-conflict tests assert the typed `DebugPortInUseError` (`driver/types.ts`) the
 * driver throws - the driver only classifies the failure; `services/debug-mode.ts:
 * describeDebugPortConflict` composes the user-facing remediation text one layer up, and is tested on
 * its own in `debug-mode-validation.test.ts`.
 */
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Docker from 'dockerode';

import { DockerDriver } from '../../src/driver/docker-driver.js';
import { DebugPortInUseError } from '../../src/driver/types.js';
import { stubDockerForRun } from './helpers/docker-stubs.js';

describe("DockerDriver.inspectDebugTarget (services/debug-mode.ts: resolveDebugPlan's own input)", () => {
	function stubDockerForInspect(config: {
		Cmd?: string[] | null;
		Entrypoint?: string | string[] | null;
		Env?: string[];
	}) {
		const inspect = vi.fn(async () => ({
			Config: {
				Cmd: config.Cmd ?? null,
				Entrypoint: config.Entrypoint ?? null,
				Env: config.Env ?? [],
			},
		}));
		const getImage = vi.fn(() => ({ inspect }));
		return { docker: { getImage } as unknown as Docker, getImage };
	}

	it('reads Config.Cmd verbatim as an array', async () => {
		const stub = stubDockerForInspect({ Cmd: ['python3', '-m', 'src'] });
		const driver = new DockerDriver(stub.docker);

		const target = await driver.inspectDebugTarget('image:tag');

		expect(target.cmd).toEqual(['python3', '-m', 'src']);
		expect(target.entrypoint).toBeUndefined();
		expect(stub.getImage).toHaveBeenCalledWith('image:tag');
	});

	it('normalizes a string-form Config.Entrypoint into a single-element array', async () => {
		const stub = stubDockerForInspect({ Entrypoint: 'docker-entrypoint.sh', Cmd: ['node', 'dist/main.js'] });
		const driver = new DockerDriver(stub.docker);

		const target = await driver.inspectDebugTarget('image:tag');

		expect(target.entrypoint).toEqual(['docker-entrypoint.sh']);
		expect(target.cmd).toEqual(['node', 'dist/main.js']);
	});

	it('leaves both cmd and entrypoint undefined for an image with neither set', async () => {
		const stub = stubDockerForInspect({});
		const driver = new DockerDriver(stub.docker);

		const target = await driver.inspectDebugTarget('image:tag');

		expect(target.cmd).toBeUndefined();
		expect(target.entrypoint).toBeUndefined();
	});

	it('extracts only the four env vars resolveDebugPlan needs, ignoring every other env entry', async () => {
		const stub = stubDockerForInspect({
			Env: [
				'PATH=/usr/bin',
				'PYTHONPATH=/usr/src/app',
				'NODE_OPTIONS=--max-old-space-size=4096',
				'PYTHON_VERSION=3.13.1',
				'NODE_VERSION=24.1.0',
				'UNRELATED=whatever',
			],
		});
		const driver = new DockerDriver(stub.docker);

		const target = await driver.inspectDebugTarget('image:tag');

		expect(target.env).toEqual({
			PYTHONPATH: '/usr/src/app',
			NODE_OPTIONS: '--max-old-space-size=4096',
			PYTHON_VERSION: '3.13.1',
			NODE_VERSION: '24.1.0',
		});
	});

	it('tolerates an env entry with no "=" at all rather than throwing', async () => {
		const stub = stubDockerForInspect({ Env: ['MALFORMED', 'PYTHON_VERSION=3.13.1'] });
		const driver = new DockerDriver(stub.docker);

		const target = await driver.inspectDebugTarget('image:tag');

		expect(target.env.PYTHON_VERSION).toBe('3.13.1');
	});
});

describe('DockerDriver.startRun - debug mode (actor-driver.md: "Debug mode")', () => {
	let payloadDir: string;
	const ORIGINAL_ENV = process.env.ACTOR_RUNTIME_DEBUGPY_PAYLOAD_DIR;

	beforeEach(() => {
		payloadDir = mkdtempSync(join(tmpdir(), 'actor-runtime-debugpy-payload-test-'));
		writeFileSync(join(payloadDir, 'debugpy-payload.tar'), 'fake-tar-content');
		writeFileSync(join(payloadDir, 'debugpy-version.txt'), '9.9.9\n');
		process.env.ACTOR_RUNTIME_DEBUGPY_PAYLOAD_DIR = payloadDir;
	});

	afterEach(() => {
		rmSync(payloadDir, { recursive: true, force: true });
		if (ORIGINAL_ENV === undefined) delete process.env.ACTOR_RUNTIME_DEBUGPY_PAYLOAD_DIR;
		else process.env.ACTOR_RUNTIME_DEBUGPY_PAYLOAD_DIR = ORIGINAL_ENV;
	});

	it("a non-debug run's createContainer options carry no ExposedPorts/PortBindings key at all (regression: byte-identical to today for an Actor that never touched the toggle)", async () => {
		const stub = stubDockerForRun();
		const driver = new DockerDriver(stub.docker);
		driver.available = true;

		const outcomePromise = driver.startRun(
			{ runId: 'run-nodebug-1', imageId: 'fake-image', env: {}, memoryMbytes: 128, timeoutSecs: 60 },
			() => {},
		);
		await new Promise((resolve) => setImmediate(resolve));

		const [options] = stub.createContainer.mock.calls[0]!;
		expect(options.ExposedPorts).toBeUndefined();
		expect(options.HostConfig?.PortBindings).toBeUndefined();
		expect(stub.container.putArchive).not.toHaveBeenCalled();

		stub.triggerContainerExit(0);
		stub.endLogStream();
		await outcomePromise;
	});

	it('a Node debug run sets ExposedPorts/PortBindings for the given port, bound to 127.0.0.1, and never touches Cmd/Entrypoint', async () => {
		const stub = stubDockerForRun();
		const driver = new DockerDriver(stub.docker);
		driver.available = true;

		const outcomePromise = driver.startRun(
			{
				runId: 'run-debug-node-1',
				imageId: 'fake-image',
				env: { NODE_OPTIONS: '--inspect-brk=0.0.0.0:9229' },
				memoryMbytes: 128,
				timeoutSecs: 60,
				debug: { language: 'node', port: 9229 },
			},
			() => {},
		);
		await new Promise((resolve) => setImmediate(resolve));

		const [options] = stub.createContainer.mock.calls[0]!;
		expect(options.ExposedPorts).toEqual({ '9229/tcp': {} });
		expect(options.HostConfig?.PortBindings).toEqual({
			'9229/tcp': [{ HostIp: '127.0.0.1', HostPort: '9229' }],
		});
		expect(options).not.toHaveProperty('Cmd');
		expect(options).not.toHaveProperty('Entrypoint');
		expect(stub.container.putArchive).not.toHaveBeenCalled();

		stub.triggerContainerExit(0);
		stub.endLogStream();
		await outcomePromise;
	});

	it('logs the attach line before createContainer, naming the language, the listen/publish address, and the unmodified-timeout warning', async () => {
		const stub = stubDockerForRun();
		const driver = new DockerDriver(stub.docker);
		driver.available = true;
		const events: string[] = [];
		stub.createContainer.mockImplementationOnce(async (..._args: unknown[]) => {
			events.push('createContainer');
			return stub.container;
		});

		const outcomePromise = driver.startRun(
			{
				runId: 'run-debug-node-2',
				imageId: 'fake-image',
				env: {},
				memoryMbytes: 128,
				timeoutSecs: 300,
				debug: { language: 'node', port: 9229 },
			},
			(chunk) => events.push(`log:${chunk}`),
		);
		await new Promise((resolve) => setImmediate(resolve));

		// The log line lands before `createContainer` is even called - matching the dev-mount line's own
		// convention (`docker-driver.ts`'s doc comment on `startRun`).
		expect(events[0]).toMatch(/^log:/);
		expect(events).toContain('createContainer');
		const attachLine = events[0]!.slice('log:'.length);
		expect(attachLine).toContain('paused before its first line');
		expect(attachLine).toContain('0.0.0.0:9229');
		expect(attachLine).toContain('127.0.0.1:9229');
		expect(attachLine).toContain('300s timeout');
		expect(attachLine).toContain('NOT extended');

		stub.triggerContainerExit(0);
		stub.endLogStream();
		await outcomePromise;
	});

	it('a Python debug run uploads the debugpy payload via putArchive({ path: "/" }) between createContainer and start(), and names the debugpy version read from the payload in the attach line', async () => {
		const stub = stubDockerForRun();
		const driver = new DockerDriver(stub.docker);
		driver.available = true;
		const chunks: string[] = [];
		const callOrder: string[] = [];
		stub.createContainer.mockImplementationOnce(async () => {
			callOrder.push('createContainer');
			return stub.container;
		});
		stub.container.putArchive.mockImplementationOnce(async () => {
			callOrder.push('putArchive');
		});
		stub.container.start.mockImplementationOnce(async () => {
			callOrder.push('start');
		});

		const outcomePromise = driver.startRun(
			{
				runId: 'run-debug-python-1',
				imageId: 'fake-image',
				env: { PYTHONPATH: '/opt/apify-debug' },
				memoryMbytes: 128,
				timeoutSecs: 60,
				debug: { language: 'python', port: 5678 },
			},
			(chunk) => chunks.push(chunk),
		);
		// Real `fs.readFile` I/O (the payload preload) doesn't settle within a single microtask/`setImmediate`
		// tick the way the rest of this stub's in-memory flow does - poll briefly instead of assuming one tick
		// suffices.
		for (let i = 0; i < 50 && callOrder.length < 3; i++) {
			await new Promise((resolve) => setTimeout(resolve, 5));
		}

		expect(callOrder).toEqual(['createContainer', 'putArchive', 'start']);
		expect(stub.container.putArchive).toHaveBeenCalledWith(Buffer.from('fake-tar-content'), { path: '/' });
		expect(chunks[0]).toContain('debugpy 9.9.9');
		expect(chunks[0]).toContain('Attach to DAP');

		const [options] = stub.createContainer.mock.calls[0]!;
		expect(options.ExposedPorts).toEqual({ '5678/tcp': {} });
		expect(options.HostConfig?.PortBindings).toEqual({
			'5678/tcp': [{ HostIp: '127.0.0.1', HostPort: '5678' }],
		});

		stub.triggerContainerExit(0);
		stub.endLogStream();
		await outcomePromise;
	});

	it('fails the run before any container is created when the Python debug payload is missing from disk, with a clear message - never a silent non-debug start', async () => {
		rmSync(join(payloadDir, 'debugpy-payload.tar'));
		const stub = stubDockerForRun();
		const driver = new DockerDriver(stub.docker);
		driver.available = true;

		await expect(
			driver.startRun(
				{
					runId: 'run-debug-python-missing',
					imageId: 'fake-image',
					env: {},
					memoryMbytes: 128,
					timeoutSecs: 60,
					debug: { language: 'python', port: 5678 },
				},
				() => {},
			),
		).rejects.toThrow(/debugpy payload is missing/);

		expect(stub.createContainer).not.toHaveBeenCalled();
	});

	it('maps a "port is already allocated" start() rejection to a typed DebugPortInUseError naming the configured port - the driver only classifies; `services/debug-mode.ts: describeDebugPortConflict` (tested separately) composes the remediation text', async () => {
		const stub = stubDockerForRun();
		stub.container.start.mockRejectedValueOnce(
			Object.assign(new Error('driver failed programming external connectivity: port is already allocated'), {
				statusCode: 500,
			}),
		);
		const driver = new DockerDriver(stub.docker);
		driver.available = true;

		let error: unknown;
		try {
			await driver.startRun(
				{
					runId: 'run-debug-port-conflict',
					imageId: 'fake-image',
					env: {},
					memoryMbytes: 128,
					timeoutSecs: 60,
					debug: { language: 'node', port: 9229 },
				},
				() => {},
			);
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(DebugPortInUseError);
		expect((error as DebugPortInUseError).port).toBe(9229);
	});

	it('maps an "address already in use" start() rejection to the same typed DebugPortInUseError (the daemon\'s other port-conflict wording)', async () => {
		const stub = stubDockerForRun();
		stub.container.start.mockRejectedValueOnce(
			Object.assign(new Error('Bind for 0.0.0.0:9229 failed: port is already in use: address already in use'), {
				statusCode: 500,
			}),
		);
		const driver = new DockerDriver(stub.docker);
		driver.available = true;

		let error: unknown;
		try {
			await driver.startRun(
				{
					runId: 'run-debug-port-conflict-address',
					imageId: 'fake-image',
					env: {},
					memoryMbytes: 128,
					timeoutSecs: 60,
					debug: { language: 'node', port: 9229 },
				},
				() => {},
			);
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(DebugPortInUseError);
		expect((error as DebugPortInUseError).port).toBe(9229);
	});

	it('does not rewrite an ordinary (non-port-conflict) start() failure for a debug run - the original error propagates', async () => {
		const stub = stubDockerForRun();
		stub.container.start.mockRejectedValueOnce(new Error('some other daemon failure'));
		const driver = new DockerDriver(stub.docker);
		driver.available = true;

		await expect(
			driver.startRun(
				{
					runId: 'run-debug-other-failure',
					imageId: 'fake-image',
					env: {},
					memoryMbytes: 128,
					timeoutSecs: 60,
					debug: { language: 'node', port: 9229 },
				},
				() => {},
			),
		).rejects.toThrow('some other daemon failure');
	});

	it("a port-in-use start() failure for a NON-debug run is left as the daemon's own message, unrewritten", async () => {
		const stub = stubDockerForRun();
		stub.container.start.mockRejectedValueOnce(new Error('port is already allocated'));
		const driver = new DockerDriver(stub.docker);
		driver.available = true;

		await expect(
			driver.startRun(
				{
					runId: 'run-nodebug-port-conflict',
					imageId: 'fake-image',
					env: {},
					memoryMbytes: 128,
					timeoutSecs: 60,
				},
				() => {},
			),
		).rejects.toThrow('port is already allocated');
	});

	it('removes the container ({ v: true }) even when the Python debugpy payload upload itself fails, never leaking it', async () => {
		const stub = stubDockerForRun();
		stub.container.putArchive.mockRejectedValueOnce(new Error('upload failed'));
		const driver = new DockerDriver(stub.docker);
		driver.available = true;

		await expect(
			driver.startRun(
				{
					runId: 'run-debug-python-upload-fail',
					imageId: 'fake-image',
					env: {},
					memoryMbytes: 128,
					timeoutSecs: 60,
					debug: { language: 'python', port: 5678 },
				},
				() => {},
			),
		).rejects.toThrow('upload failed');

		expect(stub.container.remove).toHaveBeenCalledWith({ v: true });
	});

	it('caches the debug payload in memory after the first read - a second debug run on the same driver instance still succeeds after the payload is deleted from disk', async () => {
		// A minimal per-run container stub (mirroring `stubDockerForRun`'s own container shape) - built
		// fresh per run because `container.wait()`/`.logs()` each resolve/end exactly once and can't be
		// reused for a second `startRun` call, but the *docker client* (and therefore the driver
		// constructed against it) is created exactly once and never swapped, so this needs no reach into
		// the driver's private fields at all.
		function freshContainerStub() {
			let resolveWait!: (result: { StatusCode: number }) => void;
			const waitPromise = new Promise<{ StatusCode: number }>((resolve) => {
				resolveWait = resolve;
			});
			const rawLogStream = new PassThrough();
			return {
				container: {
					start: vi.fn(async () => undefined),
					logs: vi.fn(async () => rawLogStream),
					wait: vi.fn(async () => waitPromise),
					remove: vi.fn(async () => undefined),
					stop: vi.fn(async () => undefined),
					putArchive: vi.fn(async () => undefined),
				},
				triggerContainerExit(statusCode = 0): void {
					resolveWait({ StatusCode: statusCode });
				},
				endLogStream(): void {
					rawLogStream.end();
				},
			};
		}

		const first = freshContainerStub();
		const second = freshContainerStub();
		const containers = [first.container, second.container];
		let callIndex = 0;
		const createContainer = vi.fn(async () => containers[callIndex++]!);
		const demuxStream = vi.fn((stream: NodeJS.ReadableStream, stdout: PassThrough) => {
			stream.on('data', (chunk: Buffer) => stdout.write(chunk));
		});
		const docker = { createContainer, modem: { demuxStream } } as unknown as Docker;

		const driver = new DockerDriver(docker);
		driver.available = true;

		const runOptions = (runId: string) => ({
			runId,
			imageId: 'fake-image',
			env: {},
			memoryMbytes: 128,
			timeoutSecs: 60,
			debug: { language: 'python' as const, port: 5678 },
		});

		// First run: `loadDebugPayload` has nothing cached yet, so it reads the fixture tar/version files
		// `beforeEach` wrote to `payloadDir` from disk.
		const firstOutcome = driver.startRun(runOptions('run-debug-python-cache-1'), () => {});
		for (let i = 0; i < 50 && first.container.putArchive.mock.calls.length < 1; i++) {
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		expect(first.container.putArchive).toHaveBeenCalledWith(Buffer.from('fake-tar-content'), { path: '/' });
		first.triggerContainerExit(0);
		first.endLogStream();
		await firstOutcome;

		// Delete the on-disk payload entirely before the second run. If the driver re-read it per run
		// instead of caching the first read, this second run would fail the same way the dedicated
		// "missing payload" test above asserts (`rejects.toThrow(/debugpy payload is missing/)`), and the
		// `putArchive` assertion below would never be reached - this is what makes the test a real
		// regression check for the caching behavior, not a tautology.
		rmSync(join(payloadDir, 'debugpy-payload.tar'));

		const secondOutcome = driver.startRun(runOptions('run-debug-python-cache-2'), () => {});
		for (let i = 0; i < 50 && second.container.putArchive.mock.calls.length < 1; i++) {
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		expect(second.container.putArchive).toHaveBeenCalledWith(Buffer.from('fake-tar-content'), { path: '/' });
		second.triggerContainerExit(0);
		second.endLogStream();
		await secondOutcome;
	});

	it('a debug run\'s timeoutSecs timer fires exactly like a non-debug run\'s - the pause gets no extra grace period (actor-driver.md: "completely unaffected by debug mode")', async () => {
		const stub = stubDockerForRun();
		const driver = new DockerDriver(stub.docker);
		driver.available = true;

		// A tiny real timeout - the container is never told to exit, mirroring a session where no
		// debugger ever attaches, so the only thing that can end this run is the timer itself.
		const outcomePromise = driver.startRun(
			{
				runId: 'run-debug-timeout',
				imageId: 'fake-image',
				env: {},
				memoryMbytes: 128,
				timeoutSecs: 0.05,
				debug: { language: 'node', port: 9229 },
			},
			() => {},
		);

		// The timer firing calls `container.stop()`, which this stub resolves without itself ending the
		// container - so the outcome only settles once `stop()` is observed AND the log stream is also
		// ended (mirroring a real daemon actually stopping the container and closing its logs).
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(stub.container.stop).toHaveBeenCalled();
		stub.triggerContainerExit(137);
		stub.endLogStream();

		const outcome = await outcomePromise;
		expect(outcome).toEqual({ exitCode: 137, timedOut: true });
	});

	describe('debug mode composes with the dev-folder bind mount (actor-driver.md: "the two features are independent")', () => {
		it('a run with both devMount and debug set carries both HostConfig.Mounts and the debug ExposedPorts/PortBindings/env, neither one suppressing the other', async () => {
			const stub = stubDockerForRun();
			const driver = new DockerDriver(stub.docker);
			driver.available = true;

			const outcomePromise = driver.startRun(
				{
					runId: 'run-debug-and-devmount',
					imageId: 'fake-image',
					env: { NODE_OPTIONS: '--inspect-brk=0.0.0.0:9229' },
					memoryMbytes: 128,
					timeoutSecs: 60,
					devMount: { localDevFolder: '/host/src', imageWorkingDirectory: '/usr/src/app' },
					debug: { language: 'node', port: 9229 },
				},
				() => {},
			);
			await new Promise((resolve) => setImmediate(resolve));

			const [options] = stub.createContainer.mock.calls[0]!;
			expect(options.HostConfig?.Mounts).toEqual([
				{ Type: 'bind', Source: '/host/src', Target: '/usr/src/app' },
				{ Type: 'volume', Source: '', Target: '/usr/src/app/node_modules' },
			]);
			expect(options.ExposedPorts).toEqual({ '9229/tcp': {} });
			expect(options.HostConfig?.PortBindings).toEqual({
				'9229/tcp': [{ HostIp: '127.0.0.1', HostPort: '9229' }],
			});
			expect(options.Env).toContain('NODE_OPTIONS=--inspect-brk=0.0.0.0:9229');

			stub.triggerContainerExit(0);
			stub.endLogStream();
			await outcomePromise;
		});
	});
});

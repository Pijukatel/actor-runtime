import { PassThrough } from 'node:stream';

import { vi } from 'vitest';
import type Docker from 'dockerode';

/**
 * A stub `dockerode`-shaped object covering only what `startRun` calls, with `container.wait()` and the
 * `container.logs()` stream each independently controllable - mirrors the real Docker daemon's two
 * genuinely separate API connections (the finding this fixes: nothing guarantees the log stream's final
 * chunk has arrived by the time `container.wait()` resolves).
 *
 * Lives in this non-`.test.ts` helper file - not in `docker-driver.test.ts` itself - specifically so
 * `resource-sampler.test.ts` can import it too: a `.test.ts` file's top-level code (its own `describe`/
 * `it` registrations included) re-runs as a side effect of another test file importing anything from it,
 * which would silently double-execute every one of `docker-driver.test.ts`'s own tests. Extended (not
 * reimplemented) by `resource-sampler.test.ts` via `Object.assign`-ing a `container.stats()` mock onto the
 * returned `container` - the same extend-in-place pattern `docker-driver.test.ts`'s own
 * `stubDockerForCapacity` uses for `init()`'s extra surface.
 */
export function stubDockerForRun() {
	let resolveWait!: (result: { StatusCode: number }) => void;
	const waitPromise = new Promise<{ StatusCode: number }>((resolve) => {
		resolveWait = resolve;
	});

	// The raw (not-yet-demuxed) combined stdout/stderr stream `container.logs()` would return - a
	// separate Docker API connection from `container.wait()` above.
	const rawLogStream = new PassThrough();

	const container = {
		start: vi.fn(async () => undefined),
		logs: vi.fn(async () => rawLogStream),
		wait: vi.fn(async () => waitPromise),
		remove: vi.fn(async (_options?: Record<string, unknown>) => undefined),
		stop: vi.fn(async () => undefined),
		putArchive: vi.fn(async (_file: unknown, _options: unknown) => undefined),
	};

	// Real dockerode demuxing splits stdout/stderr apart by frame header; this stub doesn't need that
	// distinction, it only needs to forward data. Crucially - faithful to the real
	// `docker-modem` `Modem.prototype.demuxStream` (`node_modules/docker-modem/lib/modem.js`) - it must
	// NOT end `stdout`/`stderr` when the source stream ends: the real implementation registers only
	// `streama.on('data', processData)` and never calls `.end()`/`.destroy()` on either destination.
	// `stdout`/`stderr` ending is entirely `DockerDriver.startRun`'s own responsibility (it derives that
	// from the SOURCE stream, i.e. `stream` here, ending) - a demux stub that auto-ends the destinations
	// (as this one previously did) hides exactly the bug that shipped in production.
	const demuxStream = vi.fn((stream: NodeJS.ReadableStream, stdout: PassThrough) => {
		stream.on('data', (chunk: Buffer) => stdout.write(chunk));
	});

	// Typed with the real `dockerode` parameter shape so `mock.calls[0]` is genuinely a
	// `[Docker.ContainerCreateOptions]` tuple below - no unsound cast needed to read it back.
	const createContainer = vi.fn(async (_options: Docker.ContainerCreateOptions) => container);
	const docker = {
		createContainer,
		modem: { demuxStream },
	} as unknown as Docker;

	return {
		docker,
		container,
		createContainer,
		/** Simulates `container.wait()` resolving - the container process has exited. */
		triggerContainerExit(statusCode = 0): void {
			resolveWait({ StatusCode: statusCode });
		},
		/** Simulates a trailing chunk still arriving over the separate Docker logs connection. */
		pushFinalLogChunk(chunk: string): void {
			rawLogStream.write(chunk);
		},
		/** Simulates the logs connection closing - the real daemon does this once the container's full
		 * output has been delivered. */
		endLogStream(): void {
			rawLogStream.end();
		},
	};
}

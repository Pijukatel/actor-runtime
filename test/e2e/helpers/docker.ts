import { execFileSync } from 'node:child_process';

/** True when a Docker daemon is reachable from this process. Gates the whole e2e suite. */
export function isDockerAvailable(): boolean {
	try {
		execFileSync('docker', ['info'], { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
}

export function buildRuntimeImage(repoRoot: string, tag: string): void {
	execFileSync('docker', ['build', '-t', tag, repoRoot], { stdio: 'inherit' });
}

export function pullBaseImages(): void {
	// Pre-pulled here rather than left to the first build, per `test.md`'s documented CI requirement -
	// building an Actor image is the one step that still needs network, and doing it once up front
	// keeps the timing of the actual push/call assertions predictable.
	for (const image of ['apify/actor-node:24', 'apify/actor-python:3.13', 'python:3.11-slim']) {
		execFileSync('docker', ['pull', image], { stdio: 'inherit' });
	}
}

export function startRuntimeContainer(tag: string, containerName: string): void {
	execFileSync(
		'docker',
		[
			'run',
			'-d',
			'--name',
			containerName,
			// Host ports are fixed, not derived from `containerName` - only one runtime container can ever
			// be bound to 3333/3000 at a time. `package.json`'s `test:e2e` script therefore runs
			// `vitest run test/e2e --no-file-parallelism`: if a second e2e file's `beforeAll` ever raced
			// this one, the loser's `docker run` would fail with "port is already allocated" and take that
			// file's whole suite down with it. Adding a third e2e file is safe as long as the suite stays
			// serialized - do not drop `--no-file-parallelism` (and do not add a `vitest.workspace.ts` or
			// per-file config that re-enables parallelism for this directory) without also parameterizing
			// these two ports per container.
			'-p',
			'3333:3333',
			'-p',
			'3000:3000',
			'-v',
			'/var/run/docker.sock:/var/run/docker.sock',
			'-v',
			`${containerName}-data:/data`,
			tag,
		],
		{ stdio: 'inherit' },
	);
}

export function stopRuntimeContainer(containerName: string): void {
	// Dump the runtime container's own logs before force-removing it - the workflow's "Dump runtime
	// container logs on failure" step tries `docker logs <name>` too, but this `afterAll` runs first and
	// already removes the container by the time that step gets to run, so it always finds "No such
	// container" and the server-side view of a failed e2e request is lost. Printing here, into the same
	// test stdout the failure shows up in, actually captures it; the workflow step stays as a harmless
	// backstop for cases where the process is killed before `afterAll` runs at all.
	try {
		const logs = execFileSync('docker', ['logs', '--tail', '300', containerName], {
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		process.stdout.write(`\n--- ${containerName} container logs (last 300 lines) ---\n`);
		process.stdout.write(logs);
		process.stdout.write(`--- end ${containerName} container logs ---\n\n`);
	} catch {
		// best-effort: the container may already be gone (never started, already removed) - diagnostics
		// only, never a reason to skip the cleanup below.
	}
	try {
		execFileSync('docker', ['rm', '-f', containerName], { stdio: 'ignore' });
	} catch {
		// best-effort cleanup
	}
	try {
		execFileSync('docker', ['volume', 'rm', '-f', `${containerName}-data`], { stdio: 'ignore' });
	} catch {
		// best-effort cleanup
	}
}

export async function waitForHttpOk(url: string, timeoutMs = 60_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	let lastError: unknown;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(url);
			if (res.ok || res.status < 500) return;
		} catch (error) {
			lastError = error;
		}
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	throw new Error(`Timed out waiting for ${url} to respond: ${String(lastError)}`);
}

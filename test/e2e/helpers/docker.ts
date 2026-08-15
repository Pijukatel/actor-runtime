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
	for (const image of ['apify/actor-node:24', 'apify/actor-python:3.13']) {
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

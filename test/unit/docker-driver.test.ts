import { describe, expect, it, vi } from 'vitest';
import type Docker from 'dockerode';

import { DockerDriver } from '../../src/driver/docker-driver.js';

/**
 * A stub `dockerode`-shaped object covering only what `reconcileOrphans` calls - there is no Docker
 * daemon in this sandbox to test against for real (see `DockerDriver`'s class doc comment), so this
 * exercises the filter construction and client-side matching in isolation.
 */
function stubDocker(containers: Array<{ Id: string; Labels: Record<string, string> }>) {
	const removed: string[] = [];
	const listContainers = vi.fn().mockResolvedValue(containers);
	const getContainer = vi.fn((id: string) => ({
		remove: vi.fn(async () => {
			removed.push(id);
		}),
	}));
	return {
		docker: { listContainers, getContainer } as unknown as Docker,
		listContainers,
		getContainer,
		removed,
	};
}

describe('DockerDriver.reconcileOrphans', () => {
	it("filters on the label KEY's presence only, never multiple key=value pairs in one call", async () => {
		const { docker, listContainers } = stubDocker([]);
		const driver = new DockerDriver(docker);
		driver.available = true;

		await driver.reconcileOrphans(['run-a', 'run-b']);

		expect(listContainers).toHaveBeenCalledTimes(1);
		const [options] = listContainers.mock.calls[0] as [{ all: boolean; filters: string }];
		expect(options.all).toBe(true);
		const filters = JSON.parse(options.filters) as { label: string[] };
		// Exactly one label filter entry - the bare key, never `key=value` - so two or more orphaned run
		// ids can never be AND'd together by the daemon's per-key label matching (a single container can
		// never satisfy two different values of the same label at once - see the doc comment on
		// `reconcileOrphans` for the moby `MatchKVList` semantics this sidesteps entirely).
		expect(filters.label).toEqual(['actor-runtime.runId']);
	});

	it("matches run ids against each returned container's own label client-side, removing only the orphaned ones", async () => {
		const { docker, getContainer, removed } = stubDocker([
			{ Id: 'container-a', Labels: { 'actor-runtime.runId': 'run-a' } },
			{ Id: 'container-b', Labels: { 'actor-runtime.runId': 'run-b' } },
			{ Id: 'container-c', Labels: { 'actor-runtime.runId': 'run-c' } },
		]);
		const driver = new DockerDriver(docker);
		driver.available = true;

		// Two orphaned run ids, out of three containers actually present - the exact "2+ orphans" shape
		// the review's question raised as at risk under the old AND'd `label=KEY=value` filter.
		await driver.reconcileOrphans(['run-a', 'run-c']);

		expect(getContainer).toHaveBeenCalledTimes(2);
		expect(removed.sort()).toEqual(['container-a', 'container-c']);
	});

	it('removes nothing when no returned container matches any given run id', async () => {
		const { docker, getContainer } = stubDocker([
			{ Id: 'container-x', Labels: { 'actor-runtime.runId': 'run-x' } },
		]);
		const driver = new DockerDriver(docker);
		driver.available = true;

		await driver.reconcileOrphans(['run-a']);

		expect(getContainer).not.toHaveBeenCalled();
	});

	it('does nothing (no daemon call at all) when the driver is unavailable', async () => {
		const { docker, listContainers } = stubDocker([]);
		const driver = new DockerDriver(docker);
		// `driver.available` defaults to false until `init()` succeeds.

		await driver.reconcileOrphans(['run-a']);

		expect(listContainers).not.toHaveBeenCalled();
	});

	it('does nothing when there are no orphaned run ids, even if available', async () => {
		const { docker, listContainers } = stubDocker([]);
		const driver = new DockerDriver(docker);
		driver.available = true;

		await driver.reconcileOrphans([]);

		expect(listContainers).not.toHaveBeenCalled();
	});
});

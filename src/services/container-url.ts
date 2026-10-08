/**
 * A run's `containerUrl` (`actor-driver.md`'s "Web server and live view"): where requests reach the HTTP
 * server an Actor may start on `ACTOR_WEB_SERVER_PORT` inside its run's container. The platform serves
 * it at `https://<key>.runs.apify.net`; here it is on the API port, in the platform's host-based shape for
 * clients on the host, and in a path form for Actor containers and clients that do not resolve
 * `*.localhost`. Every run has one, as on the platform, whether or not the Actor ever listens.
 */
import type { RunRecord } from '../storage/entities.js';
import { API_PORT, CONTAINER_API_BASE_URL } from '../config.js';
import { getRegistries } from '../storage/registries.js';
import type { StandbyUrlAudience } from './standby-config.js';

/** Who a container URL is for: a client on the host, or another Actor's container. */
export type ContainerUrlAudience = StandbyUrlAudience;

/** Where a run's web server is served: `/actor-runtime/container/<runId>/...` on the API port. */
export const CONTAINER_PATH_PREFIX = '/actor-runtime/container';

/** The hostname suffix of the host-facing form, the platform's `runs.apify.net` counterpart. */
const CONTAINER_HOST_SUFFIX = '.runs.localhost';

/**
 * Host-facing, the platform's shape: the run owns `/` of its own origin, so a web UI the Actor serves can
 * use root-relative links. The run id is lowercased, as any hostname is by the client sending it.
 * Containers cannot resolve `*.localhost` to the runtime, so they get the path form on the API alias.
 */
export function containerUrl(runId: string, audience: ContainerUrlAudience = 'host'): string {
	if (audience === 'container') return `${CONTAINER_API_BASE_URL}${CONTAINER_PATH_PREFIX}/${runId}`;
	return `http://${runId.toLowerCase()}${CONTAINER_HOST_SUFFIX}:${API_PORT}`;
}

/** The run id label, or `undefined` for a Host header not of the `<runId>.runs.localhost` form. */
export function runLabelFromHost(host: string | undefined): string | undefined {
	const match = host?.toLowerCase().match(/^([a-z0-9]+)\.runs\.localhost(?::\d+)?$/);
	return match?.[1];
}

/**
 * The run a container-URL label names. Run ids are case-sensitive but a hostname is not, so a label that
 * matches no id exactly is matched case-insensitively against every run - the runtime's intended scale
 * (`system.md`) keeps that cheap.
 */
export async function findRunByLabel(label: string): Promise<RunRecord | undefined> {
	const { runs } = getRegistries();
	const exact = await runs.get(label);
	if (exact) return exact;
	const lower = label.toLowerCase();
	return (await runs.list()).find((run) => run.id.toLowerCase() === lower);
}

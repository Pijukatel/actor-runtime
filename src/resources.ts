/**
 * The one home for the platform's memory-to-CPU ratio (`docs.apify.com/actors/running/usage-and-
 * resources#cpu`: "For every 4096MB of memory, the Actor receives one full CPU core... calculated
 * proportionally" for a non-multiple). Both the driver (`docker-driver.ts`'s `HostConfig.CpuQuota`) and
 * the env vars (`services/runs.ts`'s `APIFY_DEDICATED_CPUS`) derive from this single ratio - two copies
 * would drift the moment anyone tunes it, and the drift would be invisible: the container would be
 * limited to one thing and told another.
 */

/** Memory (MB) that corresponds to one full CPU core, per the platform's own ratio. */
const MEMORY_MBYTES_PER_CPU = 4096;

/** Docker's CFS period, in microseconds - the denominator `CpuQuota` is expressed against. Fixed, not
 * derived: it is the unit the ratio below is scaled into, not itself part of the ratio. */
export const CPU_PERIOD_US = 100_000;

/** Docker's own protocol minimum for `HostConfig.CpuQuota` (`moby`'s `verifyPlatformContainerResources`
 * rejects anything lower) - a floor on the *encoding*, not a host-capacity clamp. A `?memory=32` run
 * computes a raw quota below this and is raised to it; the host-capacity warning (`docker-driver.ts`'s
 * `init`/`startRun`) is a completely separate concern from this floor. */
const MIN_CPU_QUOTA_US = 1000;

/** The run's dedicated CPU cores, as a fraction, derived from its memory grant alone - the real
 * platform ties CPU to memory rather than accepting a free `cpus` parameter. */
export function dedicatedCpusFor(memoryMbytes: number): number {
	return memoryMbytes / MEMORY_MBYTES_PER_CPU;
}

/** `HostConfig.CpuQuota` for a run granted `memoryMbytes`, paired with the fixed `CPU_PERIOD_US` as
 * `HostConfig.CpuPeriod` - never `NanoCpus` (see `docker-driver.ts`'s doc comment on `createContainer`
 * for why: `NanoCpus` is hard-rejected above the host's own CPU count, `CpuQuota`/`CpuPeriod` are not).
 * Rounded (not floored/ceiled) to the nearest microsecond, then raised to Docker's own protocol minimum
 * if the computed value would fall below it. */
export function cpuQuotaFor(memoryMbytes: number): number {
	const rawQuota = dedicatedCpusFor(memoryMbytes) * CPU_PERIOD_US;
	return Math.max(MIN_CPU_QUOTA_US, Math.round(rawQuota));
}

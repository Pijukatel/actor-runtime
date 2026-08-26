/** Memory (MB) granted one full CPU core, per the platform's own memory-to-CPU ratio. */
const MEMORY_MBYTES_PER_CPU = 4096;

/** Docker's CFS period, in microseconds - the denominator `CpuQuota` is expressed against. */
export const CPU_PERIOD_US = 100_000;

/** Docker's protocol minimum for `HostConfig.CpuQuota` - a floor on the encoding, not a host clamp. */
const MIN_CPU_QUOTA_US = 1000;

/** The run's dedicated CPU cores, derived from its memory grant alone. */
export function dedicatedCpusFor(memoryMbytes: number): number {
	return memoryMbytes / MEMORY_MBYTES_PER_CPU;
}

/** `HostConfig.CpuQuota` for a run granted `memoryMbytes`, paired with `CPU_PERIOD_US`. */
export function cpuQuotaFor(memoryMbytes: number): number {
	const rawQuota = dedicatedCpusFor(memoryMbytes) * CPU_PERIOD_US;
	return Math.max(MIN_CPU_QUOTA_US, Math.round(rawQuota));
}

// Apify SDK - toolkit for building Apify Actors (Read more at https://docs.apify.com/sdk/js/)
import { Actor, log } from 'apify';

/**
 * The fields this sample reads off a runtime `systemInfo` frame. The SDK's platform event manager
 * re-emits each frame verbatim (`events.emit(name, data)`), so what arrives is the runtime's own
 * payload rather than a Crawlee-normalized one; only the fields printed below are declared here.
 */
interface SystemInfoFrame {
	cpuCurrentUsage?: number;
	isCpuOverloaded?: boolean;
	memCurrentBytes?: number;
	memMaxBytes?: number;
}

// The runtime publishes one systemInfo frame per second. The extra time covers container startup
// before the first frame lands, so a healthy run never trips the deadline.
const GRACE_MS = 10_000;

await Actor.init();

const input = await Actor.getInput<{ samples?: number }>();
const wanted = input?.samples ?? 5;

// Granted resources come from the SDK's environment view: `getEnv()` reads ACTOR_MEMORY_MBYTES /
// APIFY_MEMORY_MBYTES. The SDK's env map has no dedicated-CPU key, so that one is read straight from
// the environment - the runtime sets it for both SDKs, and Python's configuration does expose it.
const { memoryMbytes } = Actor.getEnv();
const dedicatedCpus = process.env.APIFY_DEDICATED_CPUS ? Number(process.env.APIFY_DEDICATED_CPUS) : undefined;

log.info('Granted to this run (SDK environment):');
log.info(`  memory: ${memoryMbytes} MB`);
log.info(`  CPU:    ${dedicatedCpus ?? 'unknown'} core(s)`);

const collected: SystemInfoFrame[] = [];
let markEnough: () => void = () => {};
const enough = new Promise<void>((resolve) => {
	markEnough = resolve;
});

// Used resources arrive on the SDK's event manager, which subscribes to the events websocket named
// by ACTOR_EVENTS_WEBSOCKET_URL and emits one `systemInfo` per frame the runtime samples.
const reportUsage = (frame: SystemInfoFrame) => {
	collected.push(frame);
	// `cpuCurrentUsage` is a percentage of one core, so dividing it by the grant yields the same
	// share-of-grant figure the Python SDK computes for its own consumers.
	const shareOfGrant =
		frame.cpuCurrentUsage !== undefined && dedicatedCpus ? frame.cpuCurrentUsage / 100 / dedicatedCpus : undefined;
	const usedMemoryMb = frame.memCurrentBytes !== undefined ? frame.memCurrentBytes / 1024 / 1024 : undefined;
	const shareText = shareOfGrant !== undefined ? ` (${(shareOfGrant * 100).toFixed(1)}% of the grant)` : '';
	log.info(
		`sample ${collected.length}/${wanted}: CPU ${frame.cpuCurrentUsage?.toFixed(1)}% of one core${shareText}, ` +
			`memory ${usedMemoryMb?.toFixed(1)} MB, overloaded: ${frame.isCpuOverloaded}`,
	);
	if (collected.length >= wanted) markEnough();
};

Actor.on('systemInfo', reportUsage);

let deadlineTimer: NodeJS.Timeout | undefined;
const deadline = new Promise<void>((resolve) => {
	deadlineTimer = setTimeout(resolve, wanted * 1000 + GRACE_MS);
});
await Promise.race([enough, deadline]);
if (deadlineTimer) clearTimeout(deadlineTimer);
Actor.off('systemInfo', reportUsage);

if (collected.length < wanted) {
	log.warning(
		`Only ${collected.length} of ${wanted} systemInfo event(s) arrived. Without ACTOR_EVENTS_WEBSOCKET_URL the ` +
			'SDK has no platform events to subscribe to, so usage stays unreported and Crawlee autoscaling would ' +
			'have no resource signal either.',
	);
}

// Indexed rather than `.at(-1)`: this sample's tsconfig narrows `lib` to DOM, which drops the
// ES2022 array helpers.
const last = collected[collected.length - 1];
await Actor.pushData({
	grantedMemoryMbytes: memoryMbytes,
	grantedCpus: dedicatedCpus ?? null,
	samplesObserved: collected.length,
	lastUsedCpuPercentOfOneCore: last?.cpuCurrentUsage ?? null,
	lastUsedMemoryBytes: last?.memCurrentBytes ?? null,
	// The frame's own view of the grant, so the two independent paths can be compared.
	lastReportedMemoryLimitBytes: last?.memMaxBytes ?? null,
});

// Gracefully exit the Actor process. It's recommended to quit all Actors with an exit()
await Actor.exit();

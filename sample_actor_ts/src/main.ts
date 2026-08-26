// Apify SDK - toolkit for building Apify Actors (Read more at https://docs.apify.com/sdk/js/)
import { Actor, log } from 'apify';
// Crawlee - web scraping and browser automation library (Read more at https://crawlee.dev)
import { CheerioCrawler } from '@crawlee/cheerio';

// The init() call configures the Actor to correctly work with the Apify-provided environment - mainly the storage infrastructure. It is necessary that every Actor performs an init() call.
await Actor.init();

interface Input {
	startUrl?: string;
	maxPages?: number;
}

const { memoryMbytes } = Actor.getEnv();
log.info(
	`Resources granted to this run: ${memoryMbytes} MB memory, ${process.env.APIFY_DEDICATED_CPUS ?? 'unknown'} CPU core(s).`,
);

// The runtime measures this container and relays a systemInfo event once a second.
Actor.on('systemInfo', (info: { cpuCurrentUsage?: number; memCurrentBytes?: number; isCpuOverloaded?: boolean }) => {
	const memoryMb = info.memCurrentBytes !== undefined ? (info.memCurrentBytes / 1024 / 1024).toFixed(1) : 'unknown';
	log.info(
		`Resource usage: CPU ${info.cpuCurrentUsage?.toFixed(1)}% of one core, memory ${memoryMb} MB, ` +
			`CPU overloaded: ${info.isCpuOverloaded}`,
	);
});

const input = await Actor.getInput<Input>();
const startUrl = input?.startUrl ?? 'https://crawlee.dev/';
const maxPages = input?.maxPages ?? 2;

log.info(`Crawling up to ${maxPages} page(s) starting from ${startUrl}.`);

// Crawling through the Actor's request queue exercises the runtime's request-queue endpoints
// end to end: batch-add, head/lock, getRequest, and mark-handled all fire against the runtime.
const requestQueue = await Actor.openRequestQueue();
await requestQueue.addRequest({ url: startUrl });

const crawler = new CheerioCrawler({
	requestQueue,
	maxRequestsPerCrawl: maxPages,
	// Sequential crawling keeps the dataset item count exactly equal to maxPages - with higher
	// concurrency, requests already in flight when the limit is reached still finish and overshoot.
	maxConcurrency: 1,
	async requestHandler({ request, $, enqueueLinks }) {
		log.info(`Processing ${request.url}`);
		await enqueueLinks();
		const title = $('title').text() || $('h1').first().text();
		await Actor.pushData({ url: request.url, title });
	},
});

await crawler.run();

log.info('Crawl finished.');

// Gracefully exit the Actor process. It's recommended to quit all Actors with an exit()
await Actor.exit();

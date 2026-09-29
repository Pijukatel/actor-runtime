// Apify SDK - toolkit for building Apify Actors (Read more at https://docs.apify.com/sdk/js/)
import { Actor, log } from 'apify';
// Crawlee - web scraping and browser automation library (Read more at https://crawlee.dev)
import { CheerioCrawler } from '@crawlee/cheerio';

// The init() call configures the Actor to correctly work with the Apify-provided environment - mainly the storage infrastructure. It is necessary that every Actor performs an init() call.
await Actor.init();

interface Input {
	startUrl: string;
	maxPages: number;
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

// Under pay-per-event pricing (set on the Actor through the runtime's API or console) this Actor charges
// two events: 'page-scraped' once per page and 'crawl-finished' once at the end. A free Actor skips both,
// so a plain push-and-call stays unchanged. `pricing.json` prices two more, 'apify-actor-start' and
// 'apify-default-dataset-item': those are charged by the runtime itself, which is why no code here
// charges them.
const { isPayPerEvent, maxTotalChargeUsd } = Actor.getChargingManager().getPricingInfo();
if (isPayPerEvent) {
	const cap = Number.isFinite(maxTotalChargeUsd) ? `$${maxTotalChargeUsd}` : 'none';
	log.info(`Pay-per-event pricing in effect, max total charge: ${cap}.`);
}

// Both fields have a `default` in the input schema, so the runtime fills them in before the run
// starts (the Apify platform does the same) - the Actor needs no fallback of its own.
const input = await Actor.getInput<Input>();
if (!input) throw new Error('No input: the input schema should have supplied its defaults.');
const { startUrl, maxPages } = input;

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
		if (isPayPerEvent) {
			const charge = await Actor.charge({ eventName: 'page-scraped' });
			log.info(
				`Charged ${charge.chargedCount} 'page-scraped' event(s); limit reached: ${charge.eventChargeLimitReached}.`,
			);
			// Nothing more can be charged, so nothing more should be scraped.
			if (charge.eventChargeLimitReached) await crawler.autoscaledPool?.abort();
		}
	},
});

await crawler.run();

if (isPayPerEvent) {
	// Charged once the work is done, so a run that hit its cap mid-crawl charges nothing here.
	const charge = await Actor.charge({ eventName: 'crawl-finished' });
	log.info(`Charged ${charge.chargedCount} 'crawl-finished' event(s).`);
}

log.info('Crawl finished.');

// Gracefully exit the Actor process. It's recommended to quit all Actors with an exit()
await Actor.exit();

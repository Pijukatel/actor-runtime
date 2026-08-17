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

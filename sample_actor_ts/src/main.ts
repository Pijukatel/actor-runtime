// Apify SDK - toolkit for building Apify Actors (Read more at https://docs.apify.com/sdk/js/)
import { Actor, log } from 'apify';
// Crawlee - web scraping and browser automation library (Read more at https://crawlee.dev)
import { CheerioCrawler } from '@crawlee/cheerio';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

// The init() call configures the Actor to correctly work with the Apify-provided environment - mainly the storage infrastructure. It is necessary that every Actor performs an init() call.
await Actor.init();

interface Input {
	maxPages?: number;
}

const input = await Actor.getInput<Input>();
const maxPages = input?.maxPages ?? 2;

log.info(`Crawling ${maxPages} page(s).`);

/**
 * A tiny in-container HTTP server that serves `maxPages` linked pages: page `i` links to page
 * `i + 1` (up to `maxPages`), so a link-following crawler starting at page 1 discovers exactly
 * `maxPages` pages. This keeps the whole run offline - no outbound network access is needed - which
 * is what lets the e2e test assert an input-dependent dataset item count deterministically.
 */
function pageHtml(pageNumber: number): string {
	const hasNext = pageNumber < maxPages;
	const link = hasNext ? `<a href="/page/${pageNumber + 1}">next</a>` : '';
	return `<!doctype html><html><body><h1>Page ${pageNumber}</h1>${link}</body></html>`;
}

const server = createServer((req, res) => {
	const match = req.url?.match(/^\/page\/(\d+)$/);
	if (!match) {
		res.writeHead(404).end('Not found');
		return;
	}
	const pageNumber = Number(match[1]);
	if (pageNumber < 1 || pageNumber > maxPages) {
		res.writeHead(404).end('Not found');
		return;
	}
	res.writeHead(200, { 'Content-Type': 'text/html' }).end(pageHtml(pageNumber));
});

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address() as AddressInfo;
const startUrl = `http://127.0.0.1:${port}/page/1`;

// Crawling through the Actor's request queue exercises the runtime's request-queue endpoints
// end to end: batch-add, head/lock, getRequest, and mark-handled all fire against the runtime.
const requestQueue = await Actor.openRequestQueue();
await requestQueue.addRequest({ url: startUrl });

const crawler = new CheerioCrawler({
	requestQueue,
	async requestHandler({ request, $, enqueueLinks }) {
		log.info(`Processing ${request.url}`);
		await enqueueLinks();
		await Actor.pushData({ url: request.url, title: $('h1').text() });
	},
});

await crawler.run();

server.close();

log.info('Crawl finished.');

// Gracefully exit the Actor process. It's recommended to quit all Actors with an exit()
await Actor.exit();

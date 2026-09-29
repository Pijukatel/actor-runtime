// Based on Apify's `ts-crawlee-playwright-chrome` template; the one deliberate change is `headless: false`
// (see README.md).

// For more information, see https://crawlee.dev
import { PlaywrightCrawler } from '@crawlee/playwright';
// For more information, see https://docs.apify.com/sdk/js
import { Actor, log } from 'apify';

// this is ESM project, and as such, it requires you to specify extensions in your relative imports
// read more about this here: https://nodejs.org/docs/latest-v18.x/api/esm.html#mandatory-file-extensions
// note that we need to use `.js` even when inside TS files
import { router } from './routes.js';

interface Input {
	startUrls: {
		url: string;
		method?: 'GET' | 'HEAD' | 'POST' | 'PUT' | 'DELETE' | 'TRACE' | 'OPTIONS' | 'CONNECT' | 'PATCH';
		headers?: Record<string, string>;
		userData?: Record<string, unknown>;
	}[];
	maxRequestsPerCrawl: number;
}

// Initialize the Apify SDK
await Actor.init();

// Structure of input is defined in .actor/input_schema.json. Every field has a `default` there, so
// the runtime fills it in before the run starts - the Actor needs no fallback of its own.
const input = await Actor.getInput<Input>();
if (!input) throw new Error('No input: the input schema should have supplied its defaults.');
const { startUrls, maxRequestsPerCrawl } = input;

// Without a proxy password (a plain local run) the crawler connects directly instead of failing the access check.
const proxyConfiguration = process.env.APIFY_PROXY_PASSWORD
	? await Actor.createProxyConfiguration({ checkAccess: true })
	: undefined;

log.info(
	`Crawling up to ${maxRequestsPerCrawl} page(s) with a headful Chrome, starting from ${startUrls.map((s) => s.url).join(', ')}.`,
);

const crawler = new PlaywrightCrawler({
	proxyConfiguration,
	maxRequestsPerCrawl,
	requestHandler: router,
	// Keeps the dataset item count exactly equal to maxRequestsPerCrawl.
	maxConcurrency: 1,
	// Headful always, so actor-runtime's browser view has something to show and watching changes nothing.
	// The base image's Xvfb provides the display.
	headless: false,
	launchContext: {
		launchOptions: {
			args: [
				'--disable-gpu', // Mitigates the "crashing GPU process" issue in Docker containers
			],
		},
	},
});

await crawler.run(startUrls);

// Exit successfully
await Actor.exit();

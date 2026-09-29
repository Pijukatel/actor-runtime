import { PLAYWRIGHT_BASE_IMAGE } from './helpers/docker.js';
import { CRAWL_START_URL, describeBrowserViewSuite } from './helpers/browser-view-suite.js';

describeBrowserViewSuite({
	dir: 'actor_playwright',
	label: 'TypeScript',
	baseImage: PLAYWRIGHT_BASE_IMAGE,
	input: (maxRequests) => ({ maxRequestsPerCrawl: maxRequests, startUrls: [{ url: CRAWL_START_URL }] }),
	withToggleClearedCase: true,
});

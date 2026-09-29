import { PYTHON_PLAYWRIGHT_BASE_IMAGE } from './helpers/docker.js';
import { CRAWL_START_URL, describeBrowserViewSuite } from './helpers/browser-view-suite.js';

describeBrowserViewSuite({
	dir: 'actor_playwright_py',
	label: 'Python',
	baseImage: PYTHON_PLAYWRIGHT_BASE_IMAGE,
	input: (maxRequests) => ({ max_requests_per_crawl: maxRequests, start_urls: [{ url: CRAWL_START_URL }] }),
	withToggleClearedCase: false,
});

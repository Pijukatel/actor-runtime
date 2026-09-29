import { createPlaywrightRouter } from '@crawlee/playwright';

export const router = createPlaywrightRouter();

// One handler for every page: record it, then follow same-hostname links until maxRequestsPerCrawl is hit.
router.addDefaultHandler(async ({ request, page, log, pushData, enqueueLinks }) => {
	const title = await page.title();
	log.info(`Processing ${request.loadedUrl} - ${title}`);

	await pushData({
		url: request.loadedUrl,
		title,
	});

	await enqueueLinks({ strategy: 'same-hostname' });
});

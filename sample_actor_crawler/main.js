/**
 * Sample Actor demonstrating a Cheerio-based crawl through Apify Proxy.
 *
 * Adapted from the Apify SDK's own CheerioCrawler guide. Reads `startUrl`
 * and `proxyConfiguration` (see `.actor/input_schema.json`) and passes the
 * latter straight to `Actor.createProxyConfiguration` with no fallback: only
 * an explicit `{"useApifyProxy": false}` crawls direct -- an omitted
 * `proxyConfiguration` behaves like `useApifyProxy: true`, not like `false`
 * -- and either way, `useApifyProxy: true` with a missing or invalid
 * `APIFY_PROXY_PASSWORD` fails the run via the SDK's own live proxy-access
 * check. See README.md's "Apify Proxy" section for the full explanation.
 */
import { Actor } from 'apify';
import { CheerioCrawler } from 'crawlee';

await Actor.main(async () => {
    const actorInput = (await Actor.getInput()) ?? {};
    const startUrl = actorInput.startUrl ?? 'https://crawlee.dev';

    const proxyConfiguration = await Actor.createProxyConfiguration(actorInput.proxyConfiguration);

    const crawler = new CheerioCrawler({
        proxyConfiguration,
        // Crawl limit: 10 pages total, seed URL counted.
        maxRequestsPerCrawl: 10,
        async requestHandler({ request, $, enqueueLinks, pushData, log }) {
            log.info(`Scraping ${request.url} ...`);

            await pushData({
                url: request.url,
                title: $('title').first().text() || null,
                headings: $('h1, h2, h3')
                    .map((_, el) => $(el).text())
                    .get(),
            });

            await enqueueLinks({ strategy: 'same-domain' });
        },
    });

    await crawler.run([startUrl]);
});

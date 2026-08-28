// Apify SDK - toolkit for building Apify Actors (https://docs.apify.com/sdk/js/)
import { Actor, log } from 'apify';
// Crawlee - web scraping and browser automation library (https://crawlee.dev)
import { CheerioCrawler } from '@crawlee/cheerio';
// impit impersonates a real browser's TLS fingerprint - moebelix.cz sits behind Cloudflare, whose
// TLS fingerprinting otherwise flags Node's own TLS stack as a bot no matter which proxy IP is used.
import { ImpitHttpClient, Browser } from '@crawlee/impit-client';
await Actor.init();
const BASE_URL = 'https://www.moebelix.cz';
const CATEGORY_HUB_URL = `${BASE_URL}/c/nabytek`;
const MEDIA_BASE_URL = 'https://media.moebelix.com/i/moebelix';
const input = (await Actor.getInput()) ?? {};
const maxItems = input.maxItems ?? 60;
const maxConcurrency = input.maxConcurrency ?? 5;
const proxyConfiguration = await Actor.createProxyConfiguration(input.proxyConfiguration ?? { useApifyProxy: true });
if (!proxyConfiguration) {
    log.warning('Running without a proxy - moebelix.cz sits behind Cloudflare and will most likely block direct requests. ' +
        'Enable Apify Proxy in the input (and provide APIFY_PROXY_PASSWORD in the environment).');
}
/** Case- and diacritics-insensitive form used to match category names ("Židle" -> "zidle"). */
const normalize = (value) => value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
/**
 * Extracts the Apollo GraphQL state the site server-renders into every page. The JSON is valid
 * except for `\<` escapes the site uses to defuse `</script>` inside strings, so those are
 * unescaped first.
 */
function parseApolloState(body) {
    const marker = body.indexOf('window.__APOLLO_STATE__');
    if (marker === -1)
        return null;
    const start = body.indexOf('{', marker);
    const end = body.indexOf('</script>', start);
    if (start === -1 || end === -1)
        return null;
    let blob = body.slice(start, end).trim();
    if (blob.endsWith(';'))
        blob = blob.slice(0, -1);
    try {
        return JSON.parse(blob.replace(/\\</g, '<'));
    }
    catch (err) {
        log.warning(`Failed to parse window.__APOLLO_STATE__: ${err.message}`);
        return null;
    }
}
/** Finds the category search result (product list + pagination) inside the Apollo state. */
function findApolloSearch(state) {
    for (const entity of Object.values(state)) {
        if (!entity || typeof entity !== 'object')
            continue;
        for (const value of Object.values(entity)) {
            if (value && typeof value === 'object' && Array.isArray(value.searchResults)) {
                return value;
            }
        }
    }
    return null;
}
function productToItem(product, category, categoryUrl, page) {
    const cdnFilename = product.mediaData?.presentation?.[0]?.cdnFilename;
    return {
        name: product.name ?? null,
        url: product.url ? new URL(product.url, BASE_URL).href : null,
        productId: product.code ?? null,
        price: product.priceData?.currentPrice?.value ?? null,
        currency: product.priceData?.currentPrice?.currencyIso ?? 'CZK',
        oldPrice: product.priceData?.oldPrice?.value ?? null,
        availability: product.availabilityStatus ?? null,
        averageRating: product.averageRating ?? null,
        numberOfReviews: product.numberOfReviews ?? null,
        color: product.color ?? null,
        freeDelivery: product.freeDelivery ?? null,
        imageUrl: cdnFilename ? `${MEDIA_BASE_URL}/${cdnFilename}` : null,
        category,
        categoryUrl,
        listingPage: page,
    };
}
/** DOM fallback used when the Apollo state is missing or fails to parse. */
function productsFromDom($, category, categoryUrl, page) {
    const items = [];
    $('article[data-testid="productTile"]').each((_, tile) => {
        const $tile = $(tile);
        const link = $tile.find('a[data-purpose="productTile.link.product"]').first();
        const href = link.attr('href');
        const priceText = $tile.find('[data-purpose="product.price.current"]').first().text();
        const priceMatch = priceText.replace(/\s| /g, '').match(/(\d+)/);
        items.push({
            name: link.text().trim() || null,
            url: href ? new URL(href, BASE_URL).href : null,
            productId: link.attr('data-product-id') ?? null,
            price: priceMatch ? Number(priceMatch[1]) : null,
            currency: 'CZK',
            oldPrice: null,
            availability: null,
            averageRating: null,
            numberOfReviews: null,
            color: null,
            freeDelivery: null,
            imageUrl: $tile.find('img').first().attr('src') ?? null,
            category,
            categoryUrl,
            listingPage: page,
        });
    });
    return items;
}
function listingPageUrl(categoryUrl, page) {
    const url = new URL(categoryUrl);
    if (page > 1)
        url.searchParams.set('page', String(page));
    else
        url.searchParams.delete('page');
    return url.href;
}
let pushedCount = 0;
const crawler = new CheerioCrawler({
    proxyConfiguration,
    maxConcurrency,
    ignoreSslErrors: input.ignoreSslErrors ?? false,
    httpClient: new ImpitHttpClient({
        browser: Browser.Chrome,
        ignoreTlsErrors: input.ignoreSslErrors ?? false,
    }),
    // Cloudflare intermittently challenges individual proxy sessions with a 403; the session pool
    // retires the blocked session and a retry with a fresh one virtually always passes, so allow
    // a generous number of retries.
    maxRequestRetries: 12,
    useSessionPool: true,
    persistCookiesPerSession: true,
    sessionPoolOptions: {
        sessionOptions: { maxUsageCount: 30 },
    },
    async requestHandler(context) {
        const { request, $, body, crawler: crawlerRef, session } = context;
        // Cloudflare sometimes serves its challenge with HTTP 200 - detect it and retry on a new session.
        const pageTitle = $('title').first().text();
        if (/just a moment/i.test(pageTitle)) {
            session?.retire();
            throw new Error('Blocked by Cloudflare challenge page, retrying with a new session.');
        }
        if (request.label === 'CATEGORY_HUB') {
            const wanted = normalize(request.userData.category);
            const candidates = [];
            $('[data-testid="categoryCard"] a[title][href]').each((_, el) => {
                const title = $(el).attr('title').trim();
                const href = $(el).attr('href');
                if (title && href)
                    candidates.push({ title, url: new URL(href, BASE_URL).href });
            });
            if (candidates.length === 0) {
                throw new Error('No category cards found on the category hub page - the page may have changed or been blocked.');
            }
            const slugOf = (url) => normalize(new URL(url).pathname.replace(/^\//, '').replace(/-C[0-9A-Za-z]+$/, '').replace(/-/g, ' '));
            const match = candidates.find((c) => normalize(c.title) === wanted) ??
                candidates.find((c) => slugOf(c.url) === wanted) ??
                candidates.find((c) => normalize(c.title).startsWith(wanted) || slugOf(c.url).startsWith(wanted)) ??
                candidates.find((c) => normalize(c.title).includes(wanted) || slugOf(c.url).includes(wanted));
            if (!match) {
                const available = candidates.map((c) => c.title).join(', ');
                throw new Error(`Category "${request.userData.category}" not found on ${CATEGORY_HUB_URL}. Available categories: ${available}`);
            }
            log.info(`Category "${request.userData.category}" resolved to "${match.title}" (${match.url}).`);
            await crawlerRef.addRequests([
                {
                    url: match.url,
                    label: 'LIST',
                    userData: { category: match.title, categoryUrl: match.url, page: 1 },
                },
            ]);
            return;
        }
        // LIST page
        const category = request.userData.category;
        const categoryUrl = request.userData.categoryUrl;
        const page = request.userData.page;
        const state = parseApolloState(body.toString());
        const search = state ? findApolloSearch(state) : null;
        let items;
        let totalPages = 1;
        if (search) {
            items = search.searchResults.map((product) => productToItem(product, category, categoryUrl, page));
            totalPages = search.pagination?.totalPages ?? 1;
            if (page === 1) {
                const total = search.pagination?.totalResults;
                log.info(`Category "${category}" has ${total ?? 'unknown'} products on ${totalPages} page(s).`);
            }
        }
        else {
            log.warning(`Falling back to DOM extraction on ${request.url} (Apollo state unavailable).`);
            items = productsFromDom($, category, categoryUrl, page);
            // The DOM fallback cannot see total page count; keep paginating until a page comes back empty.
            totalPages = items.length > 0 ? page + 1 : page;
            if (items.length === 0) {
                // A listing page with neither the Apollo state nor product tiles is almost certainly a
                // disguised block page (Cloudflare sometimes serves its challenge with HTTP 200), not a
                // genuinely empty category - an empty category still renders the Apollo state with zero
                // results. Retry on a fresh session.
                session?.retire();
                throw new Error(`Listing page ${request.url} contained no product data, retrying with a new session.`);
            }
        }
        if (items.length === 0) {
            log.warning(`No products found on ${request.url} - the category appears to be empty.`);
            return;
        }
        const remaining = maxItems - pushedCount;
        if (remaining <= 0)
            return;
        const toPush = items.slice(0, remaining);
        pushedCount += toPush.length;
        await Actor.pushData(toPush);
        log.info(`Page ${page}: scraped ${toPush.length} product(s), total ${pushedCount}/${maxItems}.`);
        // Enqueue follow-up listing pages (only from page 1 so each page is enqueued exactly once).
        if (page === 1 && pushedCount < maxItems && totalPages > 1) {
            const pageSize = items.length || 60;
            const lastPageNeeded = Math.min(totalPages, Math.ceil(maxItems / pageSize));
            const requests = [];
            for (let next = 2; next <= lastPageNeeded; next++) {
                requests.push({
                    url: listingPageUrl(categoryUrl, next),
                    label: 'LIST',
                    userData: { category, categoryUrl, page: next },
                });
            }
            if (requests.length > 0)
                await crawlerRef.addRequests(requests);
        }
        else if (!search && pushedCount < maxItems && items.length > 0) {
            // DOM-fallback pagination: page count unknown, so walk pages sequentially.
            await crawlerRef.addRequests([
                {
                    url: listingPageUrl(categoryUrl, page + 1),
                    label: 'LIST',
                    userData: { category, categoryUrl, page: page + 1 },
                },
            ]);
        }
    },
});
if (input.categoryUrl) {
    log.info(`Scraping category listing ${input.categoryUrl} (max ${maxItems} items).`);
    await crawler.run([
        {
            url: input.categoryUrl,
            label: 'LIST',
            userData: { category: input.category ?? input.categoryUrl, categoryUrl: input.categoryUrl, page: 1 },
        },
    ]);
}
else {
    const category = input.category?.trim();
    if (!category) {
        throw new Error('Either "category" or "categoryUrl" must be provided in the input.');
    }
    log.info(`Looking up category "${category}" on ${CATEGORY_HUB_URL} (max ${maxItems} items).`);
    await crawler.run([
        {
            url: CATEGORY_HUB_URL,
            label: 'CATEGORY_HUB',
            userData: { category },
        },
    ]);
}
log.info(`Finished - scraped ${pushedCount} product(s).`);
await Actor.exit();
//# sourceMappingURL=main.js.map
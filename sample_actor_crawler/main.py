"""Sample Actor demonstrating a Parsel-based crawl through Apify Proxy.

Adapted from the Apify SDK's own ParselCrawler guide. Reads ``startUrl`` and
``proxyConfiguration`` (see ``.actor/input_schema.json``) and passes the
latter straight to ``Actor.create_proxy_configuration`` with no fallback:
only an explicit ``{"useApifyProxy": false}`` crawls direct -- an omitted
``proxyConfiguration`` behaves like ``useApifyProxy: true``, not like
``false`` -- and either way, ``useApifyProxy: true`` with a missing or
invalid ``APIFY_PROXY_PASSWORD`` fails the run via the SDK's own live
proxy-access check. See README.md's "Apify Proxy" section for the full
explanation.
"""
import asyncio

from crawlee.crawlers import ParselCrawler, ParselCrawlingContext
from crawlee.router import Router

from apify import Actor

router = Router[ParselCrawlingContext]()


@router.default_handler
async def request_handler(context: ParselCrawlingContext) -> None:
    Actor.log.info(f"Scraping {context.request.url} ...")

    data = {
        "url": context.request.url,
        "title": context.selector.xpath("//title/text()").get(),
        "headings": context.selector.xpath("//h1/text() | //h2/text() | //h3/text()").getall(),
    }
    await context.push_data(data)

    await context.enqueue_links(strategy="same-domain")


async def main() -> None:
    async with Actor:
        actor_input = await Actor.get_input() or {}
        start_url = actor_input.get("startUrl", "https://crawlee.dev")

        proxy_configuration = await Actor.create_proxy_configuration(
            actor_proxy_input=actor_input.get("proxyConfiguration")
        )

        crawler = ParselCrawler(
            proxy_configuration=proxy_configuration,
            request_handler=router,
            # Crawl limit: 10 pages total, seed URL counted.
            max_requests_per_crawl=10,
        )

        await crawler.run([start_url])


if __name__ == "__main__":
    asyncio.run(main())

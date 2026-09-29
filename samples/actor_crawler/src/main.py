"""Sample Actor demonstrating a Parsel-based crawl through Apify Proxy."""

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
        # Both fields have a `default` in the input schema, so the runtime fills them in before the
        # run starts (the Apify platform does the same) - the Actor needs no fallback of its own.
        actor_input = await Actor.get_input() or {}
        start_url = actor_input["startUrl"]

        proxy_configuration = await Actor.create_proxy_configuration(
            actor_proxy_input=actor_input["proxyConfiguration"]
        )

        crawler = ParselCrawler(
            proxy_configuration=proxy_configuration,
            request_handler=router,
            # Crawl limit: 10 pages total, seed URL counted.
            max_requests_per_crawl=10,
        )

        await crawler.run([start_url])

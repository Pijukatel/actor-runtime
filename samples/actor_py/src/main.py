"""Python sample actor for actor-runtime.

Mirrors `samples/actor_ts`: crawls a live site (`startUrl` input, defaulting to
`https://crawlee.dev/`) up to `maxPages` pages with `ParselCrawler` over the Actor's default
request queue, pushes one dataset item per page, and charges the same pay-per-event events.
Also writes to the extra datasets `.actor/actor.json` declares besides the default one.
"""

from __future__ import annotations

from apify import Actor, Event, EventSystemInfoData
from crawlee import ConcurrencySettings
from crawlee.crawlers import ParselCrawler, ParselCrawlingContext


async def main() -> None:
    async with Actor:
        config = Actor.configuration
        Actor.log.info(
            f'Resources granted to this run: {config.memory_mbytes} MB memory, {config.dedicated_cpus} CPU core(s).'
        )

        # The runtime measures this container and relays a systemInfo event once a second.
        async def log_resource_usage(event_data: EventSystemInfoData) -> None:
            Actor.log.info(
                f'Resource usage: CPU {event_data.cpu_info.used_ratio:.1%} of the grant, '
                f'memory {event_data.memory_info.current_size.to_mb():.1f} MB'
            )

        Actor.on(Event.SYSTEM_INFO, log_resource_usage)

        # Under pay-per-event pricing (set on the Actor through the runtime's API or console) this Actor
        # charges two events: 'page-scraped' once per page and 'crawl-finished' once at the end. A free
        # Actor skips both, so a plain push-and-call stays unchanged. `pricing.json` prices two more,
        # 'apify-actor-start' and 'apify-default-dataset-item': those are charged by the runtime itself,
        # which is why no code here charges them.
        pricing = Actor.get_charging_manager().get_pricing_info()
        if pricing.is_pay_per_event:
            cap = f'${pricing.max_total_charge_usd}' if pricing.max_total_charge_usd.is_finite() else 'none'
            Actor.log.info(f'Pay-per-event pricing in effect, max total charge: {cap}.')

        # Both fields have a `default` in the input schema, so the runtime fills them in before the
        # run starts (the Apify platform does the same) - the Actor needs no fallback of its own.
        actor_input = await Actor.get_input() or {}
        start_url = actor_input['startUrl']
        max_pages = int(actor_input['maxPages'])
        Actor.log.info(f'Crawling up to {max_pages} page(s) starting from {start_url}.')

        # Declared under `storages.datasets` in `.actor/actor.json`, so every run gets them already created.
        page_links_dataset = await Actor.open_dataset(alias='pageLinks')
        summary_dataset = await Actor.open_dataset(alias='summary')
        crawled_urls: list[str] = []

        # Crawling through the Actor's default request queue exercises the runtime's
        # request-queue endpoints end to end via the Python SDK's non-locking dialect:
        # batch_add_requests, list_head, get_request, update_request.
        # Sequential crawling makes the item count deterministic: with concurrency > 1 the
        # autoscaled pool starts extra requests before the max_requests_per_crawl stop lands,
        # and in-progress requests are allowed to finish (overshooting maxPages).
        crawler = ParselCrawler(
            max_requests_per_crawl=max_pages,
            concurrency_settings=ConcurrencySettings(min_concurrency=1, desired_concurrency=1, max_concurrency=1),
        )

        @crawler.router.default_handler
        async def request_handler(context: ParselCrawlingContext) -> None:
            context.log.info(f'Processing {context.request.url}')
            await context.enqueue_links()
            title = context.selector.css('title::text').get()
            await context.push_data({'url': context.request.url, 'title': title})
            links = context.selector.css('a[href]::attr(href)').getall()
            await page_links_dataset.push_data({'url': context.request.url, 'linkCount': len(links)})
            crawled_urls.append(context.request.url)
            if pricing.is_pay_per_event:
                charge = await Actor.charge('page-scraped')
                Actor.log.info(
                    f"Charged {charge.charged_count} 'page-scraped' event(s); "
                    f'limit reached: {charge.event_charge_limit_reached}.'
                )
                # Nothing more can be charged, so nothing more should be scraped.
                if charge.event_charge_limit_reached:
                    crawler.stop(reason='The pay-per-event charge limit was reached.')

        await crawler.run([start_url])
        await summary_dataset.push_data({'startUrl': start_url, 'pagesCrawled': len(crawled_urls), 'urls': crawled_urls})

        if pricing.is_pay_per_event:
            # Charged once the work is done, so a run that hit its cap mid-crawl charges nothing here.
            charge = await Actor.charge('crawl-finished')
            Actor.log.info(f"Charged {charge.charged_count} 'crawl-finished' event(s).")

        Actor.log.info('Crawl finished.')

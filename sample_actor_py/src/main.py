"""Python sample actor for actor-runtime.

Mirrors `sample_actor_ts`: crawls a live site (`startUrl` input, defaulting to
`https://crawlee.dev/`) up to `maxPages` pages with `ParselCrawler` over the Actor's default
request queue, and pushes one dataset item per page.
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

        actor_input = await Actor.get_input() or {}
        start_url = actor_input.get('startUrl', 'https://crawlee.dev/')
        max_pages = int(actor_input.get('maxPages', 2))
        Actor.log.info(f'Crawling up to {max_pages} page(s) starting from {start_url}.')

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

        await crawler.run([start_url])

        Actor.log.info('Crawl finished.')

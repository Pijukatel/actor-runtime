"""Based on Apify's `python-crawlee-playwright` template; the one deliberate change is `headless=False`
(the template hard-codes `headless=True`) - see README.md.

To build Apify Actors, utilize the Apify SDK toolkit, read more at the official documentation:
https://docs.apify.com/sdk/python
"""

from __future__ import annotations

from apify import Actor
from crawlee import ConcurrencySettings
from crawlee.crawlers import PlaywrightCrawler

from .routes import router


async def main() -> None:
    """Define a main entry point for the Apify Actor.

    This coroutine is executed using `asyncio.run()`, so it must remain an asynchronous function for proper execution.
    Asynchronous execution is required for communication with Apify platform, and it also enhances performance in
    the field of web scraping significantly.
    """
    # Enter the context of the Actor.
    async with Actor:
        # Every field has a `default` in the input schema, so the runtime fills it in before the run
        # starts (the Apify platform does the same) - the Actor needs no fallback of its own.
        actor_input = await Actor.get_input() or {}
        start_urls = [url.get('url') for url in actor_input['start_urls']]
        max_requests_per_crawl = int(actor_input['max_requests_per_crawl'])

        # Exit if no start URLs are provided.
        if not start_urls:
            Actor.log.info('No start URLs specified in Actor input, exiting...')
            await Actor.exit()

        Actor.log.info(
            f'Crawling up to {max_requests_per_crawl} page(s) with a headful Chromium, starting from {", ".join(start_urls)}.'
        )

        # Create a crawler.
        crawler = PlaywrightCrawler(
            # Limit the crawl to max requests. Remove or increase it for crawling all links.
            max_requests_per_crawl=max_requests_per_crawl,
            # Keeps the dataset item count exactly equal to max_requests_per_crawl.
            concurrency_settings=ConcurrencySettings(desired_concurrency=1, max_concurrency=1),
            # Headful always, so actor-runtime's browser view has something to show and watching changes
            # nothing. The base image's Xvfb provides the display.
            headless=False,
            browser_launch_options={'args': ['--disable-gpu', '--no-sandbox']},
            # Set the request handler to the request router defined in routes.py.
            request_handler=router,
        )

        # Run the crawler with the starting requests.
        await crawler.run(start_urls)

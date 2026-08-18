"""Runs the whole Apify Python SDK docs pipeline.

Calls `sdk-concept-links` to get the URLs of the SDK concept pages, then hands those URLs to
`sdk-concept-scraper` to scrape each article, and republishes the scraped articles in its own dataset
together with an `OUTPUT` summary of the two child runs.

Both children are started with `Actor.call`, which goes through `APIFY_API_BASE_URL` - the local Actor
runtime's API when the Actors run under it, the real platform otherwise. Nothing here is specific to
either.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any

from apify import Actor

DEFAULT_LINKS_ACTOR = 'sdk-concept-links'
DEFAULT_SCRAPER_ACTOR = 'sdk-concept-scraper'
DEFAULT_START_URL = 'https://docs.apify.com/sdk/python/docs/overview'
DEFAULT_CHILD_TIMEOUT_SECS = 600


async def read_all_items(dataset_id: str) -> list[dict[str, Any]]:
    """Reads a child run's whole dataset, page by page."""
    dataset = Actor.apify_client.dataset(dataset_id)
    items: list[dict[str, Any]] = []
    while True:
        page = await dataset.list_items(offset=len(items))
        items.extend(page.items)
        if len(items) >= page.total or not page.items:
            return items


async def call_child(actor_id: str, run_input: dict[str, Any], timeout: timedelta) -> Any:
    """Starts a child Actor, waits for it, and fails this run if the child did not succeed.

    Returns the child's run record. It is typed `Any` because the SDK does not re-export the
    `apify_client` model it comes from.
    """
    Actor.log.info(f'Calling Actor "{actor_id}" with input {run_input}.')
    run = await Actor.call(actor_id, run_input=run_input, timeout=timeout)

    Actor.log.info(f'Actor "{actor_id}" run {run.id} finished with status {run.status}.')
    if run.status != 'SUCCEEDED':
        raise RuntimeError(f'Actor "{actor_id}" run {run.id} ended as {run.status}: {run.status_message}')
    return run


async def main() -> None:
    async with Actor:
        actor_input = await Actor.get_input() or {}
        links_actor_id = actor_input.get('linksActorId', DEFAULT_LINKS_ACTOR)
        scraper_actor_id = actor_input.get('scraperActorId', DEFAULT_SCRAPER_ACTOR)
        start_url = actor_input.get('startUrl', DEFAULT_START_URL)
        max_concepts = actor_input.get('maxConcepts')
        child_timeout = timedelta(seconds=int(actor_input.get('childRunTimeoutSecs', DEFAULT_CHILD_TIMEOUT_SECS)))

        # Stage 1 - which concept pages are there?
        links_run = await call_child(links_actor_id, {'startUrl': start_url}, child_timeout)
        link_items = await read_all_items(links_run.default_dataset_id)
        urls = [url for item in link_items if (url := item.get('url'))]
        if max_concepts:
            urls = urls[: int(max_concepts)]
        if not urls:
            raise RuntimeError(f'Actor "{links_actor_id}" returned no concept links to scrape.')
        Actor.log.info(f'Got {len(urls)} concept link(s) to scrape.')

        # Stage 2 - scrape each of them.
        scraper_run = await call_child(scraper_actor_id, {'urls': urls}, child_timeout)
        articles = await read_all_items(scraper_run.default_dataset_id)
        Actor.log.info(f'Got {len(articles)} scraped article(s).')

        # The pipeline's own output: every article, plus a summary of how it was produced.
        await Actor.push_data(articles)
        summary = {
            'startUrl': start_url,
            'conceptLinksFound': len(link_items),
            'conceptsRequested': len(urls),
            'articlesScraped': len(articles),
            'totalWords': sum(article.get('wordCount') or 0 for article in articles),
            'runs': {
                'links': {
                    'actorId': links_actor_id,
                    'runId': links_run.id,
                    'datasetId': links_run.default_dataset_id,
                },
                'scraper': {
                    'actorId': scraper_actor_id,
                    'runId': scraper_run.id,
                    'datasetId': scraper_run.default_dataset_id,
                },
            },
        }
        await Actor.set_value('OUTPUT', summary)

        missing = sorted(set(urls) - {article.get('url') for article in articles})
        if missing:
            Actor.log.warning(f'{len(missing)} concept page(s) were not scraped: {missing}')
        Actor.log.info(f'Pipeline finished: {summary}')

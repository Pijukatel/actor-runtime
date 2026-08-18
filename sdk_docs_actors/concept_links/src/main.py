"""Collects links to the Apify Python SDK concept pages.

Fetches one docs page (`startUrl`, by default the SDK overview) and emits every link it finds that
points into the SDK's "concepts" section, one dataset item per concept page. This is the first stage
of the `sdk_docs_actors` pipeline: `orchestrator` calls this Actor and feeds the URLs it returns to
`concept_scraper`.
"""

from __future__ import annotations

import re
from urllib.parse import urldefrag, urljoin, urlparse

from apify import Actor
from crawlee import ConcurrencySettings
from crawlee.crawlers import ParselCrawler, ParselCrawlingContext
from parsel import Selector

DEFAULT_START_URL = 'https://docs.apify.com/sdk/python/docs/overview'
DEFAULT_SECTION_PATH = '/docs/concepts/'

# `docs.apify.com` serves an LLM-friendly `.md` twin of every page, and the links to it carry a
# duplicated `/sdk/python` prefix (`/sdk/python/sdk/python/docs/concepts/storages.md`). Collapsing the
# repeat and dropping the suffix maps such a link back onto the human page it duplicates, so the same
# concept is never emitted twice.
_REPEATED_SDK_PREFIX = re.compile(r'(/sdk/python)+')

# Docusaurus renders every heading and sidebar anchor with a zero-width space inside its hash link.
_ZERO_WIDTH_SPACE = '​'


def normalize_link(base_url: str, href: str) -> str | None:
    """Resolves `href` against `base_url` into a canonical, fragment-free page URL.

    Returns `None` for anything that is not an `http(s)` page link (`mailto:`, `javascript:`, ...).
    """
    absolute, _ = urldefrag(urljoin(base_url, href.strip()))
    parsed = urlparse(absolute)
    if parsed.scheme not in {'http', 'https'} or not parsed.netloc:
        return None

    path = _REPEATED_SDK_PREFIX.sub(r'\1', parsed.path)
    path = re.sub(r'\.md$', '', path).rstrip('/')
    return f'{parsed.scheme}://{parsed.netloc}{path}'


def link_text(anchor: Selector) -> str:
    """Flattens an `<a>` element's text into a single whitespace-normalized line.

    The text nodes are concatenated without a separator because they are inline content - the source's
    own whitespace already sits inside them, and inserting more would break up words split across
    nested `<span>`s.
    """
    raw = ''.join(anchor.css('::text').getall())
    return ' '.join(raw.replace(_ZERO_WIDTH_SPACE, ' ').split())


def collect_concept_links(page_url: str, selector: Selector, section_path: str) -> dict[str, str]:
    """Maps every same-host link under `section_path` to its link text, in the order the page lists them."""
    host = urlparse(page_url).netloc
    concepts: dict[str, str] = {}

    for anchor in selector.css('a'):
        href = anchor.attrib.get('href')
        if not href:
            continue
        url = normalize_link(page_url, href)
        if url is None or urlparse(url).netloc != host:
            continue
        # A page *inside* the section always has a path segment after `section_path`; the section's
        # own index page (`/sdk/python/docs/concepts`) does not, and is skipped.
        if section_path not in urlparse(url).path:
            continue
        # The first anchor for a URL wins - on the overview page that is the prose link, whose text
        # reads better than the sidebar's.
        concepts.setdefault(url, link_text(anchor))

    return concepts


async def main() -> None:
    async with Actor:
        actor_input = await Actor.get_input() or {}
        start_url = actor_input.get('startUrl', DEFAULT_START_URL)
        section_path = actor_input.get('sectionPath', DEFAULT_SECTION_PATH)
        max_links = actor_input.get('maxLinks')

        Actor.log.info(f'Collecting "{section_path}" links from {start_url}.')

        # The links all live on a single page, so this is a one-request crawl. ParselCrawler still earns
        # its place: it brings the retry/backoff policy and runs over the Actor's default request queue,
        # exactly like the crawl in `concept_scraper`.
        crawler = ParselCrawler(
            max_requests_per_crawl=1,
            concurrency_settings=ConcurrencySettings(min_concurrency=1, desired_concurrency=1, max_concurrency=1),
        )

        concepts: dict[str, str] = {}

        @crawler.router.default_handler
        async def request_handler(context: ParselCrawlingContext) -> None:
            context.log.info(f'Processing {context.request.url}')
            page_url = context.request.loaded_url or context.request.url
            concepts.update(collect_concept_links(page_url, context.selector, section_path))

        await crawler.run([start_url])

        if not concepts:
            raise RuntimeError(f'Found no "{section_path}" links on {start_url} - the page layout may have changed.')

        items = [
            {
                'url': url,
                'title': title or url.rsplit('/', 1)[-1].replace('-', ' ').title(),
                'slug': url.rsplit('/', 1)[-1],
                'sourceUrl': start_url,
            }
            for url, title in concepts.items()
        ]
        if max_links:
            items = items[: int(max_links)]

        await Actor.push_data(items)
        # A convenience mirror of the dataset for anyone poking at the run's key-value store; the
        # pipeline's actual contract with `orchestrator` is the dataset above.
        await Actor.set_value('CONCEPT_LINKS', [item['url'] for item in items])

        Actor.log.info(f'Collected {len(items)} concept link(s).')

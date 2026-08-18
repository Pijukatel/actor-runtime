"""Scrapes the detailed article of each Apify Python SDK docs page it is given.

Takes a list of docs URLs (`urls`) - typically the ones `concept_links` collected - and pushes one
dataset item per page holding the article's title, description, section headings, prose and code
samples. This is the second stage of the `sdk_docs_actors` pipeline.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from apify import Actor
from crawlee import ConcurrencySettings
from crawlee.crawlers import ParselCrawler, ParselCrawlingContext
from parsel import Selector

DEFAULT_MAX_CONCURRENCY = 5
DEFAULT_MAX_TEXT_LENGTH = 20_000
DEFAULT_MAX_CODE_SAMPLES = 10
MAX_CODE_SAMPLE_LENGTH = 2_000

# Docusaurus wraps the page body in <article>; the other two are fallbacks for a changed layout.
ARTICLE_ROOTS = ('article', 'main', 'body')
# Every heading carries an anchor link whose text is a zero-width space.
_ZERO_WIDTH_SPACE = '​'


def clean_text(parts: list[str]) -> str:
    """Joins raw text nodes into one whitespace-normalized string.

    The nodes are concatenated without a separator: they are inline content, so the source's own
    whitespace already sits inside them and adding more would insert spaces before punctuation and
    inside words split across nested `<span>`s.
    """
    return ' '.join(''.join(parts).replace(_ZERO_WIDTH_SPACE, ' ').split())


def code_block_text(block: Selector) -> str:
    """Reads one `<pre>` block, keeping its line breaks.

    A highlighted Docusaurus code block is a stack of one-line `<span class="token-line">` elements
    with no newline of their own, so the lines have to be rejoined explicitly; anything else (a plain
    `<pre>`) already carries its newlines in its text nodes.
    """
    lines = block.css('.token-line, .code-line')
    if lines:
        return '\n'.join(''.join(line.css('::text').getall()) for line in lines).strip()
    return ''.join(block.css('::text').getall()).strip()


def to_url(source: Any) -> str | None:
    """Accepts both plain URL strings and `{"url": ...}` objects, the way Apify inputs tend to carry URLs."""
    if isinstance(source, str):
        return source.strip() or None
    if isinstance(source, dict):
        url = source.get('url')
        return url.strip() if isinstance(url, str) and url.strip() else None
    return None


def article_root(selector: Selector) -> Selector:
    """Returns the narrowest element that holds the page's own content."""
    for css in ARTICLE_ROOTS:
        root = selector.css(css)
        if root:
            return root[0]
    return selector


def extract_article(url: str, selector: Selector, *, max_text_length: int, max_code_samples: int) -> dict[str, Any]:
    """Turns one docs page into the dataset item this Actor emits."""
    root = article_root(selector)

    title = clean_text(root.css('h1 ::text').getall()) or clean_text(selector.css('title::text').getall())
    description = selector.css('meta[name="description"]::attr(content)').get()

    headings = [
        {'level': int(heading.root.tag[1]), 'text': text}
        for heading in root.css('h2, h3, h4')
        if (text := clean_text(heading.css('::text').getall()))
    ]

    # Paragraphs and list items, in document order, are the readable prose of a docs page; taking them
    # rather than the whole subtree's text keeps navigation, code and admonition chrome out of `text`.
    paragraphs = [text for node in root.css('p, li') if (text := clean_text(node.css('::text').getall()))]
    text = '\n\n'.join(paragraphs)

    blocks = [sample for block in root.css('pre') if (sample := code_block_text(block))]
    code_samples = [sample[:MAX_CODE_SAMPLE_LENGTH] for sample in blocks[:max_code_samples]]

    return {
        'url': url,
        'title': title,
        'description': description,
        'headings': headings,
        'headingCount': len(headings),
        'text': text[:max_text_length],
        'wordCount': len(text.split()),
        'codeSamples': code_samples,
        'codeSampleCount': len(code_samples),
        'scrapedAt': datetime.now(timezone.utc).isoformat(),
    }


async def main() -> None:
    async with Actor:
        actor_input = await Actor.get_input() or {}
        urls = [url for source in actor_input.get('urls') or [] if (url := to_url(source))]
        max_articles = actor_input.get('maxArticles')
        max_text_length = int(actor_input.get('maxTextLength', DEFAULT_MAX_TEXT_LENGTH))
        max_code_samples = int(actor_input.get('maxCodeSamples', DEFAULT_MAX_CODE_SAMPLES))
        max_concurrency = int(actor_input.get('maxConcurrency', DEFAULT_MAX_CONCURRENCY))

        if max_articles:
            urls = urls[: int(max_articles)]
        if not urls:
            raise RuntimeError('No URLs to scrape - pass them in the "urls" input field.')

        Actor.log.info(f'Scraping {len(urls)} article(s).')

        crawler = ParselCrawler(
            concurrency_settings=ConcurrencySettings(
                min_concurrency=1,
                desired_concurrency=min(2, max_concurrency),
                max_concurrency=max_concurrency,
            ),
        )

        @crawler.router.default_handler
        async def request_handler(context: ParselCrawlingContext) -> None:
            context.log.info(f'Processing {context.request.url}')
            article = extract_article(
                context.request.loaded_url or context.request.url,
                context.selector,
                max_text_length=max_text_length,
                max_code_samples=max_code_samples,
            )
            context.log.info(f'"{article["title"]}": {article["wordCount"]} words, {article["headingCount"]} headings')
            await context.push_data(article)

        statistics = await crawler.run(urls)

        scraped = statistics.requests_finished
        Actor.log.info(f'Scraped {scraped}/{len(urls)} article(s), {statistics.requests_failed} failed.')
        if not scraped:
            raise RuntimeError(f'None of the {len(urls)} requested article(s) could be scraped.')

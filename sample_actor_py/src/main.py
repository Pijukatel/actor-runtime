"""Python sample actor for actor-runtime.

Mirrors `sample_actor_ts`: reads a `maxPages` input, serves that many linked pages from a threaded
in-container HTTP server (keeping the whole run offline), crawls them with `ParselCrawler` over the
Actor's default request queue, and pushes one dataset item per page.

Unverified against a real install in this sandbox (no network/pip access here) - the `ParselCrawler` /
`apify` Python SDK shapes below follow the well-established Apify Python Actor template. If a future
Crawlee-Python release has drifted from this shape, the design's documented fallback is a manual
`add_request` / `fetch_next_request` / `mark_request_as_handled` loop against the same request queue,
keeping the same input/output contract.
"""

from __future__ import annotations

import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from apify import Actor
from crawlee.crawlers import ParselCrawler, ParselCrawlingContext


def _page_html(page_number: int, max_pages: int) -> bytes:
    link = f'<a href="/page/{page_number + 1}">next</a>' if page_number < max_pages else ''
    return f'<!doctype html><html><body><h1>Page {page_number}</h1>{link}</body></html>'.encode()


def _make_handler(max_pages: int) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format_: str, *args: Any) -> None:
            # Silence the default stderr access log - it would otherwise interleave with the
            # Actor's own log lines.
            pass

        def do_GET(self) -> None:
            parts = self.path.strip('/').split('/')
            if len(parts) == 2 and parts[0] == 'page' and parts[1].isdigit():
                page_number = int(parts[1])
                if 1 <= page_number <= max_pages:
                    self.send_response(200)
                    self.send_header('Content-Type', 'text/html')
                    self.end_headers()
                    self.wfile.write(_page_html(page_number, max_pages))
                    return
            self.send_response(404)
            self.end_headers()

    return Handler


async def main() -> None:
    async with Actor:
        actor_input = await Actor.get_input() or {}
        max_pages = int(actor_input.get('maxPages', 2))
        Actor.log.info(f'Crawling {max_pages} page(s).')

        server = ThreadingHTTPServer(('127.0.0.1', 0), _make_handler(max_pages))
        port = server.server_address[1]
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()

        try:
            start_url = f'http://127.0.0.1:{port}/page/1'

            # Crawling through the Actor's default request queue exercises the runtime's
            # request-queue endpoints end to end via the Python SDK's non-locking dialect:
            # batch_add_requests, list_head, get_request, update_request.
            crawler = ParselCrawler(max_requests_per_crawl=max_pages)

            @crawler.router.default_handler
            async def request_handler(context: ParselCrawlingContext) -> None:
                context.log.info(f'Processing {context.request.url}')
                await context.enqueue_links()
                title = context.selector.css('h1::text').get()
                await context.push_data({'url': context.request.url, 'title': title})

            await crawler.run([start_url])
        finally:
            server.shutdown()
            thread.join(timeout=5)

        Actor.log.info('Crawl finished.')

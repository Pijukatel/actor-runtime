## Python Playwright sample Actor

A Crawlee for Python `PlaywrightCrawler` Actor from Apify's
[`python-crawlee-playwright`](https://github.com/apify/actor-templates/tree/master/templates/python-crawlee-playwright)
template. It crawls `max_requests_per_crawl` same-hostname pages from `start_urls` with a real Chromium and pushes
`{ url, title, h1s, h2s, h3s }` per page.

The one change from the template is `headless=False` (the template hard-codes `headless=True`): the browser draws
on the base image's Xvfb display, so actor-runtime's **browser view** can show it. Watching changes nothing about
the run.

```bash
cd samples/actor_playwright_py
apify push
apify api POST /actor-runtime/browser-view/<actorId> --body '{"enabled": true}'
apify call --input '{"max_requests_per_crawl": 5}'
```

The run log prints the viewer URL (`http://localhost:3000/runs/<runId>/browser`); the run's console page links to
it too. See the repository README, "Watching an Actor's browser".

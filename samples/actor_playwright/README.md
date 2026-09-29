## Playwright sample Actor

A `PlaywrightCrawler` Actor from Apify's
[`ts-crawlee-playwright-chrome`](https://github.com/apify/actor-templates/tree/master/templates/ts-crawlee-playwright-chrome)
template. It crawls `maxRequestsPerCrawl` same-hostname pages from `startUrls` with a real Chrome and pushes
`{ url, title }` per page.

The one change from the template is `headless: false`: the browser draws on the base image's Xvfb display, so
actor-runtime's **browser view** can show it. Watching changes nothing about the run.

```bash
cd samples/actor_playwright
apify push
apify api POST /actor-runtime/browser-view/<actorId> --body '{"enabled": true}'
apify call --input '{"maxRequestsPerCrawl": 5}'
```

The run log prints the viewer URL (`http://localhost:3000/runs/<runId>/browser`); the run's console page links to
it too. See the repository README, "Watching an Actor's browser".

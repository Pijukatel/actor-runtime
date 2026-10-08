## TypeScript sample actor for actor-runtime

Crawls up to `maxPages` pages from `startUrl` over the Actor's request queue, pushing one dataset item
per page, and charges `page-scraped` / `crawl-finished` under pay-per-event pricing (`pricing.json`).

While it runs it serves a progress page on `ACTOR_WEB_SERVER_PORT`, reachable at the run's
`containerUrl` and framed by the console as the run's live view - the run log names both.

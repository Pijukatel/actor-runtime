# sdk-docs-orchestrator

Runs the whole `sdk_docs_actors` pipeline:

1. `Actor.call("sdk-concept-links")` with `startUrl`, then reads that run's dataset for the concept
   page URLs (capped by `maxConcepts`).
2. `Actor.call("sdk-concept-scraper")` with those URLs, then reads that run's dataset for the scraped
   articles.
3. Pushes every article into its own dataset and writes a summary to the key-value store under
   `OUTPUT`:

```json
{
	"startUrl": "https://docs.apify.com/sdk/python/docs/overview",
	"conceptLinksFound": 9,
	"conceptsRequested": 9,
	"articlesScraped": 9,
	"totalWords": 6710,
	"runs": {
		"links": { "actorId": "sdk-concept-links", "runId": "...", "datasetId": "..." },
		"scraper": { "actorId": "sdk-concept-scraper", "runId": "...", "datasetId": "..." }
	}
}
```

A child run that ends as anything other than `SUCCEEDED` fails this run too, with the child's status
and status message. `linksActorId`/`scraperActorId` accept either an Actor id or an Actor name, so the
defaults work as soon as both children have been pushed. `childRunTimeoutSecs` bounds each child run;
this Actor's own run needs a timeout large enough to cover both (`apify call --timeout 900`).

Part of the `sdk_docs_actors` pipeline - see the [README](../README.md) one directory up.

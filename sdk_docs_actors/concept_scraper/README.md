# sdk-concept-scraper

Scrapes the article of every docs URL passed in `urls` - typically the concept links collected by
[`sdk-concept-links`](../concept_links/README.md) - and pushes one dataset item per page:

```json
{
	"url": "https://docs.apify.com/sdk/python/docs/concepts/storages",
	"title": "Working with storages",
	"description": "...",
	"headings": [{ "level": 2, "text": "Dataset" }],
	"headingCount": 7,
	"text": "...",
	"wordCount": 812,
	"codeSamples": ["async with Actor:\n    ..."],
	"codeSampleCount": 4,
	"scrapedAt": "2026-01-01T00:00:00+00:00"
}
```

`urls` accepts plain strings or `{"url": ...}` objects. Only the page's own content is read (the
`<article>` element, falling back to `<main>` and `<body>`), so the sidebar and site chrome stay out of
the text. Highlighted code blocks are reassembled line by line, because a Docusaurus code block holds
no newlines of its own.

`maxArticles`, `maxTextLength`, `maxCodeSamples` and `maxConcurrency` tune the crawl. The run fails
only if none of the requested pages could be scraped.

Part of the `sdk_docs_actors` pipeline - see the [README](../README.md) one directory up.

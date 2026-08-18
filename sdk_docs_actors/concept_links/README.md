# sdk-concept-links

Reads one Apify Python SDK docs page (`startUrl`, by default the
[overview](https://docs.apify.com/sdk/python/docs/overview)) and pushes one dataset item per link into
the SDK's concepts section:

```json
{
	"url": "https://docs.apify.com/sdk/python/docs/concepts/storages",
	"title": "Working with storages",
	"slug": "storages",
	"sourceUrl": "https://docs.apify.com/sdk/python/docs/overview"
}
```

Links are deduplicated and canonicalized first: fragments and query strings are dropped, and the
docs site's `.md` "copy for LLM" twin of a page (which carries a duplicated `/sdk/python` prefix) maps
back onto the human page. The section's own index page, links to other sections and off-site links are
skipped. The same list of URLs is also written to the key-value store under `CONCEPT_LINKS`.

Set `sectionPath` to collect a different section (`/docs/guides/`, for example), and `maxLinks` to cap
how many links are emitted. The run fails if the page yields no links at all, which is the signal that
the docs layout changed.

Part of the `sdk_docs_actors` pipeline - see the [README](../README.md) one directory up.

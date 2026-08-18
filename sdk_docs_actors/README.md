# Apify Python SDK docs Actors

Three Actors that, together, turn the [Apify SDK for Python docs](https://docs.apify.com/sdk/python/docs/overview)
into a dataset of concept articles. They are written for the local Actor runtime in this repository, but
there is nothing local-only about them - the same push/call loop works against the real platform.

| Directory         | Actor name              | Does                                                                        |
| ----------------- | ----------------------- | --------------------------------------------------------------------------- |
| `concept_links`   | `sdk-concept-links`     | Reads the SDK overview page, emits one item per link to an SDK concept page |
| `concept_scraper` | `sdk-concept-scraper`   | Scrapes the article of every docs URL it is given                           |
| `orchestrator`    | `sdk-docs-orchestrator` | Calls the first Actor, feeds its URLs to the second, republishes the result |

```
sdk-docs-orchestrator
  ├─ Actor.call("sdk-concept-links")   -> dataset: { url, title, slug, sourceUrl }
  └─ Actor.call("sdk-concept-scraper") -> dataset: { url, title, description, headings, text, codeSamples, ... }
        (input: the URLs from the first run's dataset)
```

The orchestrator republishes every scraped article in its own dataset and writes a summary of the two
child runs to its key-value store under `OUTPUT`.

## Running them against the local runtime

Start the runtime and point the stock [`apify-cli`](https://docs.apify.com/cli/docs) at it (see the
repository `README.md` and `CLAUDE.MD`):

```bash
docker build -t actor-runtime .
docker run --rm -p 3333:3333 -p 3000:3000 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$(pwd)/data:/data" \
  actor-runtime
```

```bash
export APIFY_CLIENT_BASE_URL=http://localhost:3333
export APIFY_CONSOLE_URL=http://localhost:3000
apify login --token <any-non-empty-token>   # once
```

Push all three - the orchestrator resolves its children by name, so both of them have to exist before
it runs:

```bash
for actor in concept_links concept_scraper orchestrator; do
  (cd sdk_docs_actors/$actor && apify push)
done
```

Then run the whole pipeline:

```bash
cd sdk_docs_actors/orchestrator
apify call --json
apify datasets info <defaultDatasetId>   # itemCount == number of concept pages scraped
```

Either scraper can also be run on its own:

```bash
(cd sdk_docs_actors/concept_links && apify call --input '{"maxLinks":3}')
(cd sdk_docs_actors/concept_scraper && apify call --input '{"urls":["https://docs.apify.com/sdk/python/docs/concepts/storages"]}')
```

## Inputs

All three take only optional fields; the defaults describe the Python SDK docs. See each Actor's
`.actor/input_schema.json` for the full list.

- `sdk-concept-links`: `startUrl`, `sectionPath` (point it at `/docs/guides/` to collect those
  instead), `maxLinks`.
- `sdk-concept-scraper`: `urls`, `maxArticles`, `maxTextLength`, `maxCodeSamples`, `maxConcurrency`.
- `sdk-docs-orchestrator`: `linksActorId`, `scraperActorId`, `startUrl`, `maxConcepts`,
  `childRunTimeoutSecs`.

## Notes on the local dev loop

- A repeat `apify push` of unmodified source needs `--force`: the runtime bumps the Actor's
  `modifiedAt` when a build completes, so the CLI thinks the platform copy is newer (expected CLI
  behavior, see `requirements/cli.md`).
- The **first** `apify push` of a brand-new Actor makes the stock CLI fetch the actor-templates
  manifest over the internet. Fully offline, create the Actor record first
  (`apify api POST v2/actors -d '{"name":"sdk-concept-links"}'`) and push into it.
- The orchestrator's own run gets the runtime's default 300 s timeout while it waits for two child
  runs. Give it more with `apify call --timeout 900` when scraping a large section.

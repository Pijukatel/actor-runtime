# Test layers

- Beside the mandatory CLI-only end-to-end test below, the implementation also carries unit tests
  (no Docker, no real storage backend - pure logic: id generation, the envelope/error mapper, the
  501-vs-404 spec table, dataset projection helpers, the KV key-listing cursor, the request-queue head
  buffer's state machine) and integration tests (a real `FileSystemStorageBackend` on a temp
  directory, a real HTTP server, driven by a real `apify-client` instance - covering storages CRUD,
  the request-queue conformance suite, actors/builds/runs/logs, and the console pages). These do not
  replace the mandatory e2e test below; they exist because Docker is not available in every
  environment this runtime is developed/tested in, and the CLI-only e2e test is Docker-dependent.

# Continuous integration

- All test layers run in GitHub Actions (`.github/workflows/ci.yml`) on every pull request and on
  pushes to the main branches: one job runs build, lint, format check, and the unit + integration
  suites; a second job runs the mandatory CLI-only e2e suite below against the runner's Docker
  daemon (GitHub-hosted Ubuntu runners ship one), so the e2e's Docker-unreachable check never
  silently no-ops in CI - a missing daemon fails the job instead.

# Mandatory end-to-end tests

- All end-to-end tests can use only Apify cli commands to emulate user workflow.
- For asserting the test results, the tests must inspect the return values of the Apify cli commands.
- **Narrow carve-out:** an assertion about a host/Docker-level invariant that no `apify` CLI command can
  observe at all - e.g. whether a Docker volume or container was actually reclaimed - may read the Docker
  CLI directly instead. This does not apply to anything observable through the Apify CLI, which must
  still be asserted through it as above; it exists only because Docker volume/container accounting has
  no Apify-CLI-observable surface to assert against.
- The e2e suite requires a reachable Docker daemon (it builds and runs real Actor containers) and
  detects its absence, failing in such case.
- The sample Actors crawl a live site (`https://crawlee.dev/` by default), so the e2e suite also
  requires outbound network access from Actor containers (GitHub-hosted runners have it). This is
  separate from the runtime's own offline capability (see `system.md`'s and `cli.md`'s offline notes),
  which covers push/call/log-stream/storage-access against the runtime itself, not what a given Actor's
  own code does over the network.
- Building the sample Actors' images requires pulling their base images
  (`apify/actor-node:24`, `apify/actor-python:3.13`) at least once; CI must pre-pull both before
  running the e2e suite so the timing of the actual push/call assertions is not dominated by image
  pulls.

## Actor full dev loop

Test case must verify full Actor development flow:

- Use sample actors (one for TypeScript actor and one Python actor)
- Push and build Actor in local actor runtime `apify push`
- Run Actor in local actor runtime with arguments and get results when it is finished `apify call --input ...`
- Get and inspect results when Actor run finishes (assert results in default dataset) `apify datasets info {default dataset ID}`
- The test drives each sample Actor with `apify call --input '{"maxPages":N}'` for at least two
  different values of `N`, and asserts via `apify datasets info <id>` that the default dataset's
  `itemCount` tracks `N` - i.e. the assertion is input-dependent, not just "some items exist".

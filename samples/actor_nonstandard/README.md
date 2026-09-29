# Non-standard sample Actor

A sample Actor that deliberately looks nothing like one created from an Apify template, used by
`test/e2e/nonstandard-actor.test.ts`:

- **Unusual base image** - stock `python:3.11-slim`, no Apify SDK: the Actor talks to the runtime's
  HTTP API with the Python standard library, so its build needs no `pip install` and no network.
- **Custom entry point** - `ENTRYPOINT ["./launch.sh"]`, with the command line in `CMD`.
- **A different working directory** - `/opt/weird-app`.
- **Its own non-root user** - `weirduser`, uid 1500.
- **A Dockerfile in neither default location** - `docker/Actor.dockerfile`, found only through the
  `dockerfile` field of `.actor/actor.json`.

Input: `{ "itemCount": <n> }` - pushes `n` items to the default dataset and writes an `OUTPUT` record.

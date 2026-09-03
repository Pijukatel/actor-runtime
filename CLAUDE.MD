# Using local Actor runtime

This file provides guidance to programming agents when using the local Actor runtime.
Local Actor runtime is an Actor development tool for developing, running, and debugging Actors. It emulates subset of the real Apify API and Apify console to allow actor development locally without the need to do costly rebuilds on Apify platform.

# Set up

- Build the docker image `docker build -t actor-runtime .`
- Run the container `docker run --rm -p 3333:3333 -p 3000:3000 -v /var/run/docker.sock:/var/run/docker.sock -v "$(pwd)/data:/data" actor-runtime`
    - `-v "$(pwd)/data:/data"` shared volumes `data` is used to store internal actor runtime data. When exposed it can be directly inspected to determine internal state and storage backend (It is not recommended to manually edit those files. Any edit should be done through http API call).

## Work through CLI

- The actor runtime is best used through `apify cli`: https://docs.apify.com/cli/docs
- Use the cli according to the skill: https://docs.apify.com/cli/docs/agent-skill#install-the-skill
- To use local Actor runtime set environment variable for the Apify CLI:
    - `APIFY_CLIENT_BASE_URL=http://localhost:3333`
    - `APIFY_CONSOLE_URL=http://localhost:3000`
    - `APIFY_PROXY_PASSWORD` (optional if Apify proxy is desired)
- To redirect Apify CLI back to the original Apify services unset the environment variables:
    - `APIFY_CLIENT_BASE_URL`
    - `APIFY_CONSOLE_URL`
- Use `apify cli api ...` to send API calls and inspect the Actors, builds, runs, storages and other objects.
- To simulate multiple users use custom token and in additional authorization header. For example: `apify cli api v2/datasets -H '{"authorization": "Bearer TOKEN"}'`
- You can use already authenticated CLI or call `apify login --token TOKEN`
- To iterate on an Actor's source without a rebuild for every change: push and build the Actor once, then
  register its local source folder with
  `apify api POST /actor-runtime/dev-folder/<actorId> --body '"/abs/path/to/src"'` (this runtime's own
  `/actor-runtime/*` endpoint - also reachable at `/v2/actor-runtime/*`, purely because `apify api`
  hardcodes a `/v2`-suffixed base URL). From then on, edit locally, recompile locally (`tsc` or the
  language-appropriate equivalent), and `apify call` again - no `apify push`/build in between. Submitting
  `--body '""'` clears the registration. Dependency changes still need a real rebuild.
- To test how an Actor handles platform migrations: while a run is `RUNNING`, call
  `apify api POST /actor-runtime/migrate/<runId>`, or press the Migrate button on the run's console
  detail page. The run gets the platform migration experience: a `migrating` event, its container
  stopped a few seconds later, and a fresh container for the same run (same run id, env vars, and
  storages, in-memory state gone). `POST /v2/actor-runs/<runId>/reboot` is also implemented.
- If a call fails because this runtime doesn't have the Actor/run/build/storage id you're after, or
  doesn't implement that endpoint at all, you can opt in to having such calls transparently relayed to
  the real Apify platform instead of failing:
  `apify api POST /actor-runtime/api-fallback --body '{"fallbackUnimplementedEnabled": true, "fallbackNotFoundEnabled": true}'`
  (either field alone is also accepted; `apify api GET /actor-runtime/api-fallback` reads the current
  state). Both default off and reset to off on every restart. Enabling either forwards whatever token you
  authenticated the failing call with to the real platform, and - since all HTTP methods are eligible -
  can turn a locally-missing `POST`/`PUT`/`DELETE` into a real write against your real account; only turn
  this on with a token/account you're comfortable with that. A relayed response carries an
  `x-actor-runtime-fallback` header naming which platform served it, and an
  `x-actor-runtime-fallback-trigger` header naming which toggle let it through.

## Through direct API calls

- You can also send direct API calls. For example: http://localhost:3333/v2/datasets?token=TOKEN

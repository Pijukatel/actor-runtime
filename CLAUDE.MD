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

## Through direct API calls
- You can also send direct API calls. For example: http://localhost:3333/v2/datasets?token=TOKEN

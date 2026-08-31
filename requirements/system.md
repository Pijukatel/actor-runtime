# Environment

- Supported operating systems:
    - Linux - officially supported and verified for the POC (tested)
    - MacOS - best-effort (adhoc manual tests)
    - Windows - best-effort (not tested in POC)
- The system is encapsulated in a dedicated docker image.

# Components

- The system exposes API that is compliant with the requirements in `api.md`
- The system has very simple frontend that is compliant with the requirements in `console.md`
- The system is using permanent and ephemeral storage based on requirements in `storage.md`
- The system can build and run actors according to the requirements in `actor-driver.md`
- The system is controlled through Apify cli based on the requirements in `cli.md`

# User interface

- The system is isolated environment that is started by running the docker container.
- The system user interface is accessible on localhost with specific ports for console frontend and API.
- The user interacts with the system through the Apify cli.
- On startup the container prints a banner naming the API port (3333) and the console port (3000),
  plus a warning if the host's Docker socket could not be reached - builds and runs then fail fast
  with a clear status message, while every other endpoint (storages, actor/build/run records,
  console) still works.
- Both ports are fixed and not configurable.
- Port 3333 also serves the per-run events websocket (`api.md`); no additional port is published for it.
- Required `docker run` flags: mount the host Docker socket read-write
  (`-v /var/run/docker.sock:/var/run/docker.sock`) so the runtime can build and run Actor containers,
  and mount a persistent data directory (`-v <host-dir>:/data`, e.g. `-v "$(pwd)/data:/data"`) so
  storages survive a restart and are easy to inspect from the host. Publish both fixed ports
  (`-p 3333:3333 -p 3000:3000`). The canonical start command is:

    ```bash
    docker build -t actor-runtime .
    docker run --rm -p 3333:3333 -p 3000:3000 \
      -v /var/run/docker.sock:/var/run/docker.sock \
      -v "$(pwd)/data:/data" \
      actor-runtime
    ```

- Optionally set `APIFY_PROXY_PASSWORD` in the runtime's own environment to have it forwarded into
  every Actor container (see `actor-driver.md`).

# Implementation

- Project constraint: the system is implemented in TypeScript.

# Scope

- The system is a development tool for developing actors.
- The system is not a production system for hosting actors.

# Scale

The intended scale of the system is:

- less than 10 built actors
- less than 5 running actors at the same time
- less than 100 actor runs
- less than 100 datasets
- less than 100 key value stores
- less than 100 request queues
- less than 5 users

The intended scale is not enforced, but the system operating above the intended scale can experience performance or functional issues.

The "less than 5 running actors at the same time" budget also bounds the per-run resource measurement and the open events websocket connections - each running Actor adds at most one of each.

# Tests

The system is tested according to the requirements in `test.md`

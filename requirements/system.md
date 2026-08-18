# Environment

- Supported operating systems:
    - Linux (tested)
    - MacOS (not tested in POC)
    - Windows. (not tested in POC)

- The system is encapsulated in dedicated docker image.
- Linux is the officially supported and verified platform for the POC.
- MacOS and Windows are best-effort for the POC.
- The image is glibc-based (e.g. Debian slim), **not Alpine/musl**: `@crawlee/fs-storage` loads a
  native Rust addon (`@crawlee/fs-storage-native`) with no musl build, so an Alpine base would fail to
  load the storage layer entirely.

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
- When the container is started it prints the relevant user interface ports in console message:
  a startup banner naming the API port (3333) and the console port (3000), plus a warning if the
  host's Docker socket could not be reached (in which case builds and runs fail fast with a clear
  status message, but every other endpoint - storages, actor/build/run records, console - still works).
- The API port (3333) and the console frontend port (3000) are fixed values and
  are not configurable; they are the same on every start of the container.

# Running the container

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

- The system is implemented in TypeScript.

# Offline-after-first-build note

- This note is scoped to the **runtime** itself (push/build/call/log-stream/storage-access/console) -
  not to what an individual Actor's own code does over the network once it's running.
- The first build of any given Actor base image needs outbound network access to pull that base image
  (e.g. from Docker Hub); likewise, the first-ever `apify push` of a brand-new Actor needs outbound
  network access because the stock CLI fetches its actor-templates manifest from the internet. Once
  both of those have happened at least once, the runtime itself operates fully offline: repeat builds
  reuse the already-pulled base image and every other push/call/log-stream/storage-access needs no
  outbound network access at all (see `cli.md`'s offline-capability note).
- The bundled sample Actors (`sample_actor_ts`, `sample_actor_py`) are not offline: they crawl a live
  site (`https://crawlee.dev/` by default). Running them needs outbound network access from the Actor
  container, unlike operating the runtime around them (see `test.md`).
- The runtime's one-time, per-token, real-console identity check (`cli.md`'s User bootstrap) is
  best-effort online with a silent offline fallback.

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

# Tests

The system is tested according to the requirements in `test.md`

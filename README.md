# actor-runtime

A local Apify platform in a single container. Point the stock Apify CLI at it and push, build and run
your Actors on your own machine, with the same commands you use against the platform. It is a
development tool, not a place to host Actors.

## Quick start

```bash
npm install -g apify-cli@runtime
apify runtime install
apify runtime start --detach
apify runtime connect

cd your-actor
apify push
apify call
```

The console is at [http://localhost:3000](http://localhost:3000). The full walkthrough is in
[docs/quick-start.md](docs/quick-start.md). The complete reference ships with the runtime as an Agent
Skill: `apify runtime skill` prints it, and `apify runtime skill --install` installs it for your coding
agent.

Port 3333 or 3000 already taken? `apify runtime start --api-port 4333 --console-port 4000` moves them.

If you are not logged in, any non-empty token works (`apify login --token local-dev-token`).

In build and run logs, everything the runtime itself says opens with a blue `[actor-runtime]` prefix.
Your Actor's own output is passed through unchanged.

## What you can do only locally

- **Run offline, at no cost.** Builds and runs use no platform compute. After the first build, the
  runtime needs no network access (your Actor may still need it).
- **Edit without rebuilding.** Run your Actor from your local source folder.
- **Debug with a real IDE.** Set breakpoints and step through a run in VS Code or PyCharm.
- **Watch the browser.** See, and optionally control, the browser your Actor drives.
- **Trigger a migration.** Test how your Actor survives a migration, whenever you want.
- **Test pay-per-event pricing for free.** See what a run charges and costs, without spending money.
- **Relay missing calls to the platform.** Send calls the runtime cannot answer to the real Apify API.

### Edit without rebuilding

`apify push` registers the pushed folder as the Actor's **dev folder**. Every later run mounts it over
the built image, so you edit, recompile locally and call again:

```bash
npm run build
apify call
```

- Edits apply to the **next** run, not to one already running.
- Dependencies come from the built image, so a change to `package.json` or `requirements.txt` needs
  `apify push`.
- `apify call --no-dev-folder` runs once from the built image alone.
- To register a different folder, run `apify api POST /actor-runtime/dev-folder/<actorId> --body '"/abs/path"'`.
  To clear the registration, send `--body '""'`. The Actor's console page has the same field.

The path is resolved on the machine your container engine runs on. Under Docker Desktop or
`podman machine`, that is the VM, not your own filesystem.

### Debug with a real IDE

Turn debug mode on once. After that, every run of the Actor starts paused and waits for a debugger to
attach. You don't need to change the Actor's source or Dockerfile:

```bash
apify api POST /actor-runtime/debug/<actorId> --body '{"enabled": true}'
apify call
```

The run log prints the attach action for your IDE:

- **Python:** PyCharm's **Attach to DAP** or VS Code's **Python: Remote Attach**, on port `5678`.
- **Node:** VS Code's **Attach**, on port `9229`.

Set `"language"` or `"port"` in the body to override the defaults. Send `{"enabled": false}` to turn
debug mode off.

- The run's timeout is not extended while it waits for the debugger, so pass a larger `--timeout` up
  front.
- A Node Actor must start with `node` directly, for example `CMD ["node", "dist/main.js"]`. An Actor
  that starts through `npm start` fails with a message naming the fix. This includes a Node Actor pushed
  without its own `Dockerfile`.

### Watch the browser

```bash
apify api POST /actor-runtime/browser-view/<actorId> --body '{"enabled": true}'
apify call
```

The run log prints the viewer URL (`http://localhost:3000/runs/<runId>/browser`). Add
`"interactive": true` to send your mouse and keyboard to the browser.

The view only reads the screen, so neither the browser nor the sites it visits can tell anyone is
watching. The browser must run **headful**, on an image that provides a display, such as Apify's
Playwright and Puppeteer base images.

### Trigger a migration

While a run is `RUNNING`:

```bash
apify api POST /actor-runtime/migrate/<runId>
```

The run receives a `migrating` event. A few seconds later its container stops, and a fresh one starts
for the same run, with the same run id, environment and storages but no in-memory state. The run's
console page has a **Migrate** button that does the same.

### Test pay-per-event pricing for free

Give the Actor a pay-per-event pricing, and every run charges events as it would on the platform. No
money is spent. The bundled `sample_actor_ts` and `sample_actor_py` charge events, and include the
matching pricing in `pricing.json`:

```bash
apify api PUT /v2/actors/<actorId> --body "$(cat pricing.json)"
apify call --input '{"maxPages":3}'
apify api GET actor-runs/<runId>
```

The run object and its console page show the charged events and the run's estimated cost
(`usageTotalUsd`). The estimate covers compute units and events, but not storage, data transfer or
proxy.

### Relay missing calls to the platform

```bash
apify api POST /actor-runtime/api-fallback \
  --body '{"fallbackUnimplementedEnabled": true, "fallbackNotFoundEnabled": true}'
```

Calls to endpoints the runtime does not implement, or to ids it does not know, then go to the real
Apify API with your token. This includes named storages such as `apify~some-public-dataset`. Both
options are off by default and reset on every restart.

**This can write to your real Apify account.** Every HTTP method is relayed, so only turn it on with a
token whose account you are willing to change.

## Actor Standby

An Actor with Standby enabled - `"usesStandbyMode": true` in `.actor/actor.json`, or `actorStandby` set
through the API - is served over HTTP at its `standbyUrl`, on the API port:

```bash
cd sample_actor_standby_ts     # or sample_actor_standby_py
apify push
curl "http://<username>--my-standby-actor-ts.localhost:3333/hello?name=Ada&token=<token>"
```

The `standbyUrl` has the platform's shape, one `*.localhost` hostname per Actor, so a web UI served by the
Actor works as on `*.apify.actor`. Clients that do not resolve `*.localhost` use
`http://localhost:3333/actor-runtime/standby/<username>--<actor-name>`, and other Actors
`http://apify-api:3333/actor-runtime/standby/<username>--<actor-name>`.

The two samples are the same server in TypeScript and Python - JSON endpoints, a request body echo, a
Server-Sent Events stream, a websocket and stats kept across runs; each README lists the calls.
`sample_actor_standby_web` serves a web page with root-relative links, and in an ordinary run calls a
standby Actor from inside its container.

Requests are handed to standby runs the runtime starts, scales by `desiredRequestsPerActorRun` /
`maxRequestsPerActorRun` and winds down after `idleTimeoutSecs` without a request, as on the platform.
Single-tenant only - see `requirements/actor-driver.md`'s "Actor Standby".

## Apify Proxy

Set `APIFY_PROXY_PASSWORD` in the runtime container's environment
(`docker run -e APIFY_PROXY_PASSWORD=...`) to pass it into every Actor container. If it is unset, Actor
containers don't get the variable at all.

## Running with Podman instead of Docker

The runtime works the same on Docker and Podman, rootful or rootless. `apify runtime` uses the first
engine on your `PATH`; set `APIFY_CONTAINER_ENGINE=podman` to choose Podman.

To start the container yourself, mount your engine's API socket:

```bash
systemctl --user enable --now podman.socket   # one-time
mkdir -p data
podman run --rm -p 3333:3333 -p 3000:3000 \
  -v "$XDG_RUNTIME_DIR/podman/podman.sock:/var/run/docker.sock" \
  -v "$(pwd)/data:/data" \
  docker.io/apify/actor-runtime
```

- For rootful Podman, mount `/run/podman/podman.sock` and run with `sudo`. For rootless Docker, mount
  `$XDG_RUNTIME_DIR/docker.sock`. To mount the socket at another path, also set
  `-e DOCKER_HOST=unix:///that/path`.
- To use other ports, set `-e ACTOR_RUNTIME_API_PORT=4333 -e ACTOR_RUNTIME_CONSOLE_PORT=4000` and publish
  the same numbers on the host (`-p 4333:4333 -p 4000:4000`).
- Podman 3.4 (Ubuntu 22.04's stock package) and newer are supported. Keep the API port published on
  all interfaces (`-p 3333:3333` by default): under Podman 3.x and rootless Podman, Actors reach the API through it.
- Podman does not create a missing bind-mount directory, hence `mkdir -p data`. `apify runtime start`
  creates its data directory itself.
- Short image names in an Actor's `FROM` line (`apify/actor-node:20`) resolve to Docker Hub, as on the
  platform. You don't need `unqualified-search-registries` in `registries.conf`.
- A rootless engine enforces only the run limits whose cgroup controllers your user has. Ubuntu 22.04
  delegates `memory` and `pids` but not `cpu`. The runtime says at startup which limits it leaves out,
  and runs still start. To get CPU limits, delegate the controller:
  `sudo mkdir -p /etc/systemd/system/user@.service.d && printf '[Service]\nDelegate=cpu cpuset io memory pids\n' | sudo tee /etc/systemd/system/user@.service.d/delegate.conf && sudo systemctl daemon-reload`,
  then log out and back in.
- If you restart a hand-started `podman system service`, restart the runtime container too. The
  `podman.socket` unit does not have this problem.

## What is not supported

The runtime covers the development loop, not the whole platform. See
[requirements/unsupported.md](requirements/unsupported.md) for what it leaves out.

## Contributing

To build the runtime from source, run its tests or publish the image, see
[CONTRIBUTING.md](CONTRIBUTING.md).

# Distribution

How the Actor runtime is distributed to users on Linux, macOS and Windows.

## Chosen approach: distribution through the Apify CLI (`apify runtime`)

The Actor runtime is distributed **through the Apify CLI**, not inside it. The runtime stays what
it already is - a single Docker image - and the stock `apify-cli` gains a `runtime` command
namespace that installs and runs that image. The user's flow is:

```bash
npm install -g apify-cli   # or any other CLI install method
apify runtime install      # verify Docker works here, download the runtime image
apify runtime start        # run the runtime container (Ctrl+C stops it)
```

- **`apify runtime install`** means, concretely:
    1. Verify the OS is capable of running Docker images: the `docker` executable is on `PATH`
       and the Docker daemon is reachable (`docker info`). When either check fails, the command
       prints a per-OS remediation hint (Docker Desktop for macOS/Windows, Docker Engine for
       Linux; "start Docker Desktop" vs `systemctl start docker`) and exits non-zero.
    2. Download the proper Actor runtime Docker image (`docker pull`), skipped when the image is
       already present locally (`--force` re-downloads).
- **`apify runtime start`** re-runs the install checks (so `start` alone is enough on a machine
  with Docker), then starts the container with the canonical flags from `system.md`: publish
  ports `3333` (API) and `3000` (console), mount the host Docker socket, and mount a persistent
  data directory (default `~/.apify/actor-runtime/data`, overridable with `--data-dir`). It runs
  in the foreground with Ctrl+C forwarded into the container, or in the background with
  `--detach`.
- **`apify runtime stop`** stops a detached runtime container.

## Image location

The image will be published on Apify's Docker Hub organization. Until then the CLI hardcodes the
local placeholder tag **`actor-runtime:latest`** (one constant, `ACTOR_RUNTIME_IMAGE` in the CLI),
and when the pull fails because the image is not published yet, the CLI tells the user to build it
locally from this repository (`docker build -t actor-runtime:latest .`). Switching to the published
image is a one-line change of that constant.

## Cross-platform notes

- **Linux** - Docker Engine or Docker Desktop; socket at `/var/run/docker.sock`.
- **macOS** - Docker Desktop (and compatible engines exposing the standard socket path); same
  socket path as Linux.
- **Windows** - Docker Desktop with the WSL 2 backend running Linux containers. The CLI mounts the
  socket as `//var/run/docker.sock` (double leading slash) so MSYS/Git Bash shells do not mangle
  the path; Docker Desktop resolves it to the Linux engine's socket.
- The container is started with `--init` so interrupt signals reach the runtime process even
  though it runs as the container's PID 1.

## Why not bundle the runtime inside the CLI package (option a)

Shipping the image (or a compressed export of it) inside the npm package was rejected:

- The CLI is installed globally by many users and inside Actors; its install footprint is kept
  deliberately lean, and a runtime image is orders of magnitude larger than the whole CLI.
- The image is useless without a working Docker daemon anyway, so bundling it cannot remove the
  one real prerequisite.
- Runtime releases would be coupled to CLI releases; pulling from a registry lets each version
  independently.

The `apify runtime` commands give the same one-tool experience ("install the CLI, run one
command") without those costs.

## Out of scope (for now)

- Installing Docker itself. The CLI detects its absence and points at the official installer for
  the user's OS; silently installing a daemon is too invasive for a dev tool.
- Version/tag selection, image updates and multi-arch concerns beyond what `docker pull` already
  handles.

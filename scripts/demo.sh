#!/usr/bin/env bash
# =============================================================================
# actor-runtime demo: standby actors end to end
# =============================================================================
# Demonstrates the full Actor development loop, including the standby-actor
# feature, against either a local actor-runtime container (default) or the
# real Apify platform (`--remote`):
#
#   Local mode (default):
#     1. create a temporary data directory,
#     2. build the actor-runtime Docker image,
#     3. start the runtime container (API + console),
#     4. point the stock apify-cli at it via APIFY_CLIENT_BASE_URL,
#     5. push the two sample Actors (a standby echo server and an on-demand
#        caller) with `apify push`,
#     6. run the caller with `apify call --json` — from inside its container
#        it looks up the standby Actor through the runtime API, calls its
#        standbyUrl (cold-starting the standby container), and saves the
#        response; `--json` also hands this script the run's own id and
#        default storage ids on stdout,
#     7. read the results back through apify-cli itself (`apify info`, `apify
#        runs ls`, `apify key-value-stores get-value`, `apify datasets
#        get-items`) — never a raw HTTP call, so credential handling is
#        entirely the CLI's own and this script runs unchanged against the
#        real platform.
#
#   Remote mode (`demo.sh --remote`): steps 1-4 above don't apply — there is
#   no runtime image to build and no container to start. apify-cli is left
#   pointed at the real platform (no APIFY_CLIENT_BASE_URL override), using
#   whichever account `apify login` already stored. The demo starts directly
#   at step 5 and runs steps 5-7 unchanged, against that account.
#
# Usage: demo.sh [--remote]
#   (no flag)   run against a local actor-runtime container (default)
#   --remote    run the same demo against the real Apify platform
#               (console.apify.com); requires `apify login` beforehand
#
# Prerequisites:
#   local:  docker (daemon running), apify-cli on PATH (`npm i -g
#           apify-cli`), node (parses apify-cli's JSON output; it never
#           makes an HTTP request itself -- and it is already there, since
#           apify-cli itself runs on it), curl (liveness poll only, see
#           step 3).
#   remote: apify-cli on PATH and logged in (`apify login`), node.
# Run from anywhere; paths are resolved relative to this script's repo.
#
# Both fixture Actors are real `apify` SDK Actors: `apify push` (step 5)
# triggers a `docker build` whose .actor/Dockerfile npm-installs the pinned
# `apify` SDK, so it needs normal internet egress. Once built, both
# containers only ever call the runtime API they were pushed to (local or
# real, per mode).
#
# Local mode leaves the runtime running at the end so you can explore the
# console; cleanup commands are printed last. Remote mode has no container
# or image to clean up -- it prints pointers into the real console instead.
# =============================================================================
set -euo pipefail

# ---- mode: local actor-runtime (default) or the real platform (--remote) --
REMOTE=0
if [ "${1:-}" = "--remote" ]; then
  REMOTE=1
  shift
fi
if [ $# -gt 0 ]; then
  echo "Usage: demo.sh [--remote]" >&2
  exit 1
fi

if [ "$REMOTE" -eq 1 ]; then
  printf '\n\033[1;45m %s \033[0m\n\n' "REMOTE MODE -- running against the REAL Apify platform (console.apify.com)"
else
  printf '\n\033[1;44m %s \033[0m\n\n' "LOCAL MODE -- running against a local actor-runtime container"
fi

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ---- configuration (override via environment), local mode only ------------
if [ "$REMOTE" -eq 0 ]; then
  API_PORT="${API_PORT:-3333}"        # host port for the runtime API
  CONSOLE_PORT="${CONSOLE_PORT:-3000}" # host port for the console UI
  IMAGE_TAG="${IMAGE_TAG:-actor-runtime:demo}"
  CONTAINER_NAME="${CONTAINER_NAME:-actor-runtime-demo}"
  API_URL="http://localhost:${API_PORT}"
  CONSOLE_URL="http://localhost:${CONSOLE_PORT}"
fi

step() { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }

# Pretty-print JSON from stdin (stand-in for `python3 -m json.tool`, same
# 4-space indent). Purely local parsing; never makes an HTTP request.
json_pretty() {
  node -e '
let raw = "";
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", () => { console.log(JSON.stringify(JSON.parse(raw), null, 4)); });
'
}

step "0. Checking prerequisites"
command -v apify  >/dev/null || { echo "apify-cli is required (npm i -g apify-cli)"; exit 1; }
command -v node >/dev/null || { echo "node is required"; exit 1; }
if [ "$REMOTE" -eq 1 ]; then
  # A leftover APIFY_CLIENT_BASE_URL/APIFY_CONSOLE_URL in the invoking shell
  # (e.g. from a prior local-mode run, or manual testing per
  # requirements/cli.md) would silently redirect every apify-cli call below
  # (or its printed console links) away from the real platform while the
  # REMOTE banner keeps claiming it -- clear both so remote mode always talks
  # to the real platform regardless of ambient env. (APIFY_TOKEN is
  # deliberately not touched here: per requirements/cli.md, apify push/call/
  # info use only the CLI's stored login, never the APIFY_TOKEN env var, so a
  # stale value there can't redirect or otherwise poison this path.)
  unset APIFY_CLIENT_BASE_URL
  unset APIFY_CONSOLE_URL
  # Cheap, local check (no more of a network call than step 7 already makes):
  # every command below authenticates with apify-cli's own stored login (see
  # requirements/cli.md), so fail fast here with a clear message instead of a
  # mid-script 401 further down. apify-cli reports every `apify info` failure
  # (no stored login, an unreachable API, ...) the same way -- exit 1 with a
  # generic message -- so this can't honestly claim which one happened.
  apify info >/dev/null || { echo "apify info failed -- make sure you are logged in (\`apify login\`) and api.apify.com is reachable."; exit 1; }
else
  command -v docker >/dev/null || { echo "docker is required"; exit 1; }
  docker version >/dev/null || { echo "docker daemon is not reachable"; exit 1; }
fi

if [ "$REMOTE" -eq 0 ]; then
  step "1. Creating the temporary data directory"
  # DATA must be an ABSOLUTE host path mounted at the SAME path inside the
  # container: the runtime bind-mounts per-run storage into the sibling Actor
  # containers it launches through the shared Docker socket, so the paths it
  # passes to `docker run` must be valid on the host.
  DATA="$(mktemp -d)"
  chmod 777 "$DATA"   # Actor containers run as a non-root user and write here
  echo "DATA_DIR = $DATA"

  step "2. Building the actor-runtime image"
  docker build -t "$IMAGE_TAG" "$REPO"

  step "3. Starting the runtime container"
  # Re-runs of this demo are idempotent: replace any previous demo container.
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  docker run -d --name "$CONTAINER_NAME" \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -v "$DATA:$DATA" -e DATA_DIR="$DATA" -e HOST_DATA_DIR="$DATA" \
    -p "${API_PORT}:3333" -p "${CONSOLE_PORT}:3000" \
    "$IMAGE_TAG"

  echo -n "Waiting for the API to come up "
  # A liveness poll on the container this script itself just started -- plain
  # infrastructure, not a demo API call, so it stays a bare HTTP check. Every
  # actual read of demo data happens in step 7, entirely through apify-cli.
  for _ in $(seq 1 60); do
    if curl -fsS "$API_URL/v2/users" >/dev/null 2>&1; then echo " up!"; break; fi
    echo -n "."
    sleep 1
  done
  curl -fsS "$API_URL/v2/users" >/dev/null || { echo "runtime API never came up"; exit 1; }

  step "4. Pointing apify-cli at the local runtime"
  # Redirects apify-cli's underlying apify-client at the runtime, and its
  # console-link output at this runtime's own console; no token is
  # configured here (see "Authentication / token bootstrap" in requirements/cli.md).
  export APIFY_CLIENT_BASE_URL="$API_URL"
  export APIFY_CONSOLE_URL="$CONSOLE_URL"
  export APIFY_CLI_DISABLE_TELEMETRY=1
  export APIFY_CLI_SKIP_UPDATE_CHECK=1
  echo "APIFY_CLIENT_BASE_URL = $APIFY_CLIENT_BASE_URL"
  echo "APIFY_CONSOLE_URL = $APIFY_CONSOLE_URL"
else
  step "1-4. Skipped in --remote mode"
  # No image to build, no container to start, and no
  # APIFY_CLIENT_BASE_URL/APIFY_CONSOLE_URL to point anywhere: apify-cli
  # already talks to the real platform by default, using whichever account is
  # logged in (checked above).
fi

if [ "$REMOTE" -eq 1 ]; then
  printf '\033[1;33mWARNING:\033[0m this force-pushes actors named "standby-actor" and\n"caller-actor" into your logged-in Apify account -- any existing actors with\nthose exact names there will be overwritten.\n\n'
fi
step "5. Pushing the standby and caller Actors"
# Push from copies in a scratch dir so the CLI's local state files never
# touch the repo checkout. `apify push` builds each Actor's image through
# the target runtime; the standby Actor's .actor/actor.json carries
# `usesStandbyMode: true`, which is what standby-enables it there too.
if [ "$REMOTE" -eq 1 ]; then
  WORK="$(mktemp -d)"
else
  WORK="$DATA/projects"
  mkdir -p "$WORK"
fi
cp -r "$REPO/sample_actor_standby" "$WORK/standby-actor"
cp -r "$REPO/sample_actor_caller" "$WORK/caller-actor"
(cd "$WORK/standby-actor" && apify push --force)
(cd "$WORK/caller-actor" && apify push --force)

step "6. Running the caller Actor"
# Contract: input is the standby Actor's name only -- the caller resolves
# its own username and builds the id itself (see sample_actor_caller/main.js).
INPUT_FILE="$WORK/caller-input.json"
cat > "$INPUT_FILE" <<'JSON'
{"standbyActorName": "standby-actor", "greeting": "hello-from-the-demo"}
JSON
# --json prints the finished run's id and default storage ids to stdout
# (captured below, for step 7); the human-readable progress log `apify call`
# normally prints still streams live, to stderr, so capturing stdout into a
# variable does not hide it.
CALL_JSON="$(cd "$WORK/caller-actor" && apify call --input-file="$INPUT_FILE" --json)"

step "7. Reading the results back through apify-cli"
# Same credential contract as step 4: every read below goes through
# apify-cli, never a raw HTTP call.
USERNAME="$(apify info | sed -n 's/^username: //p')"
echo "Acting as ${USERNAME}"

CALLER_META="$(node -e '
const run = JSON.parse(process.argv[1]);
console.log(run.run.id, run.run.status, run.storage.defaultDatasetId, run.storage.defaultKeyValueStoreId);
' "$CALL_JSON")"
read -r CALLER_RUN_ID CALLER_RUN_STATUS CALLER_DATASET_ID CALLER_KV_ID <<<"$CALLER_META"
echo "Caller run ${CALLER_RUN_ID}: ${CALLER_RUN_STATUS}"

echo
echo "What the caller received from the standby Actor (OUTPUT record):"
apify key-value-stores get-value "$CALLER_KV_ID" OUTPUT

echo
echo "Caller's dataset (the same response, saved as an item):"
apify datasets get-items "$CALLER_DATASET_ID" | json_pretty

# `apify call` only ever reports the run IT started (the caller's), so the
# standby Actor's run -- warmed as a side effect, inside the caller's own
# container -- still needs one listing to find; --desc --limit 1 asks the
# CLI itself for "the most recent run" instead of fetching every run and
# picking the last one client-side.
STANDBY_ACTOR_ID="${USERNAME}~standby-actor"
STANDBY_JSON="$(apify runs ls "$STANDBY_ACTOR_ID" --json --desc --limit 1)"
STANDBY_META="$(node -e '
const [actorId, raw] = process.argv.slice(1);
const items = JSON.parse(raw).items;
if (!items.length) {
    console.error(`No runs found yet for ${actorId}`);
    process.exit(1);
}
const run = items[0];
console.log(run.id, run.status, run.defaultDatasetId);
' "$STANDBY_ACTOR_ID" "$STANDBY_JSON")"
read -r STANDBY_RUN_ID STANDBY_RUN_STATUS STANDBY_DATASET_ID <<<"$STANDBY_META"
echo
echo "Standby run ${STANDBY_RUN_ID}: ${STANDBY_RUN_STATUS} (stays warm until its idle timeout)"

echo "Standby Actor's dataset (one record per call it served):"
apify datasets get-items "$STANDBY_DATASET_ID" | json_pretty

step "Done"
if [ "$REMOTE" -eq 1 ]; then
  cat <<EOF
Explore on the real platform:
  Your Actors:          https://console.apify.com/actors
  Caller Actor run id:  ${CALLER_RUN_ID}   (Actors > caller-actor > Runs)
  Standby Actor run id: ${STANDBY_RUN_ID}  (Actors > standby-actor > Runs;
                                           stays warm until its idle timeout)

Clean up the scratch push directory with:
  rm -rf ${WORK}
EOF
else
  cat <<EOF
Explore the runtime:
  Console:            http://localhost:${CONSOLE_PORT}   (watch the standby run's live log + dataset,
                                                          try the Abort button while it is RUNNING)
  API:                ${API_URL}
  Standby run log:    ${API_URL}/v2/logs/<runId>

The standby container stays warm and tears itself down ~5 minutes after its
last request (its idle timeout). Clean everything up with:
  docker rm -f ${CONTAINER_NAME}
  rm -rf ${DATA}
EOF
fi

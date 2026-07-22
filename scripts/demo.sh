#!/usr/bin/env bash
# =============================================================================
# actor-runtime demo: standby actors end to end
# =============================================================================
# Demonstrates the full local Actor development loop against actor-runtime,
# including the standby-actor feature:
#
#   1. create a temporary data directory,
#   2. build the actor-runtime Docker image,
#   3. start the runtime container (API + console),
#   4. point the stock apify-cli at it via APIFY_CLIENT_BASE_URL,
#   5. push the two sample Actors (a standby echo server and an on-demand
#      caller) with `apify push`,
#   6. run the caller with `apify call --json` — from inside its container it
#      looks up the standby Actor through the runtime API, calls its
#      standbyUrl (cold-starting the standby container), and saves the
#      response; `--json` also hands this script the run's own id and
#      default storage ids on stdout,
#   7. read the results back through apify-cli itself (`apify info`, `apify
#      runs ls`, `apify key-value-stores get-value`, `apify datasets
#      get-items`) — never a raw HTTP call, so credential handling is
#      entirely the CLI's own and this script runs unchanged against the
#      real platform.
#
# Prerequisites: docker (daemon running), apify-cli on PATH (`npm i -g
# apify-cli`), python3 (parses apify-cli's JSON output; it never makes an
# HTTP request itself), curl (liveness poll only, see step 3).
# Run from anywhere; paths are resolved relative to this script's repo.
#
# Both fixture Actors are real `apify` SDK Actors: `apify push` (step 5)
# triggers a `docker build` whose .actor/Dockerfile pip-installs `apify` +
# `apify-client` (and, for the caller, `httpx`), so it needs normal internet
# egress. Once built, both containers only ever call this runtime's own API.
#
# The runtime is left running at the end so you can explore the console;
# cleanup commands are printed last.
# =============================================================================
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ---- configuration (override via environment) -------------------------------
API_PORT="${API_PORT:-3333}"        # host port for the runtime API
CONSOLE_PORT="${CONSOLE_PORT:-3000}" # host port for the console UI
IMAGE_TAG="${IMAGE_TAG:-actor-runtime:demo}"
CONTAINER_NAME="${CONTAINER_NAME:-actor-runtime-demo}"

API_URL="http://localhost:${API_PORT}"

step() { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }

step "0. Checking prerequisites"
command -v docker >/dev/null || { echo "docker is required"; exit 1; }
command -v apify  >/dev/null || { echo "apify-cli is required (npm i -g apify-cli)"; exit 1; }
command -v python3 >/dev/null || { echo "python3 is required"; exit 1; }
docker version >/dev/null || { echo "docker daemon is not reachable"; exit 1; }

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
# Redirects apify-cli's underlying apify-client at the runtime; no token is
# configured here (see "Authentication / token bootstrap" in requirements/cli.md).
export APIFY_CLIENT_BASE_URL="$API_URL"
export APIFY_CLI_DISABLE_TELEMETRY=1
export APIFY_CLI_SKIP_UPDATE_CHECK=1
echo "APIFY_CLIENT_BASE_URL = $APIFY_CLIENT_BASE_URL"

step "5. Pushing the standby and caller Actors"
# Push from copies in the temp dir so the CLI's local state files never
# touch the repo checkout. `apify push` builds each Actor's image through
# the runtime; the standby Actor's .actor/actor.json carries
# `usesStandbyMode: true`, which is what standby-enables it.
WORK="$DATA/projects"
mkdir -p "$WORK"
cp -r "$REPO/sample_actor_standby" "$WORK/standby-actor"
cp -r "$REPO/sample_actor_caller" "$WORK/caller-actor"
(cd "$WORK/standby-actor" && apify push --force)
(cd "$WORK/caller-actor" && apify push --force)

step "6. Running the caller Actor"
# Contract: input is the standby Actor's name only -- the caller resolves
# its own username and builds the id itself (see sample_actor_caller/main.py).
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

CALLER_META="$(python3 -c '
import json, sys
run = json.load(sys.stdin)
print(run["run"]["id"], run["run"]["status"], run["storage"]["defaultDatasetId"], run["storage"]["defaultKeyValueStoreId"])
' <<<"$CALL_JSON")"
read -r CALLER_RUN_ID CALLER_RUN_STATUS CALLER_DATASET_ID CALLER_KV_ID <<<"$CALLER_META"
echo "Caller run ${CALLER_RUN_ID}: ${CALLER_RUN_STATUS}"

echo
echo "What the caller received from the standby Actor (OUTPUT record):"
apify key-value-stores get-value "$CALLER_KV_ID" OUTPUT

echo
echo "Caller's dataset (the same response, saved as an item):"
apify datasets get-items "$CALLER_DATASET_ID" | python3 -m json.tool

# `apify call` only ever reports the run IT started (the caller's), so the
# standby Actor's run -- warmed as a side effect, inside the caller's own
# container -- still needs one listing to find; --desc --limit 1 asks the
# CLI itself for "the most recent run" instead of fetching every run and
# picking the last one client-side.
STANDBY_ACTOR_ID="${USERNAME}~standby-actor"
STANDBY_JSON="$(apify runs ls "$STANDBY_ACTOR_ID" --json --desc --limit 1)"
STANDBY_META="$(python3 -c '
import json, sys
items = json.load(sys.stdin)["items"]
if not items:
    sys.exit("No runs found yet for " + sys.argv[1])
run = items[0]
print(run["id"], run["status"], run["defaultDatasetId"])
' "$STANDBY_ACTOR_ID" <<<"$STANDBY_JSON")"
read -r STANDBY_RUN_ID STANDBY_RUN_STATUS STANDBY_DATASET_ID <<<"$STANDBY_META"
echo
echo "Standby run ${STANDBY_RUN_ID}: ${STANDBY_RUN_STATUS} (stays warm until its idle timeout)"

echo "Standby Actor's dataset (one record per call it served):"
apify datasets get-items "$STANDBY_DATASET_ID" | python3 -m json.tool

step "Done"
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

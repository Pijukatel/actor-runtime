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
#   6. run the caller with `apify call` — from inside its container it looks
#      up the standby Actor through the runtime API, calls its standbyUrl
#      (cold-starting the standby container), and saves the response,
#   7. read the results back over the API.
#
# Prerequisites: docker (daemon running), apify-cli on PATH (`npm i -g
# apify-cli`), python3 (used only to pretty-parse JSON responses), curl.
# Run from anywhere; paths are resolved relative to this script's repo.
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
for _ in $(seq 1 60); do
  if curl -fsS "$API_URL/v2/users" >/dev/null 2>&1; then echo " up!"; break; fi
  echo -n "."
  sleep 1
done
curl -fsS "$API_URL/v2/users" >/dev/null || { echo "runtime API never came up"; exit 1; }

step "4. Pointing apify-cli at the local runtime"
# APIFY_CLIENT_BASE_URL is the only redirect needed: it is the base URL the
# stock apify-cli hands to its underlying apify-client, and push/call/login
# all honour it (see requirements/cli.md). No token is configured here — the
# CLI simply presents whatever credential it already has:
#   - logged in:  its stored token is the first one this fresh runtime sees,
#                 so it becomes the default user's (`local-user`) bound
#                 credential and everything runs as `local-user`;
#   - logged out: push/call send no token at all, and the runtime's
#                 default-user fallback accepts that as `local-user` too.
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
# The caller discovers the standby Actor's standbyUrl through the runtime API
# (no hardcoded URL) and calls it container-to-container; the first request
# cold-starts the standby container. Input goes through --input-file rather
# than inline -i: apify-cli mis-detects any inline JSON containing "~" (as in
# the `local-user~standby-actor` id) as a file path (apify/apify-cli#1281).
INPUT_FILE="$WORK/caller-input.json"
cat > "$INPUT_FILE" <<'JSON'
{"standbyActorId": "local-user~standby-actor", "greeting": "hello-from-the-demo"}
JSON
(cd "$WORK/caller-actor" && apify call --input-file="$INPUT_FILE")

step "7. Reading the results back over the API"
# The script never configured a token, so it discovers the acting credential
# from the runtime itself: a tokenless request falls back to the default user
# `local-user`, and /v2/users/me deliberately returns the caller's stored
# token (that is how the console's user switcher works). Whatever token the
# CLI bound in step 5/6 — or null if it was logged out — comes back here, and
# the remaining reads authenticate with it when present.
python3 - "$API_URL" <<'PY'
import json
import sys
import urllib.request

api = sys.argv[1]

def _fetch(path, token=None):
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    req = urllib.request.Request(f"{api}{path}", headers=headers)
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))

bound_token = _fetch("/v2/users/me")["data"]["token"]
print(f"Acting as local-user (bound token {'set' if bound_token else 'not set'})")

def get(path):
    return _fetch(path, token=bound_token)

caller_run = get("/v2/acts/local-user~caller-actor/runs")["data"]["items"][-1]
print(f"Caller run {caller_run['id']}: {caller_run['status']}")

output = get(f"/v2/key-value-stores/{caller_run['defaultKeyValueStoreId']}/records/OUTPUT")
print("\nWhat the caller received from the standby Actor (OUTPUT record):")
print(json.dumps(output, indent=2))

items = get(f"/v2/datasets/{caller_run['defaultDatasetId']}/items")
print("\nCaller's dataset (the same response, saved as an item):")
print(json.dumps(items, indent=2))

standby_run = get("/v2/acts/local-user~standby-actor/runs")["data"]["items"][-1]
print(f"\nStandby run {standby_run['id']}: {standby_run['status']} (stays warm until its idle timeout)")

served = get(f"/v2/datasets/{standby_run['defaultDatasetId']}/items")
print("Standby Actor's dataset (one record per call it served):")
print(json.dumps(served, indent=2))
PY

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

#!/usr/bin/env bash
# Oracle for actor-runtime. Sets up the venv + deps + apify-cli, then runs the
# unit/integration suite and the mandatory Docker-backed e2e test. Exits nonzero
# on any failure. Intended to be run as: bash scripts/run-tests.sh
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

VENV="$REPO/.venv"
PY="$VENV/bin/python"
RUNTIME_IMAGE="${RUNTIME_IMAGE:-actor-runtime:test}"
export RUNTIME_IMAGE

echo "== [1/5] Python venv + dependencies =="
if [ ! -x "$PY" ]; then
  python3 -m venv "$VENV"
fi
"$PY" -m pip install --quiet --upgrade pip
"$PY" -m pip install --quiet -r requirements-dev.txt

echo "== [2/5] apify-cli =="
if ! command -v apify >/dev/null 2>&1; then
  npm install -g apify-cli
fi
apify --version

echo "== [3/5] Pre-pull Actor base image + build runtime image =="
docker pull python:3.11-slim

# When this environment routes HTTPS through a TLS-terminating proxy, hand the
# CA bundle and proxy to the image build so pip can install over it. In a normal
# environment none of this applies and the build is a plain `docker build`.
BUILD_ARGS=()
BUILD_NET=()
CA_SRC="/root/.ccr/ca-bundle.crt"
if [ -n "${HTTPS_PROXY:-}${https_proxy:-}" ] && [ -f "$CA_SRC" ]; then
  cp "$CA_SRC" "$REPO/ca-bundle.crt"
  trap 'rm -f "$REPO/ca-bundle.crt"' EXIT
  BUILD_ARGS+=(--build-arg "HTTPS_PROXY=${HTTPS_PROXY:-${https_proxy:-}}")
  BUILD_ARGS+=(--build-arg "https_proxy=${https_proxy:-${HTTPS_PROXY:-}}")
  BUILD_NET+=(--network=host)
fi
docker build "${BUILD_NET[@]}" "${BUILD_ARGS[@]}" -t "$RUNTIME_IMAGE" "$REPO"
rm -f "$REPO/ca-bundle.crt"

echo "== [4/5] Unit + integration tests (no Docker) =="
"$PY" -m pytest tests/unit -q

echo "== [5/5] Mandatory end-to-end test (real apify-cli + Docker) =="
"$PY" -m pytest tests/e2e -q

echo "ALL TESTS PASSED"

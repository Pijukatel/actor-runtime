#!/usr/bin/env bash
# Oracle for actor-runtime. Installs Node dependencies + apify-cli, then runs
# the unit/integration suite and the mandatory Docker-backed e2e test. Exits
# nonzero on any failure. Intended to be run as: bash scripts/run-tests.sh
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

RUNTIME_IMAGE="${RUNTIME_IMAGE:-actor-runtime:test}"
export RUNTIME_IMAGE

echo "== [1/5] Node.js dependencies =="
if [ -d node_modules ]; then
  npm install --no-audit --no-fund
else
  npm ci --no-audit --no-fund
fi

echo "== [2/5] Unit + integration tests (no Docker) =="
npx vitest run tests/unit

echo "== [3/5] apify-cli =="
if ! command -v apify >/dev/null 2>&1; then
  npm install -g apify-cli
fi
apify --version

echo "== [4/5] Pre-pull Actor base image + build runtime image =="
# The e2e suite is MANDATORY: a missing Docker daemon fails the oracle (it
# does not silently degrade to unit-only), same contract as always -- just
# with a clearer message than a failed `docker pull` would give.
if ! docker version >/dev/null 2>&1; then
  echo "ERROR: Docker daemon is not reachable -- the e2e suite is mandatory and cannot run." >&2
  exit 1
fi
docker pull node:22-alpine

# When this environment routes HTTPS through a TLS-terminating proxy, hand the
# CA bundle and proxy to the image build so npm can install over it. In a normal
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

echo "== [5/5] Mandatory end-to-end test (real apify-cli + Docker) =="
npx vitest run tests/e2e

echo "ALL TESTS PASSED"

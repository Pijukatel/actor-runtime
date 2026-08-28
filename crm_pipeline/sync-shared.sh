#!/usr/bin/env bash
# Each Actor is pushed as a self-contained source folder, so the shared normalization rules in
# shared/crm.js are copied into every Actor that needs them. Run this after editing shared/crm.js.
set -euo pipefail
cd "$(dirname "$0")"
for actor in export-simulator region-importer reconciliation-reporter; do
	cp shared/crm.js "$actor/src/crm.js"
	echo "synced shared/crm.js -> $actor/src/crm.js"
done

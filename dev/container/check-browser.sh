#!/usr/bin/env bash
# Existing upstream checks against only the disposable Docker instance.
set -euo pipefail
cd "$(dirname "$0")/../.."
export FLODE_GATE_URL=http://127.0.0.1:18123
export FLODE_GATE_TOKEN_FILE="$PWD/dev/container/runtime/token"
mkdir -p .gate
node dev/gate/ready.mjs 60
node dev/gate/seed.mjs
trap 'node dev/gate/cleanup.mjs' EXIT
status=0
for step in cards roundtrip actions visual; do
  node "dev/gate/check-$step.mjs" || status=1
done
exit "$status"

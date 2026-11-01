#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

test -f custom_components/flode/www/flode-panel.js || {
  echo 'Build the panel first: yarn build' >&2
  exit 1
}
mkdir -p dev/container/runtime/config
bash dev/container/init-git.sh
for file in configuration.yaml automations.yaml; do
  if [ ! -f "dev/container/runtime/config/$file" ]; then
    cp "dev/container/$file" "dev/container/runtime/config/$file"
  fi
done
if [ ! -f dev/container/runtime/config/scripts.yaml ]; then
  printf '{}\n' > dev/container/runtime/config/scripts.yaml
fi
docker compose -f dev/container/compose.yaml up -d
for attempt in {1..120}; do
  if curl --fail --silent --max-time 2 --output /dev/null http://127.0.0.1:18123/manifest.json; then
    node dev/container/bootstrap.mjs
    exit 0
  fi
  sleep 1
done
echo 'Test HA did not become ready. Inspect docker compose logs.' >&2
exit 1

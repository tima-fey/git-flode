#!/usr/bin/env bash
# Release certification against the disposable file-workflow HA container.
# Usage: dev/gate/gate.sh [--only STEP] [--baseline]
set -uo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO" || exit 2
OUT="$REPO/.gate"
ONLY=""
BASELINE=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --only) ONLY="${2:?Missing step}"; shift ;;
    --baseline) BASELINE=1 ;;
    --help|-h) sed -n '2,3p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done
case "$ONLY" in ""|static|backend|cards|edit-files|readonly|git|publish|ha-controls|objects|visual) ;; *) echo 'Unknown step' >&2; exit 2 ;; esac
export FLODE_GATE_URL=http://127.0.0.1:18123
export FLODE_GATE_TOKEN_FILE="$REPO/dev/container/runtime/token"
unset FLODE_GATE_TOKEN
COMMIT="$(git rev-parse HEAD)"
CLEAN=true
[ -z "$(git status --porcelain)" ] || CLEAN=false
STARTED=$(date +%s)
mkdir -p "$OUT/logs"
if ! mkdir "$OUT/run.lock" 2>/dev/null; then
  echo 'Another gate is running (.gate/run.lock). Wait for it to finish.' >&2
  exit 2
fi
trap 'rmdir "$OUT/run.lock"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
rm -f "$OUT"/step-*.json "$OUT/steps.txt"
run() {
  local name="$1"; shift
  local log="$OUT/logs/$name.log" status=ok started
  started=$(date +%s)
  if "$@" >"$log" 2>&1; then echo "✓ $name"
  else status=failed; echo "✗ $name — $log"; tail -8 "$log"; fi
  printf '%s|%s|%s|%s\n' "$name" "$status" "$(( $(date +%s) - started ))" "${log#"$REPO/"}" >> "$OUT/steps.txt"
  [ "$status" = ok ]
}
static_checks() {
  local status=0
  node --test dev/gate/summary.test.mjs || status=1
  yarn check:biome || status=1
  yarn typecheck || status=1
  yarn test --run || status=1
  yarn build || status=1
  return "$status"
}
backend_checks() {
  docker run --rm -e PYTHONDONTWRITEBYTECODE=1 -v "$REPO:/work:ro" -w /work --entrypoint sh \
    ghcr.io/home-assistant/home-assistant:2026.10.1 \
    -c 'uv pip install --system --index-strategy unsafe-best-match pytest==8.4.2 ruamel.yaml==0.18.16 ruff==0.16.9 && python -m pytest -p no:cacheprovider tests -q && ruff check --no-cache custom_components tests dev/container/fixtures/tests'
}
prepare() {
  test -d dev/gate/node_modules || (cd dev/gate && npm ci --no-audit --no-fund) || return 1
  (cd dev/gate && node node_modules/playwright/cli.js install chromium webkit) || return 1
  # Never certify a previous run's fixture tree, integration options, or tests.
  docker compose -f dev/container/compose.yaml down || return 1
  if [ -d dev/container/runtime ]; then
    mkdir -p "$OUT/runtime-backups"
    mv dev/container/runtime "$OUT/runtime-backups/$(date +%s)-$$" || return 1
  fi
  mkdir -p dev/container/runtime/config
  cp dev/container/configuration.yaml dev/container/runtime/config/configuration.yaml || return 1
  bash dev/container/start.sh || return 1
  node dev/gate/ready.mjs 180 || return 1
  node dev/container/prepare-files.mjs
}
finish() {
  [ "$(git rev-parse HEAD)" = "$COMMIT" ] || CLEAN=false
  [ -z "$(git status --porcelain)" ] || CLEAN=false
  node dev/gate/summary.mjs --commit "$COMMIT" --clean "$CLEAN" --only "$ONLY" --restart 1 --seconds "$(( $(date +%s) - STARTED ))"
}
if [ -z "$ONLY" ] || [ "$ONLY" = static ]; then run static static_checks || true; fi
if [ -z "$ONLY" ] || [ "$ONLY" = backend ]; then run backend backend_checks || true; fi
if [ "$ONLY" != static ] && [ "$ONLY" != backend ]; then
  if ! run test-ha prepare; then finish; exit 1; fi
  for pair in cards:dev/gate/check-cards.mjs edit-files:dev/container/check-edit.mjs readonly:dev/container/check-readonly.mjs git:dev/container/check-git.mjs publish:dev/container/check-publish.mjs ha-controls:dev/container/check-ha.mjs objects:dev/container/check-objects.mjs visual:dev/gate/check-visual.mjs; do
    name="${pair%%:*}"
    [ -z "$ONLY" ] || [ "$ONLY" = "$name" ] || continue
    if [ "$name" = visual ] && [ "$BASELINE" = 1 ]; then run "$name" node "${pair#*:}" --baseline || true
    else run "$name" node "${pair#*:}" || true; fi
  done
fi
# Baseline updates are useful evidence but never certify a release.
[ "$BASELINE" = 0 ] || ONLY=baseline
finish

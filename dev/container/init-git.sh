#!/usr/bin/env bash
# Build a disposable configuration checkout and bare remote, never the app repo.
set -euo pipefail
cd "$(dirname "$0")/../.."
root="$PWD/dev/container/runtime"
checkout="$root/repository"
remote="$root/remote.git"
if [ -d "$checkout/.git" ]; then
  exit 0
fi
if [ -e "$checkout" ] || [ -e "$remote" ]; then
  echo 'Partial Git test setup exists; move runtime/repository and runtime/remote.git aside.' >&2
  exit 1
fi
mkdir -p "$root"
# Hooks and signing from the developer's Git setup must not affect test fixtures.
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
git init --template= --bare --initial-branch=main "$remote"
git init --template= --initial-branch=main "$checkout"
cp -R dev/container/fixtures/automations dev/container/fixtures/objects "$checkout/"
git -C "$checkout" add automations objects
git -C "$checkout" -c user.name='FLODE Test' -c user.email=test@example.invalid commit -m 'Initial test automations'
printf 'Disposable configuration checkout for FLODE Git tests.\n' > "$checkout/README.md"
git -C "$checkout" add README.md
git -C "$checkout" -c user.name='FLODE Test' -c user.email=test@example.invalid commit -m 'Document test checkout'
git -C "$checkout" push "$remote" main
# This path is intentionally the path inside HA Container, not a host remote.
git -C "$checkout" remote add origin /git-test/remote.git

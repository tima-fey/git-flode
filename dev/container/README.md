# Isolated Home Assistant container

This development instance uses HA 2026.10.1, matching the existing venv helper's
default. It listens only on `http://127.0.0.1:18123`. It uses synthetic fixtures,
not the production configuration repository. No privileged mode, host network,
device passthrough, or production mounts are used.

The configured directory is the FLODE project root. Automation definitions
come only from its `automations/` subtree; `objects/` is reserved and never
scanned or read as automation data. A disposable Git checkout initialized from
`dev/container/fixtures/` lives in `runtime/repository/` and is mounted at
`/flode-config`. It is not included by HA. The original fixture files are never
modified by Git tests. The two synthetic smoke entries and twelve real climate examples remain
independent automations and do not need HA entities. The original HA demo automation is deliberately
absent from FLODE's file list.

Change the source in Settings → Devices & services → FLODE → Configure. Supply
an existing absolute root accessible inside HA, containing `automations/`.
Automation files may be nested under that subtree and must contain standard YAML lists with non-empty, unique IDs within each file.
Example layout (the root name and location are configurable):

```text
flode-config/
  automations/
    climate/
      heating.yaml
      ventilation.yaml
    security/
      vacation_alarm.yaml
  objects/
```

Each YAML file holds a list of independent automations. The file references
shown in the panel are relative to the project root, including `automations/`.

Unsupported YAML directives such as `!include` and `!secret` produce errors;
they are not resolved through HA or outside the configured root. Errors never
fall back to the HA automation configuration API.

Prerequisites: Git, Node 24, the repository's pinned Yarn, Docker with Compose, and
Docker Desktop running. Frontend dependencies live in `node_modules`; Home
Assistant and its Python dependencies run inside the container.

```sh
yarn install --immutable
yarn build
yarn typecheck
yarn test --run
yarn biome ci .
bash dev/container/start.sh
```

`start.sh` initializes configuration and a local Git remote only when missing,
starts HA, creates a disposable administrator, and registers FLODE. Open
[the test panel](http://127.0.0.1:18123/flode). The generated login is stored in
`dev/container/runtime/credentials.json`; use it for manual browser login.
Credentials, tokens, HA storage, and logs are ignored by Git. Do not publish
the runtime directory. The integration mount is read-only; HA's isolated config
directory is writable so HA can maintain its own storage. The panel defaults
to viewing: editor writes and action execution are disabled, and the inspector
shows the selected step as YAML. The configuration checkout is writable for
explicit Git pull/version-switch operations.

## Git controls

The home screen shows the current branch/commit, main's ahead/behind counts,
and paginated commit history. Fetch downloads origin/main without changing
working files. Pull fetches and fast-forwards main. Opening a historical commit
uses detached HEAD and preserves main; Return to main restores the local main
checkout. Pull can then update it to origin/main. Git never reloads HA or runs
an automation.

The configured FLODE directory must be the checkout root, with an existing
main branch. Network operations use its existing origin and authentication
configured outside the checkout. Git must be available inside the HA runtime;
Git in an SSH add-on is insufficient. The pinned test image already includes it.
Local changes, stale requests, and diverged history stop file-changing actions;
there is no automatic reset, stash, or push. Fetch remains available with local
changes. No interface for local edits or commits is provided at this stage.

The test origin is a local bare repository, `runtime/remote.git`, mounted
read-only in HA at `/git-test/remote.git`. `check-git.mjs` publishes temporary
synthetic changes through a separate disposable writer, exercises fetch/pull
and historical checkout in both browsers, and restores fixture content through
another normal commit and pull. It never touches the application checkout's
Git history or a production remote.

Rebuild after frontend changes with `yarn build`, then reload the browser.
After Python changes, restart HA:

```sh
docker compose -f dev/container/compose.yaml restart
docker compose -f dev/container/compose.yaml logs --tail 100
docker compose -f dev/container/compose.yaml exec -T homeassistant \
  python -m homeassistant --script check_config --config /config
```

Run the existing browser checks against this container, without the release
gate's venv lifecycle management:

```sh
cd dev/gate
npm ci --no-audit --no-fund
npx playwright install chromium webkit
cd ../..
bash dev/container/check-browser.sh
node dev/container/smoke.mjs
```

The browser runner derives scenarios from the file backend, verifies that the
file automations are not registered in HA, checks their cards in both browsers,
and exercises viewing interactions. It monitors forbidden HA automation/script
configuration requests and mutations, and compares YAML hashes before/after.
Screenshots and machine-readable results are written to ignored runtime folders.
No HA automation fixtures are seeded or removed by this runner. It then runs
the explicit Git synchronization tests against only the disposable checkout.

The upstream editing, save, and visual suites remain available for later stages;
they require matching file fixtures before use with this source. The historical
API-based baseline does not certify the new file backend.
See [baseline-results.md](baseline-results.md) for the first completed run.

Stop the test instance without deleting its configuration:

```sh
docker compose -f dev/container/compose.yaml down
```

For a fresh instance, stop it and move `dev/container/runtime/` aside before
starting again. Do not reuse this setup with production configuration or devices.

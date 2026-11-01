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
  tests/
    test_automations.py
```

Each YAML file holds a list of independent automations. The file references
shown in the panel are relative to the project root, including `automations/`.
Cards are grouped by their full directory below `automations/`, including nested
paths. Files directly in `automations/` appear under that heading. Search matches
automation names and file paths; empty groups are hidden. Folder headings can
be collapsed by mouse or keyboard. Search expands matching folders temporarily
and restores their previous state when cleared.

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
directory is writable so HA can maintain its own storage. The panel edits existing file automations through HA's native step editors.
Creating automations, saving copies, imports as new automations, and action
execution remain disabled. The configuration checkout is writable for
explicit Git pull/version-switch operations.

## Editing existing automations

Open a card, edit its steps in the visual editor, and press Save. FLODE rewrites
that same YAML file, replacing only the selected existing automation ID. Other
files are untouched. IDs and paths cannot be changed, and missing files or IDs
are never created. Saving changes only the local checkout: it does not commit,
push, or reload HA.

The writer uses `ruamel.yaml` to retain comments, quotes, multiline values, and
unmodeled automation fields. It retains legacy top-level trigger/condition/action
keys. YAML formatting may be normalized within the file. The complete serialized
file is parsed and compared before an atomic replacement. Files with anchors,
aliases, symlinked paths, blueprints, non-string mapping keys, or integers
outside JavaScript's lossless range are not editable at this stage.

A revision of the whole file and the configured root accompany every save.
External changes, Git switches, or edits in another tab cause stale saves to
fail without writing. Close and reopen the automation to load the current file
before retrying. Unsaved file drafts survive browser reloads and retain the
original revision, so restoring a draft cannot bypass conflict detection. Only
drafts for the configured root are restored. File operations, Git, and project tests share a checkout lock.

`check-edit.mjs` changes only the disposable synthetic file, verifies save and
reopen, neighboring entries, unknown fields, stale-file rejection, and absence
of HA automation config API writes. It also checks hashes, modification times, and permissions of every other
working file after successful and refused saves. It restores the original
fixture bytes. Backend tests cover separate folders, repeated IDs and filenames,
CRLF, invalid neighboring YAML, binary files, objects, and tests. A save/commit/push
regression verifies that exactly one path changes in both local and remote Git
trees, with every other blob and mode preserved.

## Home Assistant controls

The administrator-only Home Assistant card calls the native
`POST /api/config/core/check_config` endpoint and displays its errors and
warnings. Quick reload calls `homeassistant.reload_all`, which validates the
configuration before reloading supported YAML domains. It does not restart HA.
These operations apply to HA's connected YAML configuration; the standalone
FLODE checkout is included only when HA configuration explicitly references it.
Neither operation runs automatically after a Git action or while browsing.
`check-ha.mjs` exercises both controls in the disposable instance.

## Project tests

Run tests executes Python `unittest` discovery in the configured root's `tests/`
folder (`test_*.py`; use `__init__.py` for nested test packages). The example
`tests/test_automations.py` reads the synthetic automation YAML without running
HA actions. Tests use the HA Python environment; no dependencies are installed
at runtime. The process uses the project root as its working directory and can
import project helpers. Empty suites and import errors count as failures.

Only administrators can start a run. Runs are explicit, share a lock with Git,
and never happen automatically on fetch, pull, or reload. Output is limited to
64 KiB and runs stop after 60 seconds by terminating the worker process group. Python
bytecode is disabled to keep the checkout clean. The UI displays console output,
pass/fail, and timeout results. Symlinks in `tests/` are rejected.

These are trusted Python programs running with HA's permissions, not a sandbox.
Only use test code and dependencies you trust. Tests may access files, network,
and HA services if their code does so; the example only reads YAML.

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
there is no automatic reset, stash, or force push. Fetch remains available with
local changes.

Review changes shows the working-tree diff and untracked files without staging.
Commit all changes requires that exact reviewed snapshot and a message.
The author is read on the server from Git configuration (`user.name` and
`user.email`); there are no author fields in the UI. Configure these once for
the configuration checkout, where it is accessible:

```sh
git -C /flode-config config user.name "Your Name"
git -C /flode-config config user.email "you@example.com"
```

Missing identity settings stop a commit before staging any files. Commit stages
all listed working-file changes, including deletions and new non-ignored files.
Partial staging is replaced by the reviewed working-file contents. Nothing is
pushed automatically. The UI does not change Git identity settings. Keep
credentials outside the checkout and configure `.gitignore`
for generated/private files.

Push main sends committed local main to origin/main, even if uncommitted work
remains. It fetches first, refuses non-fast-forward updates, and never pushes
other branches or tags. Commit and push are disabled on historical checkouts.
The checkout root and HEAD are checked again on requests. Pull and version
switches are also blocked while editor drafts have unsaved changes; commit and
push do not close editor tabs. Git hooks and commit
signing are disabled for these non-interactive operations. Remote access uses
the existing Git authentication setup. Reviews are limited to 64 KiB; larger
changes must be committed with Git outside FLODE. Errors do not discard files;
a failed commit may leave reviewed files staged for retry.

The test origin is a local bare repository, `runtime/remote.git`, mounted
writable in HA at `/git-test/remote.git` for push checks. `check-git.mjs` publishes temporary
synthetic changes through a separate disposable writer, exercises fetch/pull
and historical checkout in both browsers, and restores fixture content through
another normal commit and pull. It never touches the application checkout's
Git history or a production remote. `check-publish.mjs` exercises review,
commit, and push through the UI in both browsers. It removes its temporary test
file through another normal commit and push, leaving the checkout clean.

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

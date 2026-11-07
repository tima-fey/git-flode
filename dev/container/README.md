# Isolated Home Assistant container

This development instance uses HA 2026.10.1, matching the existing venv helper's
default. It listens only on `http://127.0.0.1:18123`. It uses synthetic fixtures,
not the production configuration repository. No privileged mode, host network,
device passthrough, or production mounts are used.

The configured directory is the FLODE project root. Automation definitions
come only from its `automations/` subtree; `objects/` holds explicit HA metadata exports and is never
scanned or read as automation data. A disposable Git checkout initialized from
`dev/container/fixtures/` lives in `runtime/repository/` and is mounted at
`/flode-config`. HA includes its automation subtree through an absolute `!include_dir_merge_list /flode-config/automations` directive. The original fixture files are never
modified by Git tests. The synthetic smoke entries and abstract climate examples remain
independent automations and do not need HA entities. The original HA demo automation is deliberately
absent from FLODE's file list.

Change the source in Settings → Devices & services → FLODE → Configure. Supply
an existing absolute root accessible inside HA, containing `automations/`.
Automation files may be nested under that subtree and must contain standard YAML lists with non-empty, globally unique IDs across all project automation files.
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
explicit Git merge/version-switch operations.

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
drafts for the configured root are restored; switching roots preserves the
previous project's drafts in browser storage. Git completion refreshes saved
tabs and retains any edits made while the operation was pending, including
their original file revisions. Saving an unchanged config preserves file bytes
and its revision. File operations, Git, and project tests share a checkout lock.

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
folder (`test_*.py`; use `__init__.py` for nested test packages). The bundled
`tests/test_object_references.py` recursively checks automation files against
the exported catalog without executing HA actions. Tests use the HA Python
environment; no dependencies are installed
at runtime. The process uses the project root as its working directory and can
import project helpers. Empty suites and import errors count as failures.

Only administrators can start a run. Runs are explicit, share a lock with Git,
and never happen automatically on fetch, merge, or reload. Output is limited to
64 KiB and runs stop after 60 seconds by terminating the worker process group. Python
bytecode is disabled to keep the checkout clean. The UI displays console output,
pass/fail, and timeout results. Symlinks in `tests/` are rejected.

These are trusted Python programs running with HA's permissions, not a sandbox.
Only use test code and dependencies you trust. Tests may access files, network,
and HA services if their code does so; the example only reads YAML.

## Git controls

Operator procedures and recovery nuances are in
[Git operations and recovery](../../docs/git-workflow.md).

The configured directory must be the configuration checkout root with an
existing local **prod** branch. HA works on prod; the external writer works on
**main**. There is no legacy main-only mode or automatic branch migration.
Fresh `init-git.sh` fixtures create both branches and leave prod active. The
application source checkout is separate and retains its development branch.

The card shows the current commit/branch, prod's ahead/behind counts relative to
`origin/prod`, main commits not yet merged into prod, and paginated history from
prod and fetched main/prod refs. A local main branch is not required.

- **Fetch** downloads origin/main and origin/prod without changing working files.
- **Merge main into prod** fetches first, requires active prod and clean files,
  and creates a dedicated merge commit with the previous prod as first parent
  and fetched main as second parent. Already-merged main is a no-op.
- A failed/conflicting merge is aborted. The previous HEAD and clean checkout
  are verified after abort. If recovery itself fails, the error requires manual
  repair; the app does not reset or discard files.
- Resolve conflicts on your computer by merging prod into main, resolving,
  and pushing main. Retry the main-to-prod merge in HA. External updates enter
  prod only through main; another writer on origin/prod blocks merge/push.
- **Undo latest main merge** runs `git revert -m 1` against the latest FLODE
  merge at prod's tip, creating a new commit with the pre-merge file tree.
  Later commits are preserved by refusing that shortcut once the tip changes.
- **Push prod** sends committed prod to origin/prod through a normal push,
  even with uncommitted files. It never publishes into main or force-pushes.
- History opens a read-only commit diff without changing files or HEAD.
  **Return to prod** recovers an externally detached checkout. Unsaved editor drafts
  block merge and undo. Returning to prod preserves drafts.

Merge and revert use identity from Git configuration in the HA runtime. Set
`user.name` and `user.email` once; no author fields are requested by the UI:

```sh
git -C /flode-config config user.name "Your Name"
git -C /flode-config config user.email "you@example.com"
```

Review shows all changed and untracked non-ignored files without staging.
The `objects/` diff is collapsed by default.
Commit requires that exact review and a message, stages all listed changes,
and commits only on prod. Each preview shows up to 64 KiB. The review token
covers complete file contents and staging state.
Git hooks and signing are disabled. Authentication and origin are configured
outside the UI; Git must be installed inside the HA runtime. The pinned test
image includes it. All action requests include expected root and HEAD guards.

Merge, revert, commit, push, tests, object export, HA checks, and reload are
separate explicit actions. A failed commit may leave reviewed files staged.
Neither successful Git updates nor undo reload HA automatically. Apply changes
through the separate native check/reload controls only when the checkout is
included in HA configuration.

Reverting a merge preserves its ancestry. Another merge of the same main will
not reapply those changes. To restore them, merge prod into main on your computer,
revert the undo commit in main, resolve as needed, and push main. HA can then
merge that new main. This does not require another writer on prod.

The test origin is `runtime/remote.git`, mounted at `/git-test/remote.git`.
`check-git.mjs` exercises fetch, merge, prod push, published-merge undo, historical
viewing, automatic conflict abort, and human resolution through main in both
browsers. Its separate computer-side writer pushes only main. Cleanup restores
fixture content through main and merges it into prod, preserving history.
`check-publish.mjs` checks reviewed local commits, configured identity, and prod
pushes; it removes its temporary file through another commit/push on prod.
These tests never use the application's Git remote or production configuration.

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
synthetic file automations are registered in HA through the project include, checks their cards in both browsers,
and exercises viewing interactions. It monitors forbidden HA automation/script
configuration requests and mutations, and compares YAML hashes before/after.
Screenshots and machine-readable results are written to ignored runtime folders.
No automation configuration API writes are used by this runner. It then runs
the explicit Git synchronization tests against only the disposable checkout.

The [initial HA-API baseline](baseline-results.md) is historical evidence only;
it does not certify the current file workflow. Use [the current gate](../gate/README.md).

Stop the test instance without deleting its configuration:

```sh
docker compose -f dev/container/compose.yaml down
```

For a fresh instance, stop it and move `dev/container/runtime/` aside before
starting again. Do not reuse this setup with production configuration or devices.


## Offline HA object catalog

Click **Export HA objects** in the administrator controls to replace the configured
project's entire `objects/` directory with current registry metadata. Nothing is
exported on startup, navigation, Git operations, checks, or reloads. Export does
not commit, push, reload HA, or change automations and tests. Treat `objects/` as
generated data: any old or hand-written files there are removed on a successful
export. Keep local tests under `tests/`.

The snapshot contains all devices, registered entities (including disabled ones),
and current entities without registry entries. Helpers use HA's native helper
integration classification, including YAML and UI-created helpers. Integration
settings, options, tokens, state values, and arbitrary state attributes are omitted.
IDs, unique IDs, names, area/label references, and device/integration relationships
are retained. Unavailable integration metadata produces a warning; entities are
still included even when helper classification is unavailable.

```text
objects/
  index.yaml
  helpers/index.yaml
  integrations/<domain>/<config_entry_id>/
    integration.yaml
    devices/<device_id>/
      device.yaml
      entities/<entity_id>.yaml
    entities/<entity_id>.yaml
  integrations/<domain>/_standalone/
    integration.yaml
    entities/<entity_id>.yaml
```

`_standalone` groups entities without an HA config entry, including YAML entities
and storage-backed helpers. Each device is stored once under its primary owner;
a shared device lists every associated config entry. Each entity retains its own
integration/config-entry references. Path segments are percent-encoded when needed;
original IDs are preserved in records and index keys.

`index.yaml` has `schema_version: 1`, maps `integrations`, `devices`, `entities`, and
`helpers` to paths relative to `objects/`, and includes area and label metadata.
`helpers/index.yaml` maps helper entity IDs to the same canonical files, without
duplicating records. Snapshot output is deterministic and has no export timestamp,
so unchanged inventories do not create Git content changes.

The complete new tree is built before the old tree is replaced. Serialization and
publication failures preserve or restore the previous snapshot. File editing,
Git changes, project tests, and export share the project operation lock. Export
requires an administrator and rejects a changed project root or a symlinked
`objects/` directory.

For example, a project test can check a required entity and stable unique ID:

```python
from pathlib import Path
import unittest
import yaml


class ObjectReferenceTests(unittest.TestCase):
    def test_heating_sensor_identity(self):
        objects = Path(__file__).resolve().parents[1] / "objects"
        index = yaml.safe_load((objects / "index.yaml").read_text())
        entity_path = index["entities"]["sensor.heating_temperature"]
        entity = yaml.safe_load((objects / entity_path).read_text())
        self.assertEqual(entity["unique_id"], "expected-hardware-channel-id")
```

A missing or renamed entity fails the lookup after a fresh explicit export; a
replaced underlying entity fails the unique-ID assertion. Export first when you
want tests to reflect the current HA inventory; an offline snapshot does not
update itself.


## Automation reference test on HA

The portable `fixtures/tests/test_object_references.py` belongs in the configured
project's `tests/` directory. **Run tests** executes it through HA's existing
isolated Python worker, alongside the smoke test. It recursively scans all
`.yaml` and `.yml` automation files and validates explicit `entity_id`,
`device_id`, `area_id`, `label_id`, and `config_entry_id` references against the
last exported catalog. Helpers are entities and are checked the same way.
Device automation registry IDs and their device associations are checked too.
Nested blocks, comma-separated targets, static scene/script actions, time
entity triggers, and numeric entity thresholds are included.

Jinja is parsed without rendering or executing it. Literal references in native
lookups such as `states(...)`, `is_state(...)`, `state_attr(...)`, `expand(...)`,
`device_attr(...)`, area/label lookups, and `states.sensor.example` or
`states['sensor.example']` are checked. Literal lists passed to `map('states')`,
`select('is_state', ...)`, and `reject('is_state', ...)`, plus native Jinja tests,
are checked too. Constant template targets are supported.
Computed targets and lookup arguments fail explicitly when they cannot be
resolved statically. Custom template functions, service availability, runtime
values, and general HA configuration validity are outside this static ID check.
Use HA's configuration check for its separate validation.

Errors include the relative YAML filename, automation alias/ID, field path,
and missing reference. Invalid YAML and recursive aliases also fail; the test
continues checking other files. A missing/inconsistent catalog fails with an
instruction to export objects. It reads files only and does not contact HA or
modify the catalog. **Export HA objects** first when you need current inventory;
**Run tests** intentionally does not refresh it automatically. Existence in a
snapshot does not prove live availability or that an entity is enabled.

The disposable container's climate fixtures reference fictional entities absent
from test HA. Their missing-reference failures are expected and are asserted by
`check-ha.mjs`, including rendering those failures in the browser.

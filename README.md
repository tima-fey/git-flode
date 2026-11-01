# git-flode

A Home Assistant visual editor for automation YAML stored in Git.

**git-flode is an independent fork of [FLODE](https://github.com/SH1FT-W/flode)
by [SH1FT-W](https://github.com/SH1FT-W) and its contributors.** FLODE originated
from [C.A.F.E.](https://github.com/FezVrasta/cafe-hass) by
[Federico Zivolo](https://github.com/FezVrasta). The canvas, native HA editors,
and YAML graph conversion build on their work. See [credits](CREDITS.md) and the
[Apache 2.0 license](LICENSE).

This fork loads automation definitions from a configured directory. It edits
existing files, synchronizes their Git checkout, exports HA object metadata,
and runs project tests from inside Home Assistant. The panel still appears as
**FLODE** in HA and uses the `flode` integration domain.

## Current capabilities

- Browse independent automations grouped into collapsible folders; search by
  name and source path.
- Edit an existing automation using the inherited canvas and native HA forms.
  Save back to its original YAML file with revision checks.
- See the current commit, fetch without changing files, merge main into prod, inspect
  history, undo the latest merge, and return from a historical view to prod.
- Review local changes, commit with a message, and push prod. The author comes
  from Git configuration in the HA runtime.
- Explicitly check HA configuration and run **Quick reload** without restarting HA.
- Export devices, entities, and helpers to `objects/` for offline reference.
- Run Python tests from `tests/` in HA, including the supplied automation ID checker.

The current file workflow edits existing automations. Creation, save-as-copy,
imports as new automations, script-file editing, and action execution are outside
that workflow. Inherited code for upstream features is not a promise that those
features are enabled here. The historical upstream release notes are preserved
in [CHANGELOG.md](CHANGELOG.md).

## Configuration layout

Choose an existing absolute project root in **Settings → Devices & services →
FLODE → Configure**. The root name and location are configurable. Git operations
require this directory to be the checkout root, with an existing `prod` branch, active in HA.

```text
flode-config/
  automations/
    climate/
      heating.yaml
      ventilation.yaml
    security/
      vacation_alarm.yaml
  objects/
    index.yaml
    helpers/index.yaml
    integrations/<domain>/<config_entry_id>/
      integration.yaml
      devices/<device_id>/
        device.yaml
        entities/<entity_id>.yaml
      entities/<entity_id>.yaml
  tests/
    test_object_references.py
```

Entities without an HA config entry, including YAML entities and storage-backed
helpers, use `integrations/<domain>/_standalone/`. The indexes map original IDs
to their canonical files; helper records are not duplicated.

Automation files contain standard YAML lists. For example:

```yaml
- id: evening_lights
  alias: Evening lights
  triggers:
    - trigger: sun
      event: sunset
  conditions: []
  actions:
    - action: light.turn_on
      target:
        entity_id: light.living_room
  mode: single
```

Every automation needs a non-empty ID unique within its file. IDs may repeat
across separate files. Definitions are read only from `automations/`; `objects/`
and `tests/` are excluded. Loading a file into FLODE does not register it in HA.

Saving replaces the selected automation in that same file. Other files are
untouched. The writer preserves unknown fields and comments with `ruamel.yaml`;
formatting may be normalized within the saved file. External file changes cause
a stale save to fail. Files using anchors, aliases, blueprints, or unsupported
values are refused for editing. See the detailed
[editing contract](dev/container/README.md#editing-existing-automations).

## Install and configure

The integration declares **HA 2026.3+**; the development container is pinned to
**HA 2026.10.1**. The source build below uses **Node 24** and the repository's
pinned **Yarn 4**. The panel runs inside HA; there is no standalone web server.

```sh
git clone https://github.com/tima-fey/git-flode.git
cd git-flode
yarn install --immutable
yarn build
```

1. Copy the built `custom_components/flode/` directory, including `www/`, into
   your HA configuration's `custom_components/` directory.
2. Create the project root and its `automations/`, `objects/`, and `tests/`
   directories. Put automation YAML files in `automations/`.
3. Mount that project into HA with write access for editing, Git changes, and
   object exports. Git must be installed in the HA runtime for Git controls.
4. Restart HA, then add **FLODE** in **Settings → Devices & services** and enter
   the absolute project root as seen by HA. The panel is administrator-only.

The standard upstream FLODE HACS entry installs upstream FLODE. Use a build
from this fork for the behavior documented here. Both use the same integration
domain and `custom_components/flode/` path, so choose one implementation per HA
instance. Version numbers inherited from upstream are not separate fork releases.

For a reproducible isolated development installation, follow
[the Docker setup](dev/container/README.md). It uses synthetic HA configuration
and a disposable configuration checkout with a local Git remote.

## Git and applying changes

See [Git operations and recovery](docs/git-workflow.md) for conflict resolution,
merge undo and reapplication, unexpected prod divergence, and historical-checkout
pitfalls.

Configure Git identity where the HA process can read it, for example:

```sh
git -C /flode-config config user.name "Your Name"
git -C /flode-config config user.email "you@example.com"
```

Configure origin and its authentication separately. The UI uses that setup;
commit only requires a message. **Review changes** includes all changed and
untracked non-ignored files. **Commit all changes** commits that exact reviewed
snapshot; **Push prod** is a separate action. The diff preview is limited to
64 KiB, while the commit includes all listed content.

The configuration checkout in HA works on **prod**. Only this HA writes and
pushes prod; external work is committed to **main**. Set up prod before adding
this checkout to FLODE, or clone an existing `origin/prod`. For a first setup
inside the HA configuration checkout:

```sh
git -C /flode-config fetch origin
git -C /flode-config switch --no-track --create prod origin/main
git -C /flode-config push --set-upstream origin prod
```

**Fetch** updates cached `origin/main` and `origin/prod` without changing working
files. **Merge main into prod** fetches again and merges `origin/main` into
active prod. Every incoming update gets a dedicated merge commit, including
updates that could otherwise fast-forward. No automatic push or reload follows.
The UI shows prod's ahead/behind counts relative to origin/prod separately from
main commits not yet merged into prod. **Push prod** publishes prod only.

A conflicting merge is automatically aborted and the previous prod is restored.
On your computer, merge `origin/prod` into main, resolve conflicts, and push
main. Retry **Merge main into prod** in HA. Nobody else should push prod.
Unexpected remote prod commits stop merge/push rather than being overwritten.

**Undo latest main merge** creates a revert commit restoring the files from
before that update. It is available while that FLODE merge is the tip of prod,
with no pending file/editor changes. Push the revert with **Push prod** when
ready. History is preserved and force push is never used. Later local commits
are not discarded to undo an older update.

Git still considers reverted main commits merged. To reapply the same changes,
merge prod into main on your computer and revert the undo commit there, resolving
any conflicts. Push main, then merge it into prod from HA. This keeps prod's
single-writer rule intact.

Opening history uses detached HEAD in viewing mode. **Return to prod** restores
the working branch. Saving and object export are refused on historical Git
revisions. Merge, undo, and checkout require clean files and saved/discarded
editor drafts. There is no legacy main-only mode, automatic reset, stash, or
force push. The application source repository's development branches are
independent of this configuration-repository workflow.

Save, commit, push, tests, config check, and reload are explicit actions. To
apply this checkout to HA, connect its files to your HA configuration includes.
A dedicated setup can use:

```yaml
automation: !include_dir_merge_list flode-config/automations
```

Integrate this with your existing includes. **Check configuration** and
**Quick reload** operate on HA's configured files; they apply to the FLODE
checkout only when it is included there. Quick reload calls
`homeassistant.reload_all`; it is not a full HA restart.

## Object snapshots and tests

1. Click **Export HA objects** to replace the entire `objects/` directory with
   current metadata, removing obsolete files. Keep hand-written tests in `tests/`.
2. Add the portable [reference test](dev/container/fixtures/tests/test_object_references.py)
   to your project's `tests/` directory.
3. Click **Run tests** in HA. Failures identify the YAML file, automation, field,
   and missing ID.

Exports include registered entities, disabled registry entries, current
unregistered entities, and helpers. Connection settings, credentials, current
state values, and arbitrary state attributes are omitted. The catalog is a
snapshot; browsing, Git operations, and test runs do not refresh it.

The supplied test scans every automation YAML file for explicit entity, device,
area, label, and config-entry references, including supported literal Jinja
lookups. Computed references fail explicitly when they cannot be validated
statically. It reads the snapshot and never runs HA actions. Export again before
running it when you need current inventory. Existence in the snapshot does not
prove live device availability.

Project tests run Python `unittest` in the HA environment, in a separate process,
with a 60-second limit and 64-KiB output limit. They execute trusted project code
with the HA process's filesystem permissions; the runner is not a sandbox.
Details and offline ID-check examples are in the
[container guide](dev/container/README.md#offline-ha-object-catalog).

## Development and support

- [Contributing and checks](CONTRIBUTING.md)
- [Architecture and storage behavior](docs/architecture.md)
- [Isolated HA Container setup and browser checks](dev/container/README.md)
- [Fork changes and upstream history](CHANGELOG.md)
- [Credits and lineage](CREDITS.md)
- [Fork issue tracker](https://github.com/tima-fey/git-flode/issues)

Report fork-specific behavior to this repository. Credit for the original FLODE
editor and the earlier C.A.F.E. foundations remains with their authors and
contributors.

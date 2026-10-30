# git-flode: development roadmap

Status: agreed direction, adapted to the codebase as of October 30, 2026.
This document plans incremental changes; it does not authorize implementing the
entire roadmap. The build, YAML experiments, and checks listed below have not
been performed as part of preparing this document.

## Goal and scope

The FLODE fork remains a Home Assistant panel, also accessible through the HA
app. On a laptop, the user edits configuration with an agent; a separate offline
visual editor is unnecessary. The panel provides viewing and small visual edits
to the same files. YAML in Git is the source of truth.

The intended structure is `ha/<class>/<group>.yaml`, for example
`ha/climate/ventilation.yaml`. Each file contains a standard YAML list of related
but independent automations. Preserve existing `id` values, triggers, and modes;
do not turn a group into one automation. The directory structure must not
require migration before the first use.

The application repository, `/Users/timofeymarkov/repos/git-flode`, is separate
from the configuration repository, `/Users/timofeymarkov/HA`. According to the
received context, the latter currently contains 82 automations in
`automation/rules/*.yaml`, included by `automation.yaml` through
`!include_dir_merge_list automation/rules`. These details have not been verified
here. The presumed production HA checkout is `/config/HA`; verify the path and
actual configuration includes before making any changes. Project preparation
does not include moving or modifying real automation rules.

## Existing code

| Area | Existing foundation | Implication for the fork |
| --- | --- | --- |
| Panel | `packages/frontend/src/flode-panel.ts`, `tabs.ts`, canvas, and inspector | Reuse the graph and native HA forms; add file provenance to tab state |
| Loading and saving | `packages/frontend/src/ha.ts`: `loadAutomationConfig`, `saveFlowConfig`, API `config/<kind>/config/<id>` | The HA API is not a file-group store; file tabs need a separate adapter |
| Conversion | `packages/transpiler/src/parser/YamlParser.ts`, `FlowTranspiler.ts`; the panel uses `keepBlocks: true` | Reuse individual automation graphs; verify semantic round trips separately |
| Metadata | `packages/transpiler/src/save-config.ts`, `FlowTranspiler.ts` | Layout currently goes into `variables._flode_metadata`; no sidecar exists yet |
| Python | `custom_components/flode/__init__.py`, `panel.py` | Currently handles panel registration/unloading and static assets; no custom file API |
| Access | `panel.py` registers the panel with `require_admin=True` | New backend commands also need their own administrator checks |
| Validation | Package Vitest suites; `.github/workflows/ci.yml`, `hacs.yml`, `hassfest.yml`; `dev/gate` | Extend existing checks and add file-backend tests without duplicating CI |

See [architecture.md](architecture.md) for the current model. This document
describes the fork's intended behavior, not capabilities already implemented
upstream.

## Architectural direction

Introduce a storage interface between the panel and automation sources.
Wrap the existing HA API in one adapter and file groups in another. Keep file
access, Git, and checkout settings out of the UI and parser. Put shared contract
types in `@flode/shared` and pure logic in the existing packages. Prefer small
extension points to preserve the ability to receive upstream improvements.

The tentative file backend lives inside the custom integration: asynchronous HA
administrator commands, file I/O outside the event loop, and an allowed root
configured through integration settings. Define command names and the exact
interface when implementing stage 1a. Validate resolved paths after following symlinks; reject
paths outside the root, traversal through `..`, and arbitrary filesystem access.

A storage document should associate a relative path, automation `id`, original
entry, and file fingerprint. Explicitly report missing or duplicate IDs; disable
saving those entries until addressing is resolved. Distinguish automation IDs,
HA entity IDs, and temporary graph IDs.

Prefer storing layout and diagram settings separately, for example in
`.editor/`. The format, stable block identifiers, behavior when steps are
reordered externally, and compatibility with `_flode_metadata` need design.
Automatic layout without metadata writes is sufficient initially. Keep sidecars
and `catalog/` outside the `!include_dir_merge_list` tree.

## Stage 0: install dependencies, build, and run all existing tests

Establish a working baseline before changing behavior.

Development environment:

- Use Node 24 and the pinned Yarn 4 version for TypeScript dependencies. Yarn
  installs these into `node_modules`; a Python virtual environment is unrelated
  to the frontend build.
- Build and run TypeScript checks locally. Run Home Assistant and the integration
  in a separate Docker container in stage 0a.
- Use a separate Python virtual environment for backend unit tests when needed;
  do not install Python dependencies into the system interpreter.
- The repository already provides `tools/ha-venv.sh` and a release gate designed
  around HA Core in a venv. This is an existing alternative, not the selected
  Docker setup. Adapt or reuse individual browser checks; do not assume the
  existing gate can manage a container unchanged.

Baseline commands from the repository root:

```sh
yarn install --immutable
yarn build
yarn typecheck
yarn test --run
yarn biome ci .
```

Run all existing automated tests and applicable static checks, including the
existing Python lint and packaging validations where the environment supports
execution. Record exact commands and results; report skipped or unavailable
checks explicitly. Browser integration checks belong to stage 0a because the
panel requires live HA and has no standalone development server.

Acceptance: dependencies install reproducibly, the panel bundle is built, all
existing local tests and checks pass or have explicitly investigated baseline
failures, and the project is ready to load in test HA. Do not describe the
application as running based on a successful build alone.

## Stage 0a: launch the existing FLODE integration in HA Container

Before modifying loading or editing behavior, prove that the existing integration
works in a separate Home Assistant Docker container.

- Provide a reproducible container setup with an isolated writable `/config`,
  an explicit HA image version, and the built FLODE integration mounted or copied
  into `/config/custom_components/flode`.
- Determine the user's HA version before selecting the compatibility target.
  Keep container configuration and test data separate from production.
- Complete test-instance setup, add the FLODE integration, and open its panel
  as an administrator.
- Load one simple synthetic automation through the existing HA configuration
  path. Verify that the panel renders its graph and native HA forms.
- Inspect HA logs and browser errors. Run applicable existing browser checks
  against the container; adapt their lifecycle setup where necessary.
- Document startup, rebuild/update, shutdown, and verification commands.

Acceptance: the container starts, FLODE registers and serves its bundle, a simple
HA automation opens correctly, and browser checks have recorded results.
This is a baseline check of the current HA API path. No custom-folder support
is expected yet, and no real devices or production rules are used.

## Stage 1: disable modifications and operate in viewing mode

Make the fork read-only before adding a new configuration source. Apply this
mode to the panel, including existing HA-backed views, rather than only to
future file tabs.

- Keep listing, opening, navigating, selecting, and inspecting automations.
- Disable editing, saving, creating, deleting, duplicating, importing/merging,
  and other operations that modify automation configuration. Cover toolbar
  actions, context menus, keyboard shortcuts, and inspector changes.
- Keep diagram navigation available; disable layout mutation and persistence
  for this initial milestone.
- Disable action execution and configuration reload controls in viewing mode.
- Guard mutation entry points as well as visible controls. HA's own API remains
  outside the fork's control; the panel must not call its mutation endpoints.
- Add focused automated tests for mutation guards and UI paths. Rerun the full
  existing test suite and static checks; adapt editor tests explicitly to the
  intended viewing behavior rather than silently skipping failures.
- Verify viewing behavior in the HA container from stage 0a, including mobile
  viewport behavior and browser/network errors.

Acceptance: automations remain readable, editing and execution paths cannot be
triggered through the panel, and interaction produces no configuration writes
or new layout metadata. Record before/after hashes of test configuration files
and check that no mutation requests are sent.

## Stage 1a: read YAML automations from a custom directory

Teach the integration to read automation definitions from a configured directory
instead of using the HA automation configuration API for file-backed views.
Keep the existing parser and canvas. Start with a small synthetic YAML list,
not a real configuration migration.

Scope:

- A configurable allowed configuration root and a backend that lists and reads
  YAML files from it. Use relative paths; support the existing
  `automation/rules` structure without requiring migration.
- A small storage adapter between the panel and its source. File-backed listing
  and loading must not depend on automations being registered as HA entities.
  Live HA APIs may still supply native UI components and entity descriptions.
- Load a standard YAML list, list its independent automations, select an entry,
  and render it through the existing FLODE parser and canvas.
- Show automation ID, name, and source file. Report malformed YAML, incorrect
  document shapes, missing/duplicate IDs, missing files, and unsupported steps
  clearly. Do not expose a file-write API.
- Enforce administrator access on backend commands, resolve and constrain paths
  to the allowed root, reject traversal and symlink escapes, perform file I/O
  outside the event loop, and clean up handlers on unload.

Verification:

1. Add backend unit/integration tests using temporary directories and appropriate
   HA fixtures. Cover valid lists, multiple files and entries, invalid input,
   filesystem failures, access checks, traversal, and symlink escapes.
2. Add parser/model tests for file-list entries and frontend tests for source
   selection, provenance, diagnostics, and read-only guards. Reuse existing
   fixtures and run the full existing suite and static checks.
3. Mount a separate fixture directory read-only into the HA container. Include
   one simple automation using only test helpers or harmless synthetic steps;
   do not include that directory in HA's own automation configuration.
4. Open the group and automation in FLODE. Verify the expected triggers,
   conditions, and actions appear, without the definition being obtained from
   the HA automation config API. Check logs and browser/network errors.
5. Add a second independent automation to the fixture and verify separate
   selection and diagrams. Test malformed YAML and a missing source file.
6. Compare fixture hashes before and after interaction. Confirm that no sidecars,
   YAML metadata, writes, or action execution occur.

Acceptance: the containerized panel reads and displays the mounted custom-folder
fixture through the new backend, with no HA automation registration required.
Automations remain independent, errors are clear, access/path checks pass, and
all applicable automated and container/browser checks have recorded results.

The immediate sequence ends here. YAML write preservation, Git, catalog export,
and relationship diagrams remain later milestones.

## Stage 2: safely write one automation

Begin this later milestone with a separate save-contract investigation on test
fixtures: YAML → graph → generated YAML → reread. Compare semantic preservation
and source-text preservation separately, including nested blocks, Jinja,
unknown fields, comments, and neighboring entries. Existing structural round-trip
tests are useful but do not prove preservation of a YAML list file's text.
The current `js-yaml` load/dump and transpiler do not guarantee comment or
formatting preservation; step-level `_raw` is not a whole-document guarantee.
Choose and verify targeted writes using a comment-preserving CST/AST library
or a proven single-entry source-range update before enabling writes.

Then edit the selected entry in its original YAML list. Preserve neighboring
entries, unknown fields, and comments according to that verified contract;
show limitations before writing. Opening and saving an unchanged automation must not rewrite the file.

Show a diff before writing. Check the original file fingerprint at write time;
refuse to overwrite external edits from an agent or another tab. Use atomic
replacement and serialize competing backend writes. Investigate the remaining
race with external writers and do not promise unverified cross-process
guarantees. Preserve appropriate file permissions.

Saving, Git synchronization, and applying changes to HA are separate explicit
actions. Configuration validation and reload are needed to apply changes;
a successful write does not prove successful application. Do not reload
production HA in tests.

Acceptance: change one block, inspect the diff, and reread the file; neighboring
rules remain intact, saving again without changes produces no diff, and a test
detects an external edit conflict. Also test write failures.

## Stage 3: Git for an existing checkout

Sequence: status/diff → explicit commit/push → fetch, inspect incoming changes,
and fast-forward pull. Offer to push after saving without mandatory automatic
pushes. Account for unsaved tabs, dirty trees, unrelated changes, diverged
branches, and remote failures. Do not force push, reset, or automatically include
unrelated files in commits. Git failures must preserve local work.

Use existing authentication outside the repository. Defer new remote setup and
cloning. Verify Git availability specifically in the HA Core environment:
Git installed in an SSH add-on does not establish availability to the
integration. Choose a verifiable deployment or dependency before implementation.
If a separate service or add-on is needed, justify the architectural change
and explicitly document installation.

Acceptance: test the workflow and failures on a temporary checkout with a local
bare remote; do not use the production configuration repository or its remote.

## Stage 4: HA catalog for the agent and reference validation

Create `catalog/` next to `ha/`, outside the include tree, with `devices.yaml`,
`entities.yaml`, `areas.yaml`, `services.yaml`, and `manifest.yaml`. Refresh it
from live HA through a button. Include source, timestamp, and format version;
use stable sorting and meaningful diffs. Export only necessary fields, without
secrets, tokens, or constantly changing readings.

Include `device_id`, `entity_id`, entity registry entry IDs, names, device ↔
entity ↔ area relationships, model/manufacturer, classes/units, available
actions, and fields. Account for helpers without devices and available entities
outside the entity registry. An entity ID in device-based YAML can mean a
registry ID rather than `domain.object_id`; validate against the specific
action or trigger schema.

Validate explicit device, entity, area, and action references, including static
Jinja references. Mark dynamic references as unverified and show catalog age.
The catalog describes a snapshot, not current device health. Add instructions
for the configuration-repository agent. This capability is also useful
independently of the visual editor.

## Stage 5: group relationships and usability

Provide an overview diagram for viewing automations, helpers, sensors, and
actuators, with navigation to individual automations. Reuse existing ui-core
relations logic where applicable. Do not promise exact detection of dynamic
Jinja dependencies. Add traces, search, improved conflict/synchronization flows,
remote setup, and other improvements as needed afterward.

## Test environment and distribution

TypeScript: use existing Vitest suites and fixtures. Python backend: add pytest
with suitable `pytest-homeassistant-custom-component` fixtures. Test files only
in temporary directories and Git only in test repositories.

Check the UI in a separate HA Container with separate configuration and the
user's HA version (establish that version first). Native FLODE forms require
live HA; the catalog does not emulate devices. Do not connect test HA to real
devices, the production checkout, or its remote. An HA OS VM is unnecessary
for the basic custom integration.

Extend existing CI, HACS validation, and hassfest. Packaging checks do not
replace functional tests. Adapt the release `dev/gate` to the new scenarios;
it does not authorize testing against production HA.

The baseline distribution is a custom integration and panel through HACS.
A separate service or add-on is not an accepted dependency at this point.
Do not migrate all 82 rules or implement the entire roadmap in one change.

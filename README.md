# git-flode

Edit Home Assistant automation YAML on a visual canvas, review and publish its
Git changes, and apply updates from `main` to a dedicated `prod` checkout.
The integration and administrator panel appear as **git-flode** in Home Assistant.

This is an independent fork of [FLODE](https://github.com/SH1FT-W/flode) by
SH1FT-W and contributors, built on the earlier
[C.A.F.E.](https://github.com/FezVrasta/cafe-hass) project by Federico Zivolo.
See [credits](CREDITS.md), [history](CHANGELOG.md), and [license](LICENSE).

## Install the integration

The application source repository and your HA configuration repository are
separate repositories. Build this application with Node 24 and pinned Yarn 4:

```sh
git clone https://github.com/tima-fey/git-flode.git
cd git-flode
yarn install --immutable
yarn build
```

Copy `custom_components/flode/`, including its built `www/` directory, into
HA's `custom_components/`. HA 2026.3 or later is required.
The upstream FLODE HACS entry installs upstream; install the git-flode build for
this workflow. They share an integration domain, so install one implementation.

## Prepare your configuration repository

Use a separate Git repository containing your automation files and optional
object catalog and project tests:

```text
configuration-repo/
  automations/
    climate/heating.yaml
    security/alarm.yaml
  objects/
  tests/
    test_object_references.py
```

Each automation file contains a YAML list. IDs must be non-empty and unique
across **all** automation files included by HA:

```yaml
- id: evening_lights
  alias: Evening lights
  triggers:
    - trigger: sun
      event: sunset
  actions:
    - action: light.turn_on
      target:
        entity_id: light.living_room
  mode: single
```

On your computer, commit and push this repository's `main` branch to its origin.
In the HA runtime, clone that repository and prepare `prod` (replace the URL):

```sh
git clone --branch main https://example.com/you/configuration.git /config/flode-config
git -C /config/flode-config switch --no-track --create prod origin/main
git -C /config/flode-config config user.name "Your Name"
git -C /config/flode-config config user.email "you@example.com"
git -C /config/flode-config push --set-upstream origin prod
```

If `origin/prod` already exists, clone with `--branch prod` instead. Git and its
credentials must be available to the HA process; the panel uses that identity
and authentication. Use the same destination for origin fetch and push URLs.
HA is the only writer of `prod`; computer changes go to `main`.

Restart HA, then add **git-flode** under **Settings → Devices & services** and
set its project directory to `/config/flode-config`. It must be the checkout root, writable by HA, with `automations/`
and active `prod`. Connect those files to HA in `/config/configuration.yaml`:

```yaml
automation: !include_dir_merge_list flode-config/automations
```

Combine this with your existing automation configuration. A separate Container
mount at `/flode-config` also works: configure FLODE with `/flode-config` and
use `automation: !include_dir_merge_list /flode-config/automations` in HA.
The paths must refer to the same files inside HA's runtime. Opening files in
FLODE alone does not load them into HA.

The top-level HA include is supported by HA. Inside the automation files,
FLODE accepts ordinary YAML lists; `!include` and `!secret` tags are not resolved.
Anchors, aliases, blueprints, symlinked paths, and values outside the editable
schema are refused. Unknown ordinary automation fields and comments are retained;
formatting within the saved file may be normalized.

## Edit and publish

Browse by folder or search by name/path, open an automation, edit its steps using
HA's native forms, and Save. This replaces that automation in its original file.
Other files remain untouched. External changes invalidate a stale save; reopen
the file before retrying. Unsaved drafts survive browser reloads.

1. **Review changes** shows local modified and untracked files. **Commit all
   changes** requires that review and a message. Its snapshot includes
   `objects/` and `tests/`; the diff display limit is 64 KiB.
2. **Push prod** publishes committed prod separately.
3. For computer changes, push `main`, then **Merge main into prod** in HA.
   This fetches origin and creates a merge commit. Resolve conflicts on your
   computer by merging prod into main, then push main and retry.
4. **Check configuration**, then **Quick reload** to load HA's configured files.
   Reload is explicit and coordinated with project operations; Git changes do
   not reload HA automatically. It reloads supported domains without a restart.

History opens a read-only commit diff without changing the live checkout.
**Undo latest main merge** creates a revert commit while that merge remains
prod's tip. Publish the revert separately. See
[Git operations and recovery](docs/git-workflow.md) for divergence, conflicts,
and reapplying reverted changes.

## Object catalog and project tests

**Export HA objects** replaces `objects/` with devices, entities, helpers, and
registry relationships. It omits credentials, connection settings, state values,
and arbitrary attributes. Keep handwritten files under `tests/`, since export
removes obsolete catalog files. Export is explicit and creates no commit.

Copy the [portable reference test](dev/container/fixtures/tests/test_object_references.py)
into your configuration repository's `tests/`. **Run tests** runs `test_*.py`
using HA's Python environment. The checker validates automation IDs globally
and static entity/device/area/label/config-entry references against the latest
export, including supported literal Jinja lookups. Computed references report
that static validation is unavailable. Duplicate files stay available to open
and repair in the panel.

Tests run trusted project Python with HA's permissions in a separate process,
with a 60-second timeout and 64-KiB output limit. Export again when tests should
use current metadata; tests do not refresh the catalog. A snapshot does not
prove that an entity is available at runtime.

## Development and support

Use the [disposable HA Container](dev/container/README.md) for development and
browser checks. See [contributing](CONTRIBUTING.md),
[architecture](docs/architecture.md), and the [release gate](dev/gate/README.md).
Report issues in [this repository](https://github.com/tima-fey/git-flode/issues)
with the commit, HA version, and a minimal redacted example.

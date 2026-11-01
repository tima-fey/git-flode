# File-workflow release gate

Run `dev/gate/gate.sh` from the application repository after the authorized
release commit and before tagging or pushing. The gate always uses the
[disposable Container setup](../container/README.md), fixed to
`http://127.0.0.1:18123`, its generated token, synthetic configuration, local
bare Git remote, and `/flode-config` project mount. It never accepts a production
HA URL or token. Docker, Node 24, Yarn 4, and browser installation access are
required. The gate stops only this Compose project, moves any existing disposable runtime
into `.gate/runtime-backups/`, provisions fresh fixtures and a fresh local remote
from the current source, and restarts HA with the current integration build.

The full gate runs:

1. Biome, type checking, all Vitest tests, and a fresh workspace build.
2. Python backend tests and Ruff in the pinned HA 2026.10.1 image.
3. Container preparation and verification that HA includes the synthetic project
   automations through `!include_dir_merge_list /flode-config/automations`.
4. Chromium and WebKit file cards, editing/save/reopen and stale-save checks,
   viewing without mutation, Git fetch/merge/history/push/undo, reviewed local
   publication, HA check/reload, object export, and project-test controls.
5. Screenshots of file-backed flows in both browsers, compared with the stored
   baseline. New or changed pictures require human review in
   `.gate/visual/report.html`; differences are recorded rather than hidden.

The driver records each step's exit status and log. Browser suites also record
individual checks, including retries marked `flaky`. The final
`.gate/gate-<full-commit-sha>.json` has `counts_for_release: true` only after all
required steps succeed in a full run, on a clean checkout, with HEAD unchanged
and the checkout still clean at completion. A partial run or baseline update
never certifies a release. Review flaky tests and visual changes before release.

```sh
dev/gate/gate.sh
# Debug one suite; does not certify a release:
dev/gate/gate.sh --only edit-files
# After publishing, store the new visual baseline:
dev/gate/gate.sh --only visual --baseline
```

The `lib.mjs`, card checks, visual comparison, report writer, and flow fixtures
retain useful upstream utilities. Release certification no longer seeds, edits,
or removes automations/scripts through HA's configuration API. File saves are
checked against actual YAML files by the Container suites. The application
source Git repository is separate from the disposable configuration checkout.

Stop the disposable instance with
`docker compose -f dev/container/compose.yaml down`. To reset its fixture
history, stop it and move `dev/container/runtime/` aside before the next run.

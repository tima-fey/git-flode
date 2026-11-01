# git-flode development guide

Read `AGENTS.md`, `CONTRIBUTING.md`, and `docs/architecture.md` before changing
storage, graph conversion, or execution behavior. Retain project attribution in
`CREDITS.md` and source headers.

## Product and structure

The administrator panel edits existing automation YAML under a configured
configuration repository's `automations/`. Saves preserve unknown fields and
neighboring entries. Git operates on that repository's `prod`, bringing external
changes from `origin/main`. Save, review/commit, push, metadata export, project
tests, HA configuration validation, and reload are explicit actions. Historical
inspection reads a commit diff without changing the live checkout.

- `packages/shared`: strict TypeScript types and Zod schemas.
- `packages/transpiler`: native YAML parsing, graph analysis, and generation.
- `packages/ui-core`: framework-free card summaries, graph and template helpers,
  configuration-path mapping, and translations.
- `packages/frontend`: Lit HA panel, native HA editors, file and Git controls.
- `custom_components/flode`: administrator APIs, file storage, Git, object
  exports, trusted Python tests, and coordinated HA reload.
- `tests`: Python integration regressions; configuration-project tests live
  separately under that project's `tests/`.
- `dev/container`: disposable HA with synthetic configuration and a local remote.
- `dev/gate`: full file-workflow release certification and visual comparison.

## Implementation

Write repository prose, comments, and commit/PR text in English. Preserve
intentional UI translations. Keep TypeScript strict: use `unknown` and type
guards, avoid `any`, suppression comments, and assertions except unavoidable
external API boundaries. Do not use IIFEs.

Search for existing implementations before adding helpers. Reuse `@flode/*`
imports, shared contracts, and framework-free ui-core logic. Keep one Lit element
per `flode-*.ts` file with reactive properties. The panel owns tabs and undo.
Use HA's native forms, pickers, and dialogs, compatible with `hacs.json`.
Add translation keys to every supported language and preserve placeholders.

Never lose native YAML fields or modify neighboring files. Use deterministic
fixtures for semantic round trips and separate byte-preservation checks. File,
Git, export, test, and reload operations share the canonical project lock.
Do filesystem/subprocess work outside HA's event loop. Keep root, HEAD, revision,
and review guards; never introduce a fallback to HA's automation config API.
Never commit tokens, credentials, runtime files, or HA storage.

## Checks

Use Node 24 and Yarn 4 from the repository root. The pinned Yarn executable is
configured in `.yarnrc.yml`. Install with `yarn install --immutable`, then build
workspace dependencies before tests. There is no standalone frontend server:
`yarn dev` rebuilds `custom_components/flode/www` for a test HA.

```sh
yarn build
yarn test --run
yarn typecheck
yarn check:biome
```

Inspect every result; aggregate `yarn check` uses semicolons. Backend tests,
Ruff, browser checks, and disposable HA startup commands are in
`CONTRIBUTING.md` and `dev/container/README.md`. Never test against production HA.

## Git authorization

Ask for user authorization before commits, pushes, version bumps, tags,
releases, and other Git mutations. An explicit user request authorizing an
action supplies permission. Creating temporary Git repositories for regression
tests is part of testing and does not publish or alter application history.
Documentation and code edits do not authorize a release.

## Authorized releases

1. Derive user-facing notes from commits since the last release. The first
   standalone git-flode release is `1.0.0`. Use the maintainer-selected version
   for later releases; the inherited `dev/next-version` calendar helper does not
   determine git-flode release versions. Keep
   `custom_components/flode/manifest.json` and `packages/frontend/package.json`
   synchronized. Update the welcome sheet and all associated translations.
   Preserve `CHANGELOG.md` as git-flode's change history and upstream archive;
   update git-flode entries when relevant.
2. Commit the release changes with an English message. Inspect all static,
   backend, and browser checks required by the gate.
3. Run the **full** `dev/gate/gate.sh` after that commit, before tagging or
   pushing. Only `.gate/gate-<full-commit-sha>.json` with
   `counts_for_release: true` for the exact release commit qualifies.
   The tree must be clean before and after the run. Any subsequent source edit
   requires a new commit and a new full gate. Partial and baseline runs do not
   count. Read `dev/gate/README.md` for the disposable file-workflow coverage.
4. Review `.gate/visual/report.html` with the user if pictures changed. Report
   new pictures and flaky checks. Do not publish with failed checks.
5. With the authorized release commit certified, tag the bare version (no `v`),
   push main and that tag, and create the GitHub release with notes derived
   from history. Write multiline release notes to a file and use `--notes-file`.
6. Verify the published release and run
   `dev/gate/gate.sh --only visual --baseline` to record its visual baseline.

Do not create extra release commits after certification or certify a different
commit than the one being tagged and pushed.

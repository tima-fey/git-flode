# Contributing to git-flode

This repository is an independent fork of [FLODE](https://github.com/SH1FT-W/flode)
by SH1FT-W and contributors, with earlier C.A.F.E. foundations. See
[CREDITS.md](CREDITS.md). Contributions and fork-specific reports belong in
[tima-fey/git-flode](https://github.com/tima-fey/git-flode).

## Development setup

Use Node 24 and Yarn 4; `.yarnrc.yml` selects the pinned executable. Clone this
fork, install dependencies, and build upstream workspace outputs before tests:

```sh
git clone https://github.com/tima-fey/git-flode.git
cd git-flode
yarn install --immutable
yarn build
```

`yarn dev` watches and rebuilds `custom_components/flode/www/`. Load the panel
inside a separate test Home Assistant; there is no standalone development
server. Use [the isolated Docker setup](dev/container/README.md) for startup,
restarts, fixture provisioning, and browser checks. The test configuration
checkout and its local remote are separate from the application repository.

The configured project has `automations/`, `objects/`, and `tests/`. Native HA
editor elements still need a live HA frontend, while automation definitions
come from the file backend. Read [the architecture](docs/architecture.md)
before changing graph, parser, transpiler, storage, or execution behavior.

## Repository structure

| Location | Purpose |
| --- | --- |
| `packages/frontend` | Lit panel, native HA editors, file provenance, Git and HA controls |
| `packages/ui-core` | Framework-free card summaries, relations, AI, traces, and locales |
| `packages/shared` | Shared types and Zod schemas, including backend contracts |
| `packages/transpiler` | YAML/graph conversion and structural regression fixtures |
| `custom_components/flode` | HA integration, file storage, Git, object export, and test runner |
| `tests` | Python backend and portable project-test regressions |
| `dev/container` | Disposable HA Container and file-workflow browser checks |
| `dev/gate` | Inherited upstream release checks and shared browser utilities |

## Checks

Run each check and inspect its result. `yarn check:biome` runs the same lint,
formatting, and import/export organization checks as CI. The aggregate
`yarn check` uses semicolons and can hide an earlier failure behind a later successful command.

```sh
yarn build
yarn test --run
yarn typecheck
yarn check:biome
```

Run backend tests in the same pinned HA environment as CI:

```sh
docker run --rm -e PYTHONDONTWRITEBYTECODE=1 \
  -v "$PWD:/work:ro" -w /work --entrypoint sh \
  ghcr.io/home-assistant/home-assistant:2026.10.1 \
  -c 'uv pip install --system --index-strategy unsafe-best-match pytest==8.4.2 ruamel.yaml==0.18.16 && python -m pytest -p no:cacheprovider tests -q'
```

Python lint uses Ruff 0.16.9. For changes to portable project tests, include
`dev/container/fixtures/tests/` in linting as well as `custom_components/` and
`tests/`. Run relevant container/browser checks for UI, source loading, saving,
Git, object export, and the Run tests button. See the container guide for commands.
These checks use disposable fixtures and a local Git remote.

The configuration repository's `tests/` is distinct from this repository's
backend suite. HA runs its `test_*.py` files through Python unittest. The
portable ID checker uses the last explicit object export; missing production
IDs in the isolated climate examples are expected failures, not grounds to
skip checks or manufacture catalog records.

## Implementation conventions

- Use English for repository prose, comments, commits, and PR descriptions.
  Keep intentional UI translations in their locale files.
- Keep TypeScript strict: prefer `unknown` and type guards. Avoid `any`,
  assertions, and suppression comments; do not use IIFEs.
- Reuse `@flode/*` packages, shared Zod contracts, and existing helpers. Keep
  framework-free shared logic in ui-core.
- Reuse native HA elements and the existing Lit patterns. Add new translation
  keys in every supported language.
- Preserve native YAML, unknown fields, and neighboring automations. Verify
  semantic round trips separately from source-text preservation. Saving one
  file must leave every other file's content, permissions, and mtime unchanged.
- Keep save, Git operations, exports, tests, validation, and reload explicit.
  Filesystem and subprocess work belongs outside the HA event loop. Enforce
  administrator access, root/path validation, stale-request checks, and the
  shared project lock where applicable.
- Test files in temporary projects and Git in temporary repositories. Keep
  credentials, tokens, HA storage, and runtime artifacts out of commits.

## Pull requests and releases

Use focused branches and open PRs against this fork's `main`. Describe the final
behavior, relevant validation, and limitations in English. Preserve attribution
when adapting upstream code or documentation; keep historical upstream issue
links attached to their original changes.

Follow the authorization and release policy in [CLAUDE.md](CLAUDE.md): commits,
pushes, tags, version changes, and releases require user authorization. An
explicit request supplies that authorization. Documentation edits do not
implicitly authorize a release.

The current manifest/frontend versions retain upstream numbering. Keep them
synchronized for an authorized release and follow the exact-commit release
procedure in CLAUDE.md and [the release gate guide](dev/gate/README.md). The
inherited HA-API gate and fork file-workflow browser tests cover different
paths; neither should be presented as validating the other.

## Reporting issues

Use [the fork issue tracker](https://github.com/tima-fey/git-flode/issues).
Include the fork commit, HA version, installation method, reproducible steps,
and a minimal redacted YAML example when relevant. For storage or Git failures,
include the operation and displayed error. For reference-test failures, state
whether objects were exported before the test run.

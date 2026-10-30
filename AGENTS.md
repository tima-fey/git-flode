# Repository guide

FLODE is a visual editor for Home Assistant automations and scripts. It must
round-trip native Home Assistant YAML without losing users' data or unknown
fields. Read `docs/architecture.md` before changing graph, parser, transpiler,
or execution behavior. See `CONTRIBUTING.md` and `CLAUDE.md` for existing project
guidelines and release procedures.

## Structure

- `packages/frontend`: Lit panel and Home Assistant component integration.
- `packages/ui-core`: framework-free logic, card summaries, AI, traces, and locales.
- `packages/shared`: shared TypeScript types and Zod schemas.
- `packages/transpiler`: YAML parsing, graph analysis, and YAML generation.
- `custom_components/flode`: Python Home Assistant integration.
- `__tests__/yaml-automation-fixtures`: automation fixtures for regression tests.
- `dev/gate`: browser and visual release checks against a test Home Assistant.

## Development commands

Use Yarn 4 from the repository root; the pinned executable is configured in
`.yarnrc.yml`. Install dependencies with `yarn install`.

- `yarn build`: build workspaces in dependency order through Turbo.
- `yarn dev`: watch and rebuild; the frontend writes to
  `custom_components/flode/www`. There is no standalone development server:
  load the integration inside a test Home Assistant instance.
- `yarn test --run`: run Vitest without watch mode.
- `yarn typecheck`: check workspace types, building upstream dependencies.
- `yarn lint:biome`: lint the repository.
- `yarn format:check`: check formatting without modifying files.
- `yarn format`: apply formatting.
- `yarn workspace @flode/<package> test`: run a package's tests.

Build workspace dependencies before tests on a fresh checkout: internal packages
export their `dist` outputs. Validate relevant behavior with deterministic tests;
reuse existing fixtures for YAML parsing and round-trip regressions. Before a PR,
run the project's type, test, lint, and formatting checks. The aggregate
`yarn check` uses semicolons, so inspect each check's result.

## Implementation conventions

- Write all new or updated repository content in English, including documentation,
  plans, code comments, and commit/PR text. Preserve intentional non-English UI
  translations in their respective locale files. Conversation language does not
  change this repository policy.
- Keep TypeScript strict. Prefer `unknown` and type guards; avoid `any`, type
  assertions, and suppression comments. Assertions are only for unavoidable
  external API boundaries.
- Do not use IIFEs in TypeScript. Extract named helpers or Lit elements.
- Search for existing implementations before adding logic. Reuse shared helpers,
  types, and schemas; put framework-free shared behavior in `@flode/ui-core`.
- Use `@flode/*` imports for workspace packages.
- Use Home Assistant's existing elements, editors, dialogs, and pickers. Check
  compatibility with the minimum Home Assistant version in `hacs.json`.
- Follow the existing Lit pattern of one element per `flode-*.ts` file and
  reactive properties. The panel owns open flows and undo history.
- Add new UI translation keys to every supported language. Panel strings live in
  `packages/frontend/src/strings.ts` and `packages/frontend/src/locales`; card
  strings live in ui-core locales; integration strings live in
  `custom_components/flode/translations`. Preserve placeholders and plural forms.
- Never commit Home Assistant tokens, credentials, or other secrets.

## Git and releases

Follow the existing permission policy in `CLAUDE.md` for commits, pushes,
version bumps, tags, releases, and other Git mutations. An explicit user request
authorizing an action supplies that permission.

For authorized releases, follow the full release procedure in `CLAUDE.md` and
`dev/gate/README.md`. Versions use calendar format `YY.M.N`; derive the next
version with `dev/next-version`. Keep the integration manifest and frontend
version synchronized. The full release gate must pass for the exact release
commit before tagging or pushing.

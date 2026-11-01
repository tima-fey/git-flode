# Development baseline: October 30, 2026

This is a historical report from the initial upstream HA-API evaluation,
before the file workflow replaced it. It does not certify the current implementation.
Use [the file-workflow gate](../gate/README.md) for current validation.


Stages 0 and 0a were exercised on an ARM Mac using Node 24.22.1, Yarn 4.17.0,
Docker Desktop, and Home Assistant Container 2026.10.1. The HA version follows
the repository's existing test helper default; compatibility with the user's
production HA version has not been established.

The dependency lockfile was preserved. The container is isolated from the
production configuration repository and devices, and its port is bound to
localhost at `18123`. Repeatable setup and commands are in [README.md](README.md).

## Results

| Check | Result |
| --- | --- |
| `yarn install --immutable` | Passed |
| `yarn build` | Passed, all four workspaces |
| `yarn typecheck` | Passed |
| `yarn test --run` | 85 files, 840 tests passed (834 existing + 6 regression cases) |
| `yarn biome ci .` | Passed; seven existing informational diagnostics |
| Ruff 0.16.9, matching CI | Passed, using the official container with source mounted read-only |
| Official hassfest container | Passed: one integration, zero invalid integrations; existing `config.title` translation warnings |
| HA `check_config` | Passed for the isolated synthetic configuration |
| Container startup and FLODE registration | Passed, including a second idempotent startup |
| Simple automation smoke check | Passed: state trigger and delay rendered, card selection and inspector available, no captured browser errors |
| Mobile smoke check | Passed at 390 × 844; screenshot captured |
| Existing card browser suite | 92 passed: 46 flows in Chromium and WebKit; no retries in the final run |
| Existing save round-trip browser suite | 46 passed; no retries in the final run |
| Existing editor action browser suite | 20 passed across Chromium and WebKit |
| Existing visual suite | 32 screenshots captured, reported as new; no previous visual baseline available |

The fixture seeder accepted 46 upstream flows, including one script. Six parser
fixtures were rejected by HA itself: `02-knx-complex.yaml`,
`07-adaptive-lighting-complex.yaml`, `15-open-ccu.yaml`,
`17-nested-condition.yaml`, `18-sensor-trigger.yaml`, and `20-select.yaml`.
Reasons include missing real devices, an invalid entity identifier, and mixed
legacy/current trigger keys. Their parser unit tests still ran. The browser
suite does not establish real-device behavior for these fixtures.

## Issues found and corrected

- HA's native state-trigger description throws in `Intl.ListFormat` for numeric,
  numeric-list, and mapping attribute states. FLODE now keeps its own card text
  for these values rather than mounting the incompatible hidden HA row. The
  automation definition is unchanged. Six regression cases check the fallback
  and continued native descriptions for supported string/list/null values. The
  final full card suite passed after rebuilding this change.
- The browser save selector matched both `Save` and `Save script`. It now uses
  exact accessible-name matching in round-trip and action checks. The final
  round-trip suite passed after this correction.

The save suite reports the already documented C.A.F.E. state-machine conversion
as a known semantic difference. These API round-trip tests do not prove
preservation of comments or formatting in source YAML files.

## Evidence and limits

Machine-readable browser results are in `.gate/step-{cards,roundtrip,actions,visual}.json`;
the visual report is `.gate/visual/report.html`. Smoke screenshots are in
`dev/container/runtime/panel.png` and `panel-mobile.png`. These runtime artifacts
are ignored by Git, as are generated credentials and tokens.

HACS validation was not run locally: the existing workflow runs as a GitHub
Action with repository/authentication context. Its CI result remains separate
from these local results. The full release gate's venv lifecycle was not run;
its individual browser suites were run against Docker instead. This is not a
release certification. No commits, version bumps, tags, or releases were made.

This baseline still uses the original editable panel and HA configuration API.
Disabling mutations and reading a custom YAML directory are the next stages;
neither capability is claimed by this report.

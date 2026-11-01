# Read-only development fixtures

`automations/examples/simple.yaml` contains two synthetic rules for smoke tests.

`automations/climate/heating.yaml` contains five selected heating rules from
`/Users/timofeymarkov/HA/automation/rules/climate.yaml`.
`automations/climate/ventilation.yaml` contains seven selected ventilation rules
from `/Users/timofeymarkov/HA/automation/rules/ventilation.yaml`.

The climate excerpts were supplied for development, with logging, notifications,
and peripheral scenarios excluded. Original IDs, safeguards, conditions, modes,
Jinja, and legacy/current HA key styles are retained. Empty metadata/data mappings
and empty descriptions were removed before handoff. Transport-escaped `>` and
`<` characters have been decoded into valid YAML indicators and Jinja operators.
Do not normalize the files simply to accommodate a parser.

These excerpts are not a deployable configuration. Their real device/entity/area
IDs do not establish device availability on the test system. A disposable Git copy of this directory
is used by the development container and is not included in HA's automation configuration. Never
register these rules in a running HA, execute their actions, or connect test HA
to production devices. Use synthetic helpers when testing runtime behavior.

Heating covers antifreeze protection, mode scheduling, target temperatures,
thermostat synchronization, and the main heating request. Ventilation covers
manual demand, humidity hysteresis with numeric checks, strong ventilation,
and base ventilation with 800/600 ppm CO2 thresholds. Each list entry must open
as its own graph; group relationships are a separate future feature.

`tests/test_automations.py` is a Python unittest smoke test. It reads only the
synthetic example YAML and never invokes Home Assistant actions. The Run tests
button discovers it from the same Git checkout as the automation files.


`tests/test_object_references.py` validates every YAML automation against the
last explicitly exported `objects/index.yaml` and its records. The same file is
portable: copy it into another FLODE project's `tests/` directory and click
**Run tests** in HA. It requires only PyYAML and Jinja2, already present in HA.
It makes no API calls, runs no actions, and never updates the object snapshot.

The isolated HA intentionally lacks the real climate devices/helpers, so this
test reports missing references for those development excerpts. These failures
are expected; do not fabricate catalog entries or skip climate automations to
make them green. Export matching objects on the intended HA to validate a real
configuration. The synthetic smoke automations reference only the test helper.

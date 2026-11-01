"""Regression coverage for the portable test executed by HA's project runner."""
import importlib.util
from pathlib import Path

import pytest
import yaml
from custom_components.flode.object_source import export_catalog
from custom_components.flode.test_source import run_tests

SOURCE = Path(__file__).resolve().parents[1] / 'dev/container/fixtures/tests/test_object_references.py'


@pytest.fixture(scope='module')
def checker():
    spec = importlib.util.spec_from_file_location('portable_object_reference_test', SOURCE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.check_project


@pytest.fixture
def project(tmp_path):
    catalog = {
        'integrations': [{'id': 'entry', 'domain': 'demo', 'title': 'Demo'}],
        'devices': [{'id': 'device', 'config_entry_id': 'entry', 'config_entry_ids': ['entry'], 'integration_domain': 'demo', 'name': 'Device'}],
        'entities': [], 'areas': {'room': {'name': 'Room'}}, 'labels': {'comfort': {'name': 'Comfort'}}, 'warnings': [],
    }
    for entity in ('sensor.temperature', 'input_boolean.enabled', 'input_number.threshold', 'input_datetime.start', 'script.custom', 'scene.evening'):
        catalog['entities'].append({'entity_id': entity, 'registry_id': f'registry-{entity}', 'unique_id': f'unique-{entity}',
                                    'device_id': 'device' if entity.startswith('sensor.') else None,
                                    'config_entry_id': 'entry', 'integration_domain': 'demo', 'platform': 'demo',
                                    'is_helper': entity.startswith(('input_boolean.', 'input_number.', 'input_datetime.'))})
    export_catalog(str(tmp_path), str(tmp_path), catalog)
    (tmp_path / 'automations/climate/nested').mkdir(parents=True)
    return tmp_path, catalog


def write(root, actions, *, file='automations/climate/heating.yaml', **extra):
    (root / file).write_text(yaml.safe_dump([{'id': 'heating', 'alias': 'Heating', 'actions': actions, **extra}]))


def test_nested_actions_device_registry_ids_and_other_static_references(project, checker):
    root, _ = project
    write(root, [{'choose': [{'conditions': [{'condition': 'device', 'device_id': 'device', 'entity_id': 'registry-sensor.temperature', 'domain': 'sensor'}],
                             'sequence': [{'repeat': {'count': 2, 'sequence': [{'action': 'script.custom'}, {'scene': 'scene.evening'}]}},
                                          {'parallel': [{'action': 'input_boolean.turn_on', 'target': {'entity_id': ['input_boolean.enabled'], 'area_id': 'room', 'label_id': 'comfort'}}]}]}]}],
          triggers=[{'trigger': 'numeric_state', 'entity_id': 'sensor.temperature', 'above': 'input_number.threshold', 'below': 30},
                    {'trigger': 'time', 'at': ['input_datetime.start', '06:30:00']}],
          variables={'owner': {'config_entry_id': 'entry'}})
    assert checker(root) == []


@pytest.mark.parametrize(('field', 'value'), [('entity_id', 'input_boolean.removed'), ('device_id', 'removed-device'),
                                            ('area_id', 'removed-room'), ('label_id', 'removed-label'), ('config_entry_id', 'removed-entry')])
def test_missing_references_report_file_automation_and_field(project, checker, field, value):
    root, _ = project
    write(root, [{'target': {field: value}}], file='automations/climate/nested/missing.yml')
    errors = checker(root)
    assert len(errors) == 1
    assert all(text in errors[0] for text in ('automations/climate/nested/missing.yml', 'Heating', 'id=heating', f'actions[0].target.{field}', value))


@pytest.mark.parametrize('template', ["{{ states('sensor.removed') }}", "{{ is_state('sensor.removed', 'on') }}",
                                      "{{ state_attr(entity_id='sensor.removed', name='unit') }}", '{{ states.sensor.removed.state }}',
                                      "{{ states['sensor.removed'] }}", "{{ 'sensor.removed' | expand }}",
                                      "{{ ['sensor.removed'] | map('states') | list }}",
                                      "{{ ['sensor.removed'] | select('is_state', 'on') | list }}",
                                      "{{ ['sensor.removed'] | reject('is_state', 'on') | list }}",
                                      "{{ 'sensor.removed' is is_state('on') }}"])
def test_template_literal_references_are_checked(project, checker, template):
    root, _ = project
    write(root, [{'variables': {'temperature': template}}])
    assert any('sensor.removed' in error for error in checker(root))


def test_known_jinja_references_constant_targets_and_special_targets(project, checker):
    root, _ = project
    write(root, [{'target': {'entity_id': "{{ ['sensor.temperature', 'input_boolean.enabled'] }}"}},
                 {'target': {'entity_id': 'sensor.temperature, input_boolean.enabled'}}, {'target': {'entity_id': ['all', 'none']}},
                 {'variables': {'temp': "{{ states('sensor.temperature') | float }}", 'name': "{{ device_attr('device', 'name') }}",
                                'lights': "{{ area_entities('Room') }}", 'enabled': "{{ is_state('input_boolean.enabled', 'on') }}"}}],
          description="Documentation example: {{ states('sensor.not_a_reference') }}")
    assert checker(root) == []


@pytest.mark.parametrize('action', [{'target': {'entity_id': '{{ selected_entity }}'}},
                                   {'variables': {'x': '{{ states(selected_entity) }}'}}, {'variables': {'x': '{{ states[selected_entity] }}'}},
                                   {'variables': {'x': "{{ selected_entities | map('states') | list }}"}},
                                   {'variables': {'x': "{{ selected_entities | select('is_state', 'on') | list }}"}}])
def test_dynamic_references_are_explicit_failures_not_silently_skipped(project, checker, action):
    root, _ = project
    write(root, [action])
    assert any('Dynamic' in error for error in checker(root))


def test_device_reference_must_match_the_entity_device(project, checker):
    root, _ = project
    write(root, [{'type': 'turn_on', 'domain': 'input_boolean', 'device_id': 'device', 'entity_id': 'registry-input_boolean.enabled'}])
    assert any('does not belong to device' in error for error in checker(root))


def test_id_change_in_fresh_export_is_caught(project, checker):
    root, catalog = project
    write(root, [{'target': {'entity_id': 'sensor.temperature'}}])
    assert checker(root) == []
    catalog['entities'][0]['entity_id'] = 'sensor.renamed'
    export_catalog(str(root), str(root), catalog)
    assert any("unknown entities reference 'sensor.temperature'" in error for error in checker(root))
    write(root, [{'target': {'entity_id': 'sensor.renamed'}}])
    assert checker(root) == []


def test_checks_every_file_despite_invalid_yaml_and_does_not_modify_any_files(project, checker, snapshot_project_files):
    root, _ = project
    write(root, [{'target': {'entity_id': 'sensor.missing'}}])
    (root / 'automations/climate/broken.yaml').write_text('bad: [')
    (root / 'automations/climate/nested/cycle.yml').write_text('- &self {id: cycle, actions: [*self]}')
    before = snapshot_project_files(root)
    errors = checker(root)
    assert any('broken.yaml' in error for error in errors)
    assert any('recursive YAML' in error for error in errors)
    assert any('sensor.missing' in error for error in errors)
    assert snapshot_project_files(root) == before


def test_missing_catalog_and_broken_catalog_paths_cannot_pass(project, checker):
    root, _ = project
    index_path = root / 'objects/index.yaml'
    index = yaml.safe_load(index_path.read_text())
    index['entities']['sensor.temperature'] = '../outside.yaml'
    (root / 'outside.yaml').write_text('entity_id: sensor.temperature')
    index_path.write_text(yaml.safe_dump(index))
    with pytest.raises(ValueError, match='inside objects'):
        checker(root)
    index_path.unlink()
    with pytest.raises(FileNotFoundError):
        checker(root)


def test_native_ha_test_worker_runs_portable_test_and_reports_real_failures(project):
    root, _ = project
    (root / 'tests').mkdir()
    (root / 'tests/test_object_references.py').write_bytes(SOURCE.read_bytes())
    write(root, [{'target': {'entity_id': 'input_boolean.enabled'}}])
    result = run_tests(str(root))
    assert result['success'] and 'test_all_automation_object_references_exist' in result['output']
    write(root, [{'target': {'entity_id': 'input_boolean.deleted'}}])
    result = run_tests(str(root))
    assert not result['success'] and 'input_boolean.deleted' in result['output']


@pytest.mark.parametrize('template', ["{{ ['sensor.temperature'] | map('states') | list }}",
                                      "{{ ['input_boolean.enabled'] | select('is_state', 'on') | list }}",
                                      "{{ ['input_boolean.enabled'] | reject('is_state', 'on') | list }}",
                                      "{{ 'input_boolean.enabled' is is_state('on') }}",
                                      "{{ [{'name': 'Unrelated'}] | map(attribute='name') | list }}"])
def test_known_higher_order_jinja_references(project, checker, template):
    root, _ = project
    write(root, [{'variables': {'value': template}}])
    assert checker(root) == []

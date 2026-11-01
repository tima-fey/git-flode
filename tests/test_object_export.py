"""Object snapshots replace only objects/ and retain all current registry IDs."""
import asyncio
from pathlib import Path
from types import SimpleNamespace

import pytest
import yaml
from homeassistant.exceptions import Unauthorized

from custom_components.flode import object_catalog
from custom_components.flode.object_api import export_objects
from custom_components.flode.object_source import export_catalog
from custom_components.flode.project_lock import project_lock


@pytest.fixture
def catalog():
    return {
        'integrations': [
            {'id': 'entry-zha', 'domain': 'zha', 'title': 'Radio', 'state': 'loaded', 'disabled_by': None},
            {'id': 'entry-helper', 'domain': 'input_boolean', 'title': 'Helper', 'state': 'loaded', 'disabled_by': None},
        ],
        'devices': [{'id': 'device-one', 'config_entry_ids': ['entry-zha'], 'config_entry_id': 'entry-zha', 'integration_domain': 'zha', 'name': 'Lamp'}],
        'entities': [
            {'entity_id': 'light.lamp', 'registry_id': 'registry-light', 'unique_id': 'hardware-channel-one', 'device_id': 'device-one', 'config_entry_id': 'entry-zha', 'platform': 'zha', 'integration_domain': 'zha', 'is_helper': False},
            {'entity_id': 'sensor.disabled', 'registry_id': 'registry-disabled', 'unique_id': 'hardware-channel-two', 'device_id': 'device-one', 'config_entry_id': 'entry-zha', 'platform': 'zha', 'integration_domain': 'zha', 'disabled_by': 'user', 'is_helper': False},
            {'entity_id': 'input_boolean.ui_helper', 'registry_id': 'helper-id', 'unique_id': 'helper-unique', 'device_id': None, 'config_entry_id': 'entry-helper', 'platform': 'input_boolean', 'integration_domain': 'input_boolean', 'is_helper': True},
            {'entity_id': 'input_boolean.yaml_helper', 'registry_id': None, 'unique_id': None, 'device_id': None, 'config_entry_id': None, 'platform': 'input_boolean', 'integration_domain': 'input_boolean', 'is_helper': True},
        ],
        'areas': {'room-id': {'name': 'Room', 'floor_id': None}},
        'labels': {'label-id': {'name': 'Comfort'}},
        'warnings': [],
    }


def export(root, catalog):
    return export_catalog(str(root), str(root), catalog)


def load_index(root):
    return yaml.safe_load((root / 'objects/index.yaml').read_text())


def test_hierarchy_index_helpers_and_original_ids(tmp_path, catalog):
    result = export(tmp_path, catalog)
    index = load_index(tmp_path)
    assert result['devices'] == 1 and result['entities'] == 4 and result['helpers'] == 2
    assert index['devices']['device-one'] == 'integrations/zha/entry-zha/devices/device-one/device.yaml'
    assert index['entities']['light.lamp'] == 'integrations/zha/entry-zha/devices/device-one/entities/light.lamp.yaml'
    assert set(index['helpers']) == {'input_boolean.ui_helper', 'input_boolean.yaml_helper'}
    assert index['entities']['input_boolean.yaml_helper'] == 'integrations/input_boolean/_standalone/entities/input_boolean.yaml_helper.yaml'
    assert yaml.safe_load((tmp_path / 'objects/helpers/index.yaml').read_text()) == index['helpers']
    for section in ['integrations', 'devices', 'entities']:
        for relative in index[section].values():
            assert (tmp_path / 'objects' / relative).is_file()
    disabled = yaml.safe_load((tmp_path / 'objects' / index['entities']['sensor.disabled']).read_text())
    assert disabled['disabled_by'] == 'user' and disabled['unique_id'] == 'hardware-channel-two'


def test_reexport_removes_deleted_ids_and_arbitrary_old_files(tmp_path, catalog):
    export(tmp_path, catalog)
    old_index = load_index(tmp_path)
    stale = tmp_path / 'objects/old/manual.yaml'
    stale.parent.mkdir()
    stale.write_text('stale data')
    catalog['entities'] = [row for row in catalog['entities'] if row['entity_id'] != 'sensor.disabled']
    catalog['entities'][0]['entity_id'] = 'light.renamed'
    catalog['devices'][0]['id'] = 'device-new-id'
    for row in catalog['entities']:
        if row['device_id'] == 'device-one':
            row['device_id'] = 'device-new-id'
    export(tmp_path, catalog)
    current = load_index(tmp_path)
    assert 'light.lamp' not in current['entities'] and 'light.renamed' in current['entities']
    assert 'sensor.disabled' not in current['entities'] and 'device-one' not in current['devices']
    for old_path in [old_index['entities']['light.lamp'], old_index['entities']['sensor.disabled'], old_index['devices']['device-one'], 'old/manual.yaml']:
        assert not (tmp_path / 'objects' / old_path).exists()
    assert not list(tmp_path.glob('.flode-objects-*'))


def test_empty_snapshot_clears_objects(tmp_path, catalog):
    export(tmp_path, catalog)
    for key in ['integrations', 'devices', 'entities']:
        catalog[key] = []
    result = export(tmp_path, catalog)
    assert result['entities'] == result['devices'] == result['helpers'] == 0
    assert {path.relative_to(tmp_path / 'objects').as_posix() for path in (tmp_path / 'objects').rglob('*.yaml')} == {'index.yaml', 'helpers/index.yaml'}


def test_other_project_files_are_byte_exact_and_not_rewritten(tmp_path, catalog, seed_isolation_project, snapshot_project_files):
    seed_isolation_project(tmp_path)
    before = {name: value for name, value in snapshot_project_files(tmp_path).items() if not name.startswith('objects/')}
    export(tmp_path, catalog)
    after = {name: value for name, value in snapshot_project_files(tmp_path).items() if not name.startswith('objects/')}
    assert before == after


def test_preparation_failure_preserves_previous_snapshot(tmp_path, catalog, monkeypatch):
    export(tmp_path, catalog)
    before = {path.relative_to(tmp_path): path.read_bytes() for path in (tmp_path / 'objects').rglob('*') if path.is_file()}
    def fail_dump(*_args, **_kwargs):
        raise OSError('Simulated write failure')
    monkeypatch.setattr('custom_components.flode.object_source.yaml.safe_dump', fail_dump)
    with pytest.raises(OSError, match='write failure'):
        export(tmp_path, catalog)
    assert before == {path.relative_to(tmp_path): path.read_bytes() for path in (tmp_path / 'objects').rglob('*') if path.is_file()}
    assert not list(tmp_path.glob('.flode-objects-*'))
    with project_lock(str(tmp_path)):
        pass


def test_publish_failure_restores_previous_snapshot(tmp_path, catalog, monkeypatch):
    export(tmp_path, catalog)
    old = (tmp_path / 'objects/index.yaml').read_bytes()
    import os
    replace = os.replace
    def fail_publish(source, destination):
        if Path(source).name.startswith('.flode-objects-') and not Path(source).name.startswith('.flode-objects-old-'):
            raise OSError('Simulated publish failure')
        replace(source, destination)
    monkeypatch.setattr('custom_components.flode.object_source.os.replace', fail_publish)
    catalog['entities'] = []
    with pytest.raises(OSError, match='publish failure'):
        export(tmp_path, catalog)
    assert (tmp_path / 'objects/index.yaml').read_bytes() == old
    assert not list(tmp_path.glob('.flode-objects-*'))


def test_symlink_root_and_project_switch_are_rejected(tmp_path, catalog):
    external = tmp_path / 'outside'
    external.mkdir()
    sentinel = external / 'keep.txt'
    sentinel.write_text('unchanged')
    (tmp_path / 'objects').symlink_to(external, target_is_directory=True)
    with pytest.raises(ValueError, match='real directory'):
        export(tmp_path, catalog)
    assert sentinel.read_text() == 'unchanged'
    with pytest.raises(ValueError, match='project changed'):
        export_catalog(str(tmp_path), '/another-root', catalog)


def test_shared_project_lock(tmp_path, catalog):
    with project_lock(str(tmp_path)), pytest.raises(ValueError, match='Another project'):
        export(tmp_path, catalog)


def test_unsafe_ids_are_encoded_as_single_path_segments(tmp_path, catalog):
    catalog['devices'][0]['id'] = '..'
    catalog['entities'][0]['device_id'] = '..'
    catalog['entities'][0]['entity_id'] = '../../outside'
    export(tmp_path, catalog)
    index = load_index(tmp_path)
    assert '%2E%2E' in index['devices']['..']
    assert '%2F' in index['entities']['../../outside']
    assert all(path.resolve().is_relative_to(tmp_path.resolve()) for path in (tmp_path / 'objects').rglob('*'))


def test_export_requires_admin():
    with pytest.raises(Unauthorized):
        export_objects(None, SimpleNamespace(user=SimpleNamespace(is_admin=False)), {'id': 1})


def test_unchanged_inventory_has_identical_content(tmp_path, catalog):
    export(tmp_path, catalog)
    before = {path.relative_to(tmp_path): path.read_bytes() for path in (tmp_path / 'objects').rglob('*.yaml')}
    catalog['entities'].reverse()
    catalog['integrations'].reverse()
    export(tmp_path, catalog)
    assert before == {path.relative_to(tmp_path): path.read_bytes() for path in (tmp_path / 'objects').rglob('*.yaml')}


def test_shared_device_has_one_location_and_entities_retain_their_owners(tmp_path, catalog):
    catalog['devices'][0]['config_entry_ids'].append('entry-helper')
    entity = catalog['entities'][0]
    entity.update(config_entry_id='entry-helper', platform='input_boolean', integration_domain='input_boolean')
    export(tmp_path, catalog)
    index = load_index(tmp_path)
    assert len(index['devices']) == 1
    record = yaml.safe_load((tmp_path / 'objects' / index['entities'][entity['entity_id']]).read_text())
    assert record['config_entry_id'] == 'entry-helper'
    assert index['entities'][entity['entity_id']].startswith('integrations/zha/entry-zha/devices/device-one/')


def test_missing_config_entry_uses_one_consistent_domain_group(tmp_path, catalog):
    catalog['integrations'] = []
    catalog['devices'][0]['integration_domain'] = 'unknown'
    export(tmp_path, catalog)
    index = load_index(tmp_path)
    assert index['integrations']['entry-zha'] == 'integrations/zha/entry-zha/integration.yaml'
    assert index['devices']['device-one'].startswith('integrations/zha/entry-zha/')


def test_capture_excludes_credentials_and_states_but_includes_yaml_helpers(monkeypatch):
    device = SimpleNamespace(id='device', config_entry_id='entry', config_entries={'entry'}, is_composite_device=False,
                             name='Lamp', name_by_user=None, area_id=None, disabled_by=None, labels=set(), identifiers={('demo', 'stable-hardware-id')})
    entity = SimpleNamespace(id='registry-id', entity_id='light.lamp', unique_id='stable-entity-id', platform='demo', config_entry_id='entry',
                             device_id='device', area_id=None, name=None, original_name='Lamp', original_device_class=None,
                             unit_of_measurement=None, entity_category=None, disabled_by='user', hidden_by=None, labels=set())
    entry = SimpleNamespace(entry_id='entry', domain='demo', title='Demo', state='loaded', disabled_by=None,
                            data={'password': 'DO_NOT_EXPORT_DATA'}, options={'token': 'DO_NOT_EXPORT_OPTIONS'})
    state = SimpleNamespace(entity_id='input_boolean.yaml_helper', state='DO_NOT_EXPORT_STATE',
                            attributes={'friendly_name': 'YAML helper', 'token': 'DO_NOT_EXPORT_ATTRIBUTE'})
    hass = SimpleNamespace(config_entries=SimpleNamespace(async_entries=lambda: [entry]),
                           states=SimpleNamespace(async_all=lambda: [state]), config=SimpleNamespace(components={'demo', 'input_boolean'}))
    monkeypatch.setattr(object_catalog.device_registry, 'async_get', lambda _hass: SimpleNamespace(devices={'device': device}))
    monkeypatch.setattr(object_catalog.entity_registry, 'async_get', lambda _hass: SimpleNamespace(entities={'light.lamp': entity}))
    monkeypatch.setattr(object_catalog.area_registry, 'async_get', lambda _hass: SimpleNamespace(areas={}))
    monkeypatch.setattr(object_catalog.label_registry, 'async_get', lambda _hass: SimpleNamespace(labels={}))
    platform = SimpleNamespace(platform_name='input_boolean', config_entry=None, entities={'input_boolean.yaml_helper': object()})
    monkeypatch.setattr(object_catalog.entity_platform, 'async_get_platforms', lambda _hass, domain: [platform] if domain == 'input_boolean' else [])
    async def integrations(_hass, domains):
        return {domain: SimpleNamespace(integration_type='helper' if domain == 'input_boolean' else 'hub') for domain in domains}
    monkeypatch.setattr(object_catalog, 'async_get_integrations', integrations)
    result = asyncio.run(object_catalog.async_collect_catalog(hass))
    serialized = yaml.safe_dump(result)
    assert 'DO_NOT_EXPORT' not in serialized
    assert len(result['devices']) == 1 and len(result['entities']) == 2
    yaml_helper = next(row for row in result['entities'] if row['entity_id'] == 'input_boolean.yaml_helper')
    assert yaml_helper['is_helper'] and not yaml_helper['registered']
    assert next(row for row in result['entities'] if row['entity_id'] == 'light.lamp')['disabled_by'] == 'user'

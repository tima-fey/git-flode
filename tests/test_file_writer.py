"""Existing-file saves preserve YAML data and reject stale or new targets."""
from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace

import pytest
import yaml
from custom_components.flode.file_api import open_file, save_file
from custom_components.flode.file_writer import open_automation, save_automation
from homeassistant.exceptions import Unauthorized


@pytest.fixture
def source(tmp_path):
    directory = tmp_path / 'automations' / 'climate'
    directory.mkdir(parents=True)
    path = directory / 'heating.yaml'
    path.write_text('''# Project comment
- id: 'first' # Keep ID comment
  alias: "Heating"
  description: |
    Multi-line description
    More details
  triggers: []
  actions:
    - delay: '00:00:01' # Delay comment
      future_field: {custom: value}
  future_option: {nested: [1, 2]}
# Neighbor comment
- id: second
  alias: "Neighbor"
  actions: []
''')
    return tmp_path, path


def opened(source):
    root, path = source
    return open_automation(str(root), path.relative_to(root).as_posix(), 'first')


def save(source, snapshot, config, automation_id='first'):
    root, path = source
    return save_automation(str(root), path.relative_to(root).as_posix(), automation_id,
                           snapshot['version'], snapshot['directory'], config)


def test_edit_preserves_unknown_fields_comments_and_neighbor(source):
    _, path = source
    before = yaml.safe_load(path.read_text())
    snapshot = opened(source)
    config = deepcopy(snapshot['config'])
    config['actions'][0]['delay'] = '00:00:02'
    result = save(source, snapshot, config)
    after = yaml.safe_load(path.read_text())
    assert after[0] == config
    assert after[1] == before[1]
    assert after[0]['future_option'] == before[0]['future_option']
    for comment in ['Project comment', 'Keep ID comment', 'Delay comment', 'Neighbor comment']:
        assert comment in path.read_text()
    assert 'alias: "Heating"' in path.read_text()
    assert result['version'] != snapshot['version']
    assert opened(source) == result
    assert not list(path.parent.glob('.flode-*'))


def test_stale_save_never_overwrites_external_changes(source):
    _, path = source
    snapshot = opened(source)
    path.write_text(path.read_text() + '# external edit\n')
    changed = path.read_bytes()
    with pytest.raises(ValueError, match='changed on disk'):
        save(source, snapshot, snapshot['config'])
    assert path.read_bytes() == changed


def test_cannot_create_automation_or_change_id(source):
    _, path = source
    snapshot = opened(source)
    original = path.read_bytes()
    with pytest.raises(ValueError, match='existing'):
        save(source, snapshot, snapshot['config'], 'missing')
    with pytest.raises(ValueError, match='ID cannot'):
        save(source, snapshot, {**snapshot['config'], 'id': 'new'})
    assert path.read_bytes() == original


def test_cannot_create_file_or_write_outside_automations(source):
    root, _ = source
    snapshot = opened(source)
    for file in ['automations/new.yaml', '../outside.yaml', 'objects/existing.yaml']:
        with pytest.raises((OSError, ValueError)):
            save_automation(str(root), file, 'first', snapshot['version'], str(root), snapshot['config'])
    assert not (root / 'automations/new.yaml').exists()


def test_project_switch_is_not_written(source):
    snapshot = opened(source)
    with pytest.raises(ValueError, match='project changed'):
        save(source, {**snapshot, 'directory': '/different'}, snapshot['config'])


def test_anchors_are_not_modified(source):
    _, path = source
    path.write_text('- &entry {id: first, alias: A}\n- {id: second, variables: {ref: *entry}}\n')
    snapshot = opened(source)
    original = path.read_bytes()
    with pytest.raises(ValueError, match='anchors'):
        save(source, snapshot, {**snapshot['config'], 'alias': 'Changed'})
    assert path.read_bytes() == original


def test_symlinked_file_is_view_only(source):
    root, path = source
    alias = path.with_name('alias.yaml')
    alias.symlink_to(path)
    snapshot = opened(source)
    with pytest.raises(ValueError, match='Symlinked'):
        save_automation(str(root), 'automations/climate/alias.yaml', 'first', snapshot['version'], str(root), snapshot['config'])


@pytest.mark.parametrize('handler', [open_file, save_file])
def test_file_edit_endpoints_require_admin(handler):
    with pytest.raises(Unauthorized):
        handler(None, SimpleNamespace(user=SimpleNamespace(is_admin=False)), {'id': 1})


def test_graph_save_keeps_unmodeled_automation_fields(source):
    snapshot = opened(source)
    config = deepcopy(snapshot['config'])
    del config['future_option']
    config['alias'] = 'Renamed'
    saved = save(source, snapshot, config)
    assert saved['config']['future_option'] == {'nested': [1, 2]}
    assert saved['config']['alias'] == 'Renamed'


def test_atomic_failure_keeps_original_file(source, monkeypatch):
    _, path = source
    original = path.read_bytes()
    snapshot = opened(source)
    def fail_replace(*_args):
        raise OSError('Simulated rename failure')
    monkeypatch.setattr('custom_components.flode.file_writer.os.replace', fail_replace)
    with pytest.raises(OSError, match='rename failure'):
        save(source, snapshot, {**snapshot['config'], 'alias': 'Changed'})
    assert path.read_bytes() == original
    assert not list(path.parent.glob('.flode-*'))


def test_deleted_source_is_never_recreated(source):
    snapshot = opened(source)
    _, path = source
    path.unlink()
    with pytest.raises(OSError):
        save(source, snapshot, snapshot['config'])
    assert not path.exists()


@pytest.mark.parametrize('name', ['heating.yaml', 'ventilation.yaml'])
def test_real_climate_files_keep_all_other_automations(tmp_path, name):
    fixtures = Path(__file__).resolve().parents[1] / 'dev/container/fixtures/automations/climate'
    directory = tmp_path / 'automations/climate'
    directory.mkdir(parents=True)
    path = directory / name
    path.write_bytes((fixtures / name).read_bytes())
    before = yaml.safe_load(path.read_text())
    file = path.relative_to(tmp_path).as_posix()
    for index, original in enumerate(before):
        snapshot = open_automation(str(tmp_path), file, str(original['id']))
        config = deepcopy(snapshot['config'])
        config['alias'] = original['alias'] + ' edited'
        save_automation(str(tmp_path), file, str(original['id']), snapshot['version'], str(tmp_path), config)
        after = yaml.safe_load(path.read_text())
        assert after[index] == config
        assert [entry for i, entry in enumerate(after) if i != index] == [entry for i, entry in enumerate(before) if i != index]
        path.write_bytes((fixtures / name).read_bytes())


def test_legacy_root_keys_and_their_comments_survive_visual_saves(source):
    _, path = source
    path.write_text('- id: first\n  trigger: [] # Trigger comment\n  action: # Action comment\n    - delay: "00:00:01"\n')
    snapshot = opened(source)
    result = save(source, snapshot, {'id': 'first', 'triggers': [], 'actions': [{'delay': '00:00:03'}]})
    assert 'trigger' in result['config'] and 'triggers' not in result['config']
    assert 'action' in result['config'] and 'actions' not in result['config']
    assert 'Trigger comment' in path.read_text()
    assert 'Action comment' in path.read_text()


def test_write_retains_file_mode(source):
    _, path = source
    path.chmod(0o640)
    snapshot = opened(source)
    save(source, snapshot, {**snapshot['config'], 'alias': 'Changed'})
    assert path.stat().st_mode & 0o777 == 0o640


def test_oversized_source_is_not_loaded_for_editing(source):
    _, path = source
    path.write_bytes(b'x' * (2 * 1024 * 1024 + 1))
    with pytest.raises(ValueError, match='2 MiB'):
        opened(source)


@pytest.mark.parametrize('variables', ['{number: 9007199254740993}', '{1: numeric-key}'])
def test_values_that_json_cannot_represent_losslessly_are_not_rewritten(source, variables):
    _, path = source
    path.write_text('- id: first\n  alias: Existing\n  variables: ' + variables + '\n')
    snapshot = opened(source)
    original = path.read_bytes()
    with pytest.raises(ValueError, match='non-string|lossless'):
        save(source, snapshot, {**snapshot['config'], 'alias': 'Changed'})
    assert path.read_bytes() == original


@pytest.mark.parametrize('selected', [
    'automations/climate/heating.yaml',
    'automations/climate/ventilation.yaml',
    'automations/security/heating.yaml',
    'automations/security/nested/other.yml',
])
def test_save_changes_only_the_selected_file(
    tmp_path, seed_isolation_project, snapshot_project_files, selected,
):
    root = seed_isolation_project(tmp_path)
    before = snapshot_project_files(root)
    snapshot = open_automation(str(root), selected, 'first')
    config = {**snapshot['config'], 'alias': 'Changed only here'}
    save_automation(str(root), selected, 'first', snapshot['version'], str(root), config)
    after = snapshot_project_files(root)
    assert before.keys() == after.keys(), 'Saving created or deleted an unrelated file'
    assert {file for file in before if before[file] != after[file]} == {selected}
    assert yaml.safe_load((root / selected).read_text())[0]['alias'] == 'Changed only here'


@pytest.mark.parametrize('failure', ['stale', 'replace_error'])
def test_failed_save_leaves_every_file_unchanged(
    tmp_path, seed_isolation_project, snapshot_project_files, monkeypatch, failure,
):
    root = seed_isolation_project(tmp_path)
    selected = 'automations/climate/heating.yaml'
    snapshot = open_automation(str(root), selected, 'first')
    if failure == 'stale':
        with (root / selected).open('ab') as handle:
            handle.write(b'# External modification\n')
    else:
        def fail_replace(*_args):
            raise OSError('Simulated replace failure')
        monkeypatch.setattr('custom_components.flode.file_writer.os.replace', fail_replace)
    before = snapshot_project_files(root)
    with pytest.raises((ValueError, OSError)):
        save_automation(str(root), selected, 'first', snapshot['version'], str(root),
                        {**snapshot['config'], 'alias': 'Not written'})
    assert snapshot_project_files(root) == before


@pytest.mark.parametrize(('before', 'after'), [(1, True), (True, 1), (0, False), (False, 0)])
def test_nested_boolean_and_numeric_values_remain_distinct(source, before, after):
    _, path = source
    entries = yaml.safe_load(path.read_text())
    entries[0]['variables'] = {'nested': [{'flag': before}]}
    path.write_text(yaml.safe_dump(entries, sort_keys=False))
    neighbor = deepcopy(entries[1])
    snapshot = opened(source)
    config = deepcopy(snapshot['config'])
    config['variables']['nested'][0]['flag'] = after
    result = save(source, snapshot, config)
    stored = yaml.safe_load(path.read_text())
    actual = stored[0]['variables']['nested'][0]['flag']
    assert type(actual) is type(after)
    assert actual == after
    assert stored[1] == neighbor
    assert result['version'] != snapshot['version']


def test_noop_save_preserves_bytes_revision_and_file_identity(source):
    _, path = source
    original = path.read_bytes()
    before = path.stat()
    snapshot = opened(source)
    result = save(source, snapshot, deepcopy(snapshot['config']))
    assert result == snapshot
    assert path.read_bytes() == original
    assert path.stat().st_ino == before.st_ino
    assert path.stat().st_mtime_ns == before.st_mtime_ns

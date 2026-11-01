"""Validate automation references offline inside HA via the Run tests button.

Export HA objects first. This test never queries HA, renders templates, or runs
actions. Copy this file into any FLODE project's tests/ directory.
"""
import re
import unittest
from pathlib import Path

import yaml
from jinja2 import Environment, TemplateSyntaxError, nodes

FIELDS = {'entity_id': 'entities', 'device_id': 'devices', 'area_id': 'areas',
          'label_id': 'labels', 'config_entry_id': 'integrations'}
FUNCTIONS = {name: 'entities' for name in ('states', 'is_state', 'is_state_attr', 'state_attr', 'has_value', 'expand', 'config_entry_id')}
FUNCTIONS.update(device_attr='device_or_entity', is_device_attr='device_or_entity',
                 device_entities='devices', area_entities='areas', area_devices='areas',
                 label_entities='labels', label_devices='labels', label_areas='labels', config_entry_attr='integrations')
ENTITY_ID = re.compile(r'^[a-z_][a-z0-9_]*\.[a-z0-9_]+$')
TEMPLATES = Environment(extensions=['jinja2.ext.do', 'jinja2.ext.loopcontrols'])


def literal(node):
    if isinstance(node, nodes.Const):
        return node.value
    if isinstance(node, (nodes.List, nodes.Tuple)):
        return [literal(item) for item in node.items]
    if isinstance(node, nodes.Concat):
        return ''.join(str(literal(item)) for item in node.nodes)
    raise ValueError('Dynamic reference cannot be validated from the object catalog')


def state_path(node):
    if isinstance(node, nodes.Name) and node.name == 'states':
        return []
    if isinstance(node, (nodes.Getattr, nodes.Getitem)):
        parent = state_path(node.node)
        if parent is not None:
            if isinstance(node, nodes.Getattr):
                return [*parent, node.attr]
            if isinstance(node.arg, nodes.Const) and isinstance(node.arg.value, str):
                return [*parent, *node.arg.value.split('.')]
            return [*parent, '<dynamic>']
    return None


class Catalog:
    def __init__(self, root):
        self.root = root / 'objects'
        if self.root.is_symlink():
            raise ValueError('objects/ must not be a symlink')
        index = self.read('index.yaml')
        if index.get('schema_version') != 1:
            raise ValueError('Unsupported object catalog; export HA objects again')
        self.records = {}
        self.registry_ids = {}
        for scope, identity in [('entities', 'entity_id'), ('devices', 'id'), ('integrations', 'id')]:
            self.records[scope] = {}
            for identifier, relative in index[scope].items():
                record = self.read(relative)
                if scope == 'integrations' and record.get('id') is None:
                    continue  # Standalone groups are not HA config entries.
                if record.get(identity) != identifier:
                    raise ValueError(f'Catalog identity mismatch: {relative}')
                self.records[scope][identifier] = record
                if scope == 'entities' and record.get('registry_id'):
                    self.registry_ids[record['registry_id']] = identifier
        for scope in ('areas', 'labels'):
            self.records[scope] = index[scope]
        for entity_id, record in self.records['entities'].items():
            if record.get('is_helper') and index['helpers'].get(entity_id) != index['entities'][entity_id]:
                raise ValueError(f'Helper index is inconsistent: {entity_id}')
        for entity_id, relative in index['helpers'].items():
            if entity_id not in self.records['entities'] or relative != index['entities'][entity_id]:
                raise ValueError(f'Helper index is inconsistent: {entity_id}')

    def read(self, relative):
        target = (self.root / relative).resolve(strict=True)
        if not target.is_relative_to(self.root.resolve()):
            raise ValueError('Object catalog paths must stay inside objects/')
        record = yaml.safe_load(target.read_text(encoding='utf-8'))
        if not isinstance(record, dict):
            raise TypeError(f'Expected an object mapping: {relative}')
        return record

    def check(self, scope, value, where, errors, device_step=False, names=False):
        if isinstance(value, list):
            for index, item in enumerate(value):
                self.check(scope, item, f'{where}[{index}]', errors, device_step, names)
            return
        if not isinstance(value, str) or not value.strip():
            errors.append(f'{where}: expected a non-empty {scope} reference')
            return
        if scope == 'entities' and value in ('all', 'none'):
            return
        if scope == 'entities' and ',' in value:
            self.check(scope, [item.strip() for item in value.split(',')], where, errors, device_step, names)
            return
        if scope == 'device_or_entity':
            exists = value in self.records['devices'] or value in self.records['entities']
        else:
            exists = value in self.records[scope]
            if device_step and scope == 'entities':
                exists = exists or value in self.registry_ids
            if names and scope in ('devices', 'areas', 'labels'):
                exists = exists or any(value in (record.get('name'), record.get('name_by_user')) for record in self.records[scope].values())
        if not exists:
            errors.append(f'{where}: unknown {scope} reference {value!r}')


def check_template(text, catalog, where, errors, scope=None, device_step=False):
    try:
        tree = TEMPLATES.parse(text.strip())
        for call in tree.find_all(nodes.Call):
            if not isinstance(call.node, nodes.Name) or call.node.name not in FUNCTIONS:
                continue
            arguments = call.args if call.node.name == 'expand' else call.args[:1]
            if not arguments:
                arguments = [keyword.value for keyword in call.kwargs if keyword.key in ('entity_id', 'device_id', 'device_or_entity_id', 'area_id', 'area_id_or_name', 'label_id', 'config_entry_id')]
            if not arguments or call.dyn_args is not None:
                raise ValueError(f'Dynamic {call.node.name}() reference cannot be validated')
            for argument in arguments:
                catalog.check(FUNCTIONS[call.node.name], literal(argument), where, errors, names=True)
        for filtered in tree.find_all((nodes.Filter, nodes.Test)):
            if filtered.name in FUNCTIONS:
                catalog.check(FUNCTIONS[filtered.name], literal(filtered.node), where, errors, names=True)
            elif filtered.name in ('map', 'select', 'reject') and filtered.args:
                function = filtered.args[0]
                if isinstance(function, nodes.Const) and function.value in FUNCTIONS:
                    catalog.check(FUNCTIONS[function.value], literal(filtered.node), where, errors, names=True)
        for access in tree.find_all((nodes.Getattr, nodes.Getitem)):
            parts = state_path(access)
            if parts and '<dynamic>' in parts[:2]:
                raise ValueError('Dynamic states[...] reference cannot be validated')
            if parts and len(parts) >= 2:
                catalog.check('entities', '.'.join(parts[:2]), where, errors)
        if scope:
            if len(tree.body) != 1 or not isinstance(tree.body[0], nodes.Output) or len(tree.body[0].nodes) != 1:
                raise ValueError('Dynamic target cannot be validated from the object catalog')
            catalog.check(scope, literal(tree.body[0].nodes[0]), where, errors, device_step)
    except (TemplateSyntaxError, ValueError) as error:
        errors.append(f'{where}: {error}')


def walk(value, catalog, where, errors, scope=None, device_step=False, active=None):
    active = set() if active is None else active
    if scope == 'entity_or_literal' and not isinstance(value, list):
        scope = 'entities' if isinstance(value, str) and ENTITY_ID.fullmatch(value) else None
    if isinstance(value, (dict, list)):
        if id(value) in active:
            errors.append(f'{where}: recursive YAML aliases are not supported')
            return
        active.add(id(value))
        if isinstance(value, dict):
            if scope:
                errors.append(f'{where}: expected a reference or list, not a mapping')
            device_step = value.get('trigger', value.get('platform')) == 'device' or value.get('condition') == 'device' or all(key in value for key in ('device_id', 'domain', 'type'))
            entity = value.get('entity_id')
            device = value.get('device_id')
            if device_step and isinstance(entity, str) and isinstance(device, str) and not any(marker in entity + device for marker in ('{{', '{%')):
                record = catalog.records['entities'].get(catalog.registry_ids.get(entity, entity))
                if record and record.get('device_id') != device:
                    errors.append(f'{where}.entity_id: {entity!r} does not belong to device {device!r}')
            for key, child in value.items():
                if key in ('alias', 'description', 'id'):
                    continue
                child_scope = FIELDS.get(key)
                if key in ('above', 'below', 'at'):
                    child_scope = 'entity_or_literal'
                if key == 'scene':
                    child_scope = 'entities'
                if key in ('service', 'action') and isinstance(child, str) and child.startswith('script.') and child not in ('script.turn_on', 'script.turn_off', 'script.toggle', 'script.reload'):
                    child_scope = 'entities'
                walk(child, catalog, f'{where}.{key}', errors, child_scope, device_step, active)
        else:
            for index, child in enumerate(value):
                walk(child, catalog, f'{where}[{index}]', errors, scope, device_step, active)
        active.remove(id(value))
    elif isinstance(value, str) and any(marker in value for marker in ('{{', '{%', '{#')):
        check_template(value, catalog, where, errors, scope, device_step)
    elif scope:
        catalog.check(scope, value, where, errors, device_step)


def check_project(root):
    catalog = Catalog(root)
    directory = root / 'automations'
    if directory.is_symlink() or not directory.is_dir():
        raise ValueError('Expected a real automations/ directory')
    errors = []
    count = 0
    ids = {}
    for path in sorted(directory.rglob('*')):
        if path.is_symlink():
            errors.append(f'{path.relative_to(root)}: symlinks are not supported')
            continue
        if not path.is_file() or path.suffix.lower() not in ('.yaml', '.yml'):
            continue
        relative = path.relative_to(root)
        try:
            automations = yaml.safe_load(path.read_text(encoding='utf-8'))
            if not isinstance(automations, list):
                raise TypeError('Expected a YAML list of automations')
            for index, automation in enumerate(automations):
                if not isinstance(automation, dict):
                    errors.append(f'{relative}[{index}]: expected an automation mapping')
                    continue
                count += 1
                automation_id = automation.get('id')
                location = f'{relative}[{index}]'
                if type(automation_id) not in (str, int) or not str(automation_id).strip():
                    errors.append(f'{location}: expected a non-empty automation id')
                else:
                    key = str(automation_id)
                    if key in ids:
                        errors.append(f'{location}: duplicate automation id {key!r}; first defined at {ids[key]}')
                    else:
                        ids[key] = location
                name = f'{automation.get("alias", "Unnamed")} (id={automation.get("id", "missing")})'
                walk(automation, catalog, f'{relative}: {name}', errors)
        except (OSError, TypeError, ValueError, yaml.YAMLError) as error:
            errors.append(f'{relative}: {error}')
    if not count:
        errors.append('No automations found under automations/')
    print(f"Checked {count} automations against {len(catalog.records['entities'])} entities and {len(catalog.records['devices'])} devices from objects/index.yaml.")
    return list(dict.fromkeys(errors))


class AutomationObjectReferencesTest(unittest.TestCase):
    def test_all_automation_object_references_exist(self):
        root = Path(__file__).resolve().parents[1]
        try:
            errors = check_project(root)
        except (OSError, KeyError, TypeError, ValueError, yaml.YAMLError) as error:
            self.fail(f'Cannot validate automation references: {error}. Export HA objects first.')
        if errors:
            self.fail('Automation object reference errors:\n' + '\n'.join(errors))


if __name__ == '__main__':
    unittest.main()

import { describe, expect, it } from 'vitest';
import { groupAutomationsByFolder } from '../automation-folders';

function item(folder: string, name: string, id = 'same-id') {
  return { name, source: { file: `automations/${folder}rules.yaml`, id } };
}

describe('automation folders', () => {
  it('groups files by directory and sorts folders and cards without changing the input', () => {
    const items = [
      item('security/', 'Alarm'),
      item('climate/', 'Ventilation'),
      item('climate/', 'Heating'),
    ];
    const original = [...items];
    expect(groupAutomationsByFolder(items, 'en')).toEqual([
      { folder: 'climate', items: [items[2], items[1]] },
      { folder: 'security', items: [items[0]] },
    ]);
    expect(items).toEqual(original);
  });

  it('preserves nested paths and keeps repeated folder names separate', () => {
    const items = [item('upstairs/climate/', 'Heating'), item('downstairs/climate/', 'Heating')];
    expect(groupAutomationsByFolder(items, 'en').map((group) => group.folder)).toEqual([
      'downstairs/climate',
      'upstairs/climate',
    ]);
  });

  it('keeps root files together and retains automations sharing names and IDs', () => {
    const items = [item('', 'Heating'), item('climate/', 'Heating')];
    expect(groupAutomationsByFolder(items, 'en')).toEqual([
      { folder: '', items: [items[0]] },
      { folder: 'climate', items: [items[1]] },
    ]);
  });

  it('omits empty groups', () => {
    expect(groupAutomationsByFolder([])).toEqual([]);
  });
});

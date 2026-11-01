import { describe, expect, it } from 'vitest';
import { collectReferences, templateEntityIds } from '../entity-references';

describe('collectReferences', () => {
  it('finds triggers, conditions and targeted actions', () => {
    const refs = collectReferences({
      triggers: [{ trigger: 'state', entity_id: 'binary_sensor.motion', to: 'on' }],
      conditions: [{ condition: 'numeric_state', entity_id: 'sensor.lux', below: 20 }],
      actions: [{ action: 'light.turn_on', target: { entity_id: ['light.hall'] } }],
    });
    expect(refs).toEqual([
      { entityId: 'binary_sensor.motion', role: 'trigger' },
      { entityId: 'sensor.lux', role: 'condition' },
      { entityId: 'light.hall', role: 'action', service: 'light.turn_on' },
    ]);
  });

  it('reads legacy keys, nested blocks and templates', () => {
    const refs = collectReferences({
      trigger: [
        { platform: 'template', value_template: "{{ is_state('input_boolean.night', 'on') }}" },
      ],
      action: [
        {
          if: [{ condition: 'state', entity_id: 'sensor.lux', state: 'x' }],
          then: [{ service: 'cover.close_cover', entity_id: 'cover.living' }],
          else: [{ choose: [{ conditions: [], sequence: [{ action: 'script.goodnight' }] }] }],
        },
        { repeat: { while: [], sequence: [{ scene: 'scene.evening' }] } },
        {
          action: 'notify.mobile',
          data: { message: '{{ states.sensor.lux.state }} lux' },
        },
      ],
    });
    expect(refs).toContainEqual({ entityId: 'input_boolean.night', role: 'template' });
    expect(refs).toContainEqual({ entityId: 'sensor.lux', role: 'condition' });
    expect(refs).toContainEqual({
      entityId: 'cover.living',
      role: 'action',
      service: 'cover.close_cover',
    });
    expect(refs).toContainEqual({
      entityId: 'script.goodnight',
      role: 'action',
      service: 'script.turn_on',
    });
    expect(refs).toContainEqual({
      entityId: 'scene.evening',
      role: 'action',
      service: 'scene.turn_on',
    });
    expect(refs).toContainEqual({ entityId: 'sensor.lux', role: 'template' });
  });

  it('reads script sequences', () => {
    expect(
      collectReferences({
        sequence: [{ action: 'light.turn_off', target: { entity_id: 'light.hall' } }],
      })
    ).toEqual([{ entityId: 'light.hall', role: 'action', service: 'light.turn_off' }]);
  });
});

describe('templateEntityIds', () => {
  it('ignores plain strings and notify targets', () => {
    expect(templateEntityIds('light.hall')).toEqual([]);
    expect(templateEntityIds("{{ states('sensor.lux') | int }} {{ 'notify.x' }}")).toEqual([
      'sensor.lux',
    ]);
  });

  it('ignores numbers, file names and host names in quotes', () => {
    expect(
      templateEntityIds(
        "{{ '0.5' | float }} {{ 'bild.jpg' }} {{ 'example.com' }} {{ states.light.hall.state }}"
      )
    ).toEqual(['light.hall']);
  });
});

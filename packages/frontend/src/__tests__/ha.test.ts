import { afterEach, describe, expect, it } from 'vitest';
import {
  type AutomationListItem,
  configFingerprint,
  ensureAutomationEditors,
  flowName,
  sameFlow,
  usesBlueprint,
} from '../ha';

const item: AutomationListItem = {
  kind: 'automation',
  entityId: 'automation.flur',
  configId: '1',
  name: 'Flur',
  enabled: true,
  lastTriggered: null,
};

describe('sameFlow', () => {
  it('matches by kind and config id — renamed or re-read items included', () => {
    const renamed: AutomationListItem = { ...item, name: 'Flur neu', entityId: 'automation.neu' };
    expect(sameFlow(item, renamed)).toBe(true);
    expect(sameFlow(item, { ...item, kind: 'script' })).toBe(false);
    expect(sameFlow(item, { ...item, configId: '2' })).toBe(false);
    expect(sameFlow(item, undefined)).toBe(false);
  });
});

describe('usesBlueprint', () => {
  it('spots automations and scripts made from a blueprint', () => {
    expect(
      usesBlueprint({ alias: 'Bewegung', use_blueprint: { path: 'motion.yaml', input: {} } })
    ).toBe(true);
    expect(usesBlueprint({ alias: 'Flur', triggers: [], actions: [] })).toBe(false);
  });
});

describe('configFingerprint', () => {
  it('ignores key order and tells changed configs apart', () => {
    const a = { alias: 'Flur', triggers: [{ trigger: 'state', entity_id: 'light.a' }] };
    const reordered = { triggers: [{ entity_id: 'light.a', trigger: 'state' }], alias: 'Flur' };
    expect(configFingerprint(a)).toBe(configFingerprint(reordered));
    expect(configFingerprint(a)).not.toBe(configFingerprint({ ...a, alias: 'Flur 2' }));
  });
});

describe('ensureAutomationEditors', () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'customElements');
  });

  it("doesn't keep a failed load forever", async () => {
    let defined = false;
    Object.assign(globalThis, {
      customElements: {
        get: () => (defined ? class {} : undefined),
        whenDefined: () => Promise.reject(new Error('not in HA')),
      },
    });
    expect(await ensureAutomationEditors(undefined)).toBe(false);
    defined = true;
    expect(await ensureAutomationEditors(undefined)).toBe(true);
  });
});

describe('the name a flow is edited under', () => {
  it('is the alias of the config, not the entity name (renamed in the registry)', () => {
    expect(flowName({ alias: 'Licht an' }, 'Licht an (Registry)')).toBe('Licht an');
  });
  it('falls back to the entity name when the config has no alias', () => {
    expect(flowName({}, 'Automation 7')).toBe('Automation 7');
    expect(flowName({ alias: '' }, 'Automation 7')).toBe('Automation 7');
  });
});

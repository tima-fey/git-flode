import { describe, expect, it } from 'vitest';
import { listFileAutomations, loadFileAutomation } from '../file-source';
import type { HomeAssistant } from '../ha';

function connection(reply: unknown) {
  const requests: unknown[] = [];
  const hass: HomeAssistant = {
    states: {},
    language: 'en',
    themes: { darkMode: false },
    localize: (key) => key,
    callApi: () => {
      throw new Error('HA config API must not be used');
    },
    callWS: <T>(message: unknown) => {
      requests.push(message);
      // Parse JSON through the same transport boundary as the real WebSocket.
      return Promise.resolve<T>(JSON.parse(JSON.stringify(reply)));
    },
  };
  return { hass, requests };
}

describe('file-only automation source', () => {
  it('keeps file provenance and distinguishes the same id in different groups', async () => {
    const { hass, requests } = connection({
      directory: '/files',
      errors: [],
      items: [
        { file: 'automations/climate/ventilation.yaml', id: 'one', name: 'First' },
        { file: 'automations/buttons/group.yaml', id: 'one', name: 'Second' },
      ],
    });
    const { items } = await listFileAutomations(hass);
    expect(items[0].configId).not.toBe(items[1].configId);
    expect(items[0].source).toEqual({ file: 'automations/climate/ventilation.yaml', id: 'one' });
    expect(items.every((item) => item.entityId === '')).toBe(true);
    expect(requests).toEqual([{ type: 'flode/files/list' }]);
  });

  it('loads the selected file entry without consulting the HA config API', async () => {
    const config = { id: 'one', actions: [{ delay: '00:00:01' }] };
    const { hass, requests } = connection(config);
    const result = await loadFileAutomation(hass, {
      source: { file: 'automations/climate/group.yaml', id: 'one' },
      kind: 'automation',
      configId: 'file',
      entityId: '',
      name: 'File',
      enabled: true,
      lastTriggered: null,
    });
    expect(result).toEqual(config);
    expect(requests).toEqual([
      { type: 'flode/files/read', file: 'automations/climate/group.yaml', automation_id: 'one' },
    ]);
  });

  it('rejects malformed responses instead of falling back to HA', async () => {
    const { hass } = connection({ items: 'invalid' });
    await expect(listFileAutomations(hass)).rejects.toThrow();
    await expect(
      loadFileAutomation(hass, {
        kind: 'automation',
        configId: 'ha',
        entityId: 'automation.ha',
        name: 'HA',
        enabled: true,
        lastTriggered: null,
      })
    ).rejects.toThrow('no file source');
  });
});

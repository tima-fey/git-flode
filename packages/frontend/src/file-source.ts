import {
  FileAutomationConfigSchema,
  FileAutomationListSchema,
  FileAutomationSnapshotSchema,
} from '@flode/shared';
import type { AutomationListItem, HomeAssistant } from './ha';

/** File reads are the only automation source; failures never fall back to HA. */
export async function listFileAutomations(hass: HomeAssistant) {
  const result = FileAutomationListSchema.parse(await hass.callWS({ type: 'flode/files/list' }));
  const items: AutomationListItem[] = result.items.map(({ file, id, name }) => ({
    kind: 'automation',
    source: { file, id },
    configId: JSON.stringify([file, id]),
    entityId: '',
    name,
    enabled: true,
    lastTriggered: null,
  }));
  return { ...result, items };
}

export async function loadFileAutomation(hass: HomeAssistant, item: AutomationListItem) {
  if (!item.source) throw new Error('This automation has no file source');
  return FileAutomationConfigSchema.parse(
    await hass.callWS({
      type: 'flode/files/read',
      file: item.source.file,
      automation_id: item.source.id,
    })
  );
}

export async function openFileAutomation(hass: HomeAssistant, item: AutomationListItem) {
  if (!item.source) throw new Error('This automation has no file source');
  return FileAutomationSnapshotSchema.parse(
    await hass.callWS({
      type: 'flode/files/open',
      file: item.source.file,
      automation_id: item.source.id,
    })
  );
}

export async function saveFileAutomation(
  hass: HomeAssistant,
  item: AutomationListItem,
  version: string,
  directory: string,
  config: Record<string, unknown>
) {
  if (!item.source) throw new Error('Only existing file automations can be saved');
  return FileAutomationSnapshotSchema.parse(
    await hass.callWS({
      type: 'flode/files/save',
      file: item.source.file,
      automation_id: item.source.id,
      version,
      directory,
      config: { ...config, id: item.source.id },
    })
  );
}

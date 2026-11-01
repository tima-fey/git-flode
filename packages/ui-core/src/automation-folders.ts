import type { FileAutomationRef } from '@flode/shared';

/** Group file-backed cards by their full directory below automations/. */
export function groupAutomationsByFolder<T extends { name: string; source?: FileAutomationRef }>(
  items: readonly T[],
  language?: string
): { folder: string; items: T[] }[] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const folder = (item.source?.file ?? '').split('/').slice(1, -1).join('/');
    const group = groups.get(folder);
    if (group) group.push(item);
    else groups.set(folder, [item]);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right, language))
    .map(([folder, entries]) => ({
      folder,
      items: entries.sort((left, right) => left.name.localeCompare(right.name, language)),
    }));
}

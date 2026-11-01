import { isPlainObject } from '@flode/shared';

/** Replaces every string in `value` (at any depth) via `update`; unchanged parts keep their identity. */
export function mapStrings(value: unknown, update: (text: string) => string): unknown {
  if (typeof value === 'string') return update(value);
  if (Array.isArray(value)) {
    const mapped = value.map((item) => mapStrings(item, update));
    return mapped.some((item, index) => item !== value[index]) ? mapped : value;
  }
  if (!isPlainObject(value)) return value;
  let changed = false;
  const entries = Object.entries(value).map(([key, item]): [string, unknown] => {
    const mapped = mapStrings(item, update);
    if (mapped !== item) changed = true;
    return [key, mapped];
  });
  return changed ? Object.fromEntries(entries) : value;
}

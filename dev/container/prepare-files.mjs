// Prepare browser-test metadata from the file backend, without HA config reads/writes.
import fs from 'node:fs/promises';

process.env.FLODE_GATE_URL = 'http://127.0.0.1:18123';
process.env.FLODE_GATE_TOKEN_FILE = new URL('./runtime/token', import.meta.url).pathname;
const { ws } = await import('../gate/lib.mjs');
const { items, errors } = await ws({ type: 'flode/files/list' });
if (errors.length) throw new Error(JSON.stringify(errors));
if (items.length < 2) throw new Error('Expected two independent file automations');
const states = await ws({ type: 'get_states' });
for (const id of ['file_ventilation_start', 'file_ventilation_stop']) {
  if (!states.some((state) => state.attributes.id === id))
    throw new Error(`Project automation not loaded through HA include: ${id}`);
}
await fs.mkdir(new URL('../../.gate/', import.meta.url), { recursive: true });
await fs.writeFile(
  new URL('../../.gate/seeded.json', import.meta.url),
  JSON.stringify(
    items.map((item) => ({ ...item, kind: 'automation' })),
    null,
    2
  )
);
console.log(
  `Prepared ${items.length} file-backed browser scenarios; synthetic project automations included in HA`
);

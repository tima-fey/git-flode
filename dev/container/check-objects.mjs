// Export synthetic HA metadata only in the disposable development instance.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import yaml from '../gate/node_modules/js-yaml/index.js';

process.env.FLODE_GATE_URL = 'http://127.0.0.1:18123';
process.env.FLODE_GATE_TOKEN_FILE = new URL('./runtime/token', import.meta.url).pathname;
const { ENGINES, gotoPanel, label, openBrowser, report, ws } = await import('../gate/lib.mjs');
const root = new URL('./runtime/repository/', import.meta.url).pathname;
const objects = path.join(root, 'objects');
const result = report('objects');

async function snapshot(directory, exclude = []) {
  const files = {};
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (exclude.includes(entry.name)) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      for (const [name, value] of Object.entries(await snapshot(target)))
        files[`${entry.name}/${name}`] = value;
    } else {
      const info = await fs.stat(target);
      files[entry.name] = {
        hash: createHash('sha256')
          .update(await fs.readFile(target))
          .digest('hex'),
        mode: info.mode,
        modified: info.mtimeMs,
      };
    }
  }
  return files;
}

async function load(relative = 'index.yaml') {
  return yaml.load(await fs.readFile(path.join(objects, relative), 'utf8'));
}

async function clickExport(control, page) {
  await control
    .getByRole('button', { name: await label(page, 'objectsExport'), exact: true })
    .click();
  const end = Date.now() + 35000;
  while (Date.now() < end) {
    const state = await control.evaluate((element) => ({
      busy: element.busy,
      error: element.error,
      result: element.objects,
    }));
    if (!state.busy && state.error) throw new Error(state.error);
    if (!state.busy && state.result) return state.result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Object export did not finish');
}

for (const engine of ENGINES) {
  const backup = await fs.mkdtemp(path.join(os.tmpdir(), 'flode-object-check-'));
  const existed = await fs.stat(objects).then(
    () => true,
    () => false
  );
  if (existed)
    await fs.cp(objects, path.join(backup, 'objects'), {
      recursive: true,
      preserveTimestamps: true,
    });
  const before = await snapshot(root, ['.git', 'objects']);
  const initialObjects = existed ? await snapshot(objects) : {};
  const { browser, page, errors } = await openBrowser(engine);
  const commands = [];
  let helper;
  page.on('websocket', (socket) =>
    socket.on('framesent', ({ payload }) => {
      const message = JSON.parse(String(payload));
      if (message.type === 'flode/objects/export' || message.type === 'call_service')
        commands.push(message.type);
    })
  );
  try {
    await gotoPanel(page, { reload: true });
    await result.check(
      `${engine}: explicit export, registry and YAML helpers, renamed/deleted IDs, file isolation`,
      async () => {
        const control = page.locator('flode-ha-controls');
        assert.deepEqual(commands, []);
        assert.deepEqual(existed ? await snapshot(objects) : {}, initialObjects);
        helper = await ws({ type: 'input_boolean/create', name: `FLODE export ${engine}` });
        const registry = await ws({ type: 'config/entity_registry/list' });
        const entity = registry.find(
          (entry) => entry.platform === 'input_boolean' && entry.unique_id === helper.id
        );
        assert.ok(entity, 'A registered synthetic UI helper must exist');
        const devices = await ws({ type: 'config/device_registry/list' });
        const states = await ws({ type: 'get_states' });
        const exported = await clickExport(control, page);
        const index = await load();
        assert.equal(exported.devices, devices.length);
        assert.equal(
          exported.entities,
          new Set([
            ...registry.map((entry) => entry.entity_id),
            ...states.map((entry) => entry.entity_id),
          ]).size
        );
        for (const device of devices)
          assert.equal((await load(index.devices[device.id])).id, device.id);
        assert.ok(index.helpers['input_boolean.flode_test'], 'The YAML helper must be included');
        const originalPath = index.entities[entity.entity_id];
        const record = await load(originalPath);
        assert.equal(record.unique_id, helper.id);
        assert.equal(record.registry_id, entity.id);
        assert.equal(record.is_helper, true);
        assert.equal(record.registered, true);
        assert.equal(index.helpers[entity.entity_id], originalPath);
        assert.deepEqual(commands, ['flode/objects/export']);

        const gitControl = page.locator('flode-git');
        await gitControl.getByRole('button', { name: await label(page, 'gitReview') }).click();
        const review = gitControl.locator('section.review');
        const objectDiff = review.locator('details');
        assert.match(await review.locator('ul').innerText(), /objects\/index\.yaml/);
        await objectDiff.locator('pre').waitFor({ state: 'attached' });
        assert.equal(await objectDiff.locator('pre').isVisible(), false);
        await objectDiff.locator('summary').click();
        await objectDiff.locator('pre').waitFor({ state: 'visible' });
        await objectDiff.locator('summary').click();
        await objectDiff.locator('pre').waitFor({ state: 'hidden' });

        const stale = path.join(objects, 'obsolete.yaml');
        await fs.writeFile(stale, 'obsolete: true\n');
        const renamed = `${entity.entity_id}_renamed`;
        await ws({
          type: 'config/entity_registry/update',
          entity_id: entity.entity_id,
          new_entity_id: renamed,
        });
        await clickExport(control, page);
        const updated = await load();
        assert.equal(updated.entities[entity.entity_id], undefined);
        assert.equal(updated.helpers[entity.entity_id], undefined);
        assert.equal((await load(updated.entities[renamed])).unique_id, helper.id);
        assert.equal(
          await fs.stat(path.join(objects, originalPath)).then(
            () => true,
            () => false
          ),
          false
        );
        assert.equal(
          await fs.stat(stale).then(
            () => true,
            () => false
          ),
          false
        );

        await ws({ type: 'input_boolean/delete', input_boolean_id: helper.id });
        helper = undefined;
        await clickExport(control, page);
        const final = await load();
        assert.equal(final.entities[renamed], undefined);
        assert.equal(final.helpers[renamed], undefined);
        assert.deepEqual(commands, Array(3).fill('flode/objects/export'));
        assert.deepEqual(await snapshot(root, ['.git', 'objects']), before);
        assert.deepEqual(errors, []);
        await control.scrollIntoViewIfNeeded();
        await page.screenshot({ path: `dev/container/runtime/objects-${engine}.png` });
      }
    );
  } finally {
    try {
      if (helper) await ws({ type: 'input_boolean/delete', input_boolean_id: helper.id });
    } finally {
      await browser.close();
      await fs.rm(objects, { recursive: true, force: true });
      if (existed)
        await fs.cp(path.join(backup, 'objects'), objects, {
          recursive: true,
          preserveTimestamps: true,
        });
      await fs.rm(backup, { recursive: true, force: true });
    }
  }
}
result.finish();

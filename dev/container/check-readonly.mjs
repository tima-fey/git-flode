// Viewing interactions must leave both HA requests and configuration unchanged.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';

process.env.FLODE_GATE_URL = 'http://127.0.0.1:18123';
process.env.FLODE_GATE_TOKEN_FILE = new URL('./runtime/token', import.meta.url).pathname;
const { ENGINES, gotoPanel, inPanel, openBrowser, openFlow, readCards, report } = await import(
  '../gate/lib.mjs'
);
const result = report('readonly');
const files = ['configuration.yaml', 'automations.yaml', 'scripts.yaml'];
async function fingerprints() {
  return Promise.all(
    files.map(async (file) =>
      createHash('sha256')
        .update(await fs.readFile(new URL(`./runtime/config/${file}`, import.meta.url)))
        .digest('hex')
    )
  );
}
const sourceFile = new URL('./fixtures/automations/examples/simple.yaml', import.meta.url);
const sourceBefore = await fs.readFile(sourceFile, 'utf8');
const before = await fingerprints();
for (const engine of ENGINES) {
  const { browser, page, errors } = await openBrowser(engine);
  const mutations = [];
  page.on('request', (request) => {
    const route = new URL(request.url()).pathname;
    if (
      /^\/api\/config\/(automation|script)(\/|$)/.test(route) ||
      (request.method() !== 'GET' && route.startsWith('/api/config/'))
    )
      mutations.push(`${request.method()} ${new URL(request.url()).pathname}`);
  });
  page.on('websocket', (socket) => {
    socket.on('framesent', ({ payload }) => {
      const data = JSON.parse(String(payload));
      if (
        ['call_service', 'execute_script'].includes(data.type) ||
        /^(config\/)?(automation|script)\//.test(data.type) ||
        /\/(create|update|delete|reload)$/.test(data.type)
      )
        mutations.push(data.type);
    });
  });
  try {
    await gotoPanel(page, { reload: true });
    await result.check(`${engine}: inspect, shortcuts, drag, and mobile viewing`, async () => {
      errors.length = 0;
      await openFlow(page, 'File ventilation start');
      assert.equal(await inPanel(page, (panel) => panel.readOnly), true);
      assert.equal(
        await inPanel(page, (panel) => panel.flow.item.source.file),
        'automations/examples/simple.yaml'
      );
      const available = await inPanel(page, (panel) => panel.fileItems.map((item) => item.name));
      assert.ok(available.includes('File ventilation stop'));
      assert.ok(!available.includes('FLODE test simple automation'));
      const original = await inPanel(page, (panel) => JSON.stringify(panel.flow.graph));
      const cards = await readCards(page);
      assert.equal(cards.length, 2);
      const card = cards.find((item) => item.type === 'Delay');
      assert.ok(card);
      const node = page.locator(`flode-canvas .node[data-node-id="${card.id}"]`);
      await node.click();
      const inspector = page.locator('flode-inspector');
      await inspector.locator('pre').waitFor();
      assert.match(await inspector.locator('pre').innerText(), /delay/);
      assert.equal(await inspector.locator('ha-icon-button').count(), 0);
      const box = await node.boundingBox();
      assert.ok(box);
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + 90, y + 60, { steps: 5 });
      await page.mouse.up();
      assert.equal(await page.locator('flode-panel .toolbar .save').count(), 0);
      assert.equal(await page.locator('flode-ha-list').count(), 0);
      const pane = page.locator('flode-canvas .pane');
      await pane.focus();
      const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
      for (const key of ['d', 'e', 'v', 's', 'z', 'b']) await page.keyboard.press(`${mod}+${key}`);
      await page.keyboard.press('Delete');
      await page.keyboard.press('Backspace');
      assert.equal(await inPanel(page, (panel) => JSON.stringify(panel.flow.graph)), original);
      assert.equal(await inPanel(page, (panel) => panel.addOpen), false);
      const commands = await inPanel(page, (panel) =>
        panel.paletteEntries().map((entry) => entry.id)
      );
      for (const id of [
        'save',
        'saveCopy',
        'new',
        'newScript',
        'run',
        'runOnly',
        'runFrom',
        'merge',
        'tidy',
        'importYaml',
      ])
        assert.ok(!commands.includes(id), `Editing command exposed: ${id}`);
      await page.setViewportSize({ width: 390, height: 844 });
      await inPanel(page, (panel) => {
        panel.narrow = true;
      });
      await page.locator('flode-canvas .node').first().click();
      await inspector.locator('pre').waitFor();
      await page.screenshot({
        path: new URL(`./runtime/readonly-${engine}.png`, import.meta.url).pathname,
      });
      assert.deepEqual(errors, []);
      assert.deepEqual(mutations, []);
    });
  } finally {
    await page.screenshot({
      path: new URL(`./runtime/readonly-${engine}.png`, import.meta.url).pathname,
    });
    await browser.close();
  }
}
assert.deepEqual(await fingerprints(), before, 'Viewing changed configuration files');
assert.equal(
  await fs.readFile(sourceFile, 'utf8'),
  sourceBefore,
  'Viewing changed the source YAML'
);
result.finish();

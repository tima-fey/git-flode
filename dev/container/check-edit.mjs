// Edit only the disposable synthetic YAML; never deploy or run its automations.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

process.env.FLODE_GATE_URL = 'http://127.0.0.1:18123';
process.env.FLODE_GATE_TOKEN_FILE = new URL('./runtime/token', import.meta.url).pathname;
const { ENGINES, gotoPanel, inPanel, openBrowser, openFlow, readCards, report, waitForPanel, ws } =
  await import('../gate/lib.mjs');
const source = new URL('./runtime/repository/automations/examples/simple.yaml', import.meta.url);
const file = 'automations/examples/simple.yaml';
const original = await fs.readFile(source);
const result = report('edit-files');

const root = new URL('./runtime/repository/', import.meta.url).pathname;
async function otherFiles(directory = root, prefix = '') {
  const snapshot = {};
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (relative === '.git' || relative === file) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) Object.assign(snapshot, await otherFiles(absolute, relative));
    else {
      const info = await fs.lstat(absolute);
      const content = entry.isSymbolicLink()
        ? await fs.readlink(absolute)
        : await fs.readFile(absolute);
      snapshot[relative] = {
        hash: createHash('sha256').update(content).digest('hex'),
        mtime: info.mtimeMs,
        mode: info.mode,
      };
    }
  }
  return snapshot;
}

for (const engine of ENGINES) {
  const untouched = await otherFiles();
  const { browser, page, errors } = await openBrowser(engine);
  const forbidden = [];
  page.on('request', (request) => {
    if (/^\/api\/config\/(automation|script)(\/|$)/.test(new URL(request.url()).pathname))
      forbidden.push(request.url());
  });
  page.on('websocket', (socket) =>
    socket.on('framesent', ({ payload }) => {
      const message = JSON.parse(String(payload));
      if (
        ['call_service', 'execute_script'].includes(message.type) ||
        /^(config\/)?(automation|script)\//.test(message.type)
      )
        forbidden.push(message.type);
    })
  );
  try {
    await fs.writeFile(
      source,
      original
        .toString('utf8')
        .replace(
          '  alias: File ventilation start',
          '  future_option: {nested: [1, 2]} # Keep custom field\n  alias: File ventilation start'
        )
    );
    await gotoPanel(page, { reload: true });
    await result.check(
      `${engine}: edit, save, reopen, stale-file conflict, no creation or execution`,
      async () => {
        const listed = await ws({ type: 'flode/files/list' });
        const first = listed.items.find((item) => item.name === 'File ventilation start');
        const neighbor = listed.items.find((item) => item.name === 'File ventilation stop');
        assert.ok(first && neighbor);
        const before = (await ws({ type: 'flode/files/open', file, automation_id: neighbor.id }))
          .config;
        await openFlow(page, first.name);
        assert.equal(await inPanel(page, (panel) => panel.readOnly), false);
        const commands = await inPanel(page, (panel) =>
          panel.paletteEntries().map((entry) => entry.id)
        );
        for (const command of [
          'new',
          'newScript',
          'saveCopy',
          'importYaml',
          'importJson',
          'merge',
          'runOnly',
          'runFrom',
        ])
          assert.ok(!commands.includes(command));
        const card = (await readCards(page)).find((entry) => entry.type === 'Delay');
        assert.ok(card);
        await page.locator(`flode-canvas .node[data-node-id="${card.id}"]`).click();
        const editor = page.locator('flode-inspector ha-automation-action-editor');
        await editor.waitFor();
        await editor.evaluate((element) =>
          element.dispatchEvent(
            new CustomEvent('value-changed', {
              detail: { value: { ...element.action, delay: '00:00:03' } },
            })
          )
        );
        await waitForPanel(page, (panel) => panel.saveState === 'unsaved');
        await page.locator('flode-panel .actions button.save').click();
        await waitForPanel(
          page,
          (panel) => panel.saveState === 'saved' || Boolean(panel.saveProblem)
        );
        assert.equal(await inPanel(page, (panel) => panel.saveProblem), null);
        assert.equal(await inPanel(page, (panel) => panel.saveState), 'saved');
        assert.deepEqual(
          (await ws({ type: 'flode/files/open', file, automation_id: neighbor.id })).config,
          before
        );
        const stored = (await ws({ type: 'flode/files/open', file, automation_id: first.id }))
          .config;
        assert.equal((stored.actions ?? stored.action)[0].delay, '00:00:03');
        assert.deepEqual(stored.future_option, { nested: [1, 2] });
        assert.match(await fs.readFile(source, 'utf8'), /Keep custom field/);
        assert.deepEqual(await otherFiles(), untouched, 'Save changed a different project file');
        await gotoPanel(page, { reload: true });
        await openFlow(page, first.name);
        const reopened = (await readCards(page)).find((entry) => entry.type === 'Delay');
        assert.ok(reopened);
        await page.locator(`flode-canvas .node[data-node-id="${reopened.id}"]`).click();
        await editor.waitFor();
        await editor.evaluate((element) =>
          element.dispatchEvent(
            new CustomEvent('value-changed', {
              detail: { value: { ...element.action, delay: '00:00:04' } },
            })
          )
        );
        await waitForPanel(page, (panel) => panel.saveState === 'unsaved');
        await inPanel(page, (panel) => panel.persistTabs());
        await gotoPanel(page, { reload: true });
        await waitForPanel(page, (panel) => panel.saveState === 'unsaved' && Boolean(panel.flow));
        assert.ok(
          await inPanel(page, (panel) =>
            panel.flow.graph.nodes.some((node) => node.data.delay === '00:00:04')
          )
        );
        await fs.appendFile(source, '\n# External change for conflict test\n');
        const external = await fs.readFile(source);
        await page.locator('flode-panel .actions button.save').click();
        await waitForPanel(
          page,
          (panel) => panel.saveState === 'unsaved' && Boolean(panel.saveProblem)
        );
        assert.match(await inPanel(page, (panel) => panel.saveProblem.text), /changed on disk/);
        assert.deepEqual(await fs.readFile(source), external);
        assert.deepEqual(
          await otherFiles(),
          untouched,
          'Failed save changed a different project file'
        );
        assert.deepEqual(forbidden, []);
        assert.deepEqual(errors, []);
        await page.screenshot({ path: `dev/container/runtime/edit-${engine}.png` });
      }
    );
  } finally {
    await fs.writeFile(source, original);
    await browser.close();
  }
}
result.finish();

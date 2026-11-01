// Exercise explicit native HA maintenance controls only in the disposable instance.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.FLODE_GATE_URL = 'http://127.0.0.1:18123';
process.env.FLODE_GATE_TOKEN_FILE = new URL('./runtime/token', import.meta.url).pathname;
const { ENGINES, gotoPanel, label, openBrowser, report } = await import('../gate/lib.mjs');
const result = report('ha-controls');
const source = new URL('./runtime/repository/automations/examples/simple.yaml', import.meta.url);
const original = await fs.readFile(source, 'utf8');
for (const engine of ENGINES) {
  const objects = new URL('./runtime/repository/objects/', import.meta.url).pathname;
  const backup = await fs.mkdtemp(path.join(os.tmpdir(), 'flode-controls-'));
  await fs.cp(objects, path.join(backup, 'objects'), { recursive: true, preserveTimestamps: true });
  const { browser, page, errors } = await openBrowser(engine);
  const services = [];
  const reloads = [];
  const checks = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/config/core/check_config')
      checks.push(request.method());
  });
  page.on('websocket', (socket) => {
    socket.on('framesent', ({ payload }) => {
      const message = JSON.parse(String(payload));
      if (message.type === 'call_service') services.push(message);
      if (message.type === 'flode/ha/reload') reloads.push(message);
    });
  });
  try {
    await gotoPanel(page, { reload: true });
    await result.check(
      `${engine}: native config check, Quick reload, and missing-reference test output`,
      async () => {
        const control = page.locator('flode-ha-controls');
        assert.equal(services.length, 0);
        assert.equal(checks.length, 0);
        await control
          .getByRole('button', { name: await label(page, 'haCheck'), exact: true })
          .click();
        await control.getByText(await label(page, 'haValid'), { exact: true }).waitFor();
        assert.deepEqual(checks, ['POST']);
        assert.equal(services.length, 0);
        await control
          .getByRole('button', { name: await label(page, 'haReload'), exact: true })
          .click();
        await control.getByText(await label(page, 'haReloaded'), { exact: true }).waitFor();
        assert.equal(services.length, 0);
        assert.equal(reloads.length, 1);
        assert.equal(reloads[0].directory, '/flode-config');
        await control
          .getByRole('button', { name: await label(page, 'objectsExport'), exact: true })
          .click();
        await control.locator('ha-alert[alert-type="success"]').waitFor();
        await control
          .getByRole('button', { name: await label(page, 'testsRun'), exact: true })
          .click();
        await control.getByText(await label(page, 'testsFailed'), { exact: false }).waitFor();
        assert.match(await control.locator('.test-output').innerText(), /Ran 1 test/);
        assert.match(
          await control.locator('.test-output').innerText(),
          /test_all_automation_object_references_exist/
        );
        const output = await control.locator('.test-output').innerText();
        assert.match(output, /unknown entities reference 'input_boolean.example_heating_enabled'/);
        assert.match(output, /automations\/climate\/heating.yaml/);
        assert.match(output, /Checked 6 automations against \d+ entities and \d+ devices/);
        assert.doesNotMatch(output, /Export HA objects first/);
        assert.equal(services.length, 0);
        assert.equal(reloads.length, 1);
        assert.deepEqual(checks, ['POST']);
        assert.equal(await fs.readFile(source, 'utf8'), original);
        await page.setViewportSize({ width: 390, height: 844 });
        await control.scrollIntoViewIfNeeded();
        await page.screenshot({ path: `dev/container/runtime/ha-controls-${engine}.png` });
        assert.deepEqual(errors, []);
      }
    );
  } finally {
    await browser.close();
    await fs.rm(objects, { recursive: true, force: true });
    await fs.cp(path.join(backup, 'objects'), objects, {
      recursive: true,
      preserveTimestamps: true,
    });
    await fs.rm(backup, { recursive: true, force: true });
  }
}
result.finish();

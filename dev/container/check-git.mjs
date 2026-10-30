// Real Git UI operations against only runtime/repository and runtime/remote.git.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

process.env.FLODE_GATE_URL = 'http://127.0.0.1:18123';
process.env.FLODE_GATE_TOKEN_FILE = new URL('./runtime/token', import.meta.url).pathname;
const { ENGINES, gotoPanel, inPanel, label, openBrowser, report, waitForPanel, ws } = await import(
  '../gate/lib.mjs'
);
const runtime = new URL('./runtime/', import.meta.url).pathname;
const remote = path.join(runtime, 'remote.git');
const checkout = path.join(runtime, 'repository');
const relativeFile = 'automations/examples/simple.yaml';
const result = report('git');

function git(cwd, ...args) {
  return execFileSync(
    'git',
    [
      '-c',
      'user.name=FLODE Test',
      '-c',
      'user.email=test@example.invalid',
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    }
  ).trim();
}

async function waitStatus(element, predicate) {
  const end = Date.now() + 35000;
  while (Date.now() < end) {
    const current = await element.evaluate((el) => ({
      status: el.status,
      busy: el.busy,
      error: el.error,
    }));
    if (!current.busy && current.error) throw new Error(current.error);
    if (!current.busy && current.status && predicate(current.status)) return current.status;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Git UI did not reach the expected checkout state');
}

for (const engine of ENGINES) {
  const writer = await fs.mkdtemp(path.join(runtime, 'git-writer-'));
  git(runtime, 'clone', remote, writer);
  const source = path.join(writer, relativeFile);
  const original = await fs.readFile(source, 'utf8');
  const updatedName = `File ventilation start from Git ${engine}`;
  const { browser, page, errors } = await openBrowser(engine);
  try {
    await gotoPanel(page);
    const control = page.locator('flode-git');
    await result.check(`${engine}: fetch, pull, historical checkout, return to main`, async () => {
      const before = await waitStatus(control, (status) => status.branch === 'main');
      const initialFiles = await fs.readFile(path.join(checkout, relativeFile), 'utf8');
      await fs.writeFile(
        source,
        original.replace('alias: File ventilation start\n', `alias: ${updatedName}\n`)
      );
      git(writer, 'add', relativeFile);
      git(writer, 'commit', '-m', `Update synthetic fixture for ${engine}`);
      git(writer, 'push', 'origin', 'main');
      const incoming = git(writer, 'rev-parse', 'HEAD');

      await control
        .getByRole('button', { name: await label(page, 'gitFetch'), exact: true })
        .click();
      const fetched = await waitStatus(control, (status) => status.remote === incoming);
      assert.equal(fetched.commit, before.commit);
      assert.equal(fetched.behind, 1);
      assert.equal(await fs.readFile(path.join(checkout, relativeFile), 'utf8'), initialFiles);

      await control
        .getByRole('button', { name: await label(page, 'gitPull'), exact: true })
        .click();
      await waitStatus(control, (status) => status.commit === incoming && status.branch === 'main');
      await waitForPanel(
        page,
        (panel, name) => panel.fileItems.some((item) => item.name === name),
        updatedName
      );
      assert.ok(
        await fs
          .readFile(path.join(checkout, relativeFile), 'utf8')
          .then((text) => text.includes(updatedName))
      );

      await control.locator('summary').click();
      await control.locator(`[data-revision="${before.commit}"]`).click();
      const historical = await waitStatus(
        control,
        (status) => status.commit === before.commit && status.branch === null
      );
      assert.equal(historical.main, incoming);
      await waitForPanel(page, (panel) =>
        panel.fileItems.some((item) => item.name === 'File ventilation start')
      );

      await control
        .getByRole('button', { name: await label(page, 'gitMain'), exact: true })
        .click();
      await waitStatus(control, (status) => status.commit === incoming && status.branch === 'main');
      await page.setViewportSize({ width: 390, height: 844 });
      await inPanel(page, (panel) => {
        panel.narrow = true;
      });
      await page.screenshot({ path: path.join(runtime, `git-${engine}.png`) });
      assert.deepEqual(errors, []);
    });
  } finally {
    // Restore fixture content through another normal main commit and fast-forward pull.
    await fs.writeFile(source, original);
    if (git(writer, 'status', '--porcelain')) {
      git(writer, 'add', relativeFile);
      git(writer, 'commit', '-m', `Restore synthetic fixture after ${engine}`);
      git(writer, 'push', 'origin', 'main');
    }
    let status = await ws({ type: 'flode/git/status' });
    if (status.branch !== 'main')
      status = await ws({ type: 'flode/git/action', action: 'main', expected_head: status.commit });
    await ws({ type: 'flode/git/action', action: 'pull', expected_head: status.commit });
    await browser.close();
    await fs.rm(writer, { recursive: true });
  }
}
result.finish();

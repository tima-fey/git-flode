// Commit and push only to runtime/remote.git, never the application remote.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';

process.env.FLODE_GATE_URL = 'http://127.0.0.1:18123';
process.env.FLODE_GATE_TOKEN_FILE = new URL('./runtime/token', import.meta.url).pathname;
const { ENGINES, gotoPanel, label, openBrowser, report, ws } = await import('../gate/lib.mjs');
const runtime = new URL('./runtime/', import.meta.url).pathname;
const relative = 'tests/test_publish_ui.py';
const target = new URL(`./runtime/repository/${relative}`, import.meta.url);
const result = report('git-publish');

function remoteHead() {
  return execFileSync('git', ['-C', `${runtime}/remote.git`, 'rev-parse', 'prod'], {
    encoding: 'utf8',
  }).trim();
}

async function waitGit(control, predicate) {
  const end = Date.now() + 35000;
  while (Date.now() < end) {
    const state = await control.evaluate((element) => ({
      status: element.status,
      busy: element.busy,
      error: element.error,
    }));
    if (!state.busy && state.error) throw new Error(state.error);
    if (!state.busy && state.status && predicate(state.status)) return state.status;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Git UI did not finish');
}

for (const engine of ENGINES) {
  const before = await ws({ type: 'flode/git/status' });
  assert.equal(before.branch, 'prod');
  assert.equal(before.dirty, false);
  const beforeRemote = remoteHead();
  const authorName = execFileSync('git', ['-C', `${runtime}/repository`, 'config', 'user.name'], {
    encoding: 'utf8',
  }).trim();
  const authorEmail = execFileSync('git', ['-C', `${runtime}/repository`, 'config', 'user.email'], {
    encoding: 'utf8',
  }).trim();
  const content = `# Disposable ${engine} commit and push check\n`;
  const { browser, page, errors } = await openBrowser(engine);
  try {
    await fs.writeFile(target, content);
    await gotoPanel(page, { reload: true });
    const control = page.locator('flode-git');
    await result.check(
      `${engine}: review, message only, configured author, commit locally, push prod`,
      async () => {
        await waitGit(control, (status) => status.dirty);
        await control
          .getByRole('button', { name: await label(page, 'gitReview'), exact: true })
          .click();
        await control.locator('.diff').waitFor();
        assert.match(await control.locator('.diff').innerText(), /commit and push check/);
        assert.equal(await control.locator('ha-selector').count(), 1);
        assert.equal(
          await control.locator('[data-field="author-name"], [data-field="author-email"]').count(),
          0
        );
        await control
          .locator('[data-field="message"] input')
          .fill(`Commit smoke test for ${engine}`);
        await control
          .getByRole('button', { name: await label(page, 'gitCommit'), exact: true })
          .click();
        const committed = await waitGit(
          control,
          (status) => !status.dirty && status.commit !== before.commit
        );
        assert.equal(remoteHead(), beforeRemote);
        assert.equal(
          execFileSync('git', ['-C', `${runtime}/repository`, 'log', '-1', '--format=%an <%ae>'], {
            encoding: 'utf8',
          }).trim(),
          `${authorName} <${authorEmail}>`
        );
        assert.equal(committed.ahead, 1);
        assert.equal(await fs.readFile(target, 'utf8'), content);
        await control
          .getByRole('button', { name: await label(page, 'gitPush'), exact: true })
          .click();
        await waitGit(
          control,
          (status) => status.ahead === 0 && status.remote_prod === committed.commit
        );
        assert.equal(remoteHead(), committed.commit);
        assert.equal(
          execFileSync('git', ['-C', `${runtime}/remote.git`, 'show', `prod:${relative}`], {
            encoding: 'utf8',
          }),
          content
        );
        assert.deepEqual(errors, []);
        await page.setViewportSize({ width: 390, height: 844 });
        await control.screenshot({ path: `dev/container/runtime/publish-${engine}.png` });
      }
    );
  } finally {
    await browser.close();
    await fs.rm(target, { force: true });
    let current = await ws({ type: 'flode/git/status' });
    if (current.dirty) {
      const changes = await ws({ type: 'flode/git/changes' });
      assert.deepEqual(changes.files, [relative]);
      current = await ws({
        type: 'flode/git/action',
        action: 'commit',
        expected_head: current.commit,
        expected_directory: current.directory,
        expected_changes: changes.version,
        message: `Remove ${engine} publish smoke test`,
      });
      await ws({
        type: 'flode/git/action',
        action: 'push',
        expected_head: current.commit,
        expected_directory: current.directory,
      });
    }
  }
}
result.finish();

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

async function action(name, revision = '') {
  const status = await ws({ type: 'flode/git/status' });
  return ws({
    type: 'flode/git/action',
    action: name,
    revision,
    expected_head: status.commit,
    expected_directory: status.directory,
  });
}

async function click(control, page, key) {
  if (key === 'gitPush' || key === 'gitCommit')
    await control.locator('[data-manual-publish]').evaluate((element) => {
      element.open = true;
    });
  await control.getByRole('button', { name: await label(page, key), exact: true }).click();
}

async function commitThroughUi(control, page, message) {
  await control.locator('header > ha-icon-button').click();
  await waitStatus(control, (status) => status.dirty);
  await click(control, page, 'workflowOptionalReview');
  await control.locator('[data-field="message"] input').fill(message);
  await click(control, page, 'gitCommit');
  return waitStatus(control, (status) => !status.dirty);
}

for (const engine of ENGINES) {
  const writer = await fs.mkdtemp(path.join(runtime, 'git-writer-'));
  git(runtime, 'clone', remote, writer);
  const source = path.join(writer, relativeFile);
  const local = path.join(checkout, relativeFile);
  const original = await fs.readFile(source, 'utf8');
  const updatedName = `File ventilation start from Git ${engine}`;
  const { browser, page, errors } = await openBrowser(engine);
  const services = [];
  page.on('websocket', (socket) =>
    socket.on('framesent', ({ payload }) => {
      if (JSON.parse(String(payload)).type === 'call_service') services.push(payload);
    })
  );
  try {
    await gotoPanel(page, { reload: true });
    const control = page.locator('flode-git');
    await result.check(
      `${engine}: fetch main, merge prod, push, undo published merge, history`,
      async () => {
        const before = await waitStatus(control, (status) => status.branch === 'prod');
        assert.equal(before.dirty, false);
        const initialFiles = await fs.readFile(local, 'utf8');
        await fs.writeFile(
          source,
          original.replace('alias: File ventilation start\n', `alias: ${updatedName}\n`)
        );
        git(writer, 'add', relativeFile);
        git(writer, 'commit', '-m', `Update synthetic fixture for ${engine}`);
        git(writer, 'push', 'origin', 'main');
        const incoming = git(writer, 'rev-parse', 'HEAD');
        await click(control, page, 'gitFetch');
        const fetched = await waitStatus(control, (status) => status.remote_main === incoming);
        assert.equal(fetched.commit, before.commit);
        assert.equal(fetched.incoming, 1);
        const incomingList = control.locator('.incoming');
        assert.match(
          await incomingList.innerText(),
          new RegExp(`Update synthetic fixture for ${engine}`)
        );
        assert.match(await incomingList.innerText(), /FLODE Test/);
        await incomingList.locator(`[data-revision="${incoming}"]`).click();
        await control.locator('.review code').filter({ hasText: incoming }).waitFor();
        assert.equal(git(checkout, 'rev-parse', 'HEAD'), before.commit);
        await control.screenshot({ path: path.join(runtime, `git-incoming-${engine}.png`) });
        assert.equal(await fs.readFile(local, 'utf8'), initialFiles);
        await click(control, page, 'gitMerge');
        const merged = await waitStatus(
          control,
          (status) => status.commit !== before.commit && status.incoming === 0
        );
        assert.equal(await control.locator('.incoming li').count(), 0);
        assert.equal(merged.branch, 'prod');
        assert.equal(merged.merge_to_revert, merged.commit);
        assert.deepEqual(git(checkout, 'show', '-s', '--format=%P', 'HEAD').split(' '), [
          before.commit,
          incoming,
        ]);
        assert.equal(git(remote, 'rev-parse', 'prod'), before.commit);
        await waitForPanel(
          page,
          (panel, name) => panel.fileItems.some((item) => item.name === name),
          updatedName
        );
        await click(control, page, 'gitPush');
        await waitStatus(
          control,
          (status) => status.remote_prod === merged.commit && status.ahead === 0
        );
        assert.equal(git(remote, 'rev-parse', 'main'), incoming);
        await click(control, page, 'gitRevert');
        const reverted = await waitStatus(
          control,
          (status) => status.commit !== merged.commit && status.merge_to_revert === null
        );
        assert.equal(
          git(checkout, 'rev-parse', 'HEAD^{tree}'),
          git(checkout, 'rev-parse', `${before.commit}^{tree}`)
        );
        assert.equal(git(checkout, 'rev-parse', 'HEAD^'), merged.commit);
        await click(control, page, 'gitPush');
        await waitStatus(
          control,
          (status) => status.remote_prod === reverted.commit && status.ahead === 0
        );
        assert.equal(git(remote, 'rev-parse', 'main'), incoming);
        await control.locator('.history > summary').click();
        await control.locator(`[data-revision="${before.commit}"]`).click();
        await control.locator('.review code').filter({ hasText: before.commit }).waitFor();
        assert.equal(git(checkout, 'rev-parse', 'HEAD'), reverted.commit);
        assert.equal(git(checkout, 'branch', '--show-current'), 'prod');
        await waitForPanel(page, (panel) => panel.readOnly === false);
        assert.deepEqual(services, []);
      }
    );

    await result.check(`${engine}: conflict abort and human resolution via main`, async () => {
      const localName = `HA local edit ${engine}`;
      await fs.writeFile(
        local,
        original.replace('alias: File ventilation start\n', `alias: ${localName}\n`)
      );
      const committed = await commitThroughUi(control, page, `HA local fixture for ${engine}`);
      await click(control, page, 'gitPush');
      await waitStatus(
        control,
        (status) => status.remote_prod === committed.commit && status.ahead === 0
      );
      await fs.writeFile(
        source,
        original.replace('alias: File ventilation start\n', `alias: Computer edit ${engine}\n`)
      );
      git(writer, 'add', relativeFile);
      git(writer, 'commit', '-m', `Create synthetic conflict for ${engine}`);
      git(writer, 'push', 'origin', 'main');
      await click(control, page, 'gitMerge');
      const deadline = Date.now() + 35000;
      let failure;
      while (Date.now() < deadline) {
        failure = await control.evaluate((element) => ({
          busy: element.busy,
          error: element.error,
          status: element.status,
        }));
        if (!failure.busy && failure.error) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.match(failure?.error ?? '', /previous prod was restored/);
      assert.equal(failure.status.commit, committed.commit);
      assert.equal(failure.status.dirty, false);
      assert.match(await fs.readFile(local, 'utf8'), new RegExp(localName));
      assert.equal(
        await fs.stat(path.join(checkout, '.git/MERGE_HEAD')).then(
          () => true,
          () => false
        ),
        false
      );
      assert.equal(git(remote, 'rev-parse', 'prod'), committed.commit);
      git(writer, 'fetch', 'origin', 'prod');
      assert.throws(() => git(writer, 'merge', '--no-ff', '--no-edit', 'origin/prod'));
      const resolvedName = `Resolved on main ${engine}`;
      await fs.writeFile(
        source,
        original.replace('alias: File ventilation start\n', `alias: ${resolvedName}\n`)
      );
      git(writer, 'add', relativeFile);
      git(writer, 'commit', '-m', `Resolve conflict on main for ${engine}`);
      git(writer, 'push', 'origin', 'main');
      const resolvedMain = git(writer, 'rev-parse', 'HEAD');
      await click(control, page, 'gitMerge');
      const resolved = await waitStatus(
        control,
        (status) => status.commit !== committed.commit && status.incoming === 0
      );
      assert.deepEqual(git(checkout, 'show', '-s', '--format=%P', 'HEAD').split(' '), [
        committed.commit,
        resolvedMain,
      ]);
      await waitForPanel(
        page,
        (panel, name) => panel.fileItems.some((item) => item.name === name),
        resolvedName
      );
      await click(control, page, 'gitPush');
      await waitStatus(
        control,
        (status) => status.remote_prod === resolved.commit && status.ahead === 0
      );
      assert.deepEqual(services, []);
      assert.deepEqual(errors, []);
      await page.setViewportSize({ width: 390, height: 844 });
      await inPanel(page, (panel) => {
        panel.narrow = true;
      });
      await page.screenshot({ path: path.join(runtime, `git-${engine}.png`) });
    });
  } finally {
    try {
      if (
        await fs.stat(path.join(writer, '.git/MERGE_HEAD')).then(
          () => true,
          () => false
        )
      )
        git(writer, 'merge', '--abort');
      // Restore only owned fixture content through main, then merge/push prod.
      await fs.writeFile(source, original);
      if (git(writer, 'status', '--porcelain')) {
        git(writer, 'add', relativeFile);
        git(writer, 'commit', '-m', `Restore synthetic fixture after ${engine}`);
        git(writer, 'push', 'origin', 'main');
      }
      let status = await ws({ type: 'flode/git/status' });
      if (status.branch !== 'prod') status = await action('prod');
      if (status.dirty) {
        const changes = await ws({ type: 'flode/git/changes' });
        assert.deepEqual(changes.files, [relativeFile]);
        await ws({
          type: 'flode/git/action',
          action: 'commit',
          expected_head: status.commit,
          expected_directory: status.directory,
          expected_changes: changes.version,
          message: `Preserve ${engine} fixture before cleanup`,
        });
      }
      await action('merge');
      await action('push');
    } finally {
      await browser.close();
      await fs.rm(writer, { recursive: true });
    }
  }
}
result.finish();

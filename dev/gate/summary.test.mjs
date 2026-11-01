import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const required = [
  'static',
  'backend',
  'test-ha',
  'cards',
  'edit-files',
  'readonly',
  'git',
  'publish',
  'ha-controls',
  'objects',
  'visual',
];
const commit = 'a'.repeat(40);

function summarize({ steps = required, only = '', clean = true, sha = commit, failed = '' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flode-gate-summary-'));
  try {
    fs.mkdirSync(path.join(root, 'dev/gate'), { recursive: true });
    fs.mkdirSync(path.join(root, '.gate'));
    const script = path.join(root, 'dev/gate/summary.mjs');
    fs.copyFileSync(new URL('./summary.mjs', import.meta.url), script);
    fs.writeFileSync(
      path.join(root, '.gate/steps.txt'),
      steps.map((name) => `${name}|${name === failed ? 'failed' : 'ok'}|1|log`).join('\n')
    );
    const result = spawnSync(process.execPath, [
      script,
      '--commit',
      sha,
      '--clean',
      String(clean),
      '--only',
      only,
      '--restart',
      '1',
    ]);
    return {
      status: result.status,
      report: JSON.parse(fs.readFileSync(path.join(root, `.gate/gate-${sha}.json`), 'utf8')),
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('only complete clean full-SHA runs certify a release', () => {
  assert.equal(summarize().report.counts_for_release, true);
  for (const options of [
    { steps: [] },
    { steps: ['static'] },
    { steps: required.slice(0, -1) },
    { only: 'visual' },
    { only: 'baseline' },
    { clean: false },
    { sha: 'aaaaaaa' },
  ])
    assert.equal(summarize(options).report.counts_for_release, false);
});

test('failed or missing steps make a full run fail', () => {
  for (const options of [{ steps: [] }, { steps: required.slice(1) }, { failed: 'cards' }]) {
    const { status, report } = summarize(options);
    assert.equal(status, 1);
    assert.equal(report.ok, false);
    assert.equal(report.counts_for_release, false);
  }
});

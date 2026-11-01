// @vitest-environment happy-dom
import type { GitStatus } from '@flode/shared';
import { afterEach, expect, it, vi } from 'vitest';
import { FlodeGit } from '../flode-git';
import { FlodePanel } from '../flode-panel';
import { readGitStatus } from '../git-source';
import { configFingerprint, type HomeAssistant } from '../ha';
import { type EditorTab, type OpenFlow, readTabs, writeTabs } from '../tabs';

const status: GitStatus = {
  directory: '/a',
  commit: 'a'.repeat(40),
  short: 'aaaaaaa',
  branch: 'prod',
  dirty: false,
  prod: 'a'.repeat(40),
  remote_main: null,
  remote_prod: null,
  incoming: 0,
  merge_to_revert: null,
  has_origin: true,
  ahead: 0,
  behind: 0,
};
const config = { id: 'one', alias: 'Saved', triggers: [], actions: [] };
const history = { commits: [], has_more: false };
function connection(reply: (message: Record<string, unknown>) => Promise<unknown>): HomeAssistant {
  return {
    states: {},
    language: 'en',
    themes: { darkMode: false },
    localize: (key) => key,
    callApi: () => {
      throw new Error('HA config API must not be used');
    },
    callWS: async <T>(message: Record<string, unknown>) => {
      // Use the same JSON boundary as HA's WebSocket transport.
      return Promise.resolve<T>(JSON.parse(JSON.stringify(await reply(message))));
    },
  };
}
function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error('Promise not initialized');
  };
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}
function tab(): EditorTab {
  const flow: OpenFlow = {
    item: {
      kind: 'automation',
      entityId: '',
      configId: 'one',
      name: 'Saved',
      enabled: true,
      lastTriggered: null,
      source: { file: 'automations/one.yaml', id: 'one' },
    },
    graph: {
      id: '00000000-0000-4000-8000-000000000001',
      version: 1,
      name: 'Saved',
      nodes: [],
      edges: [],
    },
    fileVersion: 'original',
    fileDirectory: '/a',
    haVersion: configFingerprint(config),
  };
  return { id: 'tab-a', flow, past: [], future: [], saveState: 'saved', selectedId: null };
}
async function mountPanel(
  reply: (message: Record<string, unknown>) => Promise<unknown>,
  entry?: EditorTab,
  showHome = true
): Promise<FlodePanel> {
  if (entry) writeTabs({ tabs: [entry], activeTabId: entry.id, showHome }, new Set([entry.id]));
  const panel = new FlodePanel();
  panel.hass = connection(reply);
  panel.welcome = null;
  document.body.append(panel);
  await vi.waitFor(() => expect(panel.filesLoaded).toBe(true));
  await panel.updateComplete;
  return panel;
}
function projectReply(directory: string, message: Record<string, unknown>): unknown {
  if (message.type === 'flode/files/list') return { directory, items: [], errors: [] };
  if (message.type === 'flode/files/open') return { config, version: 'original', directory };
  if (message.type === 'flode/git/status') return { ...status, directory };
  if (message.type === 'flode/git/history') return history;
  return {};
}
function gitControl(panel: FlodePanel): FlodeGit {
  const control = panel.shadowRoot?.querySelector('flode-git');
  if (!(control instanceof FlodeGit)) throw new Error('Missing Git control');
  return control;
}
afterEach(() => {
  document.body.innerHTML = '';
  window.localStorage.clear();
});

it('accepts an unpublished prod branch and a repository without origin', async () => {
  for (const has_origin of [true, false]) {
    const hass = connection(async () => ({ ...status, has_origin }));
    expect((await readGitStatus(hass)).remote_prod).toBeNull();
  }
});

it('preserves drafts from the previous project and restores them when returning', async () => {
  const entry: EditorTab = { ...tab(), saveState: 'unsaved' };
  entry.flow.graph.name = 'My unsaved edit';
  let directory = '/a';
  const panel = await mountPanel(async (message) => projectReply(directory, message), entry);
  await vi.waitFor(() => expect(panel.flow?.graph.name).toBe('My unsaved edit'));
  gitControl(panel).dispatchEvent(
    new CustomEvent('git-state-changed', {
      detail: { ...status, branch: null },
    })
  );
  expect(panel.readOnly).toBe(true);
  directory = '/b';
  window.dispatchEvent(new Event('focus'));
  await vi.waitFor(() => expect(panel.tabs).toHaveLength(0));
  window.dispatchEvent(new Event('pagehide'));
  expect(panel.readOnly).toBe(false);
  expect(readTabs()?.tabs[0]?.flow.graph.name).toBe('My unsaved edit');
  directory = '/a';
  window.dispatchEvent(new Event('focus'));
  await vi.waitFor(() => expect(panel.flow?.graph.name).toBe('My unsaved edit'));
  expect(panel.saveState).toBe('unsaved');
});

it('refreshes the latest Git directory after an older request completes', async () => {
  const pending = deferred<GitStatus>();
  let reads = 0;
  const control = new FlodeGit();
  control.directory = '/a';
  control.hass = connection(async (message) => {
    if (message.type === 'flode/git/status')
      return ++reads === 1 ? pending.promise : { ...status, directory: '/b', short: 'bbbbbbb' };
    return history;
  });
  document.body.append(control);
  await vi.waitFor(() => expect(reads).toBe(1));
  control.directory = '/b';
  await control.updateComplete;
  pending.resolve(status);
  await vi.waitFor(() =>
    expect(control.shadowRoot?.querySelector('header code')?.textContent).toBe('bbbbbbb')
  );
  expect(reads).toBe(2);
});

it('retains and persists edits made while a Git merge is pending', async () => {
  const pending = deferred<GitStatus>();
  const entry = tab();
  let merging = false;
  const panel = await mountPanel(async (message) => {
    if (message.type === 'flode/git/action') {
      merging = true;
      return pending.promise;
    }
    return projectReply('/a', message);
  }, entry);
  const control = gitControl(panel);
  await vi.waitFor(() =>
    expect(control.shadowRoot?.querySelector('[data-action="merge"]')).not.toBeNull()
  );
  control.shadowRoot?.querySelector('[data-action="merge"]')?.dispatchEvent(new Event('click'));
  await vi.waitFor(() => expect(merging).toBe(true));
  panel.flow = { ...entry.flow, graph: { ...entry.flow.graph, name: 'Edited during merge' } };
  panel.saveState = 'unsaved';
  panel.showHome = false;
  await panel.updateComplete;
  pending.resolve({ ...status, commit: 'b'.repeat(40), short: 'bbbbbbb', branch: 'prod' });
  await vi.waitFor(() =>
    expect(control.shadowRoot?.querySelector('header code')?.textContent).toBe('bbbbbbb')
  );
  await vi.waitFor(() => expect(panel.readOnly).toBe(false));
  window.dispatchEvent(new Event('pagehide'));
  expect(panel.tabs).toHaveLength(1);
  expect(panel.flow?.graph.name).toBe('Edited during merge');
  expect(panel.flow?.fileVersion).toBe('original');
  expect(readTabs()?.tabs[0]?.flow.graph.name).toBe('Edited during merge');
});

it('does not advance a dirty tab revision when an unchanged config arrives late', async () => {
  const pending = deferred<unknown>();
  let opened = false;
  const entry = tab();
  const panel = await mountPanel(
    async (message) => {
      if (message.type === 'flode/files/open') {
        opened = true;
        return pending.promise;
      }
      return projectReply('/a', message);
    },
    entry,
    false
  );
  await vi.waitFor(() => expect(opened).toBe(true));
  panel.flow = { ...entry.flow, graph: { ...entry.flow.graph, name: 'New local edit' } };
  panel.saveState = 'unsaved';
  pending.resolve({ config, version: 'new-file-revision', directory: '/a' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await panel.updateComplete;
  expect(panel.flow.fileVersion).toBe('original');
  expect(panel.flow.graph.name).toBe('New local edit');
  expect(panel.saveState).toBe('unsaved');
});

it('ignores a file listing that arrives after a newer project response', async () => {
  const pending = deferred<unknown>();
  let reads = 0;
  const panel = new FlodePanel();
  panel.hass = connection(async (message) => {
    if (message.type === 'flode/files/list')
      return ++reads === 1 ? pending.promise : { directory: '/b', items: [], errors: [] };
    return projectReply('/b', message);
  });
  document.body.append(panel);
  await vi.waitFor(() => expect(reads).toBe(1));
  window.dispatchEvent(new Event('focus'));
  await vi.waitFor(() =>
    expect(panel.shadowRoot?.querySelector('.home-head code')?.textContent).toBe('/b')
  );
  pending.resolve({ directory: '/a', items: [], errors: [] });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await panel.updateComplete;
  expect(panel.shadowRoot?.querySelector('.home-head code')?.textContent).toBe('/b');
  expect(reads).toBe(2);
});

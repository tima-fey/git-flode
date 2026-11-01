// @vitest-environment happy-dom
import type { GitStatus } from '@flode/shared';
import { afterEach, expect, it, vi } from 'vitest';
import { FlodeGit } from '../flode-git';
import { FlodePanel } from '../flode-panel';
import { readGitStatus } from '../git-source';
import { configFingerprint, type HomeAssistant } from '../ha';
import { type EditorTab, type OpenFlow, readTabs } from '../tabs';

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
    isNew: false,
    registryEntry: null,
    fileVersion: 'original',
    fileDirectory: '/a',
    haVersion: configFingerprint(config),
  };
  return { id: 'tab-a', flow, past: [], future: [], saveState: 'saved', selectedId: null };
}
function install(panel: FlodePanel, entry: EditorTab) {
  panel['fileDirectory'] = '/a';
  panel.tabs = [entry];
  panel.flow = entry.flow;
  panel.activeTabId = entry.id;
  panel.saveState = entry.saveState;
  panel['knownTabIds'].add(entry.id);
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
  const panel = new FlodePanel();
  document.body.append(panel);
  await panel.updateComplete;
  const entry: EditorTab = { ...tab(), saveState: 'unsaved' };
  entry.flow.graph.name = 'My unsaved edit';
  install(panel, entry);
  panel['gitReadOnly'] = true;
  let directory = '/b';
  panel.hass = connection(async () => ({ directory, items: [], errors: [] }));
  await panel['loadFileList']();
  await vi.waitFor(() => expect(panel['fileDirectory']).toBe('/b'));
  panel['persistTabs']();
  expect(panel.tabs).toHaveLength(0);
  expect(panel.readOnly).toBe(false);
  expect(readTabs()?.tabs[0]?.flow.graph.name).toBe('My unsaved edit');
  directory = '/a';
  await panel['loadFileList']();
  expect(panel.flow?.graph.name).toBe('My unsaved edit');
  expect(panel.saveState).toBe('unsaved');
});

it('refreshes the latest Git directory after an older request completes', async () => {
  const pending = deferred<GitStatus>();
  let reads = 0;
  const control = new FlodeGit();
  control.directory = '/a';
  control.hass = connection(async (message) => {
    if (message.type === 'flode/git/status')
      return ++reads === 1 ? pending.promise : { ...status, directory: '/b' };
    return history;
  });
  document.body.append(control);
  await vi.waitFor(() => expect(reads).toBe(1));
  control.directory = '/b';
  await control.updateComplete;
  pending.resolve(status);
  await vi.waitFor(() => expect(control['status']?.directory).toBe('/b'));
  expect(reads).toBe(2);
});

it('retains and persists edits made while a Git checkout is pending', async () => {
  const pending = deferred<GitStatus>();
  const panel = new FlodePanel();
  const entry = tab();
  install(panel, entry);
  panel.showHome = true;
  panel.welcome = null;
  panel.filesLoaded = true;
  panel.hass = connection(async (message) => {
    if (message.type === 'flode/git/status') return status;
    if (message.type === 'flode/git/history') return history;
    if (message.type === 'flode/git/action') return pending.promise;
    if (message.type === 'flode/files/list') return { directory: '/a', items: [], errors: [] };
    if (message.type === 'flode/files/open')
      return { config, version: 'original', directory: '/a' };
    return [];
  });
  document.body.append(panel);
  await panel.updateComplete;
  const control = panel.shadowRoot?.querySelector('flode-git');
  if (!(control instanceof FlodeGit)) throw new Error('Missing Git control');
  await vi.waitFor(() => expect(control['status']).not.toBeNull());
  const operation = control['act']('checkout', 'b'.repeat(40));
  panel.flow = { ...entry.flow, graph: { ...entry.flow.graph, name: 'Edited during checkout' } };
  panel.saveState = 'unsaved';
  panel.showHome = false;
  await panel.updateComplete;
  pending.resolve({ ...status, commit: 'b'.repeat(40), branch: null });
  await operation;
  await vi.waitFor(() => expect(panel.readOnly).toBe(true));
  panel['persistTabs']();
  expect(panel.tabs).toHaveLength(1);
  expect(panel.flow?.graph.name).toBe('Edited during checkout');
  expect(panel.flow?.fileVersion).toBe('original');
  expect(readTabs()?.tabs[0]?.flow.graph.name).toBe('Edited during checkout');
});

it('does not advance a dirty tab revision when an unchanged config arrives late', async () => {
  const pending = deferred<unknown>();
  const panel = new FlodePanel();
  const entry = tab();
  install(panel, entry);
  panel.hass = connection(async () => pending.promise);
  const refresh = panel['refreshFileTab'](entry.id);
  panel.flow = { ...entry.flow, graph: { ...entry.flow.graph, name: 'New local edit' } };
  panel.saveState = 'unsaved';
  pending.resolve({ config, version: 'new-file-revision', directory: '/a' });
  await refresh;
  expect(panel.flow.fileVersion).toBe('original');
  expect(panel.flow.graph.name).toBe('New local edit');
  expect(panel.saveState).toBe('unsaved');
});

it('ignores a file listing that arrives after a newer project response', async () => {
  const pending = deferred<unknown>();
  let reads = 0;
  const panel = new FlodePanel();
  panel.hass = connection(async () =>
    ++reads === 1 ? pending.promise : { directory: '/b', items: [], errors: [] }
  );
  const first = panel['loadFileList']();
  await panel['loadFileList']();
  pending.resolve({ directory: '/a', items: [], errors: [] });
  await first;
  expect(panel['fileDirectory']).toBe('/b');
});

// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { FlodeGit } from '../flode-git';
import type { HomeAssistant } from '../ha';

if (!customElements.get('ha-selector'))
  customElements.define('ha-selector', class extends HTMLElement {});

const initial = {
  directory: '/files',
  commit: 'a'.repeat(40),
  short: 'aaaaaaa',
  branch: 'prod',
  dirty: false,
  prod: 'a'.repeat(40),
  remote_main: 'b'.repeat(40),
  remote_prod: 'a'.repeat(40),
  incoming: 1,
  merge_to_revert: 'a'.repeat(40),
  has_origin: true,
  ahead: 0,
  behind: 1,
};
const history = { commits: [], has_more: false };

async function mount(branch: string | null = 'prod') {
  const requests: Record<string, unknown>[] = [];
  const hass: HomeAssistant = {
    states: {},
    language: 'en',
    themes: { darkMode: false },
    localize: (key) => key,
    callApi: () => {
      throw new Error('HA config API must not be used');
    },
    callWS: <T>(message: Record<string, unknown> & { type: string }) => {
      requests.push(message);
      const reply =
        message.type === 'flode/git/changes'
          ? {
              files: ['automations/example.yaml'],
              diff: '-old\n+new',
              version: 'reviewed',
              truncated: true,
            }
          : message.type === 'flode/git/history'
            ? history
            : message.type === 'flode/git/action' && message.action !== 'fetch'
              ? {
                  ...initial,
                  commit: 'b'.repeat(40),
                  prod: 'b'.repeat(40),
                  short: 'bbbbbbb',
                  behind: 0,
                  merge_to_revert: message.action === 'merge' ? 'b'.repeat(40) : null,
                }
              : { ...initial, branch };
      return Promise.resolve<T>(JSON.parse(JSON.stringify(reply)));
    },
  };
  const control = new FlodeGit();
  control.hass = hass;
  document.body.append(control);
  await settle(control);
  return { control, requests };
}

async function settle(control: FlodeGit) {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await control.updateComplete;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('Git controls', () => {
  it('shows the current commit and keeps merge disabled on a historical checkout', async () => {
    const { control, requests } = await mount(null);
    expect(control.shadowRoot?.textContent).toContain('aaaaaaa');
    expect(control.shadowRoot?.textContent).toContain('Historical version');
    expect(control.shadowRoot?.querySelector('[data-action="merge"]')).toHaveProperty(
      'disabled',
      true
    );
    expect(control.shadowRoot?.querySelector('[data-action="prod"]')).toHaveProperty(
      'disabled',
      false
    );
    expect(requests.map((request) => request.type)).toEqual([
      'flode/git/status',
      'flode/git/history',
    ]);
  });

  it.each([
    'fetch',
    'merge',
  ])('%s sends the expected HEAD and invalidates files only for merge', async (action) => {
    const { control, requests } = await mount();
    let changes = 0;
    control.addEventListener('files-changed', () => changes++);
    control.shadowRoot
      ?.querySelector(`[data-action="${action}"]`)
      ?.dispatchEvent(new Event('click'));
    await settle(control);
    expect(requests).toContainEqual({
      type: 'flode/git/action',
      action,
      expected_head: initial.commit,
      revision: '',
      expected_directory: '/files',
    });
    expect(changes).toBe(action === 'merge' ? 1 : 0);
  });
  it('commits only a reviewed snapshot and pushes separately without clearing editor tabs', async () => {
    const { control, requests } = await mount();
    let changes = 0;
    control.addEventListener('files-changed', () => changes++);
    control.shadowRoot?.querySelector('[data-action="review"]')?.dispatchEvent(new Event('click'));
    await settle(control);
    expect(control.shadowRoot?.textContent).toContain('-old');
    expect(control.shadowRoot?.querySelector('[data-field="author-name"]')).toBeNull();
    expect(control.shadowRoot?.querySelector('[data-field="author-email"]')).toBeNull();
    expect(control.shadowRoot?.querySelectorAll('ha-selector')).toHaveLength(1);
    const field = control.shadowRoot?.querySelector('[data-field="message"]');
    if (!(field instanceof HTMLElement)) throw new Error('Missing message field');
    field.dispatchEvent(
      new CustomEvent('value-changed', { detail: { value: 'Edit existing automation' } })
    );
    await settle(control);
    expect(control.shadowRoot?.querySelector('[data-action="commit"]')).toHaveProperty(
      'disabled',
      false
    );
    control.shadowRoot?.querySelector('[data-action="commit"]')?.dispatchEvent(new Event('click'));
    await settle(control);
    expect(requests).toContainEqual({
      type: 'flode/git/action',
      action: 'commit',
      expected_head: initial.commit,
      revision: '',
      expected_changes: 'reviewed',
      expected_directory: '/files',
      message: 'Edit existing automation',
    });
    control.shadowRoot?.querySelector('[data-action="push"]')?.dispatchEvent(new Event('click'));
    await settle(control);
    expect(requests).toContainEqual({
      type: 'flode/git/action',
      action: 'push',
      expected_head: 'b'.repeat(40),
      revision: '',
      expected_directory: '/files',
    });
    expect(changes).toBe(0);
  });
  it('protects unsaved editor drafts from merge while leaving push available', async () => {
    const { control, requests } = await mount();
    control.hasUnsavedChanges = true;
    await settle(control);
    expect(control.shadowRoot?.querySelector('[data-action="merge"]')).toHaveProperty(
      'disabled',
      true
    );
    expect(control.shadowRoot?.querySelector('[data-action="push"]')).toHaveProperty(
      'disabled',
      false
    );
    control.shadowRoot?.querySelector('[data-action="merge"]')?.dispatchEvent(new Event('click'));
    await settle(control);
    expect(requests.some((request) => request.type === 'flode/git/action')).toBe(false);
  });
  it('undoes only the displayed merge with root and HEAD guards and refreshes files', async () => {
    const { control, requests } = await mount();
    let changes = 0;
    control.addEventListener('files-changed', () => changes++);
    control.shadowRoot?.querySelector('[data-action="revert"]')?.dispatchEvent(new Event('click'));
    await settle(control);
    expect(requests).toContainEqual({
      type: 'flode/git/action',
      action: 'revert',
      expected_head: initial.commit,
      expected_directory: '/files',
      revision: initial.merge_to_revert,
    });
    expect(changes).toBe(1);
    expect(control.shadowRoot?.querySelector('[data-action="revert"]')).toBeNull();
    expect(requests.some((request) => request.action === 'push')).toBe(false);
  });
  it('returns a historical checkout to prod while preserving editor drafts', async () => {
    const { control, requests } = await mount(null);
    control.hasUnsavedChanges = true;
    await settle(control);
    expect(control.shadowRoot?.querySelector('[data-action="prod"]')).toHaveProperty(
      'disabled',
      false
    );
    control.shadowRoot?.querySelector('[data-action="prod"]')?.dispatchEvent(new Event('click'));
    await settle(control);
    expect(requests).toContainEqual({
      type: 'flode/git/action',
      action: 'prod',
      expected_head: initial.commit,
      expected_directory: '/files',
      revision: '',
    });
    expect(requests.some((request) => request.action === 'main')).toBe(false);
  });
  it('protects unsaved drafts from undoing a merge', async () => {
    const { control, requests } = await mount();
    control.hasUnsavedChanges = true;
    await settle(control);
    expect(control.shadowRoot?.querySelector('[data-action="revert"]')).toHaveProperty(
      'disabled',
      true
    );
    control.shadowRoot?.querySelector('[data-action="revert"]')?.dispatchEvent(new Event('click'));
    await settle(control);
    expect(requests.some((request) => request.type === 'flode/git/action')).toBe(false);
  });
});

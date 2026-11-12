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
const history = {
  commits: [
    {
      commit: 'c'.repeat(40),
      short: 'ccccccc',
      date: '2026-11-01',
      subject: 'Earlier edit',
      author: 'History Author',
    },
  ],
  has_more: false,
};

async function mount(branch: string | null = 'prod') {
  const requests: Record<string, unknown>[] = [];
  const hass: HomeAssistant = {
    states: {},
    language: 'en',
    themes: { darkMode: false },
    user: { is_admin: true },
    localize: (key) => key,
    callApi: () => {
      throw new Error('HA config API must not be used');
    },
    callWS: <T>(message: Record<string, unknown> & { type: string }) => {
      requests.push(message);
      const reply =
        message.type === 'flode/git/changes'
          ? {
              files: ['automations/example.yaml', 'objects/catalog.yaml'],
              diff: '-old\n+new',
              version: 'reviewed',
              truncated: true,
              objects_diff: { diff: '+updated catalog', truncated: false },
            }
          : message.type === 'flode/git/history'
            ? message.scope === 'incoming'
              ? {
                  commits: [
                    {
                      ...history.commits[0],
                      subject: 'Incoming automation',
                      author: 'Incoming Author',
                    },
                  ],
                  has_more: false,
                }
              : history
            : message.type === 'flode/git/action' && message.action !== 'fetch'
              ? {
                  ...initial,
                  commit: 'b'.repeat(40),
                  prod: 'b'.repeat(40),
                  short: 'bbbbbbb',
                  behind: 0,
                  incoming: message.action === 'merge' ? 0 : initial.incoming,
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
  it('shows incoming subjects and authors after fetch and clears them after merge', async () => {
    const { control, requests } = await mount();
    control.shadowRoot?.querySelector('[data-action="fetch"]')?.dispatchEvent(new Event('click'));
    await settle(control);
    const incoming = control.shadowRoot?.querySelector('.incoming');
    expect(incoming?.textContent).toContain('Incoming automation');
    expect(incoming?.textContent).toContain('Incoming Author');
    expect(incoming?.textContent).not.toContain('Earlier edit');
    expect(incoming?.querySelector('ha-button')?.getAttribute('data-revision')).toBe(
      'c'.repeat(40)
    );
    expect(requests).toContainEqual({ type: 'flode/git/history', offset: 0, scope: 'incoming' });
    control.shadowRoot?.querySelector('[data-action="merge"]')?.dispatchEvent(new Event('click'));
    await settle(control);
    expect(control.shadowRoot?.querySelector('.incoming li')).toBeNull();
  });

  it('paginates incoming commits separately from combined history', async () => {
    const { control, requests } = await mount();
    const hass = control.hass;
    if (!hass) throw new Error('Missing Home Assistant');
    const callWS = hass.callWS;
    hass.callWS = <T>(message: Record<string, unknown> & { type: string }) => {
      if (message.type !== 'flode/git/history' || message.scope !== 'incoming')
        return callWS<T>(message);
      requests.push(message);
      return Promise.resolve<T>(
        JSON.parse(
          JSON.stringify({
            commits: [
              {
                ...history.commits[0],
                subject: message.offset ? 'Older incoming' : 'Newest incoming',
              },
            ],
            has_more: message.offset === 0,
          })
        )
      );
    };
    control.shadowRoot?.querySelector('[data-action="fetch"]')?.dispatchEvent(new Event('click'));
    await settle(control);
    control.shadowRoot?.querySelector('[data-more="incoming"]')?.dispatchEvent(new Event('click'));
    await settle(control);
    expect(requests).toContainEqual({ type: 'flode/git/history', offset: 1, scope: 'incoming' });
    const incoming = control.shadowRoot?.querySelector('.incoming');
    expect(incoming?.textContent).toContain('Newest incoming');
    expect(incoming?.textContent).toContain('Older incoming');
    expect(incoming?.querySelector('[data-more]')).toBeNull();
    expect(control.shadowRoot?.querySelector('.history')?.textContent).toContain('Earlier edit');
  });

  it('commits only a reviewed snapshot and pushes separately without clearing editor tabs', async () => {
    const { control, requests } = await mount();
    let changes = 0;
    control.addEventListener('files-changed', () => changes++);
    control.shadowRoot?.querySelector('[data-action="review"]')?.dispatchEvent(new Event('click'));
    await settle(control);
    const review = control.shadowRoot?.querySelector('section.review');
    expect(review?.querySelector(':scope > pre')?.textContent).toContain('-old');
    expect(review?.querySelector('li:last-child')?.textContent).toContain('objects/catalog.yaml');
    const objectsDiff = review?.querySelector('details');
    expect(objectsDiff?.open).toBe(false);
    expect(objectsDiff?.querySelector('summary')?.textContent).toBe('Changes in objects/');
    expect(objectsDiff?.querySelector('pre')?.textContent).toBe('+updated catalog');
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
  it('orders the three scenarios and publishes without an explicit review', async () => {
    const { control, requests } = await mount();
    expect(
      [...(control.shadowRoot?.querySelectorAll('[data-scenario]') ?? [])].map((element) =>
        element.getAttribute('data-scenario')
      )
    ).toEqual(['update', 'publish', 'rollback']);
    control.shadowRoot
      ?.querySelector('[data-field="message"]')
      ?.dispatchEvent(new CustomEvent('value-changed', { detail: { value: 'Publish HA edits' } }));
    await settle(control);
    control.shadowRoot
      ?.querySelector('[data-action="commit-push"]')
      ?.dispatchEvent(new Event('click'));
    await settle(control);
    const actions = requests.filter((request) => request.type === 'flode/git/action');
    expect(actions.map((request) => request.action)).toEqual(['commit', 'push']);
    expect(actions[0]).toMatchObject({
      expected_changes: 'reviewed',
      message: 'Publish HA edits',
      expected_head: initial.commit,
      expected_directory: '/files',
    });
    expect(actions[1]).toMatchObject({
      expected_head: 'b'.repeat(40),
      expected_directory: '/files',
    });
    expect(
      control.shadowRoot?.querySelector('[data-publication="commit"]')?.getAttribute('data-state')
    ).toBe('ok');
    expect(
      control.shadowRoot?.querySelector('[data-publication="push"]')?.getAttribute('data-state')
    ).toBe('ok');
  });

  it.each(['commit', 'push'])('reports partial publication failure at %s', async (failure) => {
    const { control } = await mount();
    const hass = control.hass;
    if (!hass) throw new Error('Missing Home Assistant');
    const callWS = hass.callWS;
    const actions: unknown[] = [];
    hass.callWS = <T>(message: Record<string, unknown> & { type: string }) => {
      if (message.type === 'flode/git/action') {
        actions.push(message.action);
        if (message.action === failure) return Promise.reject(new Error(`${failure} failed`));
      }
      return callWS<T>(message);
    };
    control.shadowRoot
      ?.querySelector('[data-field="message"]')
      ?.dispatchEvent(new CustomEvent('value-changed', { detail: { value: 'Publish' } }));
    await settle(control);
    control.shadowRoot
      ?.querySelector('[data-action="commit-push"]')
      ?.dispatchEvent(new Event('click'));
    await settle(control);
    expect(actions).toEqual(failure === 'commit' ? ['commit'] : ['commit', 'push']);
    expect(control.shadowRoot?.textContent).toContain(`${failure} failed`);
    expect(
      control.shadowRoot?.querySelector('[data-publication="commit"]')?.getAttribute('data-state')
    ).toBe(failure === 'commit' ? 'failed' : 'ok');
    expect(
      control.shadowRoot?.querySelector('[data-publication="push"]')?.getAttribute('data-state')
    ).toBe(failure === 'commit' ? 'skipped' : 'failed');
  });

  it('pushes existing work without creating another commit when the snapshot has no changed files', async () => {
    const { control, requests } = await mount();
    const hass = control.hass;
    if (!hass) throw new Error('Missing Home Assistant');
    const callWS = hass.callWS;
    hass.callWS = <T>(message: Record<string, unknown> & { type: string }) => {
      if (message.type === 'flode/git/changes')
        return Promise.resolve<T>(
          JSON.parse(JSON.stringify({ files: [], diff: '', version: 'clean', truncated: false }))
        );
      return callWS<T>(message);
    };
    control.shadowRoot
      ?.querySelector('[data-action="commit-push"]')
      ?.dispatchEvent(new Event('click'));
    await settle(control);
    expect(
      requests
        .filter((request) => request.type === 'flode/git/action')
        .map((request) => request.action)
    ).toEqual(['push']);
    expect(
      control.shadowRoot?.querySelector('[data-publication="commit"]')?.getAttribute('data-state')
    ).toBe('skipped');
    expect(
      control.shadowRoot?.querySelector('[data-publication="push"]')?.getAttribute('data-state')
    ).toBe('ok');
  });

  it('blocks Git mutations while a maintenance scenario is running', async () => {
    const { control, requests } = await mount();
    const maintenance = control.shadowRoot?.querySelector('flode-ha-controls');
    maintenance?.dispatchEvent(new CustomEvent('maintenance-busy', { detail: true }));
    await settle(control);
    for (const action of ['fetch', 'merge', 'commit-push', 'revert']) {
      expect(control.shadowRoot?.querySelector(`[data-action="${action}"]`)).toHaveProperty(
        'disabled',
        true
      );
      control.shadowRoot
        ?.querySelector(`[data-action="${action}"]`)
        ?.dispatchEvent(new Event('click'));
    }
    expect(requests.some((request) => request.type === 'flode/git/action')).toBe(false);
    maintenance?.dispatchEvent(new CustomEvent('maintenance-busy', { detail: false }));
    await settle(control);
    expect(control.shadowRoot?.querySelector('[data-action="fetch"]')).toHaveProperty(
      'disabled',
      false
    );
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
    expect(control.shadowRoot?.querySelector('[data-action="revert"]')).toHaveProperty(
      'disabled',
      true
    );
    expect(requests.some((request) => request.action === 'push')).toBe(false);
  });
  it('returns an external historical checkout to prod while preserving drafts', async () => {
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

it('reads historical changes without mutating Git or refreshing live files', async () => {
  const { control, requests } = await mount();
  let changes = 0;
  control.addEventListener('files-changed', () => changes++);
  const revision = 'c'.repeat(40);
  const original = control.shadowRoot?.querySelector('header')?.textContent;
  expect(original).toContain(initial.short);
  const hass = control.hass;
  if (!hass) throw new Error('Missing Home Assistant');
  const callWS = hass.callWS;
  hass.callWS = <T>(message: Record<string, unknown> & { type: string }) => {
    if (message.type !== 'flode/git/show') return callWS<T>(message);
    requests.push(message);
    return Promise.resolve<T>(
      JSON.parse(JSON.stringify({ revision, diff: '-old\n+new', truncated: false }))
    );
  };
  control.hasUnsavedChanges = true;
  const button = control.shadowRoot?.querySelector(`[data-revision="${revision}"]`);
  if (!button) throw new Error('Missing history button');
  button.dispatchEvent(new Event('click'));
  await settle(control);
  expect(requests).toContainEqual({ type: 'flode/git/show', revision });
  expect(requests.some((request) => request.type === 'flode/git/action')).toBe(false);
  expect(control.shadowRoot?.querySelector('header')?.textContent).toBe(original);
  expect(control.shadowRoot?.querySelector('.review pre')?.textContent).toContain('+new');
  expect(changes).toBe(0);
});

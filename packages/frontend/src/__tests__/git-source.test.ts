// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { FlodeGit } from '../flode-git';
import type { HomeAssistant } from '../ha';

const initial = {
  commit: 'a'.repeat(40),
  short: 'aaaaaaa',
  branch: 'main',
  dirty: false,
  main: 'a'.repeat(40),
  remote: 'b'.repeat(40),
  has_origin: true,
  ahead: 0,
  behind: 1,
};
const history = { commits: [], has_more: false };

async function mount(branch: string | null = 'main') {
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
        message.type === 'flode/git/history'
          ? history
          : message.type === 'flode/git/action' && message.action !== 'fetch'
            ? { ...initial, commit: 'b'.repeat(40), short: 'bbbbbbb', behind: 0 }
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
  it('shows the current commit and keeps pull disabled on a historical checkout', async () => {
    const { control, requests } = await mount(null);
    expect(control.shadowRoot?.textContent).toContain('aaaaaaa');
    expect(control.shadowRoot?.textContent).toContain('Historical version');
    expect(control.shadowRoot?.querySelector('[data-action="pull"]')).toHaveProperty(
      'disabled',
      true
    );
    expect(control.shadowRoot?.querySelector('[data-action="main"]')).toHaveProperty(
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
    'pull',
  ])('%s sends the expected HEAD and invalidates files only for pull', async (action) => {
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
    });
    expect(changes).toBe(action === 'pull' ? 1 : 0);
  });
});

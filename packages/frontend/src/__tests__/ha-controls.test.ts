// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FlodeHaControls } from '../flode-ha-controls';
import type { HomeAssistant } from '../ha';

async function mount(admin = true) {
  const callApi = vi.fn().mockResolvedValue({ result: 'valid', errors: null });
  const callWS = vi.fn().mockResolvedValue({});
  const hass: HomeAssistant = {
    states: {},
    language: 'en',
    themes: { darkMode: false },
    user: { is_admin: admin },
    localize: (key) => key,
    callApi,
    callWS,
  };
  const control = new FlodeHaControls();
  control.hass = hass;
  control.directory = '/flode-config';
  document.body.append(control);
  await settle(control);
  return { control, callApi, callWS };
}

async function settle(control: FlodeHaControls) {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await control.updateComplete;
}

function click(control: FlodeHaControls, action: string) {
  control.shadowRoot?.querySelector(`[data-action="${action}"]`)?.dispatchEvent(new Event('click'));
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('HA configuration controls', () => {
  it('does nothing on mount and checks configuration through the native REST endpoint', async () => {
    const { control, callApi, callWS } = await mount();
    expect(callApi).not.toHaveBeenCalled();
    expect(callWS).not.toHaveBeenCalled();
    click(control, 'check');
    await settle(control);
    expect(callApi).toHaveBeenCalledExactlyOnceWith('POST', 'config/core/check_config');
    expect(control.shadowRoot?.textContent).toContain('Configuration is valid.');
    expect(callWS).not.toHaveBeenCalled();
  });

  it('displays native validation errors and warnings without reloading', async () => {
    const { control, callApi, callWS } = await mount();
    callApi.mockResolvedValue({
      result: 'invalid',
      errors: 'Invalid automation',
      warnings: 'Deprecated option',
    });
    click(control, 'check');
    await settle(control);
    expect(control.shadowRoot?.textContent).toContain('Configuration is invalid.');
    expect(control.shadowRoot?.textContent).toContain('Invalid automation');
    expect(control.shadowRoot?.textContent).toContain('Deprecated option');
    expect(callWS).not.toHaveBeenCalled();
  });

  it('reloads through the backend lock with the displayed project identity', async () => {
    const { control, callApi, callWS } = await mount();
    click(control, 'reload');
    await settle(control);
    expect(callWS).toHaveBeenCalledExactlyOnceWith({
      type: 'flode/ha/reload',
      directory: '/flode-config',
    });
    expect(control.shadowRoot?.textContent).toContain('Quick reload completed.');
    expect(callApi).not.toHaveBeenCalled();
  });

  it('does not reload before a writable project is available', async () => {
    const { control, callWS } = await mount();
    control.directory = '';
    await settle(control);
    click(control, 'reload');
    await settle(control);
    expect(callWS).not.toHaveBeenCalled();
    expect(control.shadowRoot?.querySelector('[data-action="reload"]')).toHaveProperty(
      'disabled',
      true
    );
  });

  it('shows a failed reload without claiming success and allows retry', async () => {
    const { control, callWS } = await mount();
    callWS.mockRejectedValueOnce(new Error('Configuration is not valid'));
    click(control, 'reload');
    await settle(control);
    expect(control.shadowRoot?.textContent).toContain('Configuration is not valid');
    expect(control.shadowRoot?.textContent).not.toContain('Quick reload completed.');
    click(control, 'reload');
    await settle(control);
    expect(control.shadowRoot?.textContent).toContain('Quick reload completed.');
  });

  it('blocks concurrent clicks until the current operation finishes', async () => {
    const { control, callApi, callWS } = await mount();
    let finish: () => void = () => undefined;
    callWS.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    click(control, 'reload');
    await settle(control);
    expect(control.shadowRoot?.querySelector('[data-action="check"]')).toHaveProperty(
      'disabled',
      true
    );
    click(control, 'reload');
    click(control, 'check');
    expect(callWS).toHaveBeenCalledTimes(1);
    expect(callApi).not.toHaveBeenCalled();
    finish();
    await settle(control);
    expect(control.shadowRoot?.querySelector('[data-action="check"]')).toHaveProperty(
      'disabled',
      false
    );
  });

  it.each([
    { success: true, timed_out: false, text: 'Tests passed.' },
    { success: false, timed_out: false, text: 'Tests failed.' },
    { success: false, timed_out: true, text: 'Tests timed out after 60 seconds.' },
  ])('reports project tests: $text', async ({ success, timed_out, text }) => {
    const { control, callApi, callWS } = await mount();
    callWS.mockResolvedValue({
      success,
      timed_out,
      exit_code: success ? 0 : 1,
      truncated: true,
      output: 'Python test output',
      duration: 0.1,
    });
    click(control, 'tests');
    await settle(control);
    expect(callWS).toHaveBeenCalledExactlyOnceWith({ type: 'flode/tests/run' });
    expect(callApi).not.toHaveBeenCalled();
    expect(control.shadowRoot?.textContent).toContain(text);
    expect(control.shadowRoot?.textContent).toContain('Python test output');
    expect(control.shadowRoot?.textContent).toContain('Output truncated');
  });

  it('exports objects only after a click and reports the returned counts', async () => {
    const { control, callApi, callWS } = await mount();
    expect(callWS).not.toHaveBeenCalled();
    callWS.mockResolvedValue({
      directory: '/flode-config/objects',
      devices: 2,
      entities: 4,
      helpers: 1,
      integrations: 2,
      files: 9,
      warnings: [],
    });
    click(control, 'objects');
    await settle(control);
    expect(callWS).toHaveBeenCalledExactlyOnceWith({
      type: 'flode/objects/export',
      directory: '/flode-config',
    });
    expect(callApi).not.toHaveBeenCalled();
    expect(control.shadowRoot?.textContent).toContain('2 devices, 4 entities, 1 helpers');
  });

  it('does not export before a project root is available', async () => {
    const { control, callWS } = await mount();
    control.directory = '';
    await settle(control);
    click(control, 'objects');
    await settle(control);
    expect(callWS).not.toHaveBeenCalled();
    expect(control.shadowRoot?.querySelector('[data-action="objects"]')).toHaveProperty(
      'disabled',
      true
    );
  });

  it('shows export errors and allows retry without claiming success', async () => {
    const { control, callWS } = await mount();
    callWS.mockRejectedValueOnce(new Error('Snapshot could not be replaced'));
    click(control, 'objects');
    await settle(control);
    expect(control.shadowRoot?.textContent).toContain('Snapshot could not be replaced');
    expect(control.shadowRoot?.textContent).not.toContain('Exported:');
  });

  it('runs check, tests and reload in order and keeps all three successful results', async () => {
    const { control, callApi, callWS } = await mount();
    const order: string[] = [];
    callApi.mockImplementation(async () => {
      order.push('check');
      return { result: 'valid', errors: null, warnings: 'A warning' };
    });
    callWS.mockImplementation(async (message) => {
      order.push(message.type);
      return message.type === 'flode/tests/run'
        ? {
            success: true,
            timed_out: false,
            exit_code: 0,
            truncated: false,
            output: 'Passed',
            duration: 0.1,
          }
        : {};
    });
    click(control, 'apply');
    await settle(control);
    expect(order).toEqual(['check', 'flode/tests/run', 'flode/ha/reload']);
    for (const step of ['check', 'tests', 'reload']) {
      expect(
        control.shadowRoot?.querySelector(`[data-step="${step}"]`)?.getAttribute('data-state')
      ).toBe('ok');
    }
    expect(control.shadowRoot?.textContent).toContain('A warning');
    expect(control.shadowRoot?.querySelector('details.individual')).toHaveProperty('open', false);
  });

  it.each([
    'invalid',
    'exception',
  ])('stops after a failed configuration check: %s', async (failure) => {
    const { control, callApi, callWS } = await mount();
    if (failure === 'invalid')
      callApi.mockResolvedValue({ result: 'invalid', errors: 'Broken YAML' });
    else callApi.mockRejectedValue(new Error('Check unavailable'));
    click(control, 'apply');
    await settle(control);
    expect(callWS).not.toHaveBeenCalled();
    expect(
      control.shadowRoot?.querySelector('[data-step="check"]')?.getAttribute('data-state')
    ).toBe('failed');
    for (const step of ['tests', 'reload']) {
      expect(
        control.shadowRoot?.querySelector(`[data-step="${step}"]`)?.getAttribute('data-state')
      ).toBe('skipped');
    }
    expect(control.shadowRoot?.textContent).toContain(
      failure === 'invalid' ? 'Broken YAML' : 'Check unavailable'
    );
  });

  it.each([
    'failed',
    'timeout',
    'exception',
  ])('never reloads after unsuccessful tests: %s', async (failure) => {
    const { control, callWS } = await mount();
    if (failure === 'exception') callWS.mockRejectedValue(new Error('Test runner unavailable'));
    else
      callWS.mockResolvedValue({
        success: false,
        timed_out: failure === 'timeout',
        exit_code: 1,
        truncated: false,
        output: 'A failing test',
        duration: 0.1,
      });
    click(control, 'apply');
    await settle(control);
    expect(callWS).toHaveBeenCalledExactlyOnceWith({ type: 'flode/tests/run' });
    expect(
      control.shadowRoot?.querySelector('[data-step="check"]')?.getAttribute('data-state')
    ).toBe('ok');
    expect(
      control.shadowRoot?.querySelector('[data-step="tests"]')?.getAttribute('data-state')
    ).toBe('failed');
    expect(
      control.shadowRoot?.querySelector('[data-step="reload"]')?.getAttribute('data-state')
    ).toBe('skipped');
  });

  it('reports reload failure after successful validation and allows the whole workflow to retry', async () => {
    const { control, callWS } = await mount();
    const tests = {
      success: true,
      timed_out: false,
      exit_code: 0,
      truncated: false,
      output: '',
      duration: 0.1,
    };
    callWS.mockResolvedValueOnce(tests).mockRejectedValueOnce(new Error('Reload failed'));
    click(control, 'apply');
    await settle(control);
    expect(
      control.shadowRoot?.querySelector('[data-step="tests"]')?.getAttribute('data-state')
    ).toBe('ok');
    expect(
      control.shadowRoot?.querySelector('[data-step="reload"]')?.getAttribute('data-state')
    ).toBe('failed');
    expect(control.shadowRoot?.textContent).toContain('Reload failed');
    callWS.mockResolvedValueOnce(tests).mockResolvedValueOnce({});
    click(control, 'apply');
    await settle(control);
    expect(
      control.shadowRoot?.querySelector('[data-step="reload"]')?.getAttribute('data-state')
    ).toBe('ok');
    expect(control.shadowRoot?.textContent).not.toContain('Reload failed');
  });

  it('stops a pending workflow if the project changes before validation completes', async () => {
    const { control, callApi, callWS } = await mount();
    let finish: (value: unknown) => void = () => undefined;
    callApi.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    click(control, 'apply');
    await settle(control);
    control.directory = '/another-project';
    await settle(control);
    finish({ result: 'valid', errors: null });
    await settle(control);
    expect(callWS).not.toHaveBeenCalled();
    expect(control.shadowRoot?.querySelector('[data-step]')).toBeNull();
  });

  it('ignores workflow clicks while another scenario is busy', async () => {
    const { control, callApi, callWS } = await mount();
    control.blocked = true;
    await settle(control);
    click(control, 'apply');
    expect(callApi).not.toHaveBeenCalled();
    expect(callWS).not.toHaveBeenCalled();
  });

  it('hides maintenance controls from non-administrators', async () => {
    const { control, callApi, callWS } = await mount(false);
    expect(control.shadowRoot?.querySelector('ha-button')).toBeNull();
    expect(callApi).not.toHaveBeenCalled();
    expect(callWS).not.toHaveBeenCalled();
  });
});

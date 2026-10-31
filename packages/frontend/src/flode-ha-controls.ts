import {
  type HaConfigCheck,
  HaConfigCheckSchema,
  type ProjectTestResult,
  ProjectTestResultSchema,
} from '@flode/shared';
import { css, html, LitElement, nothing } from 'lit';
import { defineElement } from './define-element';
import { errorMessage, type HomeAssistant } from './ha';
import { t } from './strings';

/** Explicit HA maintenance commands, independent of file editing and Git. */
export class FlodeHaControls extends LitElement {
  static properties = {
    hass: { attribute: false },
    busy: { state: true },
    result: { state: true },
    reloaded: { state: true },
    error: { state: true },
    tests: { state: true },
  };
  declare hass: HomeAssistant | undefined;
  private tests: ProjectTestResult | null = null;
  private busy = false;
  private result: HaConfigCheck | null = null;
  private reloaded = false;
  private error: string | null = null;

  private async run(action: 'check' | 'reload' | 'tests'): Promise<void> {
    if (!this.hass?.user?.is_admin || this.busy) return;
    this.busy = true;
    this.result = null;
    this.tests = null;
    this.reloaded = false;
    this.error = null;
    try {
      if (action === 'check') {
        this.result = HaConfigCheckSchema.parse(
          await this.hass.callApi('POST', 'config/core/check_config')
        );
      } else if (action === 'tests') {
        this.tests = ProjectTestResultSchema.parse(
          await this.hass.callWS({ type: 'flode/tests/run' })
        );
      } else {
        // HA validates configuration before reloading all supported YAML domains.
        await this.hass.callWS({
          type: 'call_service',
          domain: 'homeassistant',
          service: 'reload_all',
          service_data: {},
        });
        this.reloaded = true;
      }
    } catch (error) {
      this.error = errorMessage(error);
    } finally {
      this.busy = false;
    }
  }

  render() {
    if (!this.hass?.user?.is_admin) return nothing;
    const language = this.hass.language;
    return html`<ha-card>
      <strong>Home Assistant</strong>
      <p>${t(language, 'haScope')}</p>
      <div class="controls">
        <ha-button data-action="check" .disabled=${this.busy} @click=${() => this.run('check')}>${t(language, 'haCheck')}</ha-button>
        <ha-button data-action="reload" .disabled=${this.busy} @click=${() => this.run('reload')}>${t(language, 'haReload')}</ha-button>
        <ha-button data-action="tests" .disabled=${this.busy} @click=${() => this.run('tests')}>${t(language, 'testsRun')}</ha-button>
      </div>
      <p>${t(language, 'testsScope')}</p>
      <div role="status" aria-live="polite">
        ${this.busy ? html`<p>${t(language, 'loading')}</p>` : nothing}
        ${this.error ? html`<ha-alert alert-type="error">${this.error}</ha-alert>` : nothing}
        ${this.result ? html`<ha-alert alert-type=${this.result.result === 'valid' ? 'success' : 'error'}>${t(language, this.result.result === 'valid' ? 'haValid' : 'haInvalid')}${this.result.errors ? html`<pre>${this.result.errors}</pre>` : nothing}</ha-alert>` : nothing}
        ${this.result?.warnings ? html`<ha-alert alert-type="warning"><pre>${this.result.warnings}</pre></ha-alert>` : nothing}
        ${
          this.tests
            ? html`<ha-alert alert-type=${this.tests.success ? 'success' : 'error'}>${t(language, this.tests.timed_out ? 'testsTimeout' : this.tests.success ? 'testsPassed' : 'testsFailed')} (${this.tests.duration}s)</ha-alert>
          <pre class="test-output">${this.tests.output}</pre>
          ${this.tests.truncated ? html`<p>${t(language, 'testsTruncated')}</p>` : nothing}`
            : nothing
        }
        ${this.reloaded ? html`<ha-alert alert-type="success">${t(language, 'haReloaded')}</ha-alert>` : nothing}
      </div>
    </ha-card>`;
  }

  static styles = css`
    :host { display: block; margin-bottom: 20px; }
    ha-card { padding: 16px; }
    p { font-size: 14px; color: var(--secondary-text-color); }
    .controls { display: flex; gap: 12px; flex-wrap: wrap; }
    ha-alert { margin-top: 12px; }
    .test-output { max-height: 320px; overflow: auto; }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; }
  `;
}

defineElement('flode-ha-controls', FlodeHaControls);

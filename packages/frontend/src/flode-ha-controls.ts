import {
  type HaConfigCheck,
  HaConfigCheckSchema,
  type ObjectExportResult,
  ObjectExportResultSchema,
  type ProjectTestResult,
  ProjectTestResultSchema,
} from '@flode/shared';
import { css, html, LitElement, nothing, type PropertyValues } from 'lit';
import { defineElement } from './define-element';
import { errorMessage, type HomeAssistant } from './ha';
import { t } from './strings';

type Step = 'check' | 'tests' | 'reload';
type StepState = 'waiting' | 'running' | 'ok' | 'failed' | 'skipped';
const STEPS: Step[] = ['check', 'tests', 'reload'];

/** Explicit maintenance workflows, stopping before reload when validation fails. */
export class FlodeHaControls extends LitElement {
  static properties = {
    hass: { attribute: false },
    directory: { type: String },
    mode: { type: String },
    revision: { type: String },
    blocked: { type: Boolean },
    busy: { state: true },
    result: { state: true },
    reloaded: { state: true },
    error: { state: true },
    tests: { state: true },
    objects: { state: true },
    steps: { state: true },
  };
  declare hass: HomeAssistant | undefined;
  directory = '';
  revision = '';
  mode: 'all' | 'apply' | 'objects' = 'all';
  blocked = false;
  private objects: ObjectExportResult | null = null;
  private tests: ProjectTestResult | null = null;
  private busy = false;
  private result: HaConfigCheck | null = null;
  private reloaded = false;
  private error: string | null = null;
  private steps: Partial<Record<Step, StepState>> = {};
  private context = 0;

  protected willUpdate(changed: PropertyValues<this>): void {
    if (changed.has('directory') || (this.mode !== 'objects' && changed.has('revision'))) {
      this.context++;
      this.objects = null;
      this.result = null;
      this.tests = null;
      this.reloaded = false;
      this.error = null;
      this.steps = {};
    }
  }

  private setStep(step: Step, state: StepState): void {
    this.steps = { ...this.steps, [step]: state };
  }

  private async run(action: Step | 'objects' | 'apply'): Promise<void> {
    const hass = this.hass;
    if (!hass?.user?.is_admin || this.busy || this.blocked) return;
    if (['objects', 'reload', 'apply'].includes(action) && !this.directory) return;
    const directory = this.directory;
    const context = this.context;
    const revision = this.revision;
    const current = () =>
      context === this.context && directory === this.directory && revision === this.revision;
    this.busy = true;
    this.error = null;
    this.dispatchEvent(new CustomEvent('maintenance-busy', { detail: true }));
    let active: Step | null = null;
    try {
      if (action === 'objects') {
        this.objects = null;
        const objects = ObjectExportResultSchema.parse(
          await hass.callWS({ type: 'flode/objects/export', directory })
        );
        if (current()) {
          this.objects = objects;
          this.dispatchEvent(new CustomEvent('objects-exported'));
        }
        return;
      }
      const sequence = action === 'apply' ? STEPS : [action];
      if (action === 'apply') {
        this.steps = { check: 'waiting', tests: 'waiting', reload: 'waiting' };
        this.result = null;
        this.tests = null;
        this.reloaded = false;
      }
      for (const step of sequence) {
        if (!current()) return;
        active = step;
        this.setStep(step, 'running');
        let success = true;
        if (step === 'check') {
          this.result = null;
          const result = HaConfigCheckSchema.parse(
            await hass.callApi('POST', 'config/core/check_config')
          );
          if (!current()) return;
          this.result = result;
          success = result.result === 'valid';
        } else if (step === 'tests') {
          this.tests = null;
          const tests = ProjectTestResultSchema.parse(
            await hass.callWS({ type: 'flode/tests/run' })
          );
          if (!current()) return;
          this.tests = tests;
          success = tests.success && !tests.timed_out;
        } else {
          this.reloaded = false;
          await hass.callWS({ type: 'flode/ha/reload', directory });
          if (!current()) return;
          this.reloaded = true;
        }
        this.setStep(step, success ? 'ok' : 'failed');
        if (!success) break;
      }
    } catch (error) {
      if (current()) {
        this.error = errorMessage(error);
        if (active) this.setStep(active, 'failed');
      }
    } finally {
      if (current()) {
        for (const step of STEPS) {
          if (this.steps[step] === 'waiting') this.setStep(step, 'skipped');
        }
      }
      this.busy = false;
      this.dispatchEvent(new CustomEvent('maintenance-busy', { detail: false }));
    }
  }

  render() {
    if (!this.hass?.user?.is_admin) return nothing;
    const language = this.hass.language;
    const disabled = this.busy || this.blocked;
    return html`
      ${
        this.mode !== 'objects'
          ? html`
        <ha-button data-action="apply" .disabled=${disabled || !this.directory} @click=${() => this.run('apply')}>${t(language, 'workflowApply')}</ha-button>
        <p>${t(language, 'workflowApplyHint')}</p>
        <details class="individual"><summary>${t(language, 'workflowIndividual')}</summary>
          <div class="controls">
            <ha-button data-action="check" .disabled=${disabled} @click=${() => this.run('check')}>${t(language, 'haCheck')}</ha-button>
            <ha-button data-action="tests" .disabled=${disabled} @click=${() => this.run('tests')}>${t(language, 'testsRun')}</ha-button>
            <ha-button data-action="reload" .disabled=${disabled || !this.directory} @click=${() => this.run('reload')}>${t(language, 'haReload')}</ha-button>
          </div>
          <p>${t(language, 'haScope')} ${t(language, 'testsScope')}</p>
        </details>`
          : nothing
      }
      ${
        this.mode !== 'apply'
          ? html`
        <ha-button data-action="objects" .disabled=${disabled || !this.directory} @click=${() => this.run('objects')}>${t(language, 'objectsExport')}</ha-button>
        <p>${t(language, 'objectsScope')}</p>`
          : nothing
      }
      <div role="status" aria-live="polite">
        <ul class="steps">${STEPS.filter((step) => this.steps[step]).map(
          (step) => html`
          <li data-step=${step} data-state=${this.steps[step]}>
            ${t(language, step === 'check' ? 'haCheck' : step === 'tests' ? 'testsRun' : 'haReload')}
            — <strong>${t(language, this.steps[step] === 'ok' ? 'workflowOk' : this.steps[step] === 'failed' ? 'workflowFailed' : this.steps[step] === 'running' ? 'workflowRunning' : this.steps[step] === 'skipped' ? 'workflowSkipped' : 'workflowWaiting')}</strong>
          </li>`
        )}</ul>
        ${this.error ? html`<ha-alert alert-type="error">${this.error}</ha-alert>` : nothing}
        ${this.result ? html`<ha-alert alert-type=${this.result.result === 'valid' ? 'success' : 'error'}>${t(language, this.result.result === 'valid' ? 'haValid' : 'haInvalid')}${this.result.errors ? html`<pre>${this.result.errors}</pre>` : nothing}</ha-alert>` : nothing}
        ${this.result?.warnings ? html`<ha-alert alert-type="warning"><pre>${this.result.warnings}</pre></ha-alert>` : nothing}
        ${
          this.tests
            ? html`
          <ha-alert alert-type=${this.tests.success && !this.tests.timed_out ? 'success' : 'error'}>${t(language, this.tests.timed_out ? 'testsTimeout' : this.tests.success ? 'testsPassed' : 'testsFailed')} (${this.tests.duration}s)</ha-alert>
          <pre class="test-output">${this.tests.output}</pre>
          ${this.tests.truncated ? html`<p>${t(language, 'testsTruncated')}</p>` : nothing}`
            : nothing
        }
        ${
          this.objects
            ? html`
          <ha-alert alert-type="success">${t(language, 'objectsExported').replace('{devices}', String(this.objects.devices)).replace('{entities}', String(this.objects.entities)).replace('{helpers}', String(this.objects.helpers))}</ha-alert>
          ${this.objects.warnings.map((warning) => html`<ha-alert alert-type="warning">${warning}</ha-alert>`)}`
            : nothing
        }
        ${this.reloaded ? html`<ha-alert alert-type="success">${t(language, 'haReloaded')}</ha-alert>` : nothing}
      </div>`;
  }

  static styles = css`
    :host { display: block; }
    p, summary { font-size: 14px; color: var(--secondary-text-color); }
    summary { cursor: pointer; padding: 8px 0; }
    .controls { display: flex; gap: 12px; flex-wrap: wrap; }
    .steps { list-style: none; padding: 0; }
    .steps li { padding: 4px 0; }
    [data-state='ok'] strong { color: var(--success-color, #22863a); }
    [data-state='failed'] strong { color: var(--error-color); }
    ha-alert { margin-top: 12px; }
    .test-output { max-height: 320px; overflow: auto; }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; }
  `;
}

defineElement('flode-ha-controls', FlodeHaControls);

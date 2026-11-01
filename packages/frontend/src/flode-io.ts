import type { FlowGraph } from '@flode/shared';
import { css, html, LitElement, type PropertyValues } from 'lit';
import { defineElement } from './define-element';
import { flowYaml } from './flow-yaml';
import { errorMessage, type FlowKind, type HomeAssistant } from './ha';
import { copyToClipboard } from './notify';
import { t } from './strings';

/** FLODE's own flow file (the graph as JSON). */
export function downloadFlowJson(graph: FlowGraph): void {
  const blob = new Blob([JSON.stringify(graph, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${(graph.name || 'flow').replace(/[^\wÀ-ɏ -]+/g, '').trim() || 'flow'}.flode.json`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** "Show YAML": the whole flow as HA saves it, read-only in HA's code editor. */
export class FlodeYamlView extends LitElement {
  static properties = {
    hass: { attribute: false },
    graph: { attribute: false },
    kind: { attribute: false },
    open: { type: Boolean },
    yaml: { state: true },
    error: { state: true },
  };

  declare hass: HomeAssistant | undefined;
  declare graph: FlowGraph | undefined;
  declare kind: FlowKind;
  declare open: boolean;
  declare yaml: string;
  declare error: string | null;

  constructor() {
    super();
    this.kind = 'automation';
    this.open = false;
    this.yaml = '';
    this.error = null;
  }

  protected willUpdate(changed: PropertyValues<this>): void {
    if (changed.has('open') && this.open) void this.load();
  }

  private async load(): Promise<void> {
    const graph = this.graph;
    this.yaml = '';
    this.error = null;
    if (!graph) return;
    try {
      this.yaml = await flowYaml(graph, this.kind);
    } catch (error) {
      this.error = errorMessage(error);
    }
  }

  private copy(): void {
    const language = this.hass?.language ?? 'en';
    void copyToClipboard(this, () => this.yaml, t(language, 'ioYamlCopied'));
  }

  render() {
    const language = this.hass?.language ?? 'en';
    return html`<ha-dialog
      .open=${this.open}
      .headerTitle=${t(language, 'ioShowYaml')}
      width="large"
      @closed=${() => this.dispatchEvent(new CustomEvent('closed'))}
    >
      <p class="muted">${t(language, 'yamlViewIntro')}</p>
      ${
        this.error
          ? html`<ha-alert alert-type="error">${this.error}</ha-alert>`
          : html`<ha-code-editor
              .hass=${this.hass}
              .value=${this.yaml}
              mode="yaml"
              .readOnly=${true}
              @keydown=${(event: KeyboardEvent) => event.stopPropagation()}
            ></ha-code-editor>`
      }
      <ha-dialog-footer slot="footer">
        <ha-button slot="secondaryAction" appearance="plain" .disabled=${!this.yaml} @click=${() => this.copy()}>
          <ha-icon slot="start" icon="mdi:content-copy"></ha-icon>${t(language, 'ioCopyYaml')}
        </ha-button>
        <ha-button slot="primaryAction" @click=${() => this.dispatchEvent(new CustomEvent('closed'))}>
          ${t(language, 'close')}
        </ha-button>
      </ha-dialog-footer>
    </ha-dialog>`;
  }

  static styles = css`
    .muted {
      margin: 0 0 12px;
      color: var(--secondary-text-color);
    }
  `;
}

defineElement('flode-yaml-view', FlodeYamlView);

declare global {
  interface HTMLElementTagNameMap {
    'flode-yaml-view': FlodeYamlView;
  }
}

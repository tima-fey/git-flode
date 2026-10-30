import type { GitAction, GitHistory, GitStatus } from '@flode/shared';
import { css, html, LitElement, nothing, type PropertyValues } from 'lit';
import { defineElement } from './define-element';
import { readGitHistory, readGitStatus, runGitAction } from './git-source';
import { errorMessage, type HomeAssistant } from './ha';
import { t } from './strings';

/** Git updates the checkout explicitly; it never runs or reloads HA automations. */
export class FlodeGit extends LitElement {
  static properties = {
    hass: { attribute: false },
    directory: { type: String },
    status: { state: true },
    history: { state: true },
    busy: { state: true },
    error: { state: true },
  };
  declare hass: HomeAssistant | undefined;
  directory = '';
  private status: GitStatus | null = null;
  private history: GitHistory = { commits: [], has_more: false };
  private busy = false;
  private error: string | null = null;

  protected willUpdate(changed: PropertyValues<this>): void {
    if ((changed.has('hass') && !changed.get('hass')) || changed.has('directory'))
      void this.refresh();
  }

  private async refresh(): Promise<void> {
    if (!this.hass || this.busy) return;
    this.busy = true;
    this.error = null;
    try {
      this.status = await readGitStatus(this.hass);
      this.history = await readGitHistory(this.hass);
    } catch (error) {
      this.error = errorMessage(error);
      this.status = null;
    } finally {
      this.busy = false;
    }
  }

  private async act(action: GitAction, revision = ''): Promise<void> {
    if (!this.hass || !this.status || this.busy) return;
    this.busy = true;
    this.error = null;
    try {
      this.status = await runGitAction(this.hass, action, this.status.commit, revision);
      if (action !== 'fetch') this.dispatchEvent(new CustomEvent('files-changed'));
      this.history = await readGitHistory(this.hass);
    } catch (error) {
      this.error = errorMessage(error);
      // A failed pull may still have fetched new remote history.
      this.status = await readGitStatus(this.hass).catch(() => null);
    } finally {
      this.busy = false;
    }
  }

  private async more(): Promise<void> {
    if (!this.hass || this.busy) return;
    this.busy = true;
    try {
      const next = await readGitHistory(this.hass, this.history.commits.length);
      this.history = {
        commits: [...this.history.commits, ...next.commits],
        has_more: next.has_more,
      };
    } catch (error) {
      this.error = errorMessage(error);
    } finally {
      this.busy = false;
    }
  }

  render() {
    const language = this.hass?.language ?? 'en';
    const status = this.status;
    const blocked = this.busy || status?.dirty;
    return html`<ha-card>
      <header><strong>Git</strong>
        ${
          status
            ? html`<span>${status.branch ?? t(language, 'gitDetached')}</span>
          <code title=${status.commit}>${status.short}</code>`
            : nothing
        }
        <ha-icon-button .label=${t(language, 'gitRefresh')} .disabled=${this.busy} @click=${() => this.refresh()}>
          <ha-icon icon="mdi:refresh"></ha-icon>
        </ha-icon-button>
      </header>
      ${this.error ? html`<ha-alert alert-type="error">${this.error}</ha-alert>` : nothing}
      ${this.busy ? html`<p>${t(language, 'loading')}</p>` : nothing}
      ${
        status
          ? html`
        <p>${status.remote ? t(language, 'gitAheadBehind').replace('{ahead}', String(status.ahead)).replace('{behind}', String(status.behind)) : 'origin/main: —'}</p>
        ${status.dirty ? html`<ha-alert alert-type="warning">${t(language, 'gitDirty')}</ha-alert>` : nothing}
        <div class="controls">
          <ha-button data-action="fetch" .disabled=${this.busy || !status.has_origin} @click=${() => this.act('fetch')}>${t(language, 'gitFetch')}</ha-button>
          <ha-button data-action="pull" .disabled=${blocked || !status.has_origin || status.branch !== 'main'} @click=${() => this.act('pull')}>${t(language, 'gitPull')}</ha-button>
          <ha-button data-action="main" .disabled=${blocked || status.branch === 'main'} @click=${() => this.act('main')}>${t(language, 'gitMain')}</ha-button>
        </div>
        <p class="muted">${t(language, 'gitFilesNotice')}</p>
        <details><summary>${t(language, 'gitHistory')}</summary>
          <ul>${this.history.commits.map(
            (entry) => html`<li>
            <div><code>${entry.short}</code> · ${entry.date}<br>${entry.subject}</div>
            <ha-button data-revision=${entry.commit} .disabled=${blocked || entry.commit === status.commit} @click=${() => this.act('checkout', entry.commit)}>${t(language, 'gitCheckout')}</ha-button>
          </li>`
          )}</ul>
          ${this.history.has_more ? html`<ha-button .disabled=${this.busy} @click=${() => this.more()}>${t(language, 'gitMore')}</ha-button>` : nothing}
        </details>`
          : nothing
      }
    </ha-card>`;
  }

  static styles = css`
    :host { display: block; margin-bottom: 20px; }
    ha-card { padding: 16px; }
    header, .controls { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
    header ha-icon-button { margin-left: auto; }
    p, summary { font-size: 14px; }
    .muted { color: var(--secondary-text-color); }
    ul { list-style: none; padding: 0; }
    li { display: flex; align-items: center; justify-content: space-between; gap: 12px;
      padding: 8px 0; border-bottom: 1px solid var(--divider-color); }
    li div { min-width: 0; overflow-wrap: anywhere; }
    code { overflow-wrap: anywhere; }
    summary { cursor: pointer; padding: 8px 0; }
  `;
}

defineElement('flode-git', FlodeGit);

import type { GitAction, GitChanges, GitHistory, GitStatus } from '@flode/shared';
import { css, html, LitElement, nothing, type PropertyValues } from 'lit';
import { defineElement } from './define-element';
import { readGitChanges, readGitHistory, readGitStatus, runGitAction } from './git-source';
import { ensureHaSelector, errorMessage, type HomeAssistant } from './ha';
import { t } from './strings';

/** Git updates the checkout explicitly; it never runs or reloads HA automations. */
export class FlodeGit extends LitElement {
  static properties = {
    hass: { attribute: false },
    directory: { type: String },
    hasUnsavedChanges: { type: Boolean },
    status: { state: true },
    history: { state: true },
    busy: { state: true },
    error: { state: true },
    changes: { state: true },
    message: { state: true },
  };
  declare hass: HomeAssistant | undefined;
  directory = '';
  hasUnsavedChanges = false;
  private status: GitStatus | null = null;
  private history: GitHistory = { commits: [], has_more: false };
  private changes: GitChanges | null = null;
  private message = '';
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
      this.changes = null;
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
    if (this.hasUnsavedChanges && ['pull', 'main', 'checkout'].includes(action)) return;
    this.busy = true;
    this.error = null;
    try {
      if (action === 'commit' && !this.changes) return;
      this.status = await runGitAction(
        this.hass,
        action,
        this.status.commit,
        revision,
        action === 'commit' && this.changes
          ? {
              expected_changes: this.changes.version,
              message: this.message,
            }
          : undefined,
        this.status.directory
      );
      this.changes = null;
      if (action === 'commit') this.message = '';
      if (['pull', 'main', 'checkout'].includes(action))
        this.dispatchEvent(new CustomEvent('files-changed'));
      this.history = await readGitHistory(this.hass);
    } catch (error) {
      this.error = errorMessage(error);
      this.changes = null;
      // A failed pull may still have fetched new remote history.
      this.status = await readGitStatus(this.hass).catch(() => null);
    } finally {
      this.busy = false;
    }
  }

  private async review(): Promise<void> {
    if (!this.hass || this.busy) return;
    this.busy = true;
    this.error = null;
    this.changes = null;
    try {
      if (!(await ensureHaSelector()))
        throw new Error('Home Assistant text selectors are unavailable');
      this.changes = await readGitChanges(this.hass);
    } catch (error) {
      this.error = errorMessage(error);
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
    const blocked = this.busy || status?.dirty || this.hasUnsavedChanges;
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
        ${this.hasUnsavedChanges ? html`<ha-alert alert-type="warning">${t(language, 'gitUnsavedEditors')}</ha-alert>` : nothing}
        ${status.dirty ? html`<ha-alert alert-type="warning">${t(language, 'gitDirty')}</ha-alert>` : nothing}
        <div class="controls">
          <ha-button data-action="fetch" .disabled=${this.busy || !status.has_origin} @click=${() => this.act('fetch')}>${t(language, 'gitFetch')}</ha-button>
          <ha-button data-action="pull" .disabled=${blocked || !status.has_origin || status.branch !== 'main'} @click=${() => this.act('pull')}>${t(language, 'gitPull')}</ha-button>
          <ha-button data-action="main" .disabled=${blocked || status.branch === 'main'} @click=${() => this.act('main')}>${t(language, 'gitMain')}</ha-button>
        </div>
        <div class="controls publish">
          <ha-button data-action="review" .disabled=${this.busy} @click=${() => this.review()}>${t(language, 'gitReview')}</ha-button>
          <ha-button data-action="push" .disabled=${this.busy || !status.has_origin || status.branch !== 'main'} @click=${() => this.act('push')}>${t(language, 'gitPush')}</ha-button>
        </div>
        ${
          this.changes
            ? html`<section class="review">
          <p>${t(language, 'gitCommitScope')}</p>
          <ul>${this.changes.files.map((file) => html`<li><code>${file}</code></li>`)}</ul>
          <pre class="diff">${this.changes.diff || t(language, 'gitNoChanges')}</pre>
          ${this.changes.truncated ? html`<ha-alert alert-type="warning">${t(language, 'gitDiffTruncated')}</ha-alert>` : nothing}
          <ha-selector data-field="message" .hass=${this.hass} .selector=${{ text: {} }}
            .label=${t(language, 'gitCommitMessage')} .required=${true}
            .value=${this.message} .disabled=${this.busy}
            @value-changed=${(event: CustomEvent<{ value: unknown }>) => {
              this.message = typeof event.detail.value === 'string' ? event.detail.value : '';
            }}></ha-selector>
          <ha-button data-action="commit" .disabled=${this.busy || status.branch !== 'main' || !this.changes.files.length || !this.message.trim() || this.changes.truncated} @click=${() => this.act('commit')}>${t(language, 'gitCommit')}</ha-button>
        </section>`
            : nothing
        }
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
    .publish { margin-top: 12px; }
    .review { display: grid; gap: 12px; margin-top: 12px; }
    .diff { max-height: 360px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; }
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

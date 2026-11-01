import type { GitAction, GitChanges, GitHistory, GitRevision, GitStatus } from '@flode/shared';
import { css, html, LitElement, nothing, type PropertyValues } from 'lit';
import { defineElement } from './define-element';
import {
  readGitChanges,
  readGitHistory,
  readGitRevision,
  readGitStatus,
  runGitAction,
} from './git-source';
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
    revision: { state: true },
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
  private revision: GitRevision | null = null;
  private changes: GitChanges | null = null;
  private message = '';
  private busy = false;
  private error: string | null = null;

  private context = 0;
  private refreshPending = false;

  protected willUpdate(changed: PropertyValues<this>): void {
    if (changed.has('directory')) {
      this.context++;
      this.status = null;
      this.revision = null;
      this.changes = null;
      this.history = { commits: [], has_more: false };
      this.message = '';
    }
    if ((changed.has('hass') && !changed.get('hass')) || changed.has('directory'))
      void this.refresh();
  }

  private acceptStatus(status: GitStatus): void {
    if (this.directory && status.directory !== this.directory)
      throw new Error('The configured project changed; refresh the file list');
    this.status = status;
  }

  private finish(context: number): void {
    this.busy = false;
    if (context === this.context)
      this.dispatchEvent(
        new CustomEvent<GitStatus | null>('git-state-changed', { detail: this.status })
      );
    if (this.refreshPending) {
      this.refreshPending = false;
      void this.refresh();
    }
  }

  private async refresh(): Promise<void> {
    if (!this.hass) return;
    if (this.busy) {
      this.refreshPending = true;
      return;
    }
    const context = this.context;
    this.busy = true;
    this.error = null;
    try {
      const status = await readGitStatus(this.hass);
      const history = await readGitHistory(this.hass);
      if (context !== this.context) return;
      this.acceptStatus(status);
      this.changes = null;
      this.history = history;
    } catch (error) {
      if (context !== this.context) return;
      this.error = errorMessage(error);
      this.status = null;
    } finally {
      this.finish(context);
    }
  }

  private async act(action: GitAction, revision = ''): Promise<void> {
    if (!this.hass || !this.status || this.busy) return;
    if (this.hasUnsavedChanges && ['merge', 'revert'].includes(action)) return;
    const context = this.context;
    const directory = this.status.directory;
    this.busy = true;
    this.error = null;
    try {
      if (action === 'commit' && !this.changes) return;
      const status = await runGitAction(
        this.hass,
        action,
        this.status.commit,
        revision,
        action === 'commit' && this.changes
          ? { expected_changes: this.changes.version, message: this.message }
          : undefined,
        directory
      );
      if (context !== this.context) return;
      this.acceptStatus(status);
      this.changes = null;
      if (action === 'commit') this.message = '';
      if (['merge', 'prod', 'revert'].includes(action))
        this.dispatchEvent(new CustomEvent('files-changed', { detail: { directory } }));
      const history = await readGitHistory(this.hass);
      if (context === this.context) this.history = history;
    } catch (error) {
      if (context !== this.context) return;
      this.error = errorMessage(error);
      this.changes = null;
      // A failed merge may still have fetched new remote history.
      const status = await readGitStatus(this.hass).catch(() => null);
      const history = await readGitHistory(this.hass).catch(() => ({
        commits: [],
        has_more: false,
      }));
      if (context !== this.context) return;
      this.status =
        status && (!this.directory || status.directory === this.directory) ? status : null;
      this.history = history;
    } finally {
      this.finish(context);
    }
  }

  private async review(): Promise<void> {
    if (!this.hass || this.busy) return;
    const context = this.context;
    this.busy = true;
    this.error = null;
    this.changes = null;
    try {
      if (!(await ensureHaSelector()))
        throw new Error('Home Assistant text selectors are unavailable');
      const changes = await readGitChanges(this.hass);
      if (context === this.context) this.changes = changes;
    } catch (error) {
      if (context === this.context) this.error = errorMessage(error);
    } finally {
      this.finish(context);
    }
  }

  private async showRevision(revision: string): Promise<void> {
    if (!this.hass || this.busy) return;
    const context = this.context;
    this.busy = true;
    this.error = null;
    this.revision = null;
    try {
      const snapshot = await readGitRevision(this.hass, revision);
      if (context === this.context) this.revision = snapshot;
    } catch (error) {
      if (context === this.context) this.error = errorMessage(error);
    } finally {
      this.finish(context);
    }
  }

  private async more(): Promise<void> {
    if (!this.hass || this.busy) return;
    const context = this.context;
    this.busy = true;
    try {
      const next = await readGitHistory(this.hass, this.history.commits.length);
      if (context === this.context)
        this.history = {
          commits: [...this.history.commits, ...next.commits],
          has_more: next.has_more,
        };
    } catch (error) {
      if (context === this.context) this.error = errorMessage(error);
    } finally {
      this.finish(context);
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
        <p>${t(language, 'gitWorkflow')}</p>
        <p>${status.remote_prod ? t(language, 'gitAheadBehind').replace('{ahead}', String(status.ahead)).replace('{behind}', String(status.behind)) : t(language, 'gitProdUnpublished')}</p>
        <p>${status.remote_main ? t(language, 'gitIncoming').replace('{count}', String(status.incoming)) : 'origin/main: —'}</p>
        ${this.hasUnsavedChanges ? html`<ha-alert alert-type="warning">${t(language, 'gitUnsavedEditors')}</ha-alert>` : nothing}
        ${status.dirty ? html`<ha-alert alert-type="warning">${t(language, 'gitDirty')}</ha-alert>` : nothing}
        <div class="controls">
          <ha-button data-action="fetch" .disabled=${this.busy || !status.has_origin} @click=${() => this.act('fetch')}>${t(language, 'gitFetch')}</ha-button>
          <ha-button data-action="merge" .disabled=${blocked || !status.has_origin || status.branch !== 'prod'} @click=${() => this.act('merge')}>${t(language, 'gitMerge')}</ha-button>
          <ha-button data-action="prod" .disabled=${this.busy || status.dirty || status.branch === 'prod'} @click=${() => this.act('prod')}>${t(language, 'gitProd')}</ha-button>
        </div>
        ${
          status.merge_to_revert
            ? html`<p>${t(language, 'gitUndoNotice')}</p>
          <ha-button data-action="revert" .disabled=${blocked || status.branch !== 'prod'} @click=${() => this.act('revert', status.merge_to_revert ?? '')}>${t(language, 'gitRevert')}</ha-button>`
            : nothing
        }
        <div class="controls publish">
          <ha-button data-action="review" .disabled=${this.busy} @click=${() => this.review()}>${t(language, 'gitReview')}</ha-button>
          <ha-button data-action="push" .disabled=${this.busy || !status.has_origin || status.branch !== 'prod'} @click=${() => this.act('push')}>${t(language, 'gitPush')}</ha-button>
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
          <ha-button data-action="commit" .disabled=${this.busy || status.branch !== 'prod' || !this.changes.files.length || !this.message.trim()} @click=${() => this.act('commit')}>${t(language, 'gitCommit')}</ha-button>
        </section>`
            : nothing
        }
        <p class="muted">${t(language, 'gitFilesNotice')}</p>
        <details><summary>${t(language, 'gitHistory')}</summary>
          <ul>${this.history.commits.map(
            (entry) => html`<li>
            <div><code>${entry.short}</code> · ${entry.date}<br>${entry.subject}</div>
            <ha-button data-revision=${entry.commit} .disabled=${this.busy} @click=${() => this.showRevision(entry.commit)}>${t(language, 'gitShow')}</ha-button>
          </li>`
          )}</ul>
          ${this.history.has_more ? html`<ha-button .disabled=${this.busy} @click=${() => this.more()}>${t(language, 'gitMore')}</ha-button>` : nothing}
        </details>
        ${
          this.revision
            ? html`<section class="review">
          <code>${this.revision.revision}</code>
          <pre class="diff">${this.revision.diff || t(language, 'gitNoChanges')}</pre>
          ${this.revision.truncated ? html`<ha-alert alert-type="warning">${t(language, 'gitDiffTruncated')}</ha-alert>` : nothing}
        </section>`
            : nothing
        }`
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

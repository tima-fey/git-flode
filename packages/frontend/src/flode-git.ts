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
import './flode-ha-controls';

const PUBLICATION_STAGES: ('commit' | 'push')[] = ['commit', 'push'];

/** Project scenarios coordinate explicit Git, publication, and HA maintenance actions. */
export class FlodeGit extends LitElement {
  static properties = {
    hass: { attribute: false },
    directory: { type: String },
    hasUnsavedChanges: { type: Boolean },
    status: { state: true },
    history: { state: true },
    incomingHistory: { state: true },
    revision: { state: true },
    busy: { state: true },
    error: { state: true },
    changes: { state: true },
    message: { state: true },
    maintenanceBusy: { state: true },
    publication: { state: true },
    publicationError: { state: true },
  };
  declare hass: HomeAssistant | undefined;
  directory = '';
  hasUnsavedChanges = false;
  private status: GitStatus | null = null;
  private history: GitHistory = { commits: [], has_more: false };
  private incomingHistory: GitHistory = { commits: [], has_more: false };
  private revision: GitRevision | null = null;
  private changes: GitChanges | null = null;
  private message = '';
  private maintenanceBusy = false;
  private publicationError: string | null = null;
  private publication: Partial<Record<'commit' | 'push', 'running' | 'ok' | 'failed' | 'skipped'>> =
    {};
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
      this.incomingHistory = { commits: [], has_more: false };
      this.message = '';
      this.publication = {};
      this.publicationError = null;
    }
    if ((changed.has('hass') && !changed.get('hass')) || changed.has('directory'))
      void this.refresh();
  }

  private get unavailable(): boolean {
    return this.busy || this.maintenanceBusy;
  }

  private maintenanceChanged(event: CustomEvent<boolean>): void {
    this.maintenanceBusy = event.detail;
    if (!event.detail && this.refreshPending) {
      this.refreshPending = false;
      void this.refresh();
    }
  }

  private async publish(): Promise<void> {
    const hass = this.hass;
    if (
      !hass ||
      !this.status ||
      this.unavailable ||
      this.status.branch !== 'prod' ||
      !this.status.has_origin
    )
      return;
    const context = this.context;
    const directory = this.status.directory;
    let head = this.status.commit;
    let stage: 'commit' | 'push' = 'commit';
    this.busy = true;
    this.error = null;
    this.publication = { commit: 'running' };
    this.publicationError = null;
    try {
      const changes = this.changes ?? (await readGitChanges(hass));
      if (context !== this.context || (this.directory && directory !== this.directory)) return;
      if (changes.files.length) {
        if (!this.message.trim()) throw new Error(t(hass.language, 'gitCommitMessage'));
        const committed = await runGitAction(
          hass,
          'commit',
          head,
          '',
          {
            expected_changes: changes.version,
            message: this.message,
          },
          directory
        );
        if (context !== this.context || (this.directory && directory !== this.directory)) return;
        this.acceptStatus(committed);
        head = committed.commit;
        this.message = '';
        this.publication = { commit: 'ok' };
      } else {
        this.publication = { commit: 'skipped' };
      }
      this.changes = null;
      stage = 'push';
      this.publication = { ...this.publication, push: 'running' };
      const pushed = await runGitAction(hass, 'push', head, '', undefined, directory);
      if (context !== this.context || (this.directory && directory !== this.directory)) return;
      this.acceptStatus(pushed);
      this.publication = { ...this.publication, push: 'ok' };
    } catch (error) {
      if (context !== this.context) return;
      this.publicationError = errorMessage(error);
      this.publication = {
        ...this.publication,
        [stage]: 'failed',
        ...(stage === 'commit' ? { push: 'skipped' } : {}),
      };
      this.changes = null;
    } finally {
      // Refresh after partial success too: a failed push must leave the committed work visible.
      if (context === this.context) this.refreshPending = true;
      this.finish(context);
    }
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
    if (this.unavailable) {
      this.refreshPending = true;
      return;
    }
    const context = this.context;
    this.busy = true;
    this.error = null;
    try {
      const status = await readGitStatus(this.hass);
      const history = await readGitHistory(this.hass);
      const incomingHistory = await readGitHistory(this.hass, 0, 'incoming');
      if (context !== this.context) return;
      this.acceptStatus(status);
      this.changes = null;
      this.history = history;
      this.incomingHistory = incomingHistory;
      await ensureHaSelector();
    } catch (error) {
      if (context !== this.context) return;
      this.error = errorMessage(error);
      this.status = null;
    } finally {
      this.finish(context);
    }
  }

  private async act(action: GitAction, revision = ''): Promise<void> {
    if (!this.hass || !this.status || this.unavailable) return;
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
      const incomingHistory = await readGitHistory(this.hass, 0, 'incoming');
      if (context === this.context) {
        this.history = history;
        this.incomingHistory = incomingHistory;
      }
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
      const incomingHistory = await readGitHistory(this.hass, 0, 'incoming').catch(() => ({
        commits: [],
        has_more: false,
      }));
      if (context !== this.context) return;
      this.status =
        status && (!this.directory || status.directory === this.directory) ? status : null;
      this.history = history;
      this.incomingHistory = incomingHistory;
    } finally {
      this.finish(context);
    }
  }

  private async review(): Promise<void> {
    if (!this.hass || this.unavailable) return;
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
    if (!this.hass || this.unavailable) return;
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

  private async more(scope: 'all' | 'incoming' = 'all'): Promise<void> {
    if (!this.hass || this.unavailable) return;
    const context = this.context;
    this.busy = true;
    try {
      const current = scope === 'incoming' ? this.incomingHistory : this.history;
      const next = await readGitHistory(this.hass, current.commits.length, scope);
      if (context === this.context) {
        const history = {
          commits: [...current.commits, ...next.commits],
          has_more: next.has_more,
        };
        if (scope === 'incoming') this.incomingHistory = history;
        else this.history = history;
      }
    } catch (error) {
      if (context === this.context) this.error = errorMessage(error);
    } finally {
      this.finish(context);
    }
  }

  private renderCommits(history: GitHistory, scope: 'all' | 'incoming') {
    const language = this.hass?.language ?? 'en';
    return html`<ul>${history.commits.map(
      (entry) => html`<li>
        <div><code>${entry.short}</code> · ${entry.date} · ${entry.author}<br>${entry.subject}</div>
        <ha-button data-revision=${entry.commit} .disabled=${this.unavailable} @click=${() => this.showRevision(entry.commit)}>${t(language, 'gitShow')}</ha-button>
      </li>`
    )}</ul>
    ${history.has_more ? html`<ha-button data-more=${scope} .disabled=${this.unavailable} @click=${() => this.more(scope)}>${t(language, 'gitMore')}</ha-button>` : nothing}`;
  }

  private renderMaintenance(mode: 'apply' | 'objects') {
    return html`<flode-ha-controls mode=${mode} .hass=${this.hass}
      .directory=${this.status?.branch === 'prod' ? this.directory || this.status.directory : ''}
      .revision=${`${this.status?.commit ?? ''}:${this.status?.dirty ?? false}`}
      .blocked=${this.unavailable || (mode === 'apply' && this.hasUnsavedChanges)}
      @maintenance-busy=${this.maintenanceChanged}
      @objects-exported=${() => this.refresh()}></flode-ha-controls>`;
  }

  private renderReview() {
    if (!this.changes) return nothing;
    const language = this.hass?.language ?? 'en';
    const objectsDiff = this.changes.objects_diff;
    return html`<section class="review">
      <p>${t(language, 'gitCommitScope')}</p>
      <ul>${this.changes.files.map((file) => html`<li><code>${file}</code></li>`)}</ul>
      ${this.changes.diff || !this.changes.files.length ? html`<pre class="diff">${this.changes.diff || t(language, 'gitNoChanges')}</pre>` : nothing}
      ${this.changes.truncated ? html`<ha-alert alert-type="warning">${t(language, 'gitDiffTruncated')}</ha-alert>` : nothing}
      ${
        objectsDiff?.diff
          ? html`<details><summary>${t(language, 'gitObjectsDiff')}</summary>
        <pre class="diff">${objectsDiff.diff}</pre>
        ${objectsDiff.truncated ? html`<ha-alert alert-type="warning">${t(language, 'gitDiffTruncated')}</ha-alert>` : nothing}
      </details>`
          : nothing
      }
    </section>`;
  }

  render() {
    const language = this.hass?.language ?? 'en';
    const status = this.status;
    const disabled = this.unavailable;
    const blocked = disabled || status?.dirty || this.hasUnsavedChanges;
    return html`<ha-card>
      <header><strong>${t(language, 'workflowTitle')}</strong>
        ${status ? html`<span>${status.branch ?? t(language, 'gitDetached')}</span><code title=${status.commit}>${status.short}</code>` : nothing}
        <ha-icon-button .label=${t(language, 'gitRefresh')} .disabled=${disabled} @click=${() => this.refresh()}>
          <ha-icon icon="mdi:refresh"></ha-icon>
        </ha-icon-button>
      </header>
      ${this.error ? html`<ha-alert alert-type="error">${this.error}</ha-alert>` : nothing}
      ${this.busy ? html`<p>${t(language, 'loading')}</p>` : nothing}
      ${
        status
          ? html`
        ${this.hasUnsavedChanges ? html`<ha-alert alert-type="warning">${t(language, 'gitUnsavedEditors')}</ha-alert>` : nothing}
        ${status.dirty ? html`<ha-alert alert-type="warning">${t(language, 'gitDirty')}</ha-alert>` : nothing}
        ${status.branch !== 'prod' ? html`<ha-button data-action="prod" .disabled=${disabled || status.dirty} @click=${() => this.act('prod')}>${t(language, 'gitProd')}</ha-button>` : nothing}
        <section class="scenario" data-scenario="update">
          <h3>1. ${t(language, 'workflowUpdate')}</h3>
          <div class="controls">
            <ha-button data-action="fetch" .disabled=${disabled || !status.has_origin} @click=${() => this.act('fetch')}>${t(language, 'gitFetch')}</ha-button>
            <ha-button data-action="merge" .disabled=${blocked || !status.has_origin || status.branch !== 'prod'} @click=${() => this.act('merge')}>${t(language, 'gitMerge')}</ha-button>
          </div>
          <section class="incoming">
            <p>${status.remote_main ? t(language, 'gitIncoming').replace('{count}', String(status.incoming)) : 'origin/main: —'}</p>
            ${status.incoming > 0 ? this.renderCommits(this.incomingHistory, 'incoming') : nothing}
          </section>
          ${this.renderMaintenance('apply')}
        </section>
        <section class="scenario" data-scenario="publish">
          <h3>2. ${t(language, 'workflowPublish')}</h3>
          ${this.renderMaintenance('objects')}
          <ha-button data-action="review" .disabled=${disabled} @click=${() => this.review()}>${t(language, 'workflowOptionalReview')}</ha-button>
          ${this.renderReview()}
          <ha-selector data-field="message" .hass=${this.hass} .selector=${{ text: {} }}
            .label=${t(language, 'gitCommitMessage')} .required=${status.dirty}
            .value=${this.message} .disabled=${disabled}
            @value-changed=${(event: CustomEvent<{ value: unknown }>) => {
              this.message = typeof event.detail.value === 'string' ? event.detail.value : '';
            }}></ha-selector>
          <ha-button data-action="commit-push" .disabled=${disabled || !status.has_origin || status.branch !== 'prod' || ((status.dirty || !!this.changes?.files.length) && !this.message.trim())} @click=${() => this.publish()}>${t(language, 'workflowCommitPush')}</ha-button>
          <div role="status" aria-live="polite">${PUBLICATION_STAGES.filter(
            (stage) => this.publication[stage]
          ).map(
            (stage) => html`
            <p data-publication=${stage} data-state=${this.publication[stage]}>${t(language, stage === 'commit' ? 'gitCommit' : 'gitPush')} — <strong>${t(language, this.publication[stage] === 'ok' ? 'workflowOk' : this.publication[stage] === 'failed' ? 'workflowFailed' : this.publication[stage] === 'skipped' ? 'workflowSkipped' : 'workflowRunning')}</strong></p>`
          )}</div>
          ${this.publicationError ? html`<ha-alert alert-type="error">${this.publicationError}</ha-alert>` : nothing}
          <details data-manual-publish><summary>${t(language, 'workflowIndividual')}</summary>
            <div class="controls">
              <ha-button data-action="commit" .disabled=${disabled || status.branch !== 'prod' || !this.changes?.files.length || !this.message.trim()} @click=${() => this.act('commit')}>${t(language, 'gitCommit')}</ha-button>
              <ha-button data-action="push" .disabled=${disabled || !status.has_origin || status.branch !== 'prod'} @click=${() => this.act('push')}>${t(language, 'gitPush')}</ha-button>
            </div>
          </details>
          <p class="muted">${status.remote_prod ? (status.ahead === 0 && status.behind === 0 ? t(language, 'gitSynced') : t(language, 'gitAheadBehind').replace('{ahead}', String(status.ahead)).replace('{behind}', String(status.behind))) : t(language, 'gitProdUnpublished')}</p>
        </section>
        <section class="scenario" data-scenario="rollback">
          <h3>3. ${t(language, 'workflowRollback')}</h3>
          <p>${t(language, status.merge_to_revert ? 'gitUndoNotice' : 'workflowNoRollback')}</p>
          <ha-button data-action="revert" .disabled=${blocked || status.branch !== 'prod' || !status.merge_to_revert} @click=${() => this.act('revert', status.merge_to_revert ?? '')}>${t(language, 'gitRevert')}</ha-button>
          <p class="muted">${t(language, 'workflowRollbackHint')}</p>
          ${this.renderMaintenance('apply')}
        </section>
        <p class="muted">${t(language, 'gitFilesNotice')}</p>
        <details class="history"><summary>${t(language, 'gitHistory')}</summary>${this.renderCommits(this.history, 'all')}</details>
        ${
          this.revision
            ? html`<section class="review"><code>${this.revision.revision}</code>
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
    .scenario { padding: 16px 0; border-bottom: 1px solid var(--divider-color); }
    h3 { margin: 0 0 16px; font-size: 16px; }
    ha-selector { display: block; margin: 12px 0; }
    [data-state='ok'] strong { color: var(--success-color, #22863a); }
    [data-state='failed'] strong { color: var(--error-color); }
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

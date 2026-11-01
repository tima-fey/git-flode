import {
  type GitAction,
  GitChangesSchema,
  type GitCommitDetails,
  GitHistorySchema,
  GitRevisionSchema,
  GitStatusSchema,
} from '@flode/shared';
import type { HomeAssistant } from './ha';

export async function readGitStatus(hass: HomeAssistant) {
  return GitStatusSchema.parse(await hass.callWS({ type: 'flode/git/status' }));
}

export async function readGitHistory(hass: HomeAssistant, offset = 0) {
  return GitHistorySchema.parse(await hass.callWS({ type: 'flode/git/history', offset }));
}

export async function runGitAction(
  hass: HomeAssistant,
  action: GitAction,
  expectedHead: string,
  revision = '',
  commit?: GitCommitDetails,
  directory = ''
) {
  return GitStatusSchema.parse(
    await hass.callWS({
      type: 'flode/git/action',
      action,
      expected_head: expectedHead,
      revision,
      ...commit,
      expected_directory: directory,
    })
  );
}

export async function readGitChanges(hass: HomeAssistant) {
  return GitChangesSchema.parse(await hass.callWS({ type: 'flode/git/changes' }));
}

export async function readGitRevision(hass: HomeAssistant, revision: string) {
  return GitRevisionSchema.parse(await hass.callWS({ type: 'flode/git/show', revision }));
}

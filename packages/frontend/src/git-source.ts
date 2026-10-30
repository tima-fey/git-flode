import { type GitAction, GitHistorySchema, GitStatusSchema } from '@flode/shared';
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
  revision = ''
) {
  return GitStatusSchema.parse(
    await hass.callWS({
      type: 'flode/git/action',
      action,
      expected_head: expectedHead,
      revision,
    })
  );
}
